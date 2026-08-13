import { describe, expect, test } from "bun:test";
import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "../compiler/canonical.mjs";
import {
  packPlugin,
  readPluginArtifact,
  validatePluginManifest,
  validateWakeLock,
} from "../compiler/plugin-package.mjs";

const testDir = import.meta.dir;
const webRoot = `${testDir}/..`;
const fixtureRoot = `${testDir}/fixtures/neutral-plugin`;
const goldenRoot = `${fixtureRoot}/artifacts`;

async function canonicalAt(path) {
  const text = await Bun.file(path).text();
  return { text, value: parseCanonicalDocument(text, path) };
}

describe("W0C frozen compiler contracts", () => {
  test("publishes the three versioned closed schemas", async () => {
    for (const name of [
      "wake-plugin-v1.schema.json",
      "wake-lock-v1.schema.json",
      "app-wake-manifest-v1.schema.json",
    ]) {
      const schema = await Bun.file(`${webRoot}/contracts/${name}`).json();
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
    }

    const pluginSchema = await Bun.file(
      `${webRoot}/contracts/wake-plugin-v1.schema.json`,
    ).json();
    expect(pluginSchema.properties.entry.$ref).toBe("#/$defs/source-path");
    expect(pluginSchema.properties.sources.items.$ref)
      .toBe("#/$defs/source-path");
    expect(pluginSchema.$defs["source-path"]).toEqual({
      allOf: [
        { $ref: "#/$defs/path" },
        { pattern: "\\.bjs$" },
      ],
    });
    const authoredSourcePattern = new RegExp(
      pluginSchema.$defs["source-path"].allOf[1].pattern,
      "u",
    );
    expect(authoredSourcePattern.test("plugin.bjs")).toBe(true);
    expect(authoredSourcePattern.test("plugin.wake")).toBe(false);
    expect(pluginSchema.required).toEqual([
      "compatibleWake",
      "durableSchemaVersion",
      "entry",
      "packageId",
      "pluginAbiVersion",
      "schemaVersion",
      "sources",
      "version",
    ]);
  });

  test("packs one neutral plugin into byte-identical canonical bytes", async () => {
    const manifest = (await canonicalAt(`${fixtureRoot}/wake-plugin.json`)).value;
    expect(validatePluginManifest(manifest)).toBe(manifest);
    expect(manifest).toEqual({
      compatibleWake: "0.1.0",
      durableSchemaVersion: 1,
      entry: "plugin.bjs",
      packageId: "wake-neutral-release",
      pluginAbiVersion: 1,
      schemaVersion: 1,
      sources: ["plugin.bjs"],
      version: "0.1.0",
    });

    const first = await packPlugin(fixtureRoot);
    const second = await packPlugin(fixtureRoot);
    expect(first.bytes).toBe(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(Object.keys(first.artifact).sort()).toEqual([
      "files",
      "manifest",
      "schemaVersion",
    ]);
    expect(first.artifact.files).toHaveLength(1);
    expect(Object.keys(first.artifact.files[0]).sort()).toEqual([
      "content",
      "mode",
      "path",
      "sha256",
    ]);
    expect(first.artifact.files[0]).toMatchObject({
      mode: "text",
      path: "plugin.bjs",
    });
    expect(first.artifact.files[0].sha256)
      .toBe(sha256Digest(first.artifact.files[0].content));
    expect(readPluginArtifact(first.bytes, first.digest, "neutral fixture"))
      .toEqual(first.artifact);

    const golden = await canonicalAt(`${goldenRoot}/neutral-plugin.wakepkg.json`);
    expect(first.bytes).toBe(golden.text);
    expect(first.digest).toBe(sha256Digest(golden.text));
  });

  test("locks the exact package artifact and records it in the app manifest", async () => {
    const artifact = await canonicalAt(`${goldenRoot}/neutral-plugin.wakepkg.json`);
    const lock = await canonicalAt(`${fixtureRoot}/wake.lock`);
    const manifest = await canonicalAt(`${goldenRoot}/app.wake.manifest.json`);
    expect(validateWakeLock(lock.value)).toBe(lock.value);
    expect(lock.value).toEqual({
      pluginAbiVersion: 1,
      plugins: [{
        artifact: "artifacts/neutral-plugin.wakepkg.json",
        digest: sha256Digest(artifact.text),
        packageId: "wake-neutral-release",
        source: {
          commit: "3189fbb4289b62e1a39141ac35bbed27cad3ea27",
          kind: "git",
        },
        version: "0.1.0",
      }],
      schemaVersion: 1,
    });
    expect(Object.keys(manifest.value).sort()).toEqual([
      "applicationId",
      "artifacts",
      "checkedApplication",
      "compiler",
      "digests",
      "hostCapabilities",
      "plugins",
      "protocols",
      "schemaVersion",
    ]);
    expect(Object.keys(manifest.value.artifacts).sort()).toEqual([
      "browserJavaScript",
      "framPlan",
    ]);
    expect(Object.keys(manifest.value.plugins[0]).sort()).toEqual([
      "alias",
      "allowedContributions",
      "artifactDigest",
      "configuration",
      "configurationDigest",
      "durableSchemaVersion",
      "migrationOrdinal",
      "packageId",
      "source",
      "version",
    ]);
    expect(manifest.value.plugins[0].artifactDigest)
      .toBe(lock.value.plugins[0].digest);
    expect(manifest.value.checkedApplication.fingerprint)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(manifest.value.artifacts).not.toHaveProperty("manifest");
  });

});
