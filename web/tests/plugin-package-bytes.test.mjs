import { describe, expect, spyOn, test } from "bun:test";
import { constants as fileConstants } from "node:fs";
import fileSystemPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalDocument,
  sha256Digest,
} from "../compiler/canonical.mjs";
import {
  packPlugin,
  pluginPackageLimits,
  readPluginArtifact,
  readPluginArtifactFile,
  validatePluginManifest,
  validateWakeLock,
} from "../compiler/plugin-package.mjs";

const {
  manifestBytes: MAX_MANIFEST_BYTES,
  sourceBytes: MAX_SOURCE_BYTES,
  sourceCount: MAX_SOURCE_COUNT,
  sourcePathBytes: MAX_SOURCE_PATH_BYTES,
  totalSourceBytes: MAX_TOTAL_SOURCE_BYTES,
} = pluginPackageLimits;
const encoder = new TextEncoder();
const validSource = "#lang beagle/js\n(ns wake.tests.plugin-bytes)\n";

function manifest(sources = ["plugin.bjs"], entry = "plugin.bjs") {
  return {
    compatibleWake: "0.1.0",
    configuration: {},
    contributions: [],
    dependencies: [],
    durableSchemaVersion: 1,
    entry,
    exports: {
      capabilities: [],
      commands: [],
      components: [],
      entities: [],
      providerPorts: [],
      queries: [],
      routes: [],
    },
    extensionPorts: [],
    migrations: [],
    packageId: "wake-plugin-bytes-test",
    pluginAbiVersion: 1,
    requiredHostCapabilities: [],
    schemaVersion: 1,
    sources,
    storageIds: { entities: {}, fields: {} },
    version: "0.1.0",
  };
}

async function temporaryPackage(manifestBytes, sources, action) {
  const root = await mkdtemp(join(tmpdir(), "wake-plugin-bytes-"));
  try {
    await writeFile(join(root, "wake-plugin.json"), manifestBytes);
    for (const [path, bytes] of Object.entries(sources)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
    }
    return await action(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function pack(manifestValue, sources) {
  return temporaryPackage(canonicalDocument(manifestValue), sources, packPlugin);
}

function sizedSource(size) {
  const headerBytes = encoder.encode(validSource).byteLength;
  return `${validSource}${" ".repeat(size - headerBytes)}`;
}

describe("plugin package raw-byte boundary", () => {
  test("snapshots exact source bytes in canonical member order", async () => {
    const sourceA = `${validSource}(def label: String "界面")\n`;
    const sourceB = `${validSource}(def count: Int 2)\n`;
    const manifestValue = manifest(["lib/a.bjs", "plugin.bjs"], "plugin.bjs");
    const first = await pack(manifestValue, {
      "lib/a.bjs": sourceA,
      "plugin.bjs": sourceB,
    });
    const second = await pack(manifestValue, {
      "lib/a.bjs": sourceA,
      "plugin.bjs": sourceB,
    });

    expect(first.bytes).toBe(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(first.artifact.files.map(({ path }) => path)).toEqual([
      "lib/a.bjs",
      "plugin.bjs",
    ]);
    expect(first.artifact.files[0].sha256).toBe(
      sha256Digest(encoder.encode(sourceA)),
    );
    expect(first.artifact.files[1].sha256).toBe(
      sha256Digest(encoder.encode(sourceB)),
    );
    expect(readPluginArtifact(
      encoder.encode(first.bytes),
      first.digest,
      "fixture.wakepkg.json",
    )).toEqual(first.artifact);
  });

  test("rejects ambiguous or non-Beagle authored member paths", () => {
    const cases = [
      [manifest(["plugin.wake"], "plugin.wake"), "must name authored Beagle .bjs source"],
      [manifest(["../plugin.bjs"], "../plugin.bjs"), "escapes its package"],
      [manifest(["/plugin.bjs"], "/plugin.bjs"), "package-relative POSIX path"],
      [manifest(["C:/plugin.bjs"], "C:/plugin.bjs"), "package-relative POSIX path"],
      [manifest(["e\u0301.bjs"], "e\u0301.bjs"), "NFC Unicode normalization"],
      [manifest(["plugin.bjs", "plugin.bjs"]), "contains a duplicate"],
      [manifest(["plugin.bjs", "lib/a.bjs"]), "canonical path order"],
    ];
    for (const [candidate, message] of cases) {
      expect(() => validatePluginManifest(candidate)).toThrow(message);
    }

    const exactPath = `${"a".repeat(MAX_SOURCE_PATH_BYTES - 4)}.bjs`;
    expect(validatePluginManifest(manifest([exactPath], exactPath)).entry).toBe(exactPath);
    const longPath = `${"a".repeat(MAX_SOURCE_PATH_BYTES - 3)}.bjs`;
    expect(() => validatePluginManifest(manifest([longPath], longPath)))
      .toThrow(`exceeds ${MAX_SOURCE_PATH_BYTES} UTF-8 bytes`);
  });

  test("rejects BOMs, malformed UTF-8, and text controls", async () => {
    const manifestValue = manifest();
    const manifestBytes = encoder.encode(canonicalDocument(manifestValue));
    const hostileSources = [
      [new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(validSource)]), "byte-order mark"],
      [new Uint8Array([0xc3, 0x28]), "valid UTF-8"],
      [encoder.encode(`${validSource}\u0000`), "forbidden control character"],
    ];
    for (const [sourceBytes, message] of hostileSources) {
      await expect(temporaryPackage(
        manifestBytes,
        { "plugin.bjs": sourceBytes },
        packPlugin,
      )).rejects.toThrow(message);
    }

    const bomManifest = new Uint8Array([0xef, 0xbb, 0xbf, ...manifestBytes]);
    await expect(temporaryPackage(
      bomManifest,
      { "plugin.bjs": validSource },
      packPlugin,
    )).rejects.toThrow("byte-order mark");
  });

  test("accepts exact manifest and source ceilings and rejects one byte over", async () => {
    const exactManifest = manifest();
    exactManifest.packageId = "";
    const manifestOverhead = encoder.encode(canonicalDocument(exactManifest)).byteLength;
    exactManifest.packageId = "p".repeat(MAX_MANIFEST_BYTES - manifestOverhead);
    expect(encoder.encode(canonicalDocument(exactManifest))).toHaveLength(MAX_MANIFEST_BYTES);
    await expect(pack(exactManifest, { "plugin.bjs": validSource })).resolves.toBeDefined();

    const oversizedManifest = structuredClone(exactManifest);
    oversizedManifest.packageId += "p";
    await expect(pack(oversizedManifest, { "plugin.bjs": validSource }))
      .rejects.toThrow(`wake-plugin.json exceeds ${MAX_MANIFEST_BYTES} bytes`);

    const exactSource = sizedSource(MAX_SOURCE_BYTES);
    expect(encoder.encode(exactSource)).toHaveLength(MAX_SOURCE_BYTES);
    await expect(pack(manifest(), { "plugin.bjs": exactSource })).resolves.toBeDefined();
    await expect(pack(manifest(), { "plugin.bjs": `${exactSource}x` }))
      .rejects.toThrow(`manifest source plugin.bjs exceeds ${MAX_SOURCE_BYTES} bytes`);
  });

  test("accepts exact aggregate and member-count ceilings and rejects one over", async () => {
    const aggregateSources = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`part-${index}.bjs`, sizedSource(MAX_SOURCE_BYTES)]),
    );
    const aggregateManifest = manifest(Object.keys(aggregateSources), "part-0.bjs");
    await temporaryPackage(
      canonicalDocument(aggregateManifest),
      aggregateSources,
      async (root) => {
        await expect(packPlugin(root)).resolves.toBeDefined();
        aggregateManifest.sources.push("part-8.bjs");
        await writeFile(join(root, "part-8.bjs"), "x");
        await writeFile(join(root, "wake-plugin.json"), canonicalDocument(aggregateManifest));
        await expect(packPlugin(root))
          .rejects.toThrow(`manifest source bytes exceed ${MAX_TOTAL_SOURCE_BYTES} bytes`);
      },
    );

    const exactCount = Array.from(
      { length: MAX_SOURCE_COUNT },
      (_, index) => `source-${String(index).padStart(3, "0")}.bjs`,
    );
    expect(validatePluginManifest(manifest(exactCount, exactCount[0])).sources)
      .toHaveLength(MAX_SOURCE_COUNT);
    expect(() => validatePluginManifest(manifest(
      [...exactCount, "source-256.bjs"],
      exactCount[0],
    ))).toThrow(`manifest.sources exceeds ${MAX_SOURCE_COUNT} entries`);
  });

  test("keeps the versioned plugin artifact suffix closed", () => {
    const lock = {
      pluginAbiVersion: 1,
      plugins: [{
        artifact: "artifacts/plugin.wakepkg.json",
        digest: `sha256:${"a".repeat(64)}`,
        packageId: "plugin",
        source: { commit: "b".repeat(40), kind: "git" },
        version: "0.1.0",
      }],
      schemaVersion: 1,
    };
    expect(validateWakeLock(lock)).toBe(lock);
    const wrongSuffix = structuredClone(lock);
    wrongSuffix.plugins[0].artifact = "artifacts/plugin.json";
    expect(() => validateWakeLock(wrongSuffix)).toThrow("must end in .wakepkg.json");
  });

  test("bounds production artifact files before strict raw-byte decoding", async () => {
    await temporaryPackage(
      canonicalDocument(manifest()),
      { "plugin.bjs": validSource },
      async (root) => {
        const packed = await packPlugin(root);
        const artifactPath = join(root, "plugin.wakepkg.json");
        await writeFile(artifactPath, packed.bytes);
        await expect(readPluginArtifactFile(
          artifactPath,
          packed.digest,
          "plugin.wakepkg.json",
        )).resolves.toEqual(packed.artifact);

        const malformed = new Uint8Array([0xc3, 0x28]);
        await writeFile(artifactPath, malformed);
        await expect(readPluginArtifactFile(
          artifactPath,
          sha256Digest(malformed),
          "plugin.wakepkg.json",
        )).rejects.toThrow("must be valid UTF-8");

        await truncate(artifactPath, pluginPackageLimits.artifactBytes + 1);
        await expect(readPluginArtifactFile(
          artifactPath,
          packed.digest,
          "plugin.wakepkg.json",
        )).rejects.toThrow(
          `exceeds ${pluginPackageLimits.artifactBytes} bytes`,
        );
      },
    );
  });

  test("rejects artifact symlinks and non-regular files", async () => {
    await temporaryPackage(
      canonicalDocument(manifest()),
      { "plugin.bjs": validSource },
      async (root) => {
        const packed = await packPlugin(root);
        const targetPath = join(root, "target.wakepkg.json");
        const symlinkPath = join(root, "symlink.wakepkg.json");
        await writeFile(targetPath, packed.bytes);
        await symlink("target.wakepkg.json", symlinkPath);
        await expect(readPluginArtifactFile(
          symlinkPath,
          packed.digest,
          "symlink.wakepkg.json",
        )).rejects.toThrow("must not be a symlink");

        const directoryPath = join(root, "directory.wakepkg.json");
        await mkdir(directoryPath);
        await expect(readPluginArtifactFile(
          directoryPath,
          packed.digest,
          "directory.wakepkg.json",
        )).rejects.toThrow("must be a regular file");
      },
    );
  });

  test("keeps nested sources beneath retained package descriptors", async () => {
    const originalSource = `${validSource}(def provenance: String "package")\n`;
    const replacementSource = `${validSource}(def provenance: String "escaped")\n`;
    await temporaryPackage(
      canonicalDocument(manifest(["content/plugin.bjs"], "content/plugin.bjs")),
      { "content/plugin.bjs": originalSource },
      async (root) => {
        const contentPath = join(root, "content");
        const retainedPath = join(root, "content-retained");
        const replacementPath = join(root, "replacement");
        await mkdir(replacementPath);
        await writeFile(join(replacementPath, "plugin.bjs"), replacementSource);

        const originalOpen = fileSystemPromises.open;
        let swapped = false;
        const openSpy = spyOn(fileSystemPromises, "open")
          .mockImplementation(async function (path, ...arguments_) {
            if (!swapped && String(path).endsWith("/plugin.bjs")) {
              swapped = true;
              await rename(contentPath, retainedPath);
              await symlink("replacement", contentPath);
            }
            return originalOpen.call(this, path, ...arguments_);
          });
        try {
          const packed = await packPlugin(root);
          expect(swapped).toBe(true);
          expect(packed.artifact.files[0].content).toBe(originalSource);
          expect(packed.artifact.files[0].content).not.toBe(replacementSource);
        } finally {
          openSpy.mockRestore();
        }
      },
    );
  });

  test("rejects package-root and nested-directory symlinks", async () => {
    await temporaryPackage(
      canonicalDocument(manifest(["content/plugin.bjs"], "content/plugin.bjs")),
      { "content/plugin.bjs": validSource },
      async (root) => {
        const rootLink = join(root, "root-link");
        await symlink(".", rootLink);
        await expect(packPlugin(rootLink)).rejects.toThrow(
          "package root must be a directory, not a symlink",
        );

        await rename(join(root, "content"), join(root, "content-retained"));
        await symlink("content-retained", join(root, "content"));
        await expect(packPlugin(root)).rejects.toThrow(
          "manifest source content/plugin.bjs crosses a symlink or non-directory path",
        );
      },
    );
  });

  test("fails closed when an opened artifact pathname is replaced", async () => {
    await temporaryPackage(
      canonicalDocument(manifest()),
      { "plugin.bjs": validSource },
      async (root) => {
        const packed = await packPlugin(root);
        const artifactPath = join(root, "plugin.wakepkg.json");
        const displacedPath = join(root, "opened.wakepkg.json");
        const replacementPath = join(root, "replacement.wakepkg.json");
        await writeFile(artifactPath, packed.bytes);
        await writeFile(replacementPath, "replacement");

        const probe = await open(
          artifactPath,
          fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
        );
        const fileHandlePrototype = Object.getPrototypeOf(probe);
        const originalRead = fileHandlePrototype.read;
        await probe.close();

        let replaced = false;
        const readSpy = spyOn(fileHandlePrototype, "read")
          .mockImplementation(async function (...arguments_) {
            if (!replaced) {
              replaced = true;
              await rename(artifactPath, displacedPath);
              await rename(replacementPath, artifactPath);
            }
            return originalRead.apply(this, arguments_);
          });
        try {
          await expect(readPluginArtifactFile(
            artifactPath,
            packed.digest,
            "plugin.wakepkg.json",
          )).rejects.toThrow("changed while being read");
          expect(replaced).toBe(true);
          expect(await Bun.file(artifactPath).text()).toBe("replacement");
        } finally {
          readSpy.mockRestore();
        }
      },
    );
  });

  test("handles short reads without returning unread buffer bytes", async () => {
    await temporaryPackage(
      canonicalDocument(manifest()),
      { "plugin.bjs": validSource },
      async (root) => {
        const packed = await packPlugin(root);
        const artifactPath = join(root, "plugin.wakepkg.json");
        await writeFile(artifactPath, packed.bytes);

        const probe = await open(artifactPath, fileConstants.O_RDONLY);
        const fileHandlePrototype = Object.getPrototypeOf(probe);
        const originalRead = fileHandlePrototype.read;
        await probe.close();
        let shortReads = 0;
        const readSpy = spyOn(fileHandlePrototype, "read")
          .mockImplementation(async function (buffer, offset, length, position) {
            shortReads += 1;
            return originalRead.call(
              this,
              buffer,
              offset,
              Math.min(length, 7),
              position,
            );
          });
        try {
          await expect(readPluginArtifactFile(
            artifactPath,
            packed.digest,
            "plugin.wakepkg.json",
          )).resolves.toEqual(packed.artifact);
          expect(shortReads).toBeGreaterThan(1);
        } finally {
          readSpy.mockRestore();
        }
      },
    );
  });

  test("rejects truncation during a descriptor read", async () => {
    await temporaryPackage(
      canonicalDocument(manifest()),
      { "plugin.bjs": validSource },
      async (root) => {
        const packed = await packPlugin(root);
        const artifactPath = join(root, "plugin.wakepkg.json");
        await writeFile(artifactPath, packed.bytes);

        const probe = await open(artifactPath, fileConstants.O_RDONLY);
        const fileHandlePrototype = Object.getPrototypeOf(probe);
        const originalRead = fileHandlePrototype.read;
        await probe.close();
        let truncated = false;
        const readSpy = spyOn(fileHandlePrototype, "read")
          .mockImplementation(async function (buffer, offset, length, position) {
            const result = await originalRead.call(
              this,
              buffer,
              offset,
              Math.min(length, 16),
              position,
            );
            if (!truncated && result.bytesRead > 0) {
              truncated = true;
              await truncate(artifactPath, 8);
            }
            return result;
          });
        try {
          await expect(readPluginArtifactFile(
            artifactPath,
            packed.digest,
            "plugin.wakepkg.json",
          )).rejects.toThrow("changed while being read");
          expect(truncated).toBe(true);
        } finally {
          readSpy.mockRestore();
        }
      },
    );
  });
});
