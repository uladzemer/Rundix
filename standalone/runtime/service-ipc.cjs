'use strict';
const net = require('node:net');
const {EventEmitter} = require('node:events');
const {randomBytes, createHmac, timingSafeEqual} = require('node:crypto');
const MAX_FRAME = 1024 * 1024, MAX_QUEUE = 2 * MAX_FRAME;
const failure = code => Object.assign(new Error(code), {code});
const proof = (secret, generation, nonce) => createHmac('sha256', secret)
  .update('rundix-service-v1\0' + generation + '\0' + nonce).digest('hex');

// One peer owns all pending operations: close/timeout never migrate work to a new connection.
class Peer extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this.socket = socket; this.options = options; this.pending = new Map();
    this.sequence = 0; this.parts = []; this.bytes = 0; this.closed = false;
    this.inflight = 0; this.handlerTimers = new Set(); this.calls = new Set();
    this.abortController = new AbortController(); this.signal = this.abortController.signal;
    socket.on('error', () => this.close('service_unavailable'));
    socket.on('close', () => this.close('service_unavailable'));
    socket.on('data', chunk => this.read(chunk));
  }
  read(chunk) {
    let start = 0;
    while (start < chunk.length && !this.closed) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.bytes += part.length;
      if (this.bytes > (this.options.maxFrame || MAX_FRAME)) return this.close('frame_too_large');
      this.parts.push(part);
      if (newline < 0) {
        if (!this.frameTimer) this.frameTimer = setTimeout(() => this.close('frame_timeout'), this.options.frameTimeoutMs || 5000);
        return;
      }
      clearTimeout(this.frameTimer); this.frameTimer = null;
      let message;
      try { message = JSON.parse(Buffer.concat(this.parts, this.bytes).toString('utf8')); }
      catch { return this.close('invalid_frame'); }
      this.parts = []; this.bytes = 0;
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') return this.close('invalid_frame');
      this.receive(message); start = end + 1;
    }
  }
  send(message) {
    if (this.closed) throw failure('service_unavailable');
    const line = JSON.stringify({jsonrpc:'2.0', ...message});
    const size = Buffer.byteLength(line);
    if (size > (this.options.maxFrame || MAX_FRAME)) throw failure('frame_too_large');
    if (this.socket.writableLength + size + 1 > (this.options.maxQueue || MAX_QUEUE)) {
      this.close('backpressure'); throw failure('backpressure');
    }
    this.socket.write(line + '\n', () => {
      if (!this.socket.writableLength) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    });
    // A reader which stops consuming cannot retain a connection forever.
    if (this.socket.writableLength && !this.writeTimer) {
      this.writeTimer = setTimeout(() => this.close('write_timeout'), this.options.writeTimeoutMs || 5000);
      // The final write callback clears the stall timer when the queue empties.
      // A small completed write need not emit drain; per-write drain listeners
      // would otherwise accumulate for the lifetime of a busy service client.
    }
  }
  request(method, params = {}, timeoutMs = 12000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1515000) return Promise.reject(failure('invalid_argument'));
    if (this.pending.size >= 64) return Promise.reject(failure('limit'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('rpc_timeout')); }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (this.closed) return;
    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        if (this.authenticated) {
          if (this.generation && message.params?.generation !== this.generation) return this.close('stale_instance');
          this.emit('event', message.method, message.params);
        }
        return;
      }
      if (typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) return this.close('invalid_frame');
      if (++this.inflight > 64) return this.close('limit');
      let timer, budget;
      const controller = new AbortController(); this.calls.add(controller);
      const context = {signal:controller.signal};
      try {
        budget = this.options.getHandlerTimeoutMs?.(message.method,message.params,this) ?? this.options.handlerTimeoutMs ?? 12000;
        if (!Number.isFinite(budget) || budget <= 0 || budget > 1515000) throw failure('invalid_argument');
      } catch {
        this.calls.delete(controller); this.inflight--;
        try { this.send({id:message.id,error:{code:'rejected',message:'rejected'}}); } catch { this.close(); }
        return;
      }
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('rpc_timeout')); }, budget); this.handlerTimers.add(timer); });
      const work = Promise.resolve().then(() => {
        if (this.closed) throw failure('service_unavailable');
        return this.handler?.(message.method, message.params, context);
      });
      // A deadline stops delivery, but must not free a slot still occupied by application work.
      work.then(() => this.inflight--, () => this.inflight--);
      Promise.race([work, deadline])
        .then(result => { if (!this.closed) this.send({id:message.id, result:result ?? null}); })
        .catch(error => {
          // No exception messages or caller-supplied error codes cross the boundary.
          const code = ['auth_failed','protocol_incompatible','stale_instance','service_initializing','method_not_supported','rpc_timeout'].includes(error?.code) ? error.code : 'rejected';
          if (!this.closed) { try { this.send({id:message.id, error:{code, message:code}}); } catch { this.close('service_unavailable'); } }
        }).finally(() => { clearTimeout(timer); this.handlerTimers.delete(timer); this.calls.delete(controller); });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(failure(['auth_failed','protocol_incompatible','stale_instance','service_initializing','method_not_supported','rpc_timeout','rejected'].includes(message.error.code) ? message.error.code : 'rejected'));
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(failure('invalid_frame'));
  }
  close(code = 'service_unavailable') {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.frameTimer); clearTimeout(this.writeTimer);
    this.abortController.abort();
    for (const controller of this.calls) controller.abort();
    this.calls.clear();
    clearTimeout(this.authTimer); this.parts = []; this.bytes = 0;
    for (const timer of this.handlerTimers) clearTimeout(timer);
    this.handlerTimers.clear();
    for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(failure(code)); }
    this.pending.clear(); this.socket.destroy(); this.emit('closed', code);
  }
}

function accept(socket, {secret, generation, status, call, hello, onAuthenticated, ...options}) {
  const peer = new Peer(socket, options);
  let nonce, expires;
  peer.authTimer = setTimeout(() => peer.close('auth_failed'), options.authTimeoutMs || 5000);
  peer.handler = async (method, params, context) => {
    if (method === 'service.ping') {
      nonce = randomBytes(32).toString('hex'); expires = Date.now() + 5000;
      return {generation, status:status(), serverNonce:nonce};
    }
    if (method === 'service.hello') {
      const challenge = nonce; nonce = null;
      if (peer.authenticated || !challenge || Date.now() >= expires || params?.generation !== generation || params?.serverNonce !== challenge || !/^[a-f0-9]{64}$/.test(params?.proof || '')) throw failure('auth_failed');
      const expected = Buffer.from(proof(secret, generation, challenge), 'hex');
      if (!timingSafeEqual(expected, Buffer.from(params.proof, 'hex'))) throw failure('auth_failed');
      if (!(params.protocol?.min <= 1 && params.protocol?.max >= 1)) throw failure('protocol_incompatible');
      if (status() !== 'ready') throw failure('service_initializing');
      const binding = await hello?.(params, peer);
      if (peer.closed || context.signal.aborted) throw failure('auth_failed');
      peer.authenticated = true; clearTimeout(peer.authTimer); onAuthenticated?.(peer);
      return {generation, protocol:1, ...binding};
    }
    if (!peer.authenticated) throw failure('auth_failed');
    if (params?.generation !== generation) throw failure('stale_instance');
    if (!call) throw failure('method_not_supported');
    return call(method, params, peer, context);
  };
  return peer;
}
function dial(address, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const timer = setTimeout(() => { socket.destroy(); reject(failure('connect_timeout')); }, options.connectTimeoutMs || 2000);
    const failed = () => { clearTimeout(timer); reject(failure('service_unavailable')); };
    socket.once('error', failed);
    socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', failed); resolve(new Peer(socket, options)); });
  });
}
async function authenticate(peer, descriptor, timeoutMs = 5000, deadline = Date.now() + 2 * timeoutMs, hello = {}) {
  const remaining = () => { const ms = Math.min(timeoutMs,deadline-Date.now()); if (ms <= 0) throw failure('rpc_timeout'); return ms; };
  const ping = await peer.request('service.ping', {}, remaining());
  if (ping.generation !== descriptor.generation) throw failure('auth_failed');
  if (ping.status !== 'ready') throw failure('service_initializing');
  const result = await peer.request('service.hello', {...hello, protocol:{min:1,max:1}, generation:ping.generation,
    serverNonce:ping.serverNonce, proof:proof(descriptor.secret, ping.generation, ping.serverNonce)}, remaining());
  remaining();
  if (result.generation !== descriptor.generation || result.protocol !== 1) throw failure('stale_instance');
  peer.authenticated = true; peer.generation = result.generation;
  peer.binding = result;
  peer.call = (method, params = {}, budget) => peer.request(method, {...params, generation:peer.generation}, budget);
  return peer;
}
module.exports = {Peer, accept, dial, authenticate, proof, failure, MAX_FRAME, MAX_QUEUE};
