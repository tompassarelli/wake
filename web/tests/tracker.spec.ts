import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(__dirname, "..", "public-js", "index.html"), "utf-8");
const js = readFileSync(join("/tmp", "eddy-tracker-run", "app.js"), "utf-8");

const bareHtml = html.replace('<script src="app.js"></script>', "");

async function loadApp(page: any) {
  await page.setContent(bareHtml);
  await page.evaluate(js);
}

async function addTask(page: any, title: string, done?: string) {
  await page.click('button:has-text("+ Add")');
  await page.fill('input[placeholder="Title"]', title);
  if (done) await page.fill('input[placeholder="Done"]', done);
  await page.click("button[type=submit]");
}

test.describe("Conditional rendering: (when ...)", () => {
  test("task without done field shows no Done badge", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Incomplete task");
    await expect(page.locator(".flex-1.text-sm")).toHaveText("Incomplete task");
    await expect(page.locator(".text-green-600")).toHaveCount(0);
  });

  test("task with done field shows Done badge", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Finished task", "yes");
    await expect(page.locator(".flex-1.text-sm")).toHaveText("Finished task");
    await expect(page.locator(".text-green-600")).toHaveText("Done");
  });

  test("mixed tasks: only done tasks show badge", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Task A");
    await addTask(page, "Task B", "yes");
    await addTask(page, "Task C");
    const badges = page.locator(".text-green-600");
    await expect(badges).toHaveCount(1);
    await expect(badges.first()).toHaveText("Done");
  });
});

test.describe("Selection: click-to-select detail panel", () => {
  test("shows empty state before selection", async ({ page }) => {
    await loadApp(page);
    await expect(page.locator("text=Select an item to view details")).toBeVisible();
  });

  test("clicking a row shows detail panel", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Click me");
    await page.click(".cursor-pointer");
    await expect(page.locator(".p-6 h2")).toHaveText("Click me");
  });

  test("selecting a done task shows Completed in detail", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Done task", "yes");
    await page.click(".cursor-pointer");
    await expect(page.locator(".p-6 h2")).toHaveText("Done task");
    await expect(page.locator(".bg-green-50")).toBeVisible();
    await expect(page.locator(".bg-green-50 span")).toHaveText("Completed");
  });

  test("selecting undone task does not show Completed", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Undone task");
    await page.click(".cursor-pointer");
    await expect(page.locator(".p-6 h2")).toHaveText("Undone task");
    await expect(page.locator(".bg-green-50")).toHaveCount(0);
  });

  test("clicking different row changes detail", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "First");
    await addTask(page, "Second");
    const rows = page.locator(".cursor-pointer .flex-1.text-sm");
    await rows.first().click();
    await expect(page.locator(".p-6 h2")).toHaveText("First");
    await rows.last().click();
    await expect(page.locator(".p-6 h2")).toHaveText("Second");
  });
});

test.describe("Routing: hash-based navigation", () => {
  test("renders nav bar with view buttons", async ({ page }) => {
    await loadApp(page);
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();
    await expect(nav.locator("button")).toHaveCount(2);
    await expect(nav.locator("button").first()).toHaveText("Tasks");
    await expect(nav.locator("button").last()).toHaveText("Board");
  });

  test("default view is tasks", async ({ page }) => {
    await loadApp(page);
    const tasksTitle = page.locator("h1").first();
    await expect(tasksTitle).toHaveText("Tasks");
    await expect(tasksTitle).toBeVisible();
  });

  test("navigating to board shows board view", async ({ page }) => {
    await loadApp(page);
    await page.click("nav button:has-text('Board')");
    const titles = page.locator("h1");
    const boardTitle = titles.filter({ hasText: "Board" });
    await expect(boardTitle).toBeVisible();
  });

  test("adding task in tasks view appears in board view", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Cross-view task");
    await page.click("nav button:has-text('Board')");
    await expect(page.getByText("Cross-view task").last()).toBeVisible();
  });

  test("navigating back preserves state", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Persistent");
    await page.click("nav button:has-text('Board')");
    await page.click("nav button:has-text('Tasks')");
    await expect(page.locator(".flex-1.text-sm").filter({ hasText: "Persistent" })).toBeVisible();
  });
});

test.describe("Integration: when + selection + routing together", () => {
  test("undo reverses add across views", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Undo me");
    await expect(page.locator(".flex-1.text-sm").filter({ hasText: "Undo me" })).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(page.locator(".cursor-pointer")).toHaveCount(0);
  });

  test("redo restores undone add", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Redo me");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".flex-1.text-sm").filter({ hasText: "Redo me" })).toBeVisible();
  });

  test("no console errors on full interaction", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err: Error) => errors.push(err.message));
    await loadApp(page);
    await addTask(page, "Error check", "yes");
    await page.click(".cursor-pointer");
    await page.click("nav button:has-text('Board')");
    await page.click("nav button:has-text('Tasks')");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Shift+z");
    expect(errors).toEqual([]);
  });

  test("search filters tasks", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Alpha task");
    await addTask(page, "Beta task");
    await addTask(page, "Gamma task");
    await page.fill('input[placeholder="Search..."]', "Beta");
    const visible = page.locator(".cursor-pointer:visible");
    await expect(visible).toHaveCount(1);
    await expect(visible.locator(".flex-1.text-sm")).toHaveText("Beta task");
  });

  test("search shows filtered count", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "One");
    await addTask(page, "Two");
    await addTask(page, "Three");
    await page.fill('input[placeholder="Search..."]', "o");
    await expect(page.locator(".mt-2.text-xs").first()).toHaveText("2 of 3");
  });

  test("selected row has highlight", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Highlight me");
    const row = page.locator(".cursor-pointer").first();
    await row.click();
    await expect(row).toHaveClass(/bg-muted/);
  });

  test("inline edit in detail panel updates list", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Edit me");
    await page.click(".cursor-pointer");
    await expect(page.locator(".p-6 h2")).toHaveText("Edit me");
    await page.click(".p-6 h2");
    const input = page.locator(".p-6 input");
    await expect(input).toBeVisible();
    await input.fill("Edited title");
    await input.press("Enter");
    await expect(page.locator(".p-6 h2")).toHaveText("Edited title");
    await expect(page.locator(".cursor-pointer .flex-1.text-sm")).toHaveText("Edited title");
  });

  test("inline edit escape cancels", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "No change");
    await page.click(".cursor-pointer");
    await page.click(".p-6 h2");
    const input = page.locator(".p-6 input");
    await input.fill("Changed");
    await input.press("Escape");
    await expect(page.locator(".p-6 h2")).toHaveText("No change");
  });

  test("inline edit undo/redo works", async ({ page }) => {
    await loadApp(page);
    await addTask(page, "Undo edit");
    await page.click(".cursor-pointer");
    await page.click(".p-6 h2");
    const input = page.locator(".p-6 input");
    await input.fill("Changed");
    await input.press("Enter");
    await expect(page.locator(".p-6 h2")).toHaveText("Changed");
    await page.keyboard.press("Control+z");
    await expect(page.locator(".cursor-pointer .flex-1.text-sm")).toHaveText("Undo edit");
  });
});
