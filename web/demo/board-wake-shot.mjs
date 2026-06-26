import { chromium } from 'playwright';

const URL = 'http://localhost:8088/board-wake.html';
const OUT = '/home/tom/code/framescope/.qa-shots/board-wake-live.png';

const browser = await chromium.launch({ executablePath: '/run/current-system/sw/bin/google-chrome-stable' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });

// kanban cards (host-shell pane) appear once the projected feed lands
await page.waitForFunction(() => document.querySelectorAll('#panel-board-kanban .fk-card').length > 0, { timeout: 15000 });

const before = await page.evaluate(() => {
  const cols = [...document.querySelectorAll('#panel-board-kanban .fk-col')].map(c => ({
    label: (c.querySelector('.fk-col-label') || {}).textContent || '',
    count: (c.querySelector('.fk-col-count') || {}).textContent || '0',
  }));
  return {
    listRows: document.querySelectorAll('#app .cursor-pointer').length,
    kanbanCards: document.querySelectorAll('#panel-board-kanban .fk-card').length,
    cols,
    storeRows: (window.wake && window.wake.stores && window.wake.stores.threads) ? window.wake.stores.threads.all().length : 0,
  };
});

// click an wake LIST row → the wake :select detail drawer renders (the view's own
// selectItem path). The kanban card click drives the shared selection bus (one-way out
// of the view); the drawer is fed by the view's list, so we click the list to populate it.
await page.click('#app .cursor-pointer');
await page.waitForTimeout(500);
const selected = await page.evaluate(() => window.wake && window.wake.selection ? window.wake.selection.get() : null);
const detail = await page.evaluate(() => {
  const r = document.querySelector('#app .w-1\\/2.min-h-0.overflow-y-auto') || document.querySelector('#app');
  return (r.textContent || '').replace(/\s+/g, ' ').slice(0, 200);
});

await page.screenshot({ path: OUT, fullPage: true });
console.log(JSON.stringify({ before, selected, detail, errors }, null, 2));
await browser.close();
