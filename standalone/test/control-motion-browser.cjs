const assert = require('node:assert/strict');

async function assertSlide(page, selector) {
  const positions = await page.$eval(selector, async thumb => {
    const animation = thumb.getAnimations().find(item => item.transitionProperty === 'transform');
    if (!animation) return null;
    const duration = animation.effect.getTiming().duration;
    const keyframes = animation.effect.getKeyframes();
    const start = new DOMMatrixReadOnly(keyframes[0].transform).m41;
    const end = new DOMMatrixReadOnly(keyframes.at(-1).transform).m41;
    const x = () => new DOMMatrixReadOnly(getComputedStyle(thumb).transform).m41;
    const samples = [];
    const began = performance.now();
    // Observe elapsed browser frames; never seek or pause the transition.
    while (performance.now() - began < duration + 80) {
      samples.push(x());
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return { start, end, samples, final: x() };
  });
  assert.ok(positions, `${selector} must have an active movement transition`);
  assert.ok(positions.samples.filter(x => x > Math.min(positions.start, positions.end) + 0.5 &&
    x < Math.max(positions.start, positions.end) - 0.5).length >= 3,
  `${selector} must pass through an intermediate position: ${JSON.stringify(positions)}`);
  assert.ok(Math.abs(positions.final - positions.end) < 0.5, `${selector} must reach its target`);
}

module.exports = async function controlMotion({ page }) {
  const saved = await page.evaluate(() => ({
    prefs: { ...window.fixture.prefs }, effort: window.fixture.effort,
    cli: window.fixture.cli,
    controlMotion: window.fixture.controlMotion,
  }));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  try {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'access' } })));
    await page.focus('input[type=range]');
    await page.keyboard.press('Home');
    await assertSlide(page, '.reasoning-thumb');
    await page.keyboard.press('End');
    await assertSlide(page, '.reasoning-thumb');
    assert.ok(await page.evaluate(() => window.calls.some(call =>
      call.action === 'settings' && call.effort === 'medium')));
    const track = await page.$eval('input[type=range]', range => {
      const bounds = range.getBoundingClientRect();
      return { x: bounds.left + 6, y: bounds.top + bounds.height / 2 };
    });
    await page.mouse.click(track.x, track.y);
    await assertSlide(page, '.reasoning-thumb');

    // Fast stays mounted; command switches are recreated after host state arrives.
    await page.evaluate(() => {
      window.fixture.prefs.fast = true;
      window.update();
    });
    await assertSlide(page, '.fast-row .switch-thumb');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'commands' } })));
    await page.type('.command-search', '/focus');
    await page.click('.command-list [role=switch]');
    await assertSlide(page, '.command-list .switch-thumb');
    await page.click('.command-list [role=switch]');
    await assertSlide(page, '.command-list .switch-thumb');
    assert.equal(await page.$eval('.command-search', input => input.value), '/focus');

    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.fixture.cli = { autoUpdate: false };
      window.update();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'open', action: 'client' } }));
      const menu = document.querySelector('.menu'), thumb = menu.querySelector('.switch-thumb');
      const button = menu.querySelector('[role=switch]');
      button.focus();
      getComputedStyle(thumb).transform;
      window.fixture.cli.autoUpdate = true;
      window.update();
      window.clientStable = menu === document.querySelector('.menu') && thumb === menu.querySelector('.switch-thumb') &&
        document.activeElement === button;
    });
    assert.ok(await page.evaluate(() => window.clientStable), 'Client settings must retain the menu, thumb and focus');
    await assertSlide(page, '.switch-thumb');

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => { window.fixture.cli.autoUpdate = false; window.update(); });
    assert.equal(await page.$eval('.switch-thumb', thumb => thumb.getAnimations().length), 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'access' } })));
    await page.focus('input[type=range]');
    await page.keyboard.press('Home');
    assert.equal(await page.$eval('.reasoning-thumb', thumb => thumb.getAnimations().length), 0);
    assert.equal(await page.$eval('.reasoning-thumb', thumb =>
      new DOMMatrixReadOnly(getComputedStyle(thumb).transform).m41), 0);

    // Explicit opt-in must beat reduced motion for both mounted and rebuilt controls.
    await page.evaluate(() => { window.fixture.controlMotion = 'on'; window.update(); });
    await page.keyboard.press('End');
    await assertSlide(page, '.reasoning-thumb');
    await page.evaluate(() => { window.fixture.prefs.fast = false; window.update(); });
    await assertSlide(page, '.fast-row .switch-thumb');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'commands' } })));
    await page.type('.command-search', '/focus');
    await page.click('.command-list [role=switch]');
    await assertSlide(page, '.command-list .switch-thumb');

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await page.evaluate(() => { window.fixture.controlMotion = 'off'; window.update(); });
    await page.click('.command-list [role=switch]');
    assert.equal(await page.$eval('.command-list .switch-thumb', thumb => thumb.getAnimations().length), 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',
      { data: { type: 'open', action: 'access' } })));
    await page.focus('input[type=range]');
    await page.keyboard.press('Home');
    assert.equal(await page.$eval('.reasoning-thumb', thumb => thumb.getAnimations().length), 0);

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => { window.fixture.controlMotion = 'unknown'; window.update(); });
    await page.keyboard.press('End');
    assert.equal(await page.$eval('.reasoning-thumb', thumb => thumb.getAnimations().length), 0);
  } finally {
    await page.keyboard.press('Escape');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await page.evaluate(saved => {
      Object.assign(window.fixture, saved);
      window.fixture.cli = saved.cli;
      window.fixture.controlMotion = saved.controlMotion;
      window.update();
    }, saved);
  }
};
