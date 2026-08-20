import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const compile = join(webRoot, "bin", "wake-compile");
const COMPILER_PROCESS_TIMEOUT_MS = 40_000;

function spawnSync(command, args, { cwd, env = process.env } = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: COMPILER_PROCESS_TIMEOUT_MS,
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

describe("Store command UX", () => {
  let outputDir;
  let storeSource;

  beforeAll(() => {
    outputDir = mkdtempSync(join(tmpdir(), "wake-command-ux-store-"));
    const storeDir = join(outputDir, "store");
    runCompile([
      "--all",
      "tests/fixtures/store-command-ux.bjs",
      storeDir,
    ]);
    storeSource = readFileSync(join(storeDir, "app.js"), "utf8");
  }, { timeout: 45_000 });

  afterAll(() => {
    if (outputDir !== undefined) {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  test("propagate promises and surface failures", () => {
    const itemStore = storeSource.match(
      /\["item", \{ store: ([A-Za-z_$][\w$]*)/,
    )?.[1];
    assert.ok(itemStore, "generated connector must bind the item store");

    assert.match(storeSource, /return wakeStoreCreate\("item", fields\);/);
    assert.match(
      storeSource,
      /return wakeStoreSet\("item", identity, attr, value\)\.then\(\(\) => true\);/,
    );
    assert.doesNotMatch(storeSource, /void wakeStore(?:Create|Set)/);
    assert.doesNotMatch(storeSource, /Store (?:create|set) failed/);
    assert.match(
      storeSource,
      /addEventListener\("click", async \(ev\) => \{[^\n]+await store\.update[^\n]+store\.commandFailed\(error\)/,
    );
    assert.match(storeSource, /const commit = async \(\) => \{/);
    assert.ok(
      storeSource.includes(`await ${itemStore}.update(selectedEid, attr, value);`),
    );
    assert.ok(storeSource.includes(`${itemStore}.commandFailed(error);`));
    assert.match(storeSource, /data-wake-command-error/);
    assert.match(storeSource, /Could not save changes\. Try again\./);
    assert.match(storeSource, /const wakeStoreHttpTimeoutMs = 10000;/);
    assert.match(storeSource, /const controller = new AbortController\(\);/);
    assert.match(
      storeSource,
      /setTimeout\(\(\) => controller\.abort\(\), wakeStoreHttpTimeoutMs\)/,
    );
    assert.match(storeSource, /signal: controller\.signal/);
    assert.match(storeSource, /finally \{\s+clearTimeout\(timeout\);/);
    assert.match(
      storeSource,
      /async function wakeStoreRefreshAfterCommand\(entities\)/,
    );
    assert.match(
      storeSource,
      /Store command committed; refresh deferred to change polling/,
    );
    assert.match(storeSource, /wakeStoreSchedulePoll\(0\)/);
    assert.match(storeSource, /await wakeStoreRefreshAfterCommand\(\[entity\]\);/);
    assert.doesNotMatch(storeSource, /await wakeStoreReload\(entity\);/);

    const submit = storeSource.indexOf(
      "formEl.addEventListener('submit', async (e) =>",
    );
    const command = storeSource.indexOf(`await ${itemStore}.add`, submit);
    const clear = storeSource.indexOf(".value = '';", command);
    const hide = storeSource.indexOf("formEl.style.display = 'none';", clear);
    const failure = storeSource.indexOf(`${itemStore}.commandFailed(error);`, hide);
    assert.ok(submit >= 0 && submit < command);
    assert.ok(command < clear && clear < hide && hide < failure);
  });
});

describe("local command UX", () => {
  let outputDir;
  let localSource;

  beforeAll(() => {
    outputDir = mkdtempSync(join(tmpdir(), "wake-command-ux-local-"));
    const localPath = join(outputDir, "local.js");
    runCompile(["demo/todo.bjs", localPath]);
    localSource = readFileSync(localPath, "utf8");
  }, { timeout: 45_000 });

  afterAll(() => {
    if (outputDir !== undefined) {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  test("stay synchronous", () => {
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
  });
});
