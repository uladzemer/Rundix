const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function contextDisplay({ page }) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const style = await page.$eval('html', node => node.getAttribute('style'));
  try {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.contextDisplayFixture = window.fixture;
      window.fixture = { ...window.fixture, contextDisplay: 'percent', busy: false, compacting: false,
        tokenUsage: { modelContextWindow: 100000, last: { totalTokens: 56000 } },
        usageModel: window.fixture.model, usageStale: false, requests: [], error: null };
      window.update();
    });
    assert.ok(await page.evaluate(() => {
      const ring = document.querySelector('.context-ring').getBoundingClientRect(), button = document.querySelector('.submit-button').getBoundingClientRect();
      return ring.width === button.width && ring.height === button.height;
    }), 'Percentage ring matches the adjacent button size');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'open', action: 'commands' } })));
    await page.$eval('.command-search', node => { node.value = '';node.dispatchEvent(new Event('input')); });
    await page.$$eval('.menu-row', nodes => nodes.find(node => node.textContent.includes('Проценты в кольце контекста')).click());
    await page.waitForFunction(() => document.querySelector('.context-button').classList.contains('ring-only'));
    assert.ok(await page.evaluate(() => window.calls.some(call => call.action === 'contextDisplay' && call.value === 'ring')));
    await page.keyboard.press('Escape');
    for (const [name, width, background, foreground] of [['dark', 700, '#181818', '#cccccc'], ['light', 340, '#ffffff', '#333333']]) {
      await page.setViewport({ width, height: 750 });
      await page.evaluate(({ background, foreground }) => {
        for (const [key, value] of Object.entries({ 'sideBar-background': background, 'editor-background': background,
          foreground, 'input-background': background, 'input-foreground': foreground }))
          document.documentElement.style.setProperty('--vscode-' + key, value);
      }, { background, foreground });
      assert.equal(await page.$eval('.context-ring', node => node.getBoundingClientRect().width), 20);
      assert.equal(await page.$eval('.context-button', node => node.getBoundingClientRect().width), 28, 'Compact visual retains the button hit target');
      assert.equal(await page.$eval('.context-value', node => getComputedStyle(node).display), 'none');
      assert.ok(await page.$eval('.context-button', node => node.title.includes('56%') && node.getAttribute('aria-label') === node.title));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(__dirname, `../.verification/context-ring-${name}.png`) });
    }
    await page.evaluate(() => { window.fixture.contextDisplay = 'percent';window.fixture.tokenUsage.last.totalTokens = 100000;window.update(); });
    assert.equal(await page.$eval('.context-ring', node => node.getBoundingClientRect().width), 28);
    assert.equal(await page.$eval('.context-value', node => node.textContent), '100%');
    assert.ok(await page.$eval('.context-value', node => {
      const range = document.createRange();range.selectNodeContents(node);const bounds = range.getBoundingClientRect();
      return Math.hypot(bounds.width / 2, bounds.height / 2) < 11;
    }), '100% fits inside the smaller ring');
    await page.focus('.context-button');await page.keyboard.press('Enter');
    assert.ok(await page.evaluate(() => window.calls.some(call => call.action === 'compact')));
  } finally {
    await page.evaluate(() => { window.fixture = window.contextDisplayFixture;delete window.contextDisplayFixture;window.update(); });
    await page.$eval('html', (node, value) => { if (value === null) node.removeAttribute('style');else node.setAttribute('style', value); }, style);
    await page.setViewport(viewport);await page.keyboard.press('Escape');
  }
};
