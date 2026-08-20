import { expect, test } from "@playwright/test";
import { loadBrowserFixture, readBrowserFixture } from "./browser-fixture";

const js = readBrowserFixture("wiki");

type Row = Record<string, unknown>;

test("an A command at 12 cannot skip an unrelated B change at 11 from cursor 10", async ({ page }) => {
  const rows: Record<string, Row[]> = {
    page: [],
    revision: [{
      id: "b",
      page: "a",
      body: "B before 11",
      status: "draft",
      "links-to": [],
    }],
  };
  let commandCommitted = false;
  const postCommandSince: string[] = [];

  await page.route("**/api/wake/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/wake/query") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: rows[body.entity],
          servedVersion: commandCommitted ? "12" : "10",
        }),
      });
      return;
    }

    if (pathname === "/api/wake/command") {
      rows.revision[0].body = "B changed at 11";
      rows.page.push({ ...body.values });
      commandCommitted = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ servedVersion: "12" }),
      });
      return;
    }

    if (pathname === "/api/wake/changes") {
      if (commandCommitted) postCommandSince.push(body.sinceVersion);
      const includesEleven = commandCommitted && BigInt(body.sinceVersion) < 11n;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          changes: includesEleven
            ? [
                { entity: "page", identities: ["a"] },
                { entity: "revision", identities: ["b"] },
              ]
            : [],
          servedVersion: commandCommitted ? "12" : "10",
        }),
      });
      return;
    }

    await route.abort();
  });

  await loadBrowserFixture(page, js);

  const pagesView = page.locator(".view-card:visible");
  await pagesView.getByRole("button", { name: "+ Add" }).click();
  await pagesView.getByPlaceholder("Slug").fill("a");
  await pagesView.getByPlaceholder("Title").fill("A at 12");
  await pagesView.getByRole("button", { name: "Add", exact: true }).click();

  await expect.poll(() => postCommandSince[0]).toBe("10");
  await page
    .locator(".sidebar-content")
    .getByRole("button", { name: "Revision history" })
    .click();
  await expect(page.getByText("B changed at 11", { exact: true })).toBeVisible();
});

test("an oversized change response resyncs every binding before advancing", async ({ page }) => {
  const rows: Record<string, Row[]> = {
    page: [{ slug: "home", title: "Home before resync" }],
    revision: [{
      id: "rev-1",
      page: "home",
      body: "Revision before resync",
      status: "draft",
      "links-to": [],
    }],
  };
  const queryCounts: Record<string, number> = { page: 0, revision: 0 };
  const sinceVersions: string[] = [];
  let resyncSent = false;

  await page.route("**/api/wake/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/wake/query") {
      queryCounts[body.entity] += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: rows[body.entity],
          servedVersion: resyncSent ? "20" : "10",
        }),
      });
      return;
    }

    if (pathname === "/api/wake/changes") {
      sinceVersions.push(body.sinceVersion);
      if (!resyncSent) {
        rows.page[0].title = "Home after resync";
        rows.revision[0].body = "Revision after resync";
        resyncSent = true;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ resync: true, changes: [], servedVersion: "20" }),
        });
      } else {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ changes: [], servedVersion: "20" }),
        });
      }
      return;
    }

    await route.abort();
  });

  await loadBrowserFixture(page, js);

  await expect.poll(() => queryCounts.page).toBeGreaterThanOrEqual(2);
  await expect.poll(() => queryCounts.revision).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("heading", { name: "Home after resync" })).toBeVisible();
  await page
    .locator(".sidebar-content")
    .getByRole("button", { name: "Revision history" })
    .click();
  await expect(page.getByText("Revision after resync", { exact: true })).toBeVisible();
  await expect.poll(() => sinceVersions.includes("20")).toBe(true);
});
