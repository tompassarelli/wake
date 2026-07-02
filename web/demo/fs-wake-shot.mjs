import { chromium } from 'playwright';

const URL = 'http://localhost:8088/wake-observatory.html';
const OUT = '/home/tom/code/framescope/web/../.qa-shots/wake-observatory-live.png';

const browser = await chromium.launch({ executablePath: '/run/current-system/sw/bin/google-chrome-stable' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
// real swarm rows = clickable agent rows fed from /presence
await page.waitForFunction(() => document.querySelectorAll('#app .cursor-pointer').length > 0, { timeout: 10000 });

const before = await page.evaluate(() => ({
  rows: document.querySelectorAll('#app .cursor-pointer').length,
  firstUuid: (document.querySelector('#app .cursor-pointer span') || {}).textContent || '',
  graphPane: !!document.getElementById('panel-agent-graph'),
  streamPane: !!document.getElementById('panel-agent-stream'),
  graphText: (document.querySelector('#panel-agent-graph') || {}).textContent || '',
  busStore: !!(window.wake && window.wake.stores && window.wake.stores.agents),
}));

// click first agent → detail panel + selection bus
await page.click('#app .cursor-pointer');
await page.waitForTimeout(400);
const selectedUuid = await page.evaluate(() => window.wake && window.wake.selection ? window.wake.selection.get() : null);
const detailText = await page.evaluate(() => {
  const r = document.querySelector('#app .w-1\\/2.min-h-0.overflow-y-auto') || document.querySelector('#app');
  return (r.textContent || '').slice(0, 120);
});

await page.screenshot({ path: OUT, fullPage: true });

console.log(JSON.stringify({ before, selectedUuid, detailText, errors }, null, 2));
await browser.close();
