import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDocument } from "../compiler/canonical.mjs";
import { packPlugin } from "../compiler/plugin-package.mjs";

const webRoot = join(import.meta.dir, "..");
const pluginRoot = join(webRoot, "plugins", "wiki");
let outputDir;
let compiled;
let generated;

beforeAll(async () => {
  outputDir = mkdtempSync(join(tmpdir(), "wake-codegen-provider-route-"));
  const packed = await packPlugin(pluginRoot);
  await Bun.write(
    join(outputDir, "substrate.bjs"),
    await Bun.file(join(pluginRoot, "fixtures", "substrate", "substrate.bjs")).text(),
  );
  await Bun.write(join(outputDir, "wake-wiki.wakepkg.json"), packed.bytes);
  await Bun.write(join(outputDir, "wake.lock"), canonicalDocument({
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
  compiled = Bun.spawnSync([
    join(webRoot, "bin", "wake-compile"),
    "--all",
    join(outputDir, "substrate.bjs"),
    join(outputDir, "out"),
  ], {
    cwd: webRoot,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 40_000,
  });
  assert.equal(
    compiled.exitCode,
    0,
    `${compiled.stdout.toString()}\n${compiled.stderr.toString()}`,
  );
  generated = await Bun.file(join(outputDir, "out", "app.js")).text();
}, { timeout: 45_000 });

afterAll(() => {
  if (outputDir !== undefined) {
    rmSync(outputDir, { force: true, recursive: true });
  }
});

test("generated route metadata exposes provider results but not internal carriers", () => {
  assert.match(
    generated,
    /name: "wiki\.read-published"[\s\S]*?columns: \[[^\]]*"safe-document"/u,
  );
  assert.doesNotMatch(generated, /wake\$provided\$0\$0/u);
});
