import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function javascriptLiteralAfter(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `generated app is missing ${marker}`);
  const tail = source.slice(markerIndex + marker.length).trimStart();
  const match = /^("(?:\\[\s\S]|[^"\\])*")/.exec(tail);
  assert.ok(match, `generated value after ${marker} is not a JSON string literal`);
  return match[1];
}

function evaluateLiteral(literal) {
  const context = { __WAKE_INJECTED__: false };
  const value = runInNewContext(`(${literal})`, context);
  assert.equal(context.__WAKE_INJECTED__, false);
  return value;
}

function embeddedLiteral(value) {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

test("generated JavaScript quotes every source string without code injection", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-codegen-escaping-"));
  const namespace = "wake.'\\\u2028globalThis.__WAKE_INJECTED__=true\u2029tail";
  const title = "Title '\" \\ newline\n\u2028\u2029; globalThis.__WAKE_INJECTED__=true; //";
  const staticText = "Static '\" \\ newline\n\u2028\u2029; globalThis.__WAKE_INJECTED__=true; //";
  const themeValue = "oklch(50% 0.1 20); '} \\ newline\n\u2028\u2029; globalThis.__WAKE_INJECTED__=true; //";
  const sourcePath = join(outputDir, "hostile.wake");
  const outputPath = join(outputDir, "app.js");

  const wakeSource = [
    `(ns ${namespace})`,
    "(theme",
    `  :colors (primary ${JSON.stringify(themeValue)}))`,
    "(entity item",
    "  (id : String))",
    "(component item-row",
    "  :props [id]",
    `  (div :text ${JSON.stringify(staticText)}))`,
    "(view items",
    "  :entity item",
    "  :each item-row",
    "  :add-form [id]",
    `  :title ${JSON.stringify(title)})`,
  ].join("\n");

  try {
    writeFileSync(sourcePath, `${wakeSource}\n`);
    const compiled = spawnSync(
      join(webRoot, "bin", "wake-compile"),
      [sourcePath, outputPath],
      { cwd: webRoot, encoding: "utf8" },
    );
    const diagnostics = [
      compiled.error?.stack,
      compiled.stdout,
      compiled.stderr,
    ].filter(Boolean).join("\n");
    assert.equal(compiled.status, 0, diagnostics);

    const checked = spawnSync(process.execPath, ["--check", outputPath], {
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);

    const generated = readFileSync(outputPath, "utf8");
    assert.equal(
      generated.split("\n")[1],
      `// Source: ${embeddedLiteral(namespace)}`,
    );
    assert.equal(generated.includes("\u2028"), false);
    assert.equal(generated.includes("\u2029"), false);

    assert.equal(
      evaluateLiteral(javascriptLiteralAfter(generated, "titleEl.textContent =")),
      title,
    );
    assert.equal(
      evaluateLiteral(javascriptLiteralAfter(generated, "el_0.textContent =")),
      staticText,
    );
    assert.equal(
      evaluateLiteral(
        javascriptLiteralAfter(generated, "_themeStyle.textContent ="),
      ),
      `:root {\n    --primary: ${themeValue};\n}`,
    );
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
});
