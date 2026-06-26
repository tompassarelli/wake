import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(__dirname, "..", "public-js", "index.html"), "utf-8");
const js = readFileSync(join(__dirname, "..", "public-js", "app.js"), "utf-8");

const bareHtml = html.replace('<script src="app.js"></script>', "");

async function loadApp(page: any) {
  await page.setContent(bareHtml);
  await page.evaluate(js);
}

async function loadAppWithOrigin(page: any) {
  await page.goto("http://localhost:8080/public-js/test.html", { waitUntil: "domcontentloaded" });
  await page.evaluate(js);
}

async function reloadApp(page: any) {
  await page.evaluate(() => { document.getElementById('app')!.innerHTML = ''; });
  await page.evaluate(js);
}

test.describe("CRM JS: direct-DOM compiler output", () => {
  test("renders title, form, and empty list", async ({ page }) => {
    await loadApp(page);
    await expect(page.locator("h1")).toHaveText("Contacts");
    await expect(page.locator('input[placeholder="Name"]')).toBeVisible();
    await expect(page.locator('input[placeholder="Email"]')).toBeVisible();
    await expect(page.locator('input[placeholder="Company"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toHaveText("Add Contact");
  });

  test("adds a contact and shows it in the list", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("Alice");
    await expect(page.locator(".ld-row")).toContainText("alice@test.com");
    await expect(page.locator(".ld-row")).toContainText("Acme");
  });

  test("stats update reactively", async ({ page }) => {
    await loadApp(page);
    await expect(page.locator("#ld-contact-stats")).toContainText("Total: 0");
    await page.fill('input[placeholder="Name"]', "Bob");
    await page.fill('input[placeholder="Email"]', "bob@test.com");
    await page.click('button[type="submit"]');
    await expect(page.locator("#ld-contact-stats")).toContainText("Total: 1");
  });

  test("clears form after submit", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Dave");
    await page.fill('input[placeholder="Email"]', "dave@test.com");
    await page.fill('input[placeholder="Company"]', "BigCo");
    await page.click('button[type="submit"]');
    await expect(page.locator('input[placeholder="Name"]')).toHaveValue("");
    await expect(page.locator('input[placeholder="Email"]')).toHaveValue("");
    await expect(page.locator('input[placeholder="Company"]')).toHaveValue("");
  });

  test("ignores empty name submission", async ({ page }) => {
    await loadApp(page);
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(0);
  });

  test("search filters contacts", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await page.fill('input[placeholder="Name"]', "Bob");
    await page.fill('input[placeholder="Email"]', "bob@test.com");
    await page.fill('input[placeholder="Company"]', "BigCo");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(2);
    await page.fill('input[placeholder="Search..."]', "alice");
    await expect(page.locator(".ld-row:not([hidden])")).toHaveCount(1);
    await expect(page.locator(".ld-row:not([hidden])")).toContainText("Alice");
    await page.fill('input[placeholder="Search..."]', "bigco");
    await expect(page.locator(".ld-row:not([hidden])")).toHaveCount(1);
    await expect(page.locator(".ld-row:not([hidden])")).toContainText("Bob");
    await page.fill('input[placeholder="Search..."]', "");
    await expect(page.locator(".ld-row:not([hidden])")).toHaveCount(2);
  });

  test("click row shows detail panel", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@detail.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail).toContainText("Alice");
    await expect(detail).toContainText("alice@detail.com");
    await expect(detail).toContainText("Acme");
  });

  test("detail panel has Overview and Notes tabs", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "TabTest");
    await page.fill('input[placeholder="Email"]', "tabs@test.com");
    await page.fill('input[placeholder="Company"]', "TabCo");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail.locator("button:has-text('Overview')")).toBeVisible();
    await expect(detail.locator("button:has-text('Notes')")).toBeVisible();
  });

  test("detail panel close button deselects", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "CloseMe");
    await page.fill('input[placeholder="Email"]', "close@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail).toContainText("CloseMe");
    await detail.locator("button.hover\\:bg-muted:has(svg)").click();
    await expect(detail).toContainText("Select a contact");
  });

  test("no console errors on load and interaction", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg: any) => {
      if (msg.type() === "error" && !msg.text().includes("WebSocket"))
        errors.push(msg.text());
    });
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "NoErrors");
    await page.fill('input[placeholder="Email"]', "noerr@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    expect(errors).toEqual([]);
  });

  test("inline edit updates detail and list simultaneously", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail.locator("span.text-sm:not(.italic)").filter({ hasText: /^Alice$/ })).toBeVisible();
    // Click the name field to edit
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: /^Alice$/ }).click();
    const editInput = detail.locator("input.text-sm");
    await expect(editInput).toBeVisible();
    await editInput.fill("Alicia");
    await editInput.press("Enter");
    // Detail field and header updated surgically
    await expect(detail.locator("h2")).toHaveText("Alicia");
    await expect(detail.locator("span.text-sm:not(.italic)").filter({ hasText: "Alicia" })).toBeVisible();
    // List row also updated
    await expect(page.locator(".ld-row")).toContainText("Alicia");
    await expect(page.locator(".ld-row")).not.toContainText("Alice");
  });

  test("inline edit escape cancels without updating", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Bob");
    await page.fill('input[placeholder="Email"]', "bob@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: /^Bob$/ }).click();
    const editInput = detail.locator("input.text-sm");
    await editInput.fill("Changed");
    await editInput.press("Escape");
    // Value should remain unchanged
    await expect(detail.locator("h2")).toHaveText("Bob");
    await expect(page.locator(".ld-row")).toContainText("Bob");
  });

  test("inline edit blur commits", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Carol");
    await page.fill('input[placeholder="Email"]', "carol@test.com");
    await page.fill('input[placeholder="Company"]', "Widgets");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: "Widgets" }).click();
    const editInput = detail.locator("input.text-sm");
    await editInput.fill("Gadgets");
    await editInput.blur();
    await expect(detail.locator("span.text-sm:not(.italic)").filter({ hasText: "Gadgets" })).toBeVisible();
    await expect(page.locator(".ld-row")).toContainText("Gadgets");
  });

  test("update persists to localStorage", async ({ page }) => {
    await loadAppWithOrigin(page);
    await page.evaluate(() => localStorage.clear());
    await reloadApp(page);
    await page.fill('input[placeholder="Name"]', "PersistEdit");
    await page.fill('input[placeholder="Email"]', "pe@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: "PersistEdit" }).click();
    const editInput = detail.locator("input.text-sm");
    await editInput.fill("Edited");
    await editInput.press("Enter");
    await expect(page.locator(".ld-row")).toContainText("Edited");
    // Reload app and verify
    await reloadApp(page);
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("Edited");
    await page.evaluate(() => localStorage.clear());
  });

  test("search re-indexes after inline edit", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "SearchMe");
    await page.fill('input[placeholder="Email"]', "sm@test.com");
    await page.fill('input[placeholder="Company"]', "OldCo");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: "OldCo" }).click();
    const editInput = detail.locator("input.text-sm");
    await editInput.fill("NewCo");
    await editInput.press("Enter");
    // Search by new value should find it
    await page.fill('input[placeholder="Search..."]', "newco");
    await expect(page.locator(".ld-row:not([hidden])")).toHaveCount(1);
    // Search by old value should not find it
    await page.fill('input[placeholder="Search..."]', "oldco");
    await expect(page.locator(".ld-row:not([hidden])")).toHaveCount(0);
  });

  test("notes tab shows empty state initially", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("button:has-text('Notes')").click();
    await expect(detail).toContainText("No notes yet");
  });

  test("add note shows it in notes tab", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("button:has-text('Notes')").click();
    await detail.locator("textarea").fill("First note for Alice");
    await detail.locator("button:has-text('Add')").click();
    await expect(detail).toContainText("First note for Alice");
    await expect(detail).not.toContainText("No notes yet");
  });

  test("notes are scoped to selected contact", async ({ page }) => {
    await loadApp(page);
    // Add two contacts
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.click('button[type="submit"]');
    await page.fill('input[placeholder="Name"]', "Bob");
    await page.fill('input[placeholder="Email"]', "bob@test.com");
    await page.click('button[type="submit"]');
    // Add note to Alice
    await page.locator(".ld-row").filter({ hasText: "Alice" }).click();
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("button:has-text('Notes')").click();
    await detail.locator("textarea").fill("Alice-only note");
    await detail.locator("button:has-text('Add')").click();
    await expect(detail).toContainText("Alice-only note");
    // Switch to Bob — should not see Alice's note
    await page.locator(".ld-row").filter({ hasText: "Bob" }).click();
    await detail.locator("button:has-text('Notes')").click();
    await expect(detail).toContainText("No notes yet");
    await expect(detail).not.toContainText("Alice-only note");
  });

  test("notes persist across reloads", async ({ page }) => {
    await loadAppWithOrigin(page);
    await page.evaluate(() => localStorage.clear());
    await reloadApp(page);
    await page.fill('input[placeholder="Name"]', "Persist");
    await page.fill('input[placeholder="Email"]', "p@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("button:has-text('Notes')").click();
    await detail.locator("textarea").fill("Persistent note");
    await detail.locator("button:has-text('Add')").click();
    await expect(detail).toContainText("Persistent note");
    // Reload
    await reloadApp(page);
    await page.click(".ld-row");
    await detail.locator("button:has-text('Notes')").click();
    await expect(detail).toContainText("Persistent note");
    await page.evaluate(() => localStorage.clear());
  });

  test("persists contacts via localStorage", async ({ page }) => {
    await loadAppWithOrigin(page);
    await page.evaluate(() => localStorage.clear());
    await reloadApp(page);
    await page.fill('input[placeholder="Name"]', "Persist");
    await page.fill('input[placeholder="Email"]', "persist@test.com");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await reloadApp(page);
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("Persist");
    await page.evaluate(() => localStorage.clear());
  });

  test("undo reverses add contact", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "UndoMe");
    await page.fill('input[placeholder="Email"]', "undo@test.com");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator("#ld-contact-stats")).toContainText("Total: 1");
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ld-row")).toHaveCount(0);
    await expect(page.locator("#ld-contact-stats")).toContainText("Total: 0");
  });

  test("redo restores undone add", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "RedoMe");
    await page.fill('input[placeholder="Email"]', "redo@test.com");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ld-row")).toHaveCount(0);
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("RedoMe");
  });

  test("undo reverses inline edit", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Original");
    await page.fill('input[placeholder="Email"]', "orig@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: /^Original$/ }).click();
    const editInput = detail.locator("input.text-sm");
    await editInput.fill("Changed");
    await editInput.press("Enter");
    await expect(detail.locator("h2")).toHaveText("Changed");
    await expect(page.locator(".ld-row")).toContainText("Changed");
    await page.keyboard.press("Control+z");
    await expect(detail.locator("h2")).toHaveText("Original");
    await expect(page.locator(".ld-row")).toContainText("Original");
  });

  test("multiple undo/redo cycles", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "a@test.com");
    await page.click('button[type="submit"]');
    await page.fill('input[placeholder="Name"]', "Bob");
    await page.fill('input[placeholder="Email"]', "b@test.com");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(2);
    // Undo Bob
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("Alice");
    // Undo Alice
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ld-row")).toHaveCount(0);
    // Redo Alice
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("Alice");
    // Redo Bob
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".ld-row")).toHaveCount(2);
  });

  test("delete contact removes row and clears detail", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "DeleteMe");
    await page.fill('input[placeholder="Email"]', "del@test.com");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail).toContainText("DeleteMe");
    await detail.locator("button.hover\\:bg-red-100").click();
    await expect(page.locator(".ld-row")).toHaveCount(0);
    await expect(page.locator("#ld-contact-stats")).toContainText("Total: 0");
    await expect(detail).toContainText("Select a contact");
  });

  test("undo delete restores contact and notes atomically", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "AtomicDel");
    await page.fill('input[placeholder="Email"]', "ad@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("button:has-text('Notes')").click();
    await detail.locator("textarea").fill("Important note");
    await detail.locator("button:has-text('Add')").click();
    await expect(detail).toContainText("Important note");
    // Delete (transaction: removes note + contact)
    await detail.locator("button.hover\\:bg-red-100").click();
    await expect(page.locator(".ld-row")).toHaveCount(0);
    // Single undo restores everything
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ld-row")).toHaveCount(1);
    await expect(page.locator(".ld-row")).toContainText("AtomicDel");
    await expect(page.locator("#ld-contact-stats")).toContainText("Total: 1");
    // Note also restored
    await page.click(".ld-row");
    await detail.locator("button:has-text('Notes')").click();
    await expect(detail).toContainText("Important note");
  });

  test("derived display-name renders in list row", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await expect(page.locator(".ld-row")).toContainText("Alice @ Acme");
  });

  test("derived display-name renders in detail panel", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Bob");
    await page.fill('input[placeholder="Email"]', "bob@test.com");
    await page.fill('input[placeholder="Company"]', "BigCo");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await expect(detail.locator("span.italic")).toContainText("Bob @ BigCo");
  });

  test("derived field updates when name changes", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    // Edit name
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: /^Alice$/ }).click();
    const editInput = detail.locator("input.text-sm");
    await editInput.fill("Alicia");
    await editInput.press("Enter");
    // Derived field updated in both detail and row
    await expect(detail.locator("span.italic")).toContainText("Alicia @ Acme");
    await expect(page.locator(".ld-row")).toContainText("Alicia @ Acme");
  });

  test("derived field updates when company changes", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "Alice");
    await page.fill('input[placeholder="Email"]', "alice@test.com");
    await page.fill('input[placeholder="Company"]', "Acme");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    // Edit company
    await detail.locator("span.text-sm:not(.italic)").filter({ hasText: /^Acme$/ }).click();
    const editInput = detail.locator("input.text-sm");
    await editInput.fill("NewCo");
    await editInput.press("Enter");
    // Derived field updated via compiled path for company dependency
    await expect(detail.locator("span.italic")).toContainText("Alice @ NewCo");
    await expect(page.locator(".ld-row")).toContainText("Alice @ NewCo");
  });

  test("status field renders as select dropdown in form", async ({ page }) => {
    await loadApp(page);
    const select = page.locator("select#form-add-contact-status");
    await expect(select).toBeVisible();
    const options = select.locator("option");
    await expect(options).toHaveCount(4); // placeholder + 3 states
    await expect(options.nth(0)).toHaveText("Select Status");
    await expect(options.nth(1)).toHaveText("Active");
  });

  test("adding contact with status select persists value", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "StatusTest");
    await page.fill('input[placeholder="Email"]', "st@test.com");
    await page.selectOption("select#form-add-contact-status", "inactive");
    await page.click('button[type="submit"]');
    const row = page.locator(".ld-row");
    await expect(row).toContainText("StatusTest");
    await row.click();
    const detail = page.locator("#ld-contact-detail");
    await expect(detail.locator("span").filter({ hasText: "inactive" })).toBeVisible();
  });

  test("inline edit status shows select dropdown", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "EditStatus");
    await page.fill('input[placeholder="Email"]', "es@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    // Status field should show "active" (default)
    const statusField = detail.locator("span.text-sm").filter({ hasText: "active" });
    await statusField.click();
    // Should show a select dropdown for inline edit
    const select = detail.locator("select");
    await expect(select).toBeVisible();
    await select.selectOption("archived");
    // After select change, should commit
    await expect(detail.locator("span.text-sm").filter({ hasText: "archived" })).toBeVisible();
  });

  test("undo add note removes it", async ({ page }) => {
    await loadApp(page);
    await page.fill('input[placeholder="Name"]', "NoteUndo");
    await page.fill('input[placeholder="Email"]', "nu@test.com");
    await page.click('button[type="submit"]');
    await page.click(".ld-row");
    const detail = page.locator("#ld-contact-detail");
    await detail.locator("button:has-text('Notes')").click();
    await detail.locator("textarea").fill("A note to undo");
    await detail.locator("button:has-text('Add')").click();
    await expect(detail).toContainText("A note to undo");
    await page.keyboard.press("Control+z");
    await expect(detail).toContainText("No notes yet");
  });
});
