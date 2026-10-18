const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function messageCard({ page }) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const originalStyle = await page.$eval('html', node => node.getAttribute('style'));
  try {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.cardFixture = window.fixture;
      window.fixture = { ...window.fixture, busy: false, error: null, requests: [], attachments: [], followUps: [],
        prefs: { ...window.fixture.prefs, focus: false }, items: [
          { id: 'compact-card', type: 'userMessage', text: 'Короткое сообщение', timestamp: 1700000000000 },
          { id: 'compact-answer', type: 'agentMessage', text: 'Ответ идёт по общей левой оси, без дополнительной рамки.' },
        ] };
      window.update();
    });
    for (const [name, background, foreground, width] of [['dark', '#181818', '#cccccc', 900], ['light-narrow', '#f7f7f8', '#333333', 340]]) {
      await page.setViewport({ width, height: 750 });
      await page.evaluate(({ background, foreground }) => {
        document.documentElement.style.setProperty('--vscode-sideBar-background', background);
        document.documentElement.style.setProperty('--vscode-editor-background', '#abcdef');
        document.documentElement.style.setProperty('--vscode-foreground', foreground);
        const dark = background === '#181818';
        for (const [key, value] of Object.entries({ 'input-background': dark ? '#222222' : '#ffffff',
          'input-foreground': foreground, 'editorWidget-background': dark ? '#242424' : '#f3f3f3',
          'input-border': dark ? '#383838' : '#cecece', 'widget-border': dark ? '#383838' : '#cecece',
          descriptionForeground: dark ? '#999999' : '#616161' }))
          document.documentElement.style.setProperty('--vscode-' + key, value);
        document.activeElement?.blur();
      }, { background, foreground });
      await page.mouse.move(0, 0);
      const geometry = await page.$eval('[data-item-id="compact-card"]', article => {
        const card = article.querySelector('.user-message-card'), content = card.querySelector('pre'), actions = card.querySelector('.message-actions');
        const c = card.getBoundingClientRect(), t = content.getBoundingClientRect(), a = actions.getBoundingClientRect();
        return { height: c.height, border: getComputedStyle(card).borderTopWidth, style: getComputedStyle(card).borderTopStyle,
          textRight: t.right, actionsLeft: a.left, inside: a.bottom <= c.bottom && a.right <= c.right,
          opacity: getComputedStyle(actions).opacity, timestampOutside: !card.querySelector('time') };
      });
      assert.ok(geometry.height <= 34, 'A one-line request has no extra copy-action row');
      assert.equal(geometry.border, '1px');assert.equal(geometry.style, 'solid');
      assert.ok(geometry.textRight <= geometry.actionsLeft && geometry.inside, 'Copy has reserved space inside the single border');
      assert.equal(geometry.opacity, '0');assert.ok(geometry.timestampOutside);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
        name === 'dark' ? 'rgb(24, 24, 24)' : 'rgb(247, 247, 248)');
      await page.hover('[data-item-id="compact-card"]');
      assert.equal(await page.$eval('[data-item-id="compact-card"] .message-actions', node => getComputedStyle(node).opacity), '1');
      await page.screenshot({ path: path.join(__dirname, `../.verification/message-card-${name}.png`) });
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-contrastBorder', '#ffff00'));
    assert.equal(await page.$eval('.user-message-card', node => getComputedStyle(node).borderTopColor), 'rgb(255, 255, 0)');
    await page.focus('.user-message-card button');
    await page.keyboard.press('Enter');
    assert.ok(await page.evaluate(() => window.calls.some(call => call.action === 'copyItem' && call.itemId === 'compact-card')));
  } finally {
    await page.evaluate(() => { window.fixture = window.cardFixture;delete window.cardFixture;window.update(); });
    await page.$eval('html', (node, style) => { if (style === null) node.removeAttribute('style');else node.setAttribute('style', style); }, originalStyle);
    await page.setViewport(viewport);
  }
};
