import { test, expect } from "@playwright/test";
import { spawn, ChildProcess } from "child_process";
import { rmSync } from "fs";
import { join } from "path";

const serverDir = join(__dirname, "..", "public-server");
const PORT = 3457;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;

test.beforeAll(async () => {
  try { rmSync(join(serverDir, "app.db"), { force: true }); } catch {}
  try { rmSync(join(serverDir, "app.db-wal"), { force: true }); } catch {}
  try { rmSync(join(serverDir, "app.db-shm"), { force: true }); } catch {}

  server = spawn("node", ["server.js"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 5000);
    server.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("http://localhost")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr?.on("data", () => {});
    server.on("error", reject);
  });
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

test.describe.serial("CRM Server: full-stack server-backed stores", () => {
  test("renders empty app from server", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.locator("h1")).toHaveText("Contacts");
  });

  test("adds a contact via form, persists to server", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("Alice");

    await page.waitForTimeout(300);
    const res = await (await page.request.get(`${BASE}/api/contacts`)).json();
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("Alice");
  });

  test("data survives full page reload", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.locator(".ld-row")).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator(".ld-row")).toContainText("Alice");
  });

  test("second contact also persists", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.locator(".ld-row")).toHaveCount(1, { timeout: 5000 });
    await page.fill('input[placeholder="Name"]', "Bob");
    await page.fill('input[placeholder="Email"]', "bob@test.com");
    await page.fill('input[placeholder="Company"]', "Corp");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(2);

    await page.waitForTimeout(300);
    const res = await (await page.request.get(`${BASE}/api/contacts`)).json();
    expect(res).toHaveLength(2);
  });

  test("inline edit syncs to server", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.locator(".ld-row")).toHaveCount(2, { timeout: 5000 });

    await page.locator(".ld-row").first().dispatchEvent("click");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail).toContainText("Alice", { timeout: 5000 });

    const nameSpan = detail.locator("span.text-sm:not(.italic)").filter({ hasText: /^Alice$/ });
    await nameSpan.dispatchEvent("click");
    const input = detail.locator("input[type='text']").first();
    await input.fill("Alice Updated");
    await input.press("Enter");

    await page.waitForTimeout(300);
    const res = await (await page.request.get(`${BASE}/api/contacts`)).json();
    const alice = res.find((c: any) => c.email === "alice@test.com");
    expect(alice.name).toBe("Alice Updated");
  });

  test("delete syncs to server", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await expect(page.locator(".ld-row")).toHaveCount(2, { timeout: 5000 });

    await page.locator(".ld-row").first().dispatchEvent("click");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail).toContainText("Alice Updated", { timeout: 3000 });
    await detail.locator("button.hover\\:bg-red-100").dispatchEvent("click");
    await expect(page.locator(".ld-row")).toHaveCount(1, { timeout: 5000 });

    await page.waitForTimeout(300);
    const res = await (await page.request.get(`${BASE}/api/contacts`)).json();
    expect(res).toHaveLength(1);
  });

  test("server health endpoint", async ({ page }) => {
    const res = await (await page.request.get(`${BASE}/health`)).json();
    expect(res.status).toBe("ok");
  });
});
