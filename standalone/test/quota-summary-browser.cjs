const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async ({ page, suffix = '' }) => {
  const originalViewport = page.viewport();
  await page.evaluate(() => {
    window.beforeQuotaSummary = window.fixture;
    window.fixture = { ...window.fixture, key: 'quota-summary', account: {type:'chatgpt'},
      authBusy:false, loginPending:false,
      limits:{buckets:[{name:'Codex',windows:[
        {minutes:300,remaining:11,resetsAt:Math.floor(Date.now()/1000)+8100},
        {minutes:10080,remaining:64,resetsAt:Math.floor(Date.now()/1000)+86400},
      ]}]} };
    window.update();
  });
  try {
    for (const width of [340, 1000]) {
      await page.setViewport({width,height:750});
      assert.ok(await page.$eval('.quota-warning', node => !node.hidden && node.textContent.includes('11%') && node.textContent.includes('64%')));
      assert.ok(await page.$eval('.quota-warning', node => node.getBoundingClientRect().height <= 32));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({path:path.join(__dirname,`../.verification/quota-summary-${width}${suffix}.png`)});
    }
    const timer = await page.evaluate(() => {
      const originalNow = Date.now, originalInterval = window.setInterval;
      let tick, period;
      const now = Date.UTC(2026,9,18), resetsAt = now/1000+8100;
      const view = new WorkbenchQuotaWarningView({el,button,open:()=>{},dismissals:new Map(),onDismiss:()=>{}});
      const state = {account:{type:'chatgpt'},limits:{buckets:[{name:'Synthetic',windows:[
        {minutes:300,remaining:11,resetsAt},{minutes:10080,remaining:64},
      ]}]}};
      try {
        window.setInterval = (callback, delay) => { tick=callback;period=delay;return originalInterval(callback,delay); };
        Date.now = () => now;
        view.render(state);
        const before = view.reset.textContent;
        Date.now = () => now+60000;tick();
        const after = view.reset.textContent;
        const next = {...state,limits:{buckets:[{name:'Other',windows:[{minutes:300,remaining:12,resetsAt:resetsAt+300}]}]}};
        view.render(next);tick();
        const switched = !view.title.textContent.includes('64%');
        view.element.querySelector('.quota-warning-close').click();
        const dismissed = view.element.hidden && view.timer === null;
        view.render(next);
        Date.now = () => now+9000000;view.render(state);
        const expired = view.element.hidden && view.timer === null;
        view.dispose();tick();
        return {before,after,period,switched,dismissed,expired,disposed:view.timer===null};
      } finally {
        view.dispose();Date.now=originalNow;window.setInterval=originalInterval;
      }
    });
    assert.equal(timer.period,60000);
    assert.notEqual(timer.before,timer.after,'The timer updates the countdown without a new host state');
    assert.ok(timer.before.includes('2') && timer.before.includes('15'));
    assert.ok(timer.after.includes('2') && timer.after.includes('14'));
    assert.ok(timer.switched && timer.dismissed && timer.expired && timer.disposed);
  } finally {
    await page.evaluate(() => { window.fixture=window.beforeQuotaSummary;delete window.beforeQuotaSummary;window.update(); });
    await page.setViewport(originalViewport);
  }
};
