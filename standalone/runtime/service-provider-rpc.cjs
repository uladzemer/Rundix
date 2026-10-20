const {EventEmitter} = require('node:events');
const {parseStrict} = require('./service-json.cjs');
const MAX_FRAME = 256 * 1024, MAX_QUEUE = 1024 * 1024, MAX_CALLS = 32;
const ERROR_CODES = new Set(['STALE_FENCE', 'INVALID_REVISION_STEP', 'METHOD_NOT_SUPPORTED']);
function rpcError(code = 'PROVIDER_UNAVAILABLE') {
  return Object.assign(Error(code), {code, reason:'action_required'});
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function globalFence(value) {
  return object(value) && typeof value.serviceGeneration === 'string' && !!value.serviceGeneration &&
    typeof value.providerGeneration === 'string' && !!value.providerGeneration &&
    Number.isSafeInteger(value.configRevision) && value.configRevision >= 0;
}
class ProviderPeer extends EventEmitter {
  constructor({readable, writable, call, frameTimeoutMs = 5000, writeTimeoutMs = 5000} = {}) {
    super(); Object.assign(this, {readable, writable, handler:call, frameTimeoutMs, writeTimeoutMs});
    this.closed = false; this.pending = new Map(); this.incoming = new Map(); this.sequence = 0;
    this.header = Buffer.alloc(4); this.headerSize = 0; this.parts = []; this.size = 0; this.expected = null;
    readable.on('data', chunk => this.receiveBytes(chunk));
    readable.on('end', () => this.close()); readable.on('error', () => this.close());
    writable.on('error', () => this.close());
    writable.on('close', () => this.close());
  }
  receiveBytes(chunk) {
    if (this.closed) return;
    try {
      if (!Buffer.isBuffer(chunk)) throw rpcError();
      let at = 0;
      while (at < chunk.length && !this.closed) {
        if (!this.frameTimer) this.frameTimer = setTimeout(() => this.close(), this.frameTimeoutMs);
        if (this.expected === null) {
          const count = Math.min(4 - this.headerSize, chunk.length - at);
          chunk.copy(this.header, this.headerSize, at, at + count); this.headerSize += count; at += count;
          if (this.headerSize !== 4) continue;
          this.expected = this.header.readUInt32BE(0);
          if (!this.expected || this.expected > MAX_FRAME) throw rpcError();
        }
        const count = Math.min(this.expected - this.size, chunk.length - at);
        // Copy retained slices so one small partial frame cannot retain an
        // arbitrarily large shared incoming chunk's backing buffer.
        if (count) this.parts.push(Buffer.from(chunk.subarray(at, at + count)));
        this.size += count; at += count;
        if (this.size !== this.expected) continue;
        const message = parseStrict(Buffer.concat(this.parts, this.size));
        clearTimeout(this.frameTimer); this.frameTimer = null;
        this.headerSize = 0; this.parts = []; this.size = 0; this.expected = null;
        this.receive(message);
      }
    } catch { this.close(); }
  }
  send(message) {
    if (this.closed || !this.writable.writable) throw rpcError();
    const bytes = Buffer.from(JSON.stringify({jsonrpc:'2.0', ...message}));
    if (!bytes.length || bytes.length > MAX_FRAME || this.writable.writableLength + bytes.length + 4 > MAX_QUEUE) {
      this.close(); throw rpcError();
    }
    const frame = Buffer.allocUnsafe(4 + bytes.length); frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
    this.writable.write(frame, error => {
      if (error) return this.close();
      if (!this.writable.writableLength) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    });
    if (this.writable.writableLength && !this.writeTimer) {
      this.writeTimer = setTimeout(() => this.close(), this.writeTimeoutMs);
    }
  }
  request(method, params, fence, timeoutMs, {onRequest} = {}) {
    if (!globalFence(fence) || typeof method !== 'string' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000 ||
        this.pending.size >= MAX_CALLS || this.closed) return Promise.reject(rpcError());
    const id = 'r' + (++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), timeoutMs);
      this.pending.set(id, {resolve, reject, timer, fence:structuredClone(fence)});
      try { onRequest?.(id); this.send({id, method, params, fence, timeoutMs}); }
      catch { this.close(); }
    });
  }
  event(method, params, fence) {
    if (!globalFence(fence)) throw rpcError();
    this.send({method, params, fence});
  }
  receive(message) {
    if (!object(message) || message.jsonrpc !== '2.0' || !globalFence(message.fence)) throw rpcError();
    if (typeof message.method === 'string') {
      if (!object(message.params)) throw rpcError();
      if (message.id === undefined) {
        if (message.timeoutMs !== undefined) throw rpcError();
        this.emit('event', message.method, message.params, message.fence); return;
      }
      if (!((typeof message.id === 'string' && !!message.id) || Number.isSafeInteger(message.id)) || this.incoming.has(message.id) ||
          this.incoming.size >= MAX_CALLS || !Number.isInteger(message.timeoutMs) || message.timeoutMs < 1 || message.timeoutMs > 90000) throw rpcError();
      const controller = new AbortController();
      const context = {id:message.id, fence:message.fence, signal:controller.signal, deadline:Date.now() + message.timeoutMs};
      const entry = {controller, timer:null}; this.incoming.set(message.id, entry);
      // Timed-out application work remains counted until settled. No late
      // callback can deliver or authorize side effects through its signal.
      entry.timer = setTimeout(() => { controller.abort(); this.close(); }, message.timeoutMs);
      Promise.resolve().then(() => {
        if (this.closed) throw rpcError();
        if (!this.handler) throw rpcError('METHOD_NOT_SUPPORTED');
        return this.handler(message.method, message.params, context);
      }).then(result => {
        if (!this.closed && !controller.signal.aborted) this.send({id:message.id, result, fence:message.fence});
      }, error => {
        if (!this.closed && !controller.signal.aborted) {
          const code = ERROR_CODES.has(error?.code) ? error.code : 'METHOD_NOT_SUPPORTED';
          this.send({id:message.id, error:{code, message:code}, fence:message.fence});
        }
      }).catch(() => this.close()).finally(() => {
        clearTimeout(entry.timer); this.incoming.delete(message.id);
      });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) throw rpcError();
    // Full canonical fence equality is checked by the owning provider driver;
    // the peer only delivers the envelope, never drops the returned fence.
    if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw rpcError();
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) {
      const error = rpcError(ERROR_CODES.has(message.error.code) ? message.error.code : 'PROVIDER_UNAVAILABLE');
      error.fence = message.fence; pending.reject(error);
    } else pending.resolve({result:message.result, fence:message.fence});
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.frameTimer); clearTimeout(this.writeTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(rpcError()); }
    this.pending.clear();
    for (const entry of this.incoming.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.parts = []; this.size = 0;
    this.readable.destroy(); this.writable.destroy(); this.emit('closed');
  }
}
module.exports = {ProviderPeer, rpcError, globalFence, MAX_FRAME, MAX_QUEUE, MAX_CALLS};
