import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs';
import { join, extname } from 'path';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join('.', req.url.split('?')[0]);
  readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); }
    else { res.writeHead(200, { 'Content-Type': types[extname(p)] || 'text/plain' }); res.end(data); }
  });
}).listen(8091);

const browser = await chromium.launch({ executablePath: '/run/current-system/sw/bin/google-chrome-stable' });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto('http://localhost:8091/demo/fleet-index.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelectorAll('#app .cursor-pointer').length > 0, { timeout: 8000 });

// SEAM ASSERTIONS — both custom panes carved by wake, fed by window.wake.
const panesMounted = await page.evaluate(() => ({
  graphEl: !!document.getElementById('panel-agent-graph'),
  streamEl: !!document.getElementById('panel-agent-stream'),
  graphText: (document.querySelector('#panel-agent-graph div:nth-child(2)') || {}).textContent || '',
  streamText: (document.querySelector('#panel-agent-stream') || {}).textContent || '',
  busHasStore: !!(window.wake && window.wake.stores && window.wake.stores.agents),
}));

await page.click('#app .cursor-pointer');
await page.waitForTimeout(500);
const selectedUuid = await page.evaluate(() => window.wake.selection.get());

// Prove the shared feed reaches the custom pane: wait for a live delta to bump the stream.
const streamBefore = await page.$eval('#panel-agent-stream', el => el.textContent);
await page.waitForTimeout(6000);
const streamAfter = await page.$eval('#panel-agent-stream', el => el.textContent);
const feedReachedPane = streamAfter !== streamBefore && /Δ/.test(streamAfter);

await page.screenshot({ path: 'demo/fleet-seam.png', fullPage: true });

console.log(JSON.stringify({ panesMounted, selectedUuid, feedReachedPane, errors }, null, 2));
await browser.close();
srv.close();
