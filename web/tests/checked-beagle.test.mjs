import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const webRoot = `${import.meta.dir}/..`;
const compile = `${webRoot}/bin/wake-compile`;
const source = resolve(webRoot, "tests/fixtures/checked-beagle/application.bjs");
const beagleRoot = process.env.BEAGLE_PROJECTION_ROOT
  ?? process.env.BEAGLE_ROOT
  ?? `${process.env.HOME}/code/beagle/main`;
const beagle = `${beagleRoot}/bin/beagle`;
const moduleRoot = ["--module-root", `web=${webRoot}`];

function compileDriver(arguments_) {
  return Bun.spawnSync(
    ["bun", "--no-install", `${webRoot}/compiler/compile-driver.mjs`, ...arguments_],
    { cwd: webRoot, stderr: "pipe", stdout: "pipe" },
  );
}

test("Wake source is an ordinary typed Beagle program", () => {
  const result = Bun.spawnSync([beagle, "ast", ...moduleRoot, source], {
    cwd: webRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const ast = JSON.parse(result.stdout.toString());
  const definitions = new Map(
    ast.forms
      .filter((form) => form.node === "def")
      .map((form) => [form.name, form.value.inferredType.name]),
  );
  expect(definitions.get("page")).toBe("wake.core/EntityDeclarationSpec");
  expect(definitions.get("published-revisions")).toBe("wake.core/QueryDeclarationSpec");
  expect(definitions.get("application")).toBe("wake.core/ApplicationRootSpec");
}, 60_000);

test("typed Beagle input reaches Wake graph and code generation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-typed-beagle-"));
  try {
    const result = Bun.spawnSync([compile, "--all", source, temporary], {
      cwd: webRoot,
      env: {
        ...process.env,
        BEAGLE_ROOT: process.env.BEAGLE_PROJECTION_ROOT ?? process.env.BEAGLE_ROOT,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const plan = JSON.parse(readFileSync(join(temporary, "app.store.json"), "utf8"));
    expect(plan.applicationId).toBe("wake-checked-beagle-fixture");
    expect(plan.entities.map((entity) => entity.name)).toEqual(["page", "revision"]);
    expect(readFileSync(join(temporary, "app.js"), "utf8")).toContain(
      '// Source: "wake.fixtures.checked-beagle"',
    );
    expect(readFileSync(join(temporary, "wake-client.js"), "utf8")).toContain(
      'export const applicationId = "wake-checked-beagle-fixture";',
    );

    const manifest = JSON.parse(
      readFileSync(join(temporary, "app.wake.manifest.json"), "utf8"),
    );
    const deployment = JSON.parse(
      readFileSync(join(temporary, "app.wake.deployment.json"), "utf8"),
    );
    expect(deployment.applicationId).toBe(manifest.applicationId);
    for (const [receiptKey, artifactKey] of [
      ["browserClientDigest", "browserClient"],
      ["browserJavaScriptDigest", "browserJavaScript"],
      ["storePlanDigest", "storePlan"],
    ]) {
      expect(deployment[receiptKey]).toBe(manifest.artifacts[artifactKey].sha256);
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, 60_000);

test("compile driver exposes no caller-supplied AST route", () => {
  const result = compileDriver([
    "--ast", "/tmp/forged.json",
    "--dist", "/tmp/unreachable",
    "--mode", "store",
    "--source", source,
    "--output", "-",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("driver rejects unsupported option --ast");
});

test("external source identity depends only on exact bytes", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-external-source-"));
  try {
    const outputs = [];
    for (const directory of ["first", "second"]) {
      const root = join(temporary, directory);
      const externalSource = join(root, "application.bjs");
      const output = join(root, "app.store.json");
      mkdirSync(root);
      copyFileSync(source, externalSource);
      const result = Bun.spawnSync([compile, "--store", externalSource, output], {
        cwd: webRoot,
        env: {
          ...process.env,
          BEAGLE_ROOT: process.env.BEAGLE_PROJECTION_ROOT ?? process.env.BEAGLE_ROOT,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      outputs.push(readFileSync(output, "utf8"));
    }
    expect(outputs[0]).toBe(outputs[1]);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, 60_000);
