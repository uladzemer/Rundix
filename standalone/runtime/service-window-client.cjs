// Host-independent window client. The extension owns its lifetime and projection.
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const {windowBinding} = require('./service-window-rpc.cjs');
const {createServiceConnection} = require('./service-connection.cjs');
const failure = code => Object.assign(Error(code), {code});
const unwrap = response => {
  if (response?.error) throw Object.assign(Error(response.error.message), response.error);
  return response?.result;
};
class ServiceWindowClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const binding = {workspaceFolders:options.workspaceFolders, trusted:options.trusted, windowId:options.windowId || randomUUID()};
    this.windowId = binding.windowId;
    this.spaces = [...windowBinding(binding).spaces.values()];
    this.snapshots = new Map(); this.reads = new Map(); this.wanted = new Map();
    this.options = options; this.closed = false; this.delay = 250;
    this.connection = createServiceConnection(options, {clientKind:'window', binding});
  }
  start() {
    if (this.closed) return Promise.reject(failure('service_unavailable'));
    if (this.connecting) return this.connecting;
    if (this.peer && !this.peer.closed) return Promise.resolve();
    clearTimeout(this.retry); this.retry = null;
    this.connecting = this.connect().finally(() => {this.connecting = null;});
    return this.connecting;
  }
  async connect() {
    let peer;
    try {
      peer = await this.connection.connect();
      if (this.closed) {peer.close(); throw failure('service_unavailable');}
      const received = peer.binding.spaces;
      if (!peer.binding.capabilities?.includes('spaceSnapshot.v1') || !Array.isArray(received) ||
          received.length !== this.spaces.length || received.some(space => !this.spaces.some(own => own.spaceId === space.spaceId)))
        throw failure('protocol_incompatible');
      this.peer = peer;
      peer.on('event', (method, params) => {
        if (this.peer !== peer || method !== 'space.changed') return;
        if (params?.schemaVersion !== 1 || !this.spaces.some(space => space.spaceId === params.spaceId) ||
            !Number.isSafeInteger(params.viewRevision) || params.viewRevision < 0) {peer.close(); return;}
        if (params.viewRevision <= (this.snapshots.get(params.spaceId)?.viewRevision ?? -1)) return;
        this.wanted.set(params.spaceId, Math.max(this.wanted.get(params.spaceId) || 0, params.viewRevision));
        // Every newer event triggers a full snapshot, so gaps need no replay log.
        void this.refresh(params.spaceId, peer).catch(() => peer.close());
      });
      peer.once('closed', () => {
        if (this.peer !== peer) return;
        this.peer = null; clearInterval(this.heartbeat);
        this.snapshots.clear(); this.reads.clear(); this.wanted.clear();
        this.emit('changed'); this.emit('status', 'disconnected'); this.reconnect();
      });
      await Promise.all(this.spaces.map(space => this.refresh(space.spaceId, peer)));
      if (this.peer !== peer || peer.closed || this.closed) throw failure('service_unavailable');
      this.delay = 250;
      this.heartbeat = setInterval(() => {
        void peer.request('service.ping', {}, 5000).then(value => {
          if (value.generation !== peer.generation || value.status !== 'ready') peer.close();
        }, () => peer.close());
      }, 15000); this.heartbeat.unref?.();
      this.emit('status', 'connected');
    } catch (error) {
      peer?.close(); this.reconnect(); throw error;
    }
  }
  reconnect() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null; void this.start().catch(() => {});
    }, this.delay);
    this.retry.unref?.(); this.delay = Math.min(5000, this.delay * 2);
  }
  refresh(spaceId, peer = this.peer) {
    if (!peer || peer !== this.peer || peer.closed || this.closed) return Promise.reject(failure('service_unavailable'));
    if (!this.spaces.some(space => space.spaceId === spaceId)) return Promise.reject(failure('space_not_bound'));
    if (this.reads.has(spaceId)) return this.reads.get(spaceId);
    const read = (async () => {
      do {
        const snapshot = unwrap(await peer.call('space.subscribe', {bindingId:peer.binding.bindingId, spaceId}, 12000));
        if (this.peer !== peer || this.closed || peer.closed) return;
        if (snapshot?.generation !== peer.generation || snapshot.schemaVersion !== 1 || snapshot.spaceId !== spaceId ||
            !Number.isSafeInteger(snapshot.viewRevision) || snapshot.viewRevision < 0 || !Array.isArray(snapshot.tasks))
          throw failure('protocol_incompatible');
        const previous = this.snapshots.get(spaceId);
        if (!previous || snapshot.viewRevision >= previous.viewRevision) {
          this.snapshots.set(spaceId, snapshot); this.emit('changed', spaceId);
        }
      } while ((this.wanted.get(spaceId) || 0) > this.snapshots.get(spaceId).viewRevision);
    })().finally(() => {if (this.reads.get(spaceId) === read) this.reads.delete(spaceId);});
    this.reads.set(spaceId, read); return read;
  }
  async call(spaceId, name, args = {}) {
    const peer = this.peer;
    if (!peer || peer.closed || this.closed) throw failure('service_unavailable');
    if (!this.spaces.some(space => space.spaceId === spaceId)) throw failure('space_not_bound');
    // Exactly one dispatch. Failure leaves requestId/arguments with the caller.
    return unwrap(await peer.call('task.call', {bindingId:peer.binding.bindingId, spaceId, name, arguments:args}, 12000));
  }
  close() {
    this.closed = true; clearTimeout(this.retry); clearInterval(this.heartbeat);
    this.connection.close(); this.peer = null;
    this.snapshots.clear(); this.reads.clear(); this.wanted.clear(); this.emit('changed');
  }
}
module.exports = {ServiceWindowClient};
