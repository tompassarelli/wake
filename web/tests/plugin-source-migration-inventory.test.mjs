import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "..");

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
});
