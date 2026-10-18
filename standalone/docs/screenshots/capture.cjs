// Capture only the isolated synthetic demo; no CLI or user browser is connected.
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const puppeteer = require('puppeteer-core');

async function capture() {
  const chrome = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].find(file => file && fs.existsSync(file));
  if (!chrome) throw Error('Set CHROME_PATH to Chrome or Chromium.');
  const preview = spawn(process.execPath, [path.join(__dirname, 'preview.cjs')], {stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(Error('Demo server startup timed out.')), 15000);
      preview.once('error', error => {clearTimeout(timeout); reject(error);});
      preview.once('exit', () => {clearTimeout(timeout); reject(Error('Demo server exited.'));});
      preview.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {clearTimeout(timeout); resolve(match[0]);}
      });
    });
    browser = await puppeteer.launch({executablePath:chrome,headless:true,pipe:true});
    const page = await browser.newPage();
    await page.setViewport({width:300,height:60,deviceScaleFactor:1});
    const badge = path.join(__dirname,'../branding/marketplace-badge.svg');
    await page.goto(pathToFileURL(badge).href);
    await page.screenshot({path:badge.replace(/\.svg$/,'.png'),omitBackground:true});
    await page.setViewport({width:900,height:720,deviceScaleFactor:1});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, {waitUntil:'networkidle0'});
    await page.waitForSelector('.composer');
    await page.screenshot({path:path.join(__dirname,'chat-dark.jpg'),type:'jpeg',quality:90});
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',{data:{type:'open',action:'access'}})));
    await page.waitForSelector('.mode-menu');
    await page.screenshot({path:path.join(__dirname,'access-modes.jpg'),type:'jpeg',quality:90});
    await page.goto(url+'/?theme=light&scene=questions', {waitUntil:'networkidle0'});
    await page.waitForSelector('.composer');
    await page.screenshot({path:path.join(__dirname,'questions-light.jpg'),type:'jpeg',quality:90});
    if (errors.length) throw Error('Synthetic demo has browser errors.');
    console.log('Captured three panel scenes and the installation badge; no inference performed.');
  } finally {
    try { await browser?.close(); }
    finally { preview.kill(); }
  }
}
capture().catch(error => {console.error(error.message);process.exitCode=1;});
