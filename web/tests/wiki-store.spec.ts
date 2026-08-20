import { expect, test } from "@playwright/test";
import { loadBrowserFixture, readBrowserFixture } from "./browser-fixture";

const js = readBrowserFixture("wiki");
const wikiFingerprint =
  "sha256:96ec5a4c77face2b82ae48f990ad62d40a13d148663d3ecb650a568932fd863e";

type Row = Record<string, unknown>;
type WakeCreate = {
  op: "create";
  entity: string;
  fingerprint: string;
  values: Row;
};
type WakePublish = {
  op: "publish";
  fingerprint: string;
  publication: string;
  owner: unknown;
  revision: unknown;
  expectedPointer: unknown | null;
};

test("wiki add forms issue typed Store create commands", async ({ page }) => {
  const rows: Record<string, Row[]> = { page: [], revision: [] };
  const commands: WakeCreate[] = [];
  let servedVersion = 1;

  await page.route("**/api/wake/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/wake/query") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: rows[body.entity],
          servedVersion: String(servedVersion),
        }),
      });
      return;
    }

    if (pathname === "/api/wake/changes") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          changes: [],
          servedVersion: String(servedVersion),
        }),
      });
      return;
    }

    if (pathname === "/api/wake/command") {
      if (body.op !== "create") throw new Error(`unexpected command ${body.op}`);
      commands.push(body);
      const row = { ...body.values };
      if (body.entity === "revision") row.status = "draft";
      rows[body.entity].push(row);
      servedVersion += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ servedVersion: String(servedVersion) }),
      });
      return;
    }

    await route.abort();
  });

  await loadBrowserFixture(page, js);

  const pagesView = page.locator(".view-card:visible");
  await pagesView.getByRole("button", { name: "+ Add" }).click();
  await pagesView.getByPlaceholder("Slug").fill("home");
  await pagesView.getByPlaceholder("Title").fill("Home");
  await pagesView.getByRole("button", { name: "Add", exact: true }).click();

  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    op: "create",
    entity: "page",
    fingerprint: wikiFingerprint,
    values: { slug: "home", title: "Home" },
  });
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  await page
    .locator(".sidebar-content")
    .getByRole("button", { name: "Revision history" })
    .click();
  const revisionsView = page.locator(".view-card:visible");
  await revisionsView.getByRole("button", { name: "+ Add" }).click();
  await revisionsView.getByPlaceholder("Id").fill("rev-1");
  await revisionsView.getByPlaceholder("Page").fill("home");
  await revisionsView.getByPlaceholder("Body").fill("First revision");
  await revisionsView.getByPlaceholder("Links-to").fill("home");
  await revisionsView.getByRole("button", { name: "Add", exact: true }).click();

  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({
    op: "create",
    entity: "revision",
    fingerprint: wikiFingerprint,
    values: {
      id: "rev-1",
      page: "home",
      body: "First revision",
      "links-to": ["home"],
    },
  });
  await expect(page.getByText("First revision", { exact: true })).toBeVisible();
});

for (const failure of ["conflict", "network"] as const) {
  test(`wiki create preserves input and retries after ${failure} failure`, async ({
    page,
  }) => {
    const rows: Record<string, Row[]> = { page: [], revision: [] };
    let commandAttempts = 0;
    let servedVersion = 1;

    await page.route("**/api/wake/**", async (route) => {
      const request = route.request();
      const body = request.postDataJSON();
      const pathname = new URL(request.url()).pathname;

      if (pathname === "/api/wake/query") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            rows: rows[body.entity],
            servedVersion: String(servedVersion),
          }),
        });
        return;
      }

      if (pathname === "/api/wake/changes") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            changes: [],
            servedVersion: String(servedVersion),
          }),
        });
        return;
      }

      if (pathname === "/api/wake/command") {
        commandAttempts += 1;
        if (commandAttempts === 1) {
          if (failure === "conflict") {
            await route.fulfill({ status: 409, body: "identity conflict" });
          } else {
            await route.abort("failed");
          }
          return;
        }

        rows[body.entity].push({ ...body.values });
        servedVersion += 1;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ servedVersion: String(servedVersion) }),
        });
        return;
      }

      await route.abort();
    });

    await loadBrowserFixture(page, js);

    const pagesView = page.locator(".view-card:visible");
    const form = pagesView.locator("form");
    const slug = pagesView.getByPlaceholder("Slug");
    const title = pagesView.getByPlaceholder("Title");
    const add = pagesView.getByRole("button", { name: "Add", exact: true });

    await pagesView.getByRole("button", { name: "+ Add" }).click();
    await slug.fill("retry-page");
    await title.fill("Retry Page");
    await add.click();

    await expect.poll(() => commandAttempts).toBe(1);
    await expect(page.locator("[data-wake-command-error]")).toHaveText(
      "Could not save changes. Try again.",
    );
    await expect(form).toBeVisible();
    await expect(slug).toHaveValue("retry-page");
    await expect(title).toHaveValue("Retry Page");
    await expect(add).toBeEnabled();

    await add.click();

    await expect.poll(() => commandAttempts).toBe(2);
    await expect(page.locator("[data-wake-command-error]")).toBeHidden();
    await expect(form).toBeHidden();
    await expect(slug).toHaveValue("");
    await expect(title).toHaveValue("");
    await expect(page.getByRole("heading", { name: "Retry Page" })).toBeVisible();
  });
}

test("accepted create clears its form and polling recovers a failed refresh", async ({
  page,
}) => {
  const rows: Record<string, Row[]> = { page: [], revision: [] };
  let servedVersion = 1;
  let initialQueries = 0;
  let commandAccepted = false;
  let refreshFailed = false;
  let recoveryPolls = 0;

  await page.route("**/api/wake/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/wake/query") {
      if (!commandAccepted) initialQueries += 1;
      if (commandAccepted && body.entity === "page" && !refreshFailed) {
        refreshFailed = true;
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: rows[body.entity],
          servedVersion: String(servedVersion),
        }),
      });
      return;
    }

    if (pathname === "/api/wake/command") {
      rows.page.push({ ...body.values });
      servedVersion = 2;
      commandAccepted = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ servedVersion: "2" }),
      });
      return;
    }

    if (pathname === "/api/wake/changes") {
      if (commandAccepted) recoveryPolls += 1;
      const needsRefresh = commandAccepted && BigInt(body.sinceVersion) < 2n;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          changes: needsRefresh ? [{ entity: "page", identities: ["accepted"] }] : [],
          servedVersion: String(servedVersion),
        }),
      });
      return;
    }

    await route.abort();
  });

  await loadBrowserFixture(page, js);
  await expect.poll(() => initialQueries).toBeGreaterThanOrEqual(2);

  const pagesView = page.locator(".view-card:visible");
  const form = pagesView.locator("form");
  const slug = pagesView.getByPlaceholder("Slug");
  const title = pagesView.getByPlaceholder("Title");
  const add = pagesView.getByRole("button", { name: "Add", exact: true });

  await pagesView.getByRole("button", { name: "+ Add" }).click();
  await slug.fill("accepted");
  await title.fill("Accepted command");
  await add.click();

  await expect.poll(() => refreshFailed).toBe(true);
  await expect(form).toBeHidden();
  await expect(slug).toHaveValue("");
  await expect(title).toHaveValue("");
  await expect(page.locator("[data-wake-command-error]")).toHaveCount(0);

  await expect.poll(() => recoveryPolls).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Accepted command" })).toBeVisible();
});

test("wiki publication preserves the invariant across a stale-CAS race and retry", async ({
  page,
}) => {
  const rows: Record<string, Row[]> = {
    page: [{ slug: "home", title: "Home", "canonical-revision": "rev-1" }],
    revision: [
      {
        id: "rev-1",
        page: "home",
        body: "Published first",
        status: "canonical",
        "links-to": [],
      },
      {
        id: "rev-2",
        page: "home",
        body: "Publish second",
        status: "draft",
        "links-to": [],
      },
    ],
  };
  const commands: WakePublish[] = [];
  let servedVersion = 10;

  await page.route("**/api/wake/**", async (route) => {
    const body = route.request().postDataJSON();
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === "/api/wake/query") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          rows: rows[body.entity],
          servedVersion: String(servedVersion),
        }),
      });
      return;
    }
    if (pathname === "/api/wake/changes") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ changes: [], servedVersion: String(servedVersion) }),
      });
      return;
    }
    if (pathname === "/api/wake/command") {
      if (body.op !== "publish") throw new Error(`unexpected command ${body.op}`);
      commands.push(body);
      if (commands.length === 1) {
        await route.fulfill({ status: 409, body: "pointer moved" });
        return;
      }

      rows.page[0]["canonical-revision"] = "rev-2";
      rows.revision[0].status = "obsolete";
      rows.revision[1].status = "canonical";
      servedVersion += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ changed: true, servedVersion: String(servedVersion) }),
      });
      return;
    }
    await route.abort();
  });

  await loadBrowserFixture(page, js);
  await page
    .locator(".sidebar-content")
    .getByRole("button", { name: "Revision history" })
    .click();

  const publish = page.getByRole("button", { name: "Publish rev-2" });
  await expect(publish).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish rev-1" })).toHaveCount(0);

  await publish.click();

  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    op: "publish",
    fingerprint: wikiFingerprint,
    publication: "canonical",
    owner: "home",
    revision: "rev-2",
    expectedPointer: "rev-1",
  });
  await expect(page.locator("[data-wake-command-error]")).toHaveText(
    "Could not save changes. Try again.",
  );
  await expect(publish).toBeEnabled();
  await expect(page.getByText("draft", { exact: true })).toBeVisible();
  expect(rows.page[0]["canonical-revision"]).toBe("rev-1");
  expect(rows.revision[0].status).toBe("canonical");

  await publish.click();

  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(page.locator("[data-wake-command-error]")).toBeHidden();
  await expect(page.getByRole("button", { name: "Publish rev-2" })).toHaveCount(0);
  await expect(page.getByText("obsolete", { exact: true })).toBeVisible();
  await expect(page.getByText("canonical", { exact: true })).toBeVisible();

  await page
    .locator(".sidebar-content")
    .getByRole("button", { name: "Wiki pages" })
    .click();
  await expect(
    page.locator(".view-card:visible").getByText("rev-2", { exact: true }),
  ).toBeVisible();
});
