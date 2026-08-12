import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const compile = `${webRoot}/bin/wake-compile`;
const fixtures = `${webRoot}/tests/fixtures/beagle-source`;

function compileAll(source, output) {
  const result = Bun.spawnSync([compile, "--all", source, output], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function withoutFingerprint(value) {
  if (Array.isArray(value)) return value.map(withoutFingerprint);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "semanticFingerprint")
    .map(([key, child]) => [key, withoutFingerprint(child)]));
}

function normalizeFingerprint(text) {
  return text.replaceAll(/sha256:[0-9a-f]{64}/gu, "sha256:<fingerprint>");
}

test("checked Beagle source reaches Wake graph and codegen unchanged", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-beagle-source-"));
  const beagleOutput = join(temporary, "beagle");
  const legacyOutput = join(temporary, "legacy");
  try {
    compileAll(join(fixtures, "application.wake.bjs"), beagleOutput);
    compileAll(join(fixtures, "legacy.wake"), legacyOutput);

    const beaglePlan = JSON.parse(readFileSync(join(beagleOutput, "app.fram.json"), "utf8"));
    const legacyPlan = JSON.parse(readFileSync(join(legacyOutput, "app.fram.json"), "utf8"));
    expect(withoutFingerprint(beaglePlan)).toEqual(withoutFingerprint(legacyPlan));

    const beagleJavaScript = normalizeFingerprint(
      readFileSync(join(beagleOutput, "app.js"), "utf8"),
    );
    const legacyJavaScript = normalizeFingerprint(
      readFileSync(join(legacyOutput, "app.js"), "utf8"),
    );
    expect(beagleJavaScript).toBe(legacyJavaScript);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, 30_000);
