const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async ({ page, suffix = '' }) => {
  const viewport = page.viewport();
  const theme = await page.$eval('html', node => node.getAttribute('style'));
  await page.evaluate(light => {
    for (const [key, value] of Object.entries({ 'editor-background': light ? '#fff' : '#1e1e1e',
      foreground: light ? '#333' : '#ccc', 'editorWidget-background': light ? '#f3f3f3' : '#242424',
      'input-background': light ? '#fff' : '#242424', 'input-foreground': light ? '#333' : '#ccc',
      descriptionForeground: light ? '#616161' : '#999', 'widget-border': light ? '#cecece' : '#383838' }))
      document.documentElement.style.setProperty('--vscode-' + key, value);
  }, suffix.includes('light'));
  await page.evaluate(() => {
    window.beforeReviewDismiss = window.fixture;
    window.reviewSetState = vscode.setState;
    vscode.setState = value => { window.reviewSaved = value;window.reviewSetState(value); };
    window.fixture = { ...window.fixture, key: 'dismiss-review-fixture', busy: false, turnId: 'review-turn',
      followUps: [], requests: [], items: [
        { id: 'review-task', type: 'userMessage', turnId: 'review-turn', text: 'Synthetic task' },
        { id: 'review-edit', type: 'fileChange', turnId: 'review-turn', status: 'completed',
          changes: [{ path: 'synthetic.js', diff: '@@ -0,0 +1 @@\n+synthetic\n' }] }
      ] };
    window.update();
  });
  try {
    assert.equal(await page.$eval('.review-close', node => node.getAttribute('aria-label')), suffix ? 'Hide changed files panel' : 'Скрыть панель изменённых файлов');
    await page.setViewport({ width: 340, height: 750 });
    assert.ok(await page.$eval('.review-bar', node => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(__dirname, '../.verification/review-close-narrow' + suffix + '.png') });
    await page.focus('.review-close');await page.keyboard.press('Enter');
    assert.equal(await page.$eval('.review-bar', node => node.hidden), true);
    assert.equal(await page.$('.menu'), null, 'Closing the summary must not open changes');
    assert.ok(await page.evaluate(() => window.reviewSaved.reviewDismissals.includes(JSON.stringify(['dismiss-review-fixture', 'review-turn']))));
    await page.evaluate(() => window.update());
    assert.equal(await page.$eval('.review-bar', node => node.hidden), true, 'State updates keep this task dismissed');
    await page.evaluate(() => { window.fixture.key = 'other-review-session';window.update(); });
    assert.equal(await page.$eval('.review-bar', node => node.hidden), false);
    await page.evaluate(() => { window.fixture.key = 'dismiss-review-fixture';window.update(); });
    assert.equal(await page.$eval('.review-bar', node => node.hidden), true);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'open', action: 'changes' } })));
    assert.ok(await page.$('.menu .changed-file'), 'File changes remain accessible after hiding the summary');
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.fixture.turnId = 'next-review-turn';
      window.fixture.items.push({ ...window.fixture.items[1], id: 'next-review-edit', turnId: 'next-review-turn' });
      window.update();
    });
    assert.equal(await page.$eval('.review-bar', node => node.hidden), false, 'A new task can show its own changes');
    await page.setViewport({ width: 800, height: 850 });
    await page.screenshot({ path: path.join(__dirname, '../.verification/review-close-wide' + suffix + '.png') });
    await page.click('.review-open');assert.ok(await page.$('.menu .changed-file'));await page.keyboard.press('Escape');
  } finally {
    await page.evaluate(() => {
      vscode.setState = window.reviewSetState;delete window.reviewSetState;delete window.reviewSaved;
      window.fixture = window.beforeReviewDismiss;delete window.beforeReviewDismiss;window.update();
    });
    await page.setViewport(viewport);
    await page.$eval('html', (node, style) => { if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style); }, theme);
  }
};
