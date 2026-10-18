const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async ({ page, suffix = '' }) => {
  const viewport = page.viewport();
  const theme = await page.$eval('html', node => node.getAttribute('style'));
  await page.evaluate(light => {
    for (const [key, value] of Object.entries({ 'editor-background': light ? '#fff' : '#1e1e1e',
      foreground: light ? '#333' : '#ccc', 'editorWidget-background': light ? '#f3f3f3' : '#242424',
      'input-background': light ? '#fff' : '#242424', 'input-foreground': light ? '#333' : '#ccc',
      'descriptionForeground': light ? '#616161' : '#999', 'widget-border': light ? '#cecece' : '#383838' }))
      document.documentElement.style.setProperty('--vscode-' + key, value);
  }, suffix.includes('light'));
  await page.evaluate(() => {
    window.beforeQueuedEdit = { fixture: window.fixture, draft: document.querySelector('textarea').value };
    window.fixture = { ...window.fixture, busy: true, followUpSending: false, queuePaused: false, requests: [],
      followUps: [{ id: 'editable-fixture', text: 'Original queued task', images: 1, model: 'fixture-model', editable: true,
        attachments: [{id:'original-image',name:'original.png',kind:'image'}] }] };
    window.update();
  });
  try {
    await page.focus('.queued-message-transfer');await page.keyboard.press('Enter');
    const transfer=await page.evaluate(()=>window.calls.findLast(call=>call.action==='transferQueued'));
    assert.equal(transfer.id,'editable-fixture');assert.equal(transfer.expectedText,'Original queued task');
    assert.deepEqual(transfer.expectedAttachmentIds,['original-image']);
    assert.equal(await page.$eval('.queued-message-transfer',node=>node.getAttribute('aria-label')),suffix.includes('en')?'Send in new session':'Отправить в новой сессии');
    await page.evaluate(()=>{window.fixture.followUps[0].deliveryUncertain=true;window.fixture.followUps[0].editable=false;window.update();});
    assert.equal(await page.$eval('.queued-message-transfer',node=>node.disabled),true);
    await page.evaluate(()=>{window.fixture.followUps[0].transferPending=true;window.update();});
    assert.equal(await page.$eval('.queued-message-transfer',node=>node.disabled),false);
    await page.evaluate(()=>{delete window.fixture.followUps[0].transferPending;delete window.fixture.followUps[0].deliveryUncertain;window.fixture.followUps[0].editable=true;window.update();});
    assert.ok(await page.evaluate(() => {
      const row = document.querySelector('.queued-message');window.update();
      return row === document.querySelector('.queued-message');
    }), 'Unchanged queue controls survive transcript/state updates');
    await page.click('.queued-message-text');
    assert.equal(await page.$eval('.queued-editor textarea', node => node.value), 'Original queued task');
    assert.ok(await page.$eval('.queued-editor textarea', node => node === document.activeElement));
    await page.click('.queued-editor-file button');
    assert.equal(await page.$$('.queued-editor-file').then(nodes => nodes.length), 0);
    await page.click('.queued-editor-add');
    await page.evaluate(() => {
      const request = window.calls.findLast(call => call.action === 'pickQueuedFiles');
      window.dispatchEvent(new MessageEvent('message', {data:{type:'queuedAttachmentsResult',key:window.fixture.key,
        requestId:request.requestId,editId:request.editId,ok:true,
        attachments:[{id:'picked-file',name:'new.js',kind:'file'},{id:'picked-image',name:'replacement.png',kind:'image'}]}}));
    });
    assert.equal(await page.$$('.queued-editor-file').then(nodes => nodes.length), 2);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII='), ch=>ch.charCodeAt(0))], 'pasted.png', {type:'image/png'}));
      document.querySelector('.queued-editor textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    });
    await page.waitForFunction(()=>window.calls.some(call=>call.action==='pasteQueuedImage'));
    await page.evaluate(() => {
      const request = window.calls.findLast(call=>call.action==='pasteQueuedImage');
      window.dispatchEvent(new MessageEvent('message',{data:{type:'queuedAttachmentsResult',key:window.fixture.key,
        requestId:request.requestId,editId:request.editId,ok:true,
        attachments:[{id:'picked-file',name:'new.js',kind:'file'},{id:'picked-image',name:'replacement.png',kind:'image'},{id:'pasted-image',name:'pasted.png',kind:'image'}]}}));
    });
    assert.equal(await page.evaluate(() => window.fixture.followUps[0].attachments[0].id), 'original-image', 'Attachment edits stay local until save');
    await page.type('.queued-editor textarea', '\nAdditional details');
    await page.evaluate(() => window.update());
    assert.equal(await page.$eval('.queued-editor textarea', node => node.value), 'Original queued task\nAdditional details');
    await page.setViewport({ width: 800, height: 850 });
    await page.screenshot({ path: path.join(__dirname, '../.verification/queued-editor-wide' + suffix + '.png') });
    await page.setViewport({ width: 340, height: 750 });
    assert.ok(await page.$eval('.queued-editor', node => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(__dirname, '../.verification/queued-editor-narrow' + suffix + '.png') });
    await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
    const payload = await page.evaluate(() => window.calls.findLast(call => call.action === 'editQueued'));
    assert.equal(payload.expectedText, 'Original queued task');assert.equal(payload.text, 'Original queued task\nAdditional details');
    assert.deepEqual(payload.expectedAttachmentIds,['original-image']);assert.deepEqual(payload.attachmentIds,['picked-file','picked-image','pasted-image']);
    assert.ok(await page.$eval('.queued-editor textarea', node => node.readOnly));
    await page.evaluate(payload => {
      window.fixture.followUps[0].text = payload.text;
      window.fixture.followUps[0].attachments = [{id:'picked-file',name:'new.js',kind:'file'},{id:'picked-image',name:'replacement.png',kind:'image'},{id:'pasted-image',name:'pasted.png',kind:'image'}];window.update();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'queuedEditResult', key: window.fixture.key, requestId: payload.requestId, ok: true } }));
    }, payload);
    assert.equal(await page.$eval('.queued-editor', node => node.open), false);
    assert.equal(await page.$eval('.queued-message-text', node => node.textContent), payload.text);
    assert.equal(await page.evaluate(() => document.querySelector('textarea').value === window.beforeQueuedEdit.draft), true);
    await page.click('.queued-message-text');
    await page.type('.queued-editor textarea', ' Keep this draft');
    await page.click('.queued-editor .primary-button');
    await page.evaluate(() => {
      const payload = window.calls.findLast(call => call.action === 'editQueued');
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'queuedEditResult', key: window.fixture.key, requestId: payload.requestId, ok: false } }));
    });
    assert.ok(await page.$eval('.queued-editor textarea', node => node.value.endsWith('Keep this draft')));
    assert.ok(await page.$eval('.queued-editor [role="status"]', node => node.textContent.length > 0));
    await page.evaluate(() => { window.fixture.followUps = [];window.update(); });
    assert.ok(await page.$eval('.queued-editor .primary-button', node => node.disabled));
    assert.ok(await page.$eval('.queued-editor textarea', node => node.value.endsWith('Keep this draft') && !node.readOnly));
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('.queued-editor', node => node.open), false);
    await page.waitForFunction(() => document.activeElement === document.querySelector('textarea'));
    await page.evaluate(() => {
      window.fixture.followUps=[{id:'first',text:'First pending task',attachments:[]},{id:'second',text:'Second pending task',attachments:[]}];
      window.fixture.queuePaused=false;window.update();
    });
    await page.$$eval('.queued-message', rows => rows[1].querySelector('.queued-message-move').click());
    const move = await page.evaluate(() => window.calls.findLast(call => call.action==='moveQueued'));
    assert.deepEqual(move.expectedOrder,['first','second']);assert.equal(move.id,'second');assert.equal(move.direction,-1);
    await page.evaluate(() => { window.fixture.followUps.reverse();window.update(); });
    assert.equal(await page.$eval('.queued-message-text',node=>node.textContent),'Second pending task');
    await page.click('.queued-message-pause');
    assert.equal(await page.evaluate(() => window.calls.findLast(call=>call.action==='queuePause').paused),true);
    await page.evaluate(() => { window.fixture.queuePaused=true;window.fixture.busy=false;window.update(); });
    assert.equal(await page.$eval('.queued-message-pause',node=>node.getAttribute('aria-pressed')),'true');
    await page.click('.queued-message-run');
    assert.ok(await page.evaluate(()=>window.calls.some(call=>call.action==='sendQueued')));
    await page.setViewport({width:340,height:750});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok(await page.$eval('.queued-messages',node=>node.scrollHeight<=node.clientHeight), 'Two queued tasks and pause controls fit the narrow panel');
    await page.screenshot({path:path.join(__dirname,'../.verification/queue-management-narrow'+suffix+'.png')});
    await page.click('.queued-message-pause');
    assert.equal(await page.evaluate(() => window.calls.findLast(call=>call.action==='queuePause').paused),false);
  } finally {
    await page.evaluate(() => {
      document.querySelector('.queued-editor').close();
      window.fixture = {...window.beforeQueuedEdit.fixture,queuePaused:!!window.beforeQueuedEdit.fixture.queuePaused};delete window.beforeQueuedEdit;window.update();
    });
    await page.setViewport(viewport);
    await page.$eval('html', (node, style) => { if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style); }, theme);
  }
};
