import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/run/current-system/sw/bin/google-chrome-stable' });
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto('http://localhost:8090/demo/swarm-index.html', { waitUntil: 'networkidle' });
// wait for at least one agent row from the live feed
await page.waitForFunction(() => document.querySelectorAll('#app .cursor-pointer').length > 0, { timeout: 8000 });
const rowCount = await page.$$eval('#app .cursor-pointer', els => els.length);
// read the stats counter element directly (textContent of #app concatenates the first uuid → bad regex)
const stats = await page.$eval('#app .mt-2.text-xs.text-muted-foreground', el => el.textContent.trim()).catch(() => '(no stats)');
await page.screenshot({ path: 'demo/swarm-list.png' });

// click the first row -> :select detail panel, capture which agent
await page.click('#app .cursor-pointer');
await page.waitForTimeout(400);
const detailBefore = await page.$eval('#app .w-1\\/2.overflow-y-auto h2', el => el.textContent.trim()).catch(() => null);
await page.screenshot({ path: 'demo/swarm-detail.png' });

// PROOF of per-row push: hold selection across several seconds of live WS updates.
// Old load() rebuilt the whole list every 4s and dropped selection; per-row update() keeps it.
await page.waitForTimeout(4000);
const detailAfter = await page.$eval('#app .w-1\\/2.overflow-y-auto h2', el => el.textContent.trim()).catch(() => null);
const selectionSurvived = detailBefore !== null && detailBefore === detailAfter;

console.log(JSON.stringify({ rowCount, stats, detailBefore, detailAfter, selectionSurvived, errors }, null, 2));
await browser.close();
