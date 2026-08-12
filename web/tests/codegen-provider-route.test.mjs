import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDocument } from "../compiler/canonical.mjs";
import { packPlugin } from "../compiler/plugin-package.mjs";

const webRoot = join(import.meta.dir, "..");
const pluginRoot = join(webRoot, "plugins", "wiki");

test("generated route metadata exposes provider results but not internal carriers", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-codegen-provider-route-"));
  try {
    const packed = await packPlugin(pluginRoot);
    await Bun.write(
      join(outputDir, "substrate.wake"),
      await Bun.file(join(pluginRoot, "fixtures", "substrate", "substrate.wake")).text(),
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
    const compiled = Bun.spawnSync([
      join(webRoot, "bin", "wake-compile"),
      "--all",
      join(outputDir, "substrate.wake"),
      join(outputDir, "out"),
    ], {
      cwd: webRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    assert.equal(
      compiled.exitCode,
      0,
      `${compiled.stdout.toString()}\n${compiled.stderr.toString()}`,
    );

    const generated = await Bun.file(join(outputDir, "out", "app.js")).text();
    assert.match(
      generated,
      /name: "wiki\.read-published"[\s\S]*?columns: \[[^\]]*"safe-document"/u,
    );
    assert.doesNotMatch(generated, /wake\$provided\$0\$0/u);
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
}, 30_000);
