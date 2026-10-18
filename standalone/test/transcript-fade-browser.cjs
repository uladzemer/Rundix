const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async ({ page, suffix = '' }) => {
  const viewport = page.viewport();
  const theme = await page.$eval('html', node => node.getAttribute('style'));
  const bodyClass = await page.$eval('body', node => node.getAttribute('class'));
  const settle = () => page.evaluate(async () => {
    for (let index = 0; index < 4; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  await page.evaluate(light => {
    window.beforeTranscriptFade = window.fixture;
    for (const [key, value] of Object.entries({ 'editor-background': light ? '#fff' : '#1e1e1e',
      foreground: light ? '#333' : '#ccc', 'editorWidget-background': light ? '#f3f3f3' : '#242424',
      'input-background': light ? '#fff' : '#242424', 'input-foreground': light ? '#333' : '#ccc',
      descriptionForeground: light ? '#616161' : '#999', 'widget-border': light ? '#cecece' : '#383838' }))
      document.documentElement.style.setProperty('--vscode-' + key, value);
    window.fixture = { ...window.fixture, key: 'transcript-fade-fixture', turnId:null, busy: false, queuePaused: false,
      requests: [], error: null, attachments: [], followUps: [], items: [{id:'fade-changes',type:'fileChange',status:'completed',
        changes:[{path:'D:/fixture-project/example.js',diff:'@@ -1 +1 @@\n-old\n+new\n'}]}, ...Array.from({length:18}, (_, index) => ({
        id: 'fade-message-' + index, type: 'agentMessage', text: ('Paragraph ' + index + ': content scrolls below the floating input panel.\n').repeat(5)
      }))] };
    window.update();
  }, suffix.includes('light'));
  try {
    for (const width of [1000, 340]) {
      await page.setViewport({width,height:750});await settle();
      await page.evaluate(() => transcriptScroll.toBottom());await settle();
      const geometry = await page.evaluate(() => {
        const messages = document.querySelector('.messages'), dock = document.querySelector('.composer-dock');
        return { bottom: messages.getBoundingClientRect().bottom, viewport: innerHeight,
          lastBottom: messages.lastElementChild.getBoundingClientRect().bottom, panelTop: dock.getBoundingClientRect().top,
          mask: getComputedStyle(messages).maskImage };
      });
      assert.ok(Math.abs(geometry.bottom - geometry.viewport) <= 1, 'The transcript and fade reach the viewport bottom behind the entire panel');
      assert.notEqual(geometry.mask, 'none');
      assert.ok(geometry.lastBottom <= geometry.panelTop - 8, 'Last lines remain fully above the fading region at the end');
      assert.ok(await page.$eval('.composer', node => {
        const box = node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + 20));
      }), 'The input panel receives pointer input above the transcript');
      await page.$eval('.messages', node => { node.scrollTop = (node.scrollHeight - node.clientHeight) / 2; });await settle();
      assert.ok(await page.$eval('.review-bar',node=>!node.hidden),'Changed files from the fixture must be visible');
      const clip = await page.$eval('.review-bar',node=>{
        const box=node.getBoundingClientRect();return {x:Math.ceil(box.left+16),y:Math.ceil(box.top+3),width:Math.floor(box.width-32),height:Math.floor(box.height-6)};
      });
      // Compare the surface alone: text antialiasing can change when Chromium
      // recomposites the masked transcript even though the panel is opaque.
      await page.$$eval('.review-bar > *',nodes=>nodes.forEach(node=>{node.style.visibility='hidden';}));
      const visible = await page.screenshot({clip});
      await page.$eval('.messages',node=>{node.style.visibility='hidden';});
      const withoutTranscript = await page.screenshot({clip});
      await page.$eval('.review-bar',node=>{node.style.visibility='hidden';});
      const withoutBoth = await page.screenshot({clip});
      await page.$eval('.messages',node=>{node.style.removeProperty('visibility');});
      const behindPanel = await page.screenshot({clip});
      await page.$eval('.review-bar',node=>{node.style.removeProperty('visibility');});
      await page.$$eval('.review-bar > *',nodes=>nodes.forEach(node=>{node.style.removeProperty('visibility');}));
      assert.ok(!behindPanel.equals(withoutBoth),'The scrolled transcript actually passes beneath the changed-files panel');
      assert.ok(visible.equals(withoutTranscript),'Transcript text must not show through the changed-files panel');
      assert.ok(await page.$eval('.jump-latest', node => !node.hidden && node.getBoundingClientRect().bottom < document.querySelector('.composer-dock').getBoundingClientRect().top));
      await page.screenshot({path:path.join(__dirname,'../.verification/transcript-fade-'+width+suffix+'.png')});
      await page.click('.jump-latest');await settle();
    }
    await page.evaluate(() => { document.body.classList.add('vscode-high-contrast'); });await settle();
    assert.equal(await page.$eval('.messages', node => getComputedStyle(node).maskImage), 'none');
    await page.evaluate(() => { document.body.classList.remove('vscode-high-contrast');window.fixture.items=[];window.update(); });await settle();
    assert.equal(await page.$eval('.messages', node => getComputedStyle(node).maskImage), 'none', 'The welcome screen is not faded');
  } finally {
    await page.evaluate(() => { window.fixture=window.beforeTranscriptFade;delete window.beforeTranscriptFade;window.update(); });
    await page.$eval('html',(node,style)=>{if(style===null)node.removeAttribute('style');else node.setAttribute('style',style);},theme);
    await page.$eval('body',(node,value)=>{if(value===null)node.removeAttribute('class');else node.setAttribute('class',value);},bodyClass);
    await page.setViewport(viewport);
  }
};
