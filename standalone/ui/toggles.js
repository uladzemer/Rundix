// Pending switch positions belong to one webview session, never to saved settings.
class WorkbenchToggles {
  constructor({ owner, onTimeout }) {
    this.owner = owner;
    this.onTimeout = onTimeout;
    this.bindings = new WeakMap();
    this.pending = new Map();
    this.requests = new Map();
  }

  bind(button, { key, checked, disabled, action }) {
    this.bindings.set(button, { key, checked, disabled, action, owner: this.owner() });
    button.onclick = () => this.start(button);
    this.paint(button);
  }

  update(button, { checked, disabled }) {
    const binding = this.bindings.get(button);
    if (!binding) return;
    binding.checked = checked;
    binding.disabled = disabled;
    this.paint(button);
  }

  paint(button) {
    const binding = this.bindings.get(button);
    if (!binding) return;
    const pending = this.pending.get(binding.key);
    const waiting = !!pending && pending.owner === binding.owner;
    const checked = waiting ? pending.checked : binding.checked;
    // Keep focus and opacity while waiting; start() still rejects duplicate activation.
    button.disabled = !!binding.disabled;
    button.setAttribute('aria-disabled', String(!!binding.disabled || waiting));
    button.setAttribute('aria-checked', String(!!checked));
    button.querySelector('.switch').classList.toggle('on', !!checked);
    if (waiting) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  paintAll() {
    for (const button of document.querySelectorAll('[role="switch"]')) this.paint(button);
  }

  start(button) {
    const binding = this.bindings.get(button);
    if (!binding || button.disabled || binding.owner !== this.owner() || this.pending.has(binding.key)) return;
    // Also retain the starting position when a freshly opened menu is activated immediately.
    button.querySelector('.switch-thumb').getBoundingClientRect();
    const requestId = Array.from(crypto.getRandomValues(new Uint32Array(4)),
      value => value.toString(16).padStart(8, '0')).join('');
    const pending = { key: binding.key, owner: binding.owner, checked: !binding.checked, requestId };
    this.pending.set(binding.key, pending);
    this.requests.set(requestId, pending);
    pending.timer = setTimeout(() => {
      if (!this.finish({ requestId, key: pending.owner })) return;
      if (this.owner() === pending.owner) this.onTimeout();
    }, 30000);
    this.paintAll();
    try {
      binding.action(requestId);
    } catch (error) {
      this.finish({ requestId, key: pending.owner });
      throw error;
    }
  }

  finish({ requestId, key }) {
    const pending = this.requests.get(requestId);
    if (!pending || pending.owner !== key) return false;
    clearTimeout(pending.timer);
    this.requests.delete(requestId);
    this.pending.delete(pending.key);
    this.paintAll();
    return true;
  }

  reset() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.requests.clear();
    this.paintAll();
  }
}
