const assert = require('node:assert/strict');

module.exports = async function toggleResponse({ page }) {
  const saved = await page.evaluate(() => {
    window.togglePost = vscode.postMessage;
    window.toggleRequests = [];
    vscode.postMessage = message => {
      if (message.toggleRequestId) window.toggleRequests.push(message);
      else window.togglePost(message);
    };
    const saved = { prefs: { ...window.fixture.prefs }, key: window.fixture.key,
      controlMotion: window.fixture.controlMotion, error: window.fixture.error, models: window.fixture.models };
    window.fixture.prefs.fast = false;
    window.fixture.prefs.focus = false;
    window.fixture.controlMotion = 'on';
    window.update();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'open', action: 'access' } }));
    return saved;
  });
  const status = selector => page.$eval(selector, button => ({
    checked: button.getAttribute('aria-checked'), disabled: button.disabled,
    busy: button.getAttribute('aria-busy'),
    ariaDisabled: button.getAttribute('aria-disabled'),
  }));
  const reply = (index, ok, owner) => page.evaluate(({ index, ok, owner }) => {
    const request = window.toggleRequests[index];
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'toggleResult', requestId: request.toggleRequestId, key: owner || request.sessionKey, ok,
    } }));
  }, { index, ok, owner });
  try {
    const immediate = await page.$eval('.fast-row', button => {
      button.focus();
      button.click();
      return { checked: button.getAttribute('aria-checked'), disabled: button.disabled,
        busy: button.getAttribute('aria-busy'), confirmed: window.fixture.prefs.fast,
        focused: document.activeElement === button, opacity: getComputedStyle(button).opacity,
        ariaDisabled: button.getAttribute('aria-disabled') };
    });
    assert.deepEqual(immediate, { checked: 'true', disabled: false, busy: 'true', confirmed: false,
      focused: true, opacity: '1', ariaDisabled: 'true' });
    await page.evaluate(() => window.update()); // Unrelated old state must not interrupt the pending position.
    assert.equal((await status('.fast-row')).checked, 'true');
    await page.$eval('.fast-row', button => button.click());
    assert.equal(await page.evaluate(() => window.toggleRequests.length), 1);
    const movement = await page.$eval('.fast-row .switch-thumb', async thumb => {
      const samples = [];
      for (let frame = 0; frame < 18; frame++) {
        samples.push(new DOMMatrixReadOnly(getComputedStyle(thumb).transform).m41);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return samples.some(x => x > 0.5 && x < 11.5);
    });
    assert.ok(movement, 'Fast must move while the host has not replied');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'commands' } })));
    await page.type('.command-search', '/fast');
    assert.deepEqual(await status('.command-list [role=switch]'), { checked: 'true', disabled: false, busy: 'true', ariaDisabled: 'true' });
    await page.evaluate(() => {
      window.toggleMenu = document.querySelector('.menu');
      window.toggleButton = document.querySelector('.command-list [role=switch]');
      window.toggleThumb = window.toggleButton.querySelector('.switch-thumb');
      window.toggleSearch = document.querySelector('.command-search');
      window.toggleSearch.setSelectionRange(2, 4);
      window.toggleButton.focus();
    });
    await page.evaluate(() => { window.fixture.prefs.fast = true; window.update(); });
    assert.ok(await page.evaluate(() => window.toggleMenu === document.querySelector('.menu') &&
      window.toggleButton === document.querySelector('.command-list [role=switch]') &&
      window.toggleThumb === document.querySelector('.command-list .switch-thumb') &&
      window.toggleSearch === document.querySelector('.command-search') &&
      document.activeElement === window.toggleButton && window.toggleSearch.selectionStart === 2 &&
      window.toggleSearch.selectionEnd === 4), 'Host confirmation must retain the open menu, focus and controls');
    await reply(0, true);
    assert.deepEqual(await status('.command-list [role=switch]'), { checked: 'true', disabled: false, busy: null, ariaDisabled: 'false' });

    await page.$eval('.command-search', input => { input.value = '/focus'; input.oninput(); });
    await page.focus('.command-list [role=switch]');
    await page.keyboard.press('Space');
    assert.equal((await status('.command-list [role=switch]')).checked, 'true');
    await page.evaluate(() => { window.fixture.error = 'Synthetic setting rejection'; window.update(); });
    await reply(1, false);
    assert.deepEqual(await status('.command-list [role=switch]'), { checked: 'false', disabled: false, busy: null, ariaDisabled: 'false' });
    await page.click('.command-list [role=switch]');
    await reply(1, false); // A duplicate old reply cannot clear the next request.
    await reply(2, true, 'another-owner');
    assert.equal((await status('.command-list [role=switch]')).busy, 'true');

    await page.evaluate(() => { window.fixture.key = 'other-toggle-session'; window.update(); });
    await page.evaluate(key => { window.fixture.key = key; window.fixture.error = null; window.update(); }, saved.key);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'commands' } })));
    await page.type('.command-search', '/focus');
    await page.click('.command-list [role=switch]');
    await reply(2, false); // Late result from the abandoned session visit.
    assert.equal((await status('.command-list [role=switch]')).busy, 'true');
    await page.evaluate(() => { window.fixture.prefs.focus = true; window.update(); });
    await reply(3, true);
    assert.equal((await status('.command-list [role=switch]')).disabled, false);

    await page.evaluate(() => {
      const original = window.setTimeout;
      window.setTimeout = (callback, duration, ...args) => {
        if (duration === 30000) window.toggleTimeout = callback;
        return original(callback, duration, ...args);
      };
      try { document.querySelector('.command-list [role=switch]').click(); }
      finally { window.setTimeout = original; }
      window.toggleTimeout();
    });
    assert.deepEqual(await status('.command-list [role=switch]'), { checked: 'true', disabled: false, busy: null, ariaDisabled: 'false' });
    assert.ok(await page.evaluate(() => window.fixture.error === null &&
      document.querySelector('.alerts').textContent.includes('Не удалось подтвердить изменение настройки')));
    assert.equal(await page.evaluate(() => window.toggleRequests.length), 5, 'Timeout must not retry the mutation');

    // Reproduce a menu opened before the first session snapshot hydrates the UI.
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.fixture.error = null;
      state.key = undefined;
      state.models = [];
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'open', action: 'access' } }));
      window.update();
    });
    assert.equal(await page.$('.menu'), null, 'First hydration must discard bindings without a session owner');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'access' } })));
    await page.click('.fast-row');
    assert.equal((await status('.fast-row')).busy, 'true');
    await reply(5, false);
    assert.equal((await status('.fast-row')).disabled, false);

    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'commands' } })));
    const commandStable = await page.evaluate(() => {
      const menu = document.querySelector('.menu'), list = menu.querySelector('.command-list');
      const button = list.querySelector('[data-row-key="show-thinking"]');
      button.focus();
      const top = list.scrollTop;
      window.fixture.prefs.fast = !window.fixture.prefs.fast;
      window.update();
      return menu === document.querySelector('.menu') && document.activeElement === button && list.scrollTop === top;
    });
    assert.ok(commandStable, 'Full command list must preserve focus and scroll');

    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const base = window.fixture.models[0];
      window.fixture.models = [base, ...Array.from({ length: 30 }, (_, index) =>
        ({ ...base, model: 'stable-' + index, displayName: 'Stable model ' + index }))];
      window.update();
    });
    await page.click('.model-button');
    const modelStable = await page.evaluate(() => {
      const menu = document.querySelector('.model-menu'), list = menu.querySelector('.model-list');
      const button = list.children[15];
      button.focus();
      const top = list.scrollTop;
      window.fixture.prefs.fast = !window.fixture.prefs.fast;
      window.update();
      return menu === document.querySelector('.model-menu') && button === list.children[15] &&
        document.activeElement === button && list.scrollTop === top;
    });
    assert.ok(modelStable, 'Fast confirmation must retain model rows, focus and scroll');
  } finally {
    await page.evaluate(saved => {
      vscode.postMessage = window.togglePost;
      window.fixture.prefs = saved.prefs;
      window.fixture.key = saved.key;
      window.fixture.controlMotion = saved.controlMotion;
      window.fixture.error = saved.error;
      window.fixture.models = saved.models;
      window.update();
    }, saved);
    await page.keyboard.press('Escape');
  }
};
