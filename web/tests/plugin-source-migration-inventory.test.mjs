import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sha256Digest } from "../compiler/canonical.mjs";

const webRoot = join(import.meta.dir, "..");
const repositoryRoot = join(webRoot, "..");
const inventoryPath = "web/tests/plugin-source-migration-inventory.test.mjs";

const pendingWakeSources = [
  "demo/crm-v2.wake",
  "demo/todo.wake",
  "demo/tracker.wake",
  "demo/wiki.wake",
  "plugins/wiki/fixtures/handbook/handbook.wake",
  "plugins/wiki/fixtures/substrate/substrate.wake",
  "plugins/wiki/plugin.wake",
  "tests/fixtures/checked-beagle/legacy.wake",
  "tests/fixtures/command-app.wake",
  "tests/fixtures/compiler-contracts-list-detail.wake",
  "tests/fixtures/composition-plugin/plugin.wake",
  "tests/fixtures/configured-plugin/application.wake",
  "tests/fixtures/configured-plugin/plugin.wake",
  "tests/fixtures/fram-command-ux.wake",
  "tests/fixtures/neutral-plugin/app.wake",
  "tests/fixtures/neutral-plugin/plugin.wake",
  "tests/fixtures/plugin-state-query/app.wake",
  "tests/fixtures/plugin-state-query/plugin.wake",
];

const pendingPluginManifests = {
  "plugins/wiki/wake-plugin.json": {
    entry: "plugin.wake",
    sources: ["plugin.wake"],
  },
  "tests/fixtures/composition-plugin/wake-plugin.json": {
    entry: "plugin.wake",
    sources: ["plugin.wake"],
  },
  "tests/fixtures/configured-plugin/wake-plugin.json": {
    entry: "plugin.wake",
    sources: ["plugin.wake"],
  },
  "tests/fixtures/neutral-plugin/wake-plugin.json": {
    entry: "plugin.wake",
    sources: ["plugin.wake"],
  },
  "tests/fixtures/plugin-state-query/wake-plugin.json": {
    entry: "plugin.wake",
    sources: ["plugin.wake"],
  },
};

const pendingWakeReferenceOwners = [
  ".github/workflows/ci.yml",
  ".github/workflows/runtime-release.yml",
  ".gitignore",
  "claude.md",
  "web/bin/wake-browser-test",
  "web/compiler/sexpr.bjs",
  "web/package.json",
  "web/plugins/wiki/package.json",
  "web/plugins/wiki/tests/wiki-contract.test.mjs",
  "web/plugins/wiki/wake-plugin.json",
  "web/tests/checked-beagle.test.mjs",
  "web/tests/codegen-escaping.test.mjs",
  "web/tests/codegen-provider-route.test.mjs",
  "web/tests/command-link.test.mjs",
  "web/tests/command-ux.test.mjs",
  "web/tests/compiler-contract-freeze.test.mjs",
  "web/tests/compiler-contracts.test.mjs",
  "web/tests/composition.test.mjs",
  "web/tests/fixtures/composition-plugin/wake-plugin.json",
  "web/tests/fixtures/configured-plugin/wake-plugin.json",
  "web/tests/fixtures/neutral-plugin/artifacts/neutral-plugin.wakepkg.json",
  "web/tests/fixtures/neutral-plugin/wake-plugin.json",
  "web/tests/fixtures/plugin-state-query/wake-plugin.json",
  "web/tests/fram-graph.test.mjs",
  "web/tests/named-query.test.mjs",
  "web/tests/plugin-config-link.test.mjs",
  "web/tests/plugin-package-bytes.test.mjs",
  "web/tests/wiki-fram.test.mjs",
  "web/tests/wiki-routing.spec.ts",
];

const frozenArtifactRegeneration = {
  applicationManifest:
    "web/tests/fixtures/neutral-plugin/artifacts/app.wake.manifest.json",
  applicationSource: "web/tests/fixtures/neutral-plugin/app.wake",
  compileCommand:
    "web/bin/wake-compile --all web/tests/fixtures/neutral-plugin/app.wake web/tests/fixtures/neutral-plugin/artifacts",
  lock: "web/tests/fixtures/neutral-plugin/wake.lock",
  packageArtifact:
    "web/tests/fixtures/neutral-plugin/artifacts/neutral-plugin.wakepkg.json",
  packCommand:
    "web/bin/wake-pack web/tests/fixtures/neutral-plugin web/tests/fixtures/neutral-plugin/artifacts/neutral-plugin.wakepkg.json",
  pluginSource: "web/tests/fixtures/neutral-plugin/plugin.wake",
  verificationOwner: "web/tests/compiler-contract-freeze.test.mjs",
};

async function trackedPaths() {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split("\0").filter(Boolean);
}

describe("pending authored Beagle source migration", () => {
  test("pins the complete .wake to .bjs content inventory", async () => {
    const actual = [];
    for (const root of ["demo", "plugins", "tests/fixtures"]) {
      const glob = new Bun.Glob("**/*.wake");
      for await (const path of glob.scan({ cwd: join(webRoot, root) })) {
        actual.push(`${root}/${path}`);
      }
    }
    expect(actual.sort()).toEqual(pendingWakeSources);

    for (const source of pendingWakeSources) {
      expect(await Bun.file(join(webRoot, source)).exists()).toBe(true);
      const target = join(webRoot, source.replace(/\.wake$/u, ".bjs"));
      expect(await Bun.file(target).exists()).toBe(false);
    }
  });

  test("pins every manifest reference that must move atomically", async () => {
    const manifestPaths = [];
    for (const root of ["plugins", "tests/fixtures"]) {
      const glob = new Bun.Glob("**/wake-plugin.json");
      for await (const path of glob.scan({ cwd: join(webRoot, root) })) {
        manifestPaths.push(`${root}/${path}`);
      }
    }
    expect(manifestPaths.sort()).toEqual(Object.keys(pendingPluginManifests));

    const actual = {};
    for (const path of manifestPaths) {
      const manifest = await Bun.file(join(webRoot, path)).json();
      actual[path] = {
        entry: manifest.entry,
        sources: manifest.sources,
      };
    }
    expect(actual).toEqual(pendingPluginManifests);
  });

  test("pins every tracked owner of the authored .wake suffix", async () => {
    const authoredWakeReference = /\.wake(?![A-Za-z0-9_.-])/u;
    const actual = [];
    for (const path of await trackedPaths()) {
      if (path === inventoryPath || path.endsWith(".wake")) continue;
      const text = await Bun.file(join(repositoryRoot, path)).text();
      if (authoredWakeReference.test(text)) actual.push(path);
    }
    expect(actual.sort()).toEqual(pendingWakeReferenceOwners);

    const workflow = await Bun.file(
      join(repositoryRoot, ".github/workflows/ci.yml"),
    ).text();
    const releaseWorkflow = await Bun.file(
      join(repositoryRoot, ".github/workflows/runtime-release.yml"),
    ).text();
    const packageDocument = await Bun.file(join(webRoot, "package.json")).json();
    const wikiPackage = await Bun.file(
      join(webRoot, "plugins/wiki/package.json"),
    ).json();
    expect(workflow).toContain("web/demo/wiki.wake");
    expect(releaseWorkflow).toContain("web/demo/wiki.wake");
    expect(packageDocument.scripts.build).toContain("demo/wiki.wake");
    expect(wikiPackage.files).toContain("plugin.wake");
  });

  test("pins the frozen artifact regeneration dependency closure", async () => {
    for (const path of [
      frozenArtifactRegeneration.applicationManifest,
      frozenArtifactRegeneration.applicationSource,
      frozenArtifactRegeneration.lock,
      frozenArtifactRegeneration.packageArtifact,
      frozenArtifactRegeneration.pluginSource,
      frozenArtifactRegeneration.verificationOwner,
    ]) {
      expect(await Bun.file(join(repositoryRoot, path)).exists()).toBe(true);
    }
    for (const command of [
      frozenArtifactRegeneration.compileCommand,
      frozenArtifactRegeneration.packCommand,
    ]) {
      const executable = command.split(" ", 1)[0];
      expect(await Bun.file(join(repositoryRoot, executable)).exists()).toBe(true);
    }

    const artifactText = await Bun.file(join(
      repositoryRoot,
      frozenArtifactRegeneration.packageArtifact,
    )).text();
    const lock = await Bun.file(join(
      repositoryRoot,
      frozenArtifactRegeneration.lock,
    )).json();
    const applicationManifest = await Bun.file(join(
      repositoryRoot,
      frozenArtifactRegeneration.applicationManifest,
    )).json();
    expect(lock.plugins).toHaveLength(1);
    expect(lock.plugins[0].artifact).toBe("artifacts/neutral-plugin.wakepkg.json");
    expect(lock.plugins[0].digest).toBe(sha256Digest(artifactText));
    expect(applicationManifest.plugins).toHaveLength(1);
    expect(applicationManifest.plugins[0].artifactDigest)
      .toBe(lock.plugins[0].digest);
  });
});
