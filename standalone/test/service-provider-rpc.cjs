const assert = require('node:assert/strict');
const {PassThrough, Writable} = require('node:stream');
const {once} = require('node:events');
const {ProviderPeer, MAX_FRAME, MAX_CALLS, rpcError} = require('../runtime/service-provider-rpc.cjs');
const fence = {serviceGeneration:'synthetic-service', providerGeneration:'synthetic-provider', configRevision:1};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function pair(call, options = {}) {
  const left = new PassThrough(), right = new PassThrough();
  return [new ProviderPeer({readable:right, writable:left, ...options}), new ProviderPeer({readable:left, writable:right, call, ...options})];
}
function frame(text) { const body = Buffer.from(text), buffer = Buffer.alloc(4 + body.length); buffer.writeUInt32BE(body.length); body.copy(buffer, 4); return buffer; }
async function main() {
  {
    const [a, b] = pair(async (method, params, context) => {
      if (method === 'unknown') throw rpcError('METHOD_NOT_SUPPORTED');
      assert.equal(context.fence.serviceGeneration, fence.serviceGeneration); return {kind:'synthetic', count:params.count};
    });
    try {
      assert.deepEqual(await a.request('synthetic', {count:1}, fence, 1000), {result:{kind:'synthetic', count:1}, fence});
      await assert.rejects(a.request('unknown', {}, fence, 1000), {code:'METHOD_NOT_SUPPORTED'});
      const event = once(b, 'event'); a.event('syntheticEvent', {count:2}, fence);
      assert.deepEqual(await event, ['syntheticEvent', {count:2}, fence]);
    } finally { a.close(); b.close(); }
  }
  for (const invalid of [
    '[{}]', '{"jsonrpc":"2.0","jsonrpc":"2.0"}', '{"fence":{"x":1,"x":2}}', '\u00ff',
    JSON.stringify({jsonrpc:'2.0', method:'event', params:{}}),
  ]) {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new ProviderPeer({readable:input, writable:output});
    const closed = once(peer, 'closed'); input.write(frame(invalid)); await closed; assert(peer.closed);
  }
  {
    const input = new PassThrough(), output = new PassThrough(), chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    const peer = new ProviderPeer({readable:input, writable:output, call:async () => ({ok:true})});
    input.write(frame(JSON.stringify({jsonrpc:'2.0', id:7, method:'synthetic', params:{}, fence, timeoutMs:100})));
    await pause(5);
    const response = Buffer.concat(chunks); assert.equal(JSON.parse(response.subarray(4).toString()).id, 7);
    peer.close();
  }
  {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new ProviderPeer({readable:input, writable:output});
    const message = frame(JSON.stringify({jsonrpc:'2.0', method:'synthetic', params:{}, fence}));
    const event = once(peer, 'event'); for (const byte of message) input.write(Buffer.from([byte]));
    await event; assert(!peer.closed); peer.close();
  }
  for (const bytes of [Buffer.from([0, 0]), Buffer.from([0, 0, 0, 10, 123]), Buffer.from([0, 4, 0, 1]), Buffer.alloc(4)]) {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new ProviderPeer({readable:input, writable:output, frameTimeoutMs:15});
    const closed = once(peer, 'closed'); input.write(bytes); await closed; assert(peer.closed);
  }
  {
    const [a, b] = pair(() => new Promise(() => {}));
    const requests = Array.from({length:MAX_CALLS}, () => a.request('hang', {}, fence, 500));
    const settled = Promise.allSettled(requests);
    await assert.rejects(a.request('overflow', {}, fence, 100), {code:'PROVIDER_UNAVAILABLE'});
    assert.equal(a.pending.size, MAX_CALLS); a.close(); b.close(); await settled;
  }
  {
    let aborted = false;
    const [a, b] = pair((_method, _params, context) => new Promise(() => { context.signal.addEventListener('abort', () => {aborted = true;}); }));
    await assert.rejects(a.request('deadline', {}, fence, 15), {code:'PROVIDER_UNAVAILABLE'});
    await pause(5); assert(aborted); a.close(); b.close();
  }
  {
    const [a, b] = pair(() => ({ok:true}));
    await assert.rejects(a.request('huge', {text:'x'.repeat(MAX_FRAME)}, fence, 100), {code:'PROVIDER_UNAVAILABLE'});
    assert(a.closed); b.close();
  }
  {
    const readable = new PassThrough(), writable = new Writable({write(_chunk, _encoding, _callback) {}});
    const peer = new ProviderPeer({readable, writable, writeTimeoutMs:20});
    const closed = once(peer, 'closed'); peer.event('stall', {}, fence); await closed;
  }
  {
    const readable = new PassThrough(), writable = new Writable({write(_chunk, _encoding, _callback) {}});
    const peer = new ProviderPeer({readable, writable});
    for (let index = 0; index < 20 && !peer.closed; index++) {
      try { peer.event('backpressure', {text:'x'.repeat(100000)}, fence); } catch {}
    }
    assert(peer.closed);
  }
  console.log('PASS provider framed RPC: BE frames, split input, duplicate/batch rejection, deadlines, caps, backpressure and safe errors.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
