import { expect, test } from "@playwright/test";

import { canonicalDocument } from "../compiler/canonical.mjs";
import { packPlugin } from "../compiler/plugin-package.mjs";

const fixtureDirectory = process.env.WAKE_BROWSER_FIXTURES;
if (!fixtureDirectory) {
  throw new Error("WAKE_BROWSER_FIXTURES is unset; run with bun run test:browser");
}

const webRoot = `${import.meta.dir}/..`;
const sourceRoot = `${webRoot}/plugins/wiki/fixtures/substrate`;
const buildRoot = `${fixtureDirectory}/wiki-routing`;
const packed = await packPlugin(`${webRoot}/plugins/wiki`);

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

run(["mkdir", "-p", buildRoot]);
await Bun.write(
  `${buildRoot}/substrate.wake`,
  await Bun.file(`${sourceRoot}/substrate.wake`).text(),
);
await Bun.write(`${buildRoot}/wake-wiki.wakepkg.json`, packed.bytes);
await Bun.write(`${buildRoot}/wake.lock`, canonicalDocument({
  pluginAbiVersion: 1,
  plugins: [{
    artifact: "wake-wiki.wakepkg.json",
    digest: packed.digest,
    packageId: "wake-wiki",
    source: { commit: "0".repeat(40), kind: "git" },
    version: "0.1.0",
  }],
  schemaVersion: 1,
}));
run([
  `${webRoot}/bin/wake-compile`,
  "--all",
  `${buildRoot}/substrate.wake`,
  `${buildRoot}/out`,
]);
const javascript = await Bun.file(`${buildRoot}/out/app.js`).text();

type RequestBody = Record<string, unknown>;

async function loadWiki(page: any, path: string, requests: RequestBody[]) {
  await page.route("**/api/wake/**", async (route: any) => {
    const request = route.request();
    const body = request.postDataJSON() as RequestBody;
    const pathname = new URL(request.url()).pathname;
    requests.push(body);

    if (pathname === "/api/wake/changes") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ changes: [], servedVersion: "1" }),
      });
      return;
    }
    if (pathname === "/api/wake/query") {
      const row = body.query === "wiki.read-published"
        ? {
            "resource-id": "entry-1",
            "revision-id": "revision-1",
            title: "Published entry",
            summary: "A routed entry",
            "links-to": [],
            author: "member-1",
            "created-at": "2026-08-12T00:00:00Z",
            digest: `sha256:${"1".repeat(64)}`,
            audience: "public",
            "safe-document": { children: [], kind: "document" },
          }
        : null;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          body.op === "execute"
            ? { row, servedVersion: "1" }
            : { rows: [], servedVersion: "1" },
        ),
      });
      return;
    }
    await route.abort();
  });

  await page.goto("/test.html", { waitUntil: "domcontentloaded" });
  await page.evaluate((nextPath: string) => history.replaceState(null, "", nextPath), path);
  await page.evaluate(javascript);
}

function namedReads(requests: RequestBody[]) {
  return requests.filter(request => request.op === "execute");
}

test("direct static route wins over the overlapping parameter route", async ({ page }) => {
  const requests: RequestBody[] = [];
  await loadWiki(page, "/library/new", requests);

  await expect(page.getByRole("heading", { name: "New draft" })).toBeVisible();
  expect(namedReads(requests)).toEqual([]);
});

test("a static hash wins over the current query path and sidebar navigation remains static", async ({
  page,
}) => {
  const requests: RequestBody[] = [];
  await loadWiki(page, "/library/entry-1", requests);
  await expect(page.getByRole("heading", { name: "Published entry" })).toBeVisible();
  expect(namedReads(requests)).toHaveLength(1);

  await page.getByRole("button", { name: "New draft" }).click();
  await expect(page).toHaveURL(/#wiki\.new-view$/u);
  await expect(page.getByRole("heading", { name: "New draft" })).toBeVisible();
  await page.waitForTimeout(50);
  expect(namedReads(requests)).toHaveLength(1);

  await page.goto("/test.html", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    history.replaceState(null, "", "/library/entry-1#wiki.new-view");
  });
  await page.evaluate(javascript);
  await expect(page.getByRole("heading", { name: "New draft" })).toBeVisible();
  expect(namedReads(requests)).toHaveLength(1);
});
