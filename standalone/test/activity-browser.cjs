const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function activityBrowser({ page }) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.$eval('html', node => node.getAttribute('style'));
  const patch = data => page.evaluate(data => { Object.assign(window.fixture, data); window.update(); }, data);
  try {
    await page.evaluate(() => {
      for (const [key, value] of Object.entries({ 'editor-background': '#1e1e1e', foreground: '#cccccc',
        descriptionForeground: '#999999', 'editorWidget-background': '#242424', 'input-background': '#242424',
        'input-foreground': '#cccccc', 'widget-border': '#383838', 'textBlockQuote-background': '#292929' }))
        document.documentElement.style.setProperty('--vscode-' + key, value);
      window.activityFixture = window.fixture;
      window.fixture = { ...window.fixture, busy: true, error: null, requests: [], attachments: [], followUps: [],
        activityMotion: 'on', turnId: 'live-footer', turnStartedAt: Date.now(),
        prefs: { ...window.fixture.prefs, focus: false },
        items: [{ id: 'live-user', type: 'userMessage', text: 'Проверь изменения и объясни результат.' },
          { id: 'live-comment', type: 'agentMessage', phase: 'commentary', text: 'Проверяю изменения. Затем соберу итог.' },
          { id: 'live-tool', type: 'commandExecution', turnId: 'live-footer', status: 'inProgress', command: 'synthetic-check', text: 'Synthetic fixture' }] };
      window.update();
    });
    assert.ok(await page.$eval('.activity-status', node => node.parentElement.classList.contains('messages') && node === node.parentElement.lastElementChild),
      'The live indicator follows the conversation, not the composer');
    const before = await page.$eval('.activity-spinner', node => getComputedStyle(node).transform);
    assert.ok(await page.$eval('.activity-spinner', node => parseFloat(getComputedStyle(node).animationDuration) >= 1.5 && parseFloat(getComputedStyle(node).animationDuration) <= 2),
      'The activity mark uses a calmer cycle of about two seconds');
    const glyphBefore = await page.$eval('.activity-glyph', node => getComputedStyle(node).transform);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.notEqual(await page.$eval('.activity-spinner', node => getComputedStyle(node).transform), before, 'The mark moves between real animation frames');
    assert.notEqual(await page.$eval('.activity-glyph', node => getComputedStyle(node).transform), glyphBefore, 'The central glyph rocks between frames');
    const change = await page.evaluate(() => {
      const label = document.querySelector('.activity-label'), announcement = document.querySelector('.activity-announcement');
      const prior = label.textContent, spoken = announcement.textContent, footer = label.parentElement;
      const original = Date.now;
      let first, second, held;
      try {
        Date.now = () => activityView.phaseStarted + 1100; updateActivity();held = label.textContent === prior;
        Date.now = () => activityView.phaseStarted + 3100; updateActivity();first = label.textContent;
        Date.now = () => activityView.phaseStarted + 6100; updateActivity();second = label.textContent;
      }
      finally { Date.now = original; }
      return { changed: held && first !== prior && second !== first, same: footer === document.querySelector('.activity-status'),
        quiet: announcement.textContent === spoken, time: document.querySelector('.activity-time').textContent };
    });
    assert.ok(change.changed && change.same && change.quiet, 'Words rotate without replacing the footer or repeatedly announcing decorative phrases');
    assert.ok(parseInt(change.time, 10) >= 2);
    await page.screenshot({ path: path.join(__dirname, '../.verification/activity-footer-dark.png') });

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.equal(await page.$eval('.activity-spinner', node => getComputedStyle(node).animationName), 'work-orbit', 'Explicit on works with reduced motion');
    await patch({ activityMotion: 'auto' });
    assert.equal(await page.$eval('.activity-spinner', node => getComputedStyle(node).animationName), 'none');
    assert.equal(await page.$eval('.activity-glyph', node => getComputedStyle(node).animationName), 'none');
    assert.ok(await page.evaluate(() => {
      const before = document.querySelector('.activity-label').textContent, original = Date.now, now = original();
      try { Date.now = () => now + 9000; updateActivity(); return before === document.querySelector('.activity-label').textContent; }
      finally { Date.now = original; }
    }), 'Reduced motion also stops decorative word rotation in auto mode');
    await patch({ activityMotion: 'on', requests: [{ id: 'activity-approval', method: 'item/commandExecution/requestApproval', params: { command: 'Synthetic confirmation' } }] });
    assert.equal(await page.$eval('.activity-status', node => node.dataset.phase), 'waiting');
    assert.equal(await page.$eval('.activity-spinner', node => getComputedStyle(node).animationName), 'none', 'Waiting for the user has a still indicator');
    assert.equal(await page.$eval('.activity-glyph', node => getComputedStyle(node).animationName), 'none');
    await patch({ requests: [], activityMotion: 'off' });
    assert.equal(await page.$eval('.activity-spinner', node => getComputedStyle(node).animationName), 'none');
    assert.equal(await page.$eval('.activity-glyph', node => getComputedStyle(node).animationName), 'none');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await patch({ activityMotion: 'on' });
    await patch({ items: [{ id: 'unknown-activity', type: 'constructor', turnId: 'live-footer', status: 'inProgress' }] });
    assert.equal(await page.$eval('.activity-status', node => node.dataset.phase), 'working', 'An unknown item type falls back to generic activity');
    await patch({ turnId: null, items: [{ id: 'previous-answer', type: 'agentMessage', phase: 'final', text: 'Earlier final answer' }] });
    assert.equal(await page.$eval('.activity-status', node => node.dataset.phase), 'working', 'Starting a turn cannot advertise the previous final answer');
    await patch({ turnId: 'live-footer', items: [{ id: 'old-user', type: 'userMessage', text: 'Earlier request' }, { id: 'old-answer', type: 'agentMessage', phase: 'final', text: 'Earlier answer' }] });
    assert.equal(await page.$eval('.activity-status', node => node.dataset.phase), 'working', 'A new turn ID cannot attribute unowned history to the current turn');
    await patch({ turnId: 'live-footer', items: [{ id: 'previous-tool', type: 'commandExecution', status: 'inProgress' }, { id: 'next-user', type: 'userMessage', text: 'Next task' }] });
    assert.equal(await page.$eval('.activity-status', node => node.dataset.phase), 'working', 'An unowned old tool before the latest request is not current work');
    await patch({ items: [{ id: 'live-user', type: 'userMessage', text: 'Проверь изменения и объясни результат.' },
      { id: 'live-comment', type: 'agentMessage', phase: 'commentary', text: 'Проверяю изменения. Затем соберу итог.' },
      { id: 'live-reason', type: 'reasoning', turnId: 'live-footer', status: 'inProgress', text: 'Synthetic reasoning' }] });

    await page.setViewport({ width: 340, height: 800 });
    await page.evaluate(() => {
      for (const [key, value] of Object.entries({ 'editor-background': '#ffffff', foreground: '#333333',
        descriptionForeground: '#616161', 'editorWidget-background': '#f3f3f3', 'widget-border': '#cecece', 'textBlockQuote-background': '#f2f2f2' }))
        document.documentElement.style.setProperty('--vscode-' + key, value);
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(__dirname, '../.verification/activity-footer-light-narrow.png') });
    await page.setViewport({ width: 800, height: 850 });
    await page.evaluate(() => { window.activityLanguage = WorkbenchI18n.language; WorkbenchI18n.setLanguage('en'); activityView.tick(); });
    assert.ok(await page.$eval('.activity-label', node => !/[А-Яа-я]/.test(node.textContent)), 'Activity labels remain localized in English');
    await page.screenshot({ path: path.join(__dirname, '../.verification/activity-footer-light-wide-en.png') });
    await page.evaluate(() => { WorkbenchI18n.setLanguage(window.activityLanguage); delete window.activityLanguage; activityView.tick(); });
    await page.evaluate(() => {
      window.fixture.items = Array.from({ length: 50 }, (_, index) => ({ id: 'activity-history-' + index, type: 'agentMessage', text: 'Earlier synthetic message ' + index }));
      window.fixture.items.push({ id: 'activity-work', type: 'reasoning', turnId: 'live-footer', status: 'inProgress', text: 'Considering details' });window.update();
      const messages = document.querySelector('.messages');messages.scrollTop = 0;
      window.activityHistoryNode = messages.querySelector('.assistant');
      window.activityScroll = messages.scrollTop;
      activityView.tick();
    });
    assert.ok(await page.evaluate(() => window.activityHistoryNode === document.querySelector('.messages .assistant') && document.querySelector('.messages').scrollTop === window.activityScroll),
      'Activity updates preserve earlier message DOM and scroll');
    await patch({ key: 'activity-other-session', turnId: 'other-turn', turnStartedAt: Date.now() });
    assert.equal(await page.$eval('.activity-time', node => node.textContent), '0 с', 'Elapsed time belongs to the active session and turn');
    await patch({ busy: false });
    assert.equal(await page.$('.messages > .activity-status'), null);
    assert.ok(await page.evaluate(() => activityView.timer === null), 'Idle clears the activity timer');
    const disposed = await page.evaluate(() => {
      const probe = new WorkbenchActivity({ icon: () => document.createElement('span') });
      probe.update({ ...window.fixture, busy: true });probe.dispose();probe.update({ ...window.fixture, busy: true });
      return probe.timer === null && probe.element.hidden;
    });
    assert.ok(disposed, 'A closed owner cannot restart its timer');
  } finally {
    await page.evaluate(() => { window.fixture = window.activityFixture; delete window.activityFixture; window.update(); });
    await page.$eval('html', (node, style) => { if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style); }, theme);
    await page.setViewport(viewport);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  }
};
