import { expect, test } from "@playwright/test";
import { loadBrowserFixture, readBrowserFixture } from "./browser-fixture";

const js = readBrowserFixture("crm");

test("real form controls retain a 16px focused font floor", async ({ page }) => {
  await loadBrowserFixture(page, js);
  await expect(page.locator('link[href="/dist.css"]')).toHaveCount(1);
  const stylesheet = await page.request.get("/dist.css");
  expect(stylesheet.status()).toBe(200);
  expect(stylesheet.headers()["content-type"]).toBe("text/css; charset=utf-8");
  expect((await page.request.get("/package.json")).status()).toBe(404);

  const input = page.getByPlaceholder("Name");
  const select = page.locator("select#form-add-contact-status");
  await input.fill("Mobile-safe contact");
  await page.getByPlaceholder("Email").fill("mobile@example.com");
  await page.getByRole("button", { name: "Add Contact" }).click();
  await page.locator(".ld-row").click();

  const detail = page.locator("#ld-contact-detail");
  await detail.getByRole("button", { name: "Notes" }).click();
  const textarea = detail.locator("textarea");

  for (const control of [input, select, textarea]) {
    await control.focus();
    const fontSize = await control.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    expect(fontSize).toBeGreaterThanOrEqual(16);
  }
});
