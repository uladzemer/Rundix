const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function transcriptScroll({ page }) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const settle = () => page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  const gap = () => page.$eval('.messages', node => node.scrollHeight - node.clientHeight - node.scrollTop);
  try {
    await page.keyboard.press('Escape');await page.setViewport({ width: 700, height: 750 });
    await page.evaluate(() => {
      window.scrollFixture = window.fixture;
      window.fixture = { ...window.fixture, busy: true, turnId: 'scroll-turn', turnStartedAt: Date.now(),
        requests: [], attachments: [], followUps: [], error: null, prefs: { ...window.fixture.prefs, focus: true },
        items: Array.from({ length: 25 }, (_, index) => ({ id: 'scroll-history-' + index, type: 'agentMessage', text: 'Earlier message\n\n' + 'Details. '.repeat(20) })) };
      window.fixture.items.push({ id: 'scroll-last', type: 'agentMessage', turnId: 'scroll-turn', phase: 'final', text: 'Initial answer.' });
      window.update();document.querySelector('.messages').scrollTop = document.querySelector('.messages').scrollHeight;
    });
    await settle();assert.ok(await gap() < 2);
    await page.evaluate(() => {
      window.fixture.items.at(-1).text += '\n\n' + 'A streamed answer paragraph. '.repeat(80);
      window.fixture.busy = false;window.update();
    });
    await settle();assert.ok(await gap() < 2, 'Final text and removal of activity keep the bottom visible');
    await page.setViewport({ width: 340, height: 520 });await settle();
    assert.ok(await gap() < 2, 'Resizing and wrapping the final answer retain bottom following');
    await page.evaluate(() => {
      window.fixture.followUps = Array.from({ length: 8 }, (_, index) => ({ id: 'scroll-queue-' + index, text: 'Queued task ' + index }));window.update();
    });
    await settle();assert.ok(await gap() < 2, 'Composer growth must not leave the last lines below the viewport');
    await page.screenshot({ path: path.join(__dirname, '../.verification/transcript-bottom.png') });
    await page.$eval('[data-item-id="scroll-last"]', node => { node.style.paddingBottom = '180px'; });
    await settle();assert.ok(await gap() < 2, 'Late message layout growth also retains the bottom');
    await page.$eval('.messages', node => { node.scrollTop = 0; });await settle();
    const top = await page.$eval('.messages', node => node.scrollTop);
    await page.evaluate(() => { window.fixture.items.at(-1).text += '\n\n' + 'New streamed text. '.repeat(60);window.update(); });
    await settle();assert.equal(await page.$eval('.messages', node => node.scrollTop), top, 'Reading earlier messages is preserved');
    await page.setViewport({ width: 700, height: 750 });await settle();
    assert.equal(await page.$eval('.messages', node => node.scrollTop), top, 'Resize cannot drag a reader to the bottom');
    await page.click('.jump-latest');await settle();assert.ok(await gap() < 2);
    await page.evaluate(() => { window.fixture.items.at(-1).text += '\n\n' + 'After explicit return. '.repeat(50);window.update(); });
    await settle();assert.ok(await gap() < 2, 'Jump to latest restores following');
    await page.evaluate(() => { pendingReveal = 'scroll-history-1';window.update(); });
    await settle();assert.ok(await gap() > 200, 'Revealing an earlier message cancels pending bottom following');
    await page.click('.jump-latest');await settle();
    await page.evaluate(() => {
      window.scrollPrimaryFixture = window.fixture;
      window.fixture = { ...window.fixture, key: 'scroll-other-session' };window.update();
    });
    await settle();await page.$eval('.messages', node => { node.scrollTop = 100; });await settle();
    await page.evaluate(() => { window.scrollOtherFixture = window.fixture;window.fixture = window.scrollPrimaryFixture;window.update(); });
    await settle();assert.ok(await gap() < 2, 'Returning to a session at its bottom restores following');
    await page.evaluate(() => { window.fixture = window.scrollOtherFixture;window.update(); });
    await settle();assert.equal(await page.$eval('.messages', node => node.scrollTop), 100, 'The other session retains its reading position');
    await page.evaluate(() => { delete window.scrollPrimaryFixture;delete window.scrollOtherFixture; });
    assert.ok(await page.evaluate(() => {
      const probe = new WorkbenchTranscriptScroll(document.createElement('div'));
      probe.capture('synthetic');probe.schedule();probe.dispose();return probe.frame === null && probe.disposed;
    }), 'Closing the owner cancels deferred scrolling');
  } finally {
    await page.evaluate(() => { window.fixture = window.scrollFixture;delete window.scrollFixture;window.update(); });
    await page.setViewport(viewport);
  }
};
