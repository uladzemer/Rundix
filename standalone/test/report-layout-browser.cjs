const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function reportLayout({ page }) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.$eval('html', node => node.getAttribute('style'));
  const report = [
    'Готово. Изменения сохранены, проверки завершены.',
    '',
    '1. **Что было задано**',
    '',
    '   Сделать итоговый ответ компактным и удобным для чтения.',
    '',
    '2. **Что сделано**',
    '',
    '   - **Типографика:** спокойный размер текста и заметные названия разделов.',
    '   - **Списки:** сохранены вложенность и нумерация.',
    '     - Короткий подпункт.',
    '     - Длинный подпункт с `synthetic-example.js` переносится на узкой панели.',
    '',
    '3. **Что не удалось / ограничения**',
    '',
    '   - Проверка выполнена на синтетическом примере.',
    '',
    '4. **Что бы я ещё сделал**',
    '',
    '   - Оценить результат в обычном разговоре.',
    '',
    '## Validation details',
    '',
    'English text uses the same typography. **Checks passed.**',
  ].join('\n');
  const compactReport = [
    '- **Что было задано:** убрать повтор вопроса в квизе.',
    '- **Что я решил**: вопрос показан один раз. Изменён `question-panel.js`.',
    '- **Что бы я ещё сделал:** проверить результат после перезагрузки.',
  ].join('\n');
  try {
    const unchanged = await page.evaluate(text => {
      const view = new WorkbenchMarkdownView({ icon: () => document.createElement('span'), send: () => {} });
      const ordinary = view.render({ type: 'agentMessage', text: text.replace('Что было задано', 'Первый пункт') });
      const commentary = view.render({ type: 'agentMessage', phase: 'commentary', text });
      const partial = view.render({ type: 'agentMessage', text: text.split('\n').slice(0, 2).join('\n') });
      return [ordinary, commentary, partial].every(node => node.querySelector('ul') && !node.querySelector('.completion-report'));
    }, compactReport);
    assert.ok(unchanged, 'Ordinary lists, commentary and partial reports retain their Markdown structure');
    await page.evaluate(text => {
      window.typographyFixture = window.fixture;
      window.fixture = { ...window.fixture, items: [{ id: 'report-layout', type: 'agentMessage', text }],
        busy: false, error: null, requests: [], attachments: [], followUps: [],
        prefs: { ...window.fixture.prefs, focus: false } };
      window.update();
    }, report);
    for (const [name, width, background, foreground, muted, border] of [
      ['dark-wide', 1000, '#1e1e1e', '#cccccc', '#999999', '#383838'],
      ['light-narrow', 340, '#ffffff', '#333333', '#616161', '#cecece'],
    ]) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate(({ background, foreground, muted, border }) => {
        for (const [key, value] of Object.entries({ 'editor-background': background, foreground,
          descriptionForeground: muted, 'widget-border': border, 'editorWidget-background': background,
          'editorWidget-foreground': foreground, 'input-background': background, 'input-foreground': foreground,
          'textCodeBlock-background': background === '#ffffff' ? '#f2f2f2' : '#292929' }))
          document.documentElement.style.setProperty('--vscode-' + key, value);
      }, { background, foreground, muted, border });
      const layout = await page.$eval('[data-item-id="report-layout"] .message-content', node => ({
        sections: node.querySelectorAll(':scope > ol > li').length,
        nested: node.querySelectorAll('li ul').length,
        font: parseFloat(getComputedStyle(node).fontSize),
        heading: parseFloat(getComputedStyle(node.querySelector('h2')).fontSize),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.equal(layout.sections, 4);
      assert.ok(layout.nested >= 3);
      assert.ok(layout.heading >= layout.font && layout.heading <= layout.font * 1.25,
        'Report headings retain a restrained text scale');
      assert.equal(layout.overflow, false);
      await page.screenshot({ path: path.join(__dirname, '../.verification/report-' + name + '.png') });
      await page.evaluate(text => { window.fixture.items[0].text = text; window.update(); }, compactReport);
      const sections = await page.$eval('[data-item-id="report-layout"] .message-content', node => {
        const list = node.querySelector('ol.completion-report');
        if (!list) return null;
        return [...list.children].map(row => {
          const title = row.querySelector('.report-title');
          const text = title.nextSibling;
          const range = document.createRange();range.selectNode(text);
          return { title: title.textContent, separated: range.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 1 };
        });
      });
      assert.ok(sections && sections.length === 3 && sections.every(section => section.separated),
        'An existing three-line completion report must display numbered headings above their explanations');
      assert.equal(await page.evaluate(() => window.fixture.items[0].text), compactReport, 'Stored Markdown is unchanged');
      await page.screenshot({ path: path.join(__dirname, '../.verification/report-existing-' + name + '.png') });
      await page.evaluate(text => { window.fixture.items[0].text = text; window.update(); }, report);
    }
  } finally {
    await page.evaluate(() => { window.fixture = window.typographyFixture; delete window.typographyFixture; window.update(); });
    await page.$eval('html', (node, style) => {
      if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style);
    }, theme);
    await page.setViewport(viewport);
  }
};
