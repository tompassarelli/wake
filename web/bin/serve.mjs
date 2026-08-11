import { createServer } from "node:http";
import { readFile } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testPage = join(webRoot, "public-js", "test.html");
const stylesheet = join(webRoot, "public-js", "dist.css");
const assets = new Map([
  ["/test.html", { path: testPage, type: "text/html; charset=utf-8" }],
  ["/dist.css", { path: stylesheet, type: "text/css; charset=utf-8" }],
]);
const portText = process.env.WAKE_BROWSER_PORT ?? "8080";
const port = Number(portText);

if (
  !/^[0-9]+$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error(`invalid WAKE_BROWSER_PORT: ${portText}`);
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const asset = assets.get(pathname);
  if (!asset) {
    res.writeHead(404);
    res.end();
    return;
  }

  readFile(asset.path, (error, data) => {
    if (error) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": asset.type });
    res.end(data);
  });
}).listen(port, "127.0.0.1");
