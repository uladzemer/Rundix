// Optional connection providers are installed extensions, not webview plug-ins.
// The selected owner is durable: a missing provider must never fall back to local sign-in.
const {randomUUID} = require('node:crypto');
const locale = require('../ui/i18n.js');
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OWNER = /^[a-z0-9-]+\.[a-z0-9-]+$/i;
class Connections {
  constructor({store, activateOwner}) {
    this.store = store;
    this.activateOwner = activateOwner;
    this.providers = new Map();
  }
  selection() {
    const file = this.store.file('connection', 'active');
    const fs = require('node:fs');
    if (!fs.existsSync(file)) return {id: 'local', revision: 'initial'};
    const value = this.store.read('connection', 'active');
    if (!value || !ID.test(value.id) || typeof value.revision !== 'string' ||
        (value.id !== 'local' && !OWNER.test(value.owner || '')))
      throw Error('Connection settings are unreadable. Choose the connection again.');
    return value;
  }
  register(owner, provider) {
    if (!OWNER.test(owner) || !provider || !ID.test(provider.id || '') || provider.id === 'local' ||
        typeof provider.label !== 'string' || !provider.label.trim() || provider.label.length > 100 ||
        typeof provider.authenticate !== 'function' || typeof provider.configure !== 'function' ||
        (provider.accountLabel !== undefined && (typeof provider.accountLabel !== 'string' || provider.accountLabel.length > 100)) ||
        (provider.requestMethods !== undefined && (!Array.isArray(provider.requestMethods) || provider.requestMethods.length > 8 ||
          provider.requestMethods.some(method => typeof method !== 'string' || method.length > 128) || typeof provider.handleRequest !== 'function')))
      throw Error('Invalid connection provider.');
    if (this.providers.has(provider.id)) throw Error('Connection provider already registered.');
    const entry = {owner, provider};
    this.providers.set(provider.id, entry);
    return {dispose: () => { if (this.providers.get(provider.id) === entry) this.providers.delete(provider.id); }};
  }
  choices() {
    return [{id: 'local', label: locale.t('Локальный Codex CLI')}, ...[...this.providers.values()].map(({provider}) => ({id: provider.id, label: provider.label}))];
  }
  async resolve() {
    const selected = this.selection();
    if (selected.id === 'local') return {...selected, provider: null};
    if (!this.providers.has(selected.id)) await this.activateOwner(selected.owner);
    const entry = this.providers.get(selected.id);
    if (!entry || entry.owner !== selected.owner) throw Error('The selected connection extension is unavailable. Enable or update it, or explicitly choose Local Codex CLI.');
    const result = {...selected, provider: entry.provider};
    this.assertCurrent(result);
    return result;
  }
  assertCurrent(connection) {
    const selected = this.selection();
    if (selected.id !== connection.id || selected.revision !== connection.revision ||
        (connection.provider && this.providers.get(connection.id)?.provider !== connection.provider))
      throw Error('The connection changed. Your draft is preserved; retry with the selected connection.');
  }
  select(id) {
    if (id !== 'local' && !this.providers.has(id)) throw Error('Connection provider is not registered.');
    const owner = this.providers.get(id)?.owner;
    return this.store.write('connection', 'active', {id, ...(owner ? {owner} : {}), revision: randomUUID()});
  }
  display() {
    let selected;
    try { selected = this.selection(); }
    catch { return {id:'unavailable',label:locale.t('Настройки подключения недоступны'),external:true,configurable:true}; }
    const provider = this.providers.get(selected.id)?.provider;
    return {id: selected.id, label: selected.id === 'local' ? locale.t('Локальный Codex CLI') : provider?.label || locale.t('Модуль подключения недоступен'), external: selected.id !== 'local', configurable: this.providers.size > 0 || selected.id !== 'local'};
  }
  projectAccount(account) {
    let selected;
    try { selected = this.selection(); }
    catch { return account ? {type:account.type} : null; }
    if (selected.id === 'local') return account;
    const provider = this.providers.get(selected.id)?.provider;
    // An external connection never exposes an account identifier by default.
    return account ? {type: account.type, ...(provider?.accountLabel ? {email: provider.accountLabel} : {})} : null;
  }
}
module.exports = {Connections};
