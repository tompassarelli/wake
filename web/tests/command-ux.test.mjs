import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const compile = join(webRoot, "bin", "wake-compile");
const COMPILER_TEST_TIMEOUT_MS = 20_000;

function spawnSync(command, args, { cwd, env = process.env } = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runCompile(args) {
  const result = spawnSync(compile, args, {
    cwd: webRoot,
  });
  const diagnostics = [
    result.stdout,
    result.stderr,
  ].filter(Boolean).join("\n");
  assert.equal(result.status, 0, diagnostics);
}

test("FRAM commands propagate promises while local commands stay synchronous", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-command-ux-"));

  try {
    const framDir = join(outputDir, "fram");
    runCompile([
      "--all",
      "tests/fixtures/fram-command-ux.bjs",
      framDir,
    ]);
    const framSource = readFileSync(join(framDir, "app.js"), "utf8");
    const itemStore = framSource.match(
      /\["item", \{ store: ([A-Za-z_$][\w$]*)/,
    )?.[1];
    assert.ok(itemStore, "generated connector must bind the item store");

    assert.match(framSource, /return wakeFramCreate\("item", fields\);/);
    assert.match(
      framSource,
      /return wakeFramSet\("item", identity, attr, value\)\.then\(\(\) => true\);/,
    );
    assert.doesNotMatch(framSource, /void wakeFram(?:Create|Set)/);
    assert.doesNotMatch(framSource, /FRAM (?:create|set) failed/);
    assert.match(
      framSource,
      /addEventListener\("click", async \(ev\) => \{[^\n]+await store\.update[^\n]+store\.commandFailed\(error\)/,
    );
    assert.match(framSource, /const commit = async \(\) => \{/);
    assert.ok(
      framSource.includes(`await ${itemStore}.update(selectedEid, attr, value);`),
    );
    assert.ok(framSource.includes(`${itemStore}.commandFailed(error);`));
    assert.match(framSource, /data-wake-command-error/);
    assert.match(framSource, /Could not save changes\. Try again\./);
    assert.match(framSource, /const wakeFramHttpTimeoutMs = 10000;/);
    assert.match(framSource, /const controller = new AbortController\(\);/);
    assert.match(
      framSource,
      /setTimeout\(\(\) => controller\.abort\(\), wakeFramHttpTimeoutMs\)/,
    );
    assert.match(framSource, /signal: controller\.signal/);
    assert.match(framSource, /finally \{\s+clearTimeout\(timeout\);/);
    assert.match(
      framSource,
      /async function wakeFramRefreshAfterCommand\(entities\)/,
    );
    assert.match(
      framSource,
      /FRAM command committed; refresh deferred to change polling/,
    );
    assert.match(framSource, /wakeFramSchedulePoll\(0\)/);
    assert.match(framSource, /await wakeFramRefreshAfterCommand\(\[entity\]\);/);
    assert.doesNotMatch(framSource, /await wakeFramReload\(entity\);/);

    const submit = framSource.indexOf(
      "formEl.addEventListener('submit', async (e) =>",
    );
    const command = framSource.indexOf(`await ${itemStore}.add`, submit);
    const clear = framSource.indexOf(".value = '';", command);
    const hide = framSource.indexOf("formEl.style.display = 'none';", clear);
    const failure = framSource.indexOf(`${itemStore}.commandFailed(error);`, hide);
    assert.ok(submit >= 0 && submit < command);
    assert.ok(command < clear && clear < hide && hide < failure);

    const localPath = join(outputDir, "local.js");
    runCompile(["demo/todo.bjs", localPath]);
    const localSource = readFileSync(localPath, "utf8");
    assert.match(localSource, /return entity;/);
    assert.match(
      localSource,
      /formEl\.addEventListener\('submit', \(e\) => \{/,
    );
    assert.doesNotMatch(localSource, /data-wake-command-error/);
    assert.doesNotMatch(
      localSource,
      /formEl\.addEventListener\('submit', async \(e\) => \{/,
    );
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);
