import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = process.env.WAKE_BROWSER_FIXTURES;

if (!fixtureDir) {
  throw new Error(
    "WAKE_BROWSER_FIXTURES is unset; run the browser suite with npm run test:browser",
  );
}

export function readBrowserFixture(name: string): string {
  return readFileSync(join(fixtureDir, `${name}.js`), "utf8");
}

export async function loadBrowserFixture(page: any, source: string): Promise<void> {
  await page.goto("/test.html", { waitUntil: "domcontentloaded" });
  await page.evaluate(source);
}
