import { describe, expect, test } from "bun:test";

import {
  canonicalDocument,
  sha256Digest,
} from "../runtime/canonical.mjs";

const webRoot = `${import.meta.dir}/..`;
const repositoryRoot = `${webRoot}/..`;
const packer = `${webRoot}/bin/wake-runtime-pack`;
const archiveName = "tompassarelli-wake-runtime-0.2.0.tgz";
const receiptName = "tompassarelli-wake-runtime-0.2.0.receipt.json";
const releaseTagEnvironment = Object.freeze({
  ...process.env,
  GIT_COMMITTER_DATE: "2026-08-12T00:01:00Z",
  GIT_COMMITTER_EMAIL: "wake@example.invalid",
  GIT_COMMITTER_NAME: "Wake Release",
});
const expectedFiles = [
  "package/LICENSE-APACHE",
  "package/LICENSE-MIT",
  "package/README.md",
  "package/application-installer.mjs",
  "package/application-receipt.mjs",
  "package/bun-adapter.mjs",
  "package/canonical.mjs",
  "package/checked-value.mjs",
  "package/commands.mjs",
  "package/compiler-compatibility.mjs",
  "package/cursor-provider.mjs",
  "package/fram-gateway.mjs",
  "package/fram-http.mjs",
  "package/index.d.ts",
  "package/index.mjs",
  "package/named-query.mjs",
  "package/package.json",
  "package/safe-document.mjs",
  "package/worker-host.mjs",
];

function run(command, options = {}) {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return result.stdout;
}

function fails(command, options = {}) {
  return Bun.spawnSync(command, {
    cwd: options.cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
}

function temporaryDirectory(label) {
  return new TextDecoder()
    .decode(run(["mktemp", "-d", `/tmp/${label}.XXXXXX`]))
    .trim();
}

function removeTemporaryDirectory(path, label) {
  if (!path.startsWith(`/tmp/${label}.`) || path.includes("/../")) {
    throw new Error(`refusing to remove unverified test scratch: ${path}`);
  }
  run(["rm", "-rf", "--", path]);
}

function copyRuntime(source) {
  run(["mkdir", "-p", `${source}/web`]);
  run(["cp", "-R", `${webRoot}/runtime`, `${source}/web/runtime`]);
}

function releaseSource(scratch) {
  const seed = `${scratch}/seed`;
  copyRuntime(seed);
  run(["git", "init", "-q"], { cwd: seed });
  run(["git", "config", "user.name", "Wake Release"], { cwd: seed });
  run(["git", "config", "user.email", "wake@example.invalid"], { cwd: seed });
  run(["git", "remote", "add", "origin", "https://github.com/tompassarelli/wake.git"], {
    cwd: seed,
  });
  run(["git", "add", "web/runtime"], { cwd: seed });
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-12T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-12T00:00:00Z",
  };
  run(["git", "commit", "-q", "-m", "Wake 0.2.0 runtime"], { cwd: seed, env: environment });
  run(["git", "tag", "-a", "v0.2.0", "-m", "Wake v0.2.0"], {
    cwd: seed,
    env: releaseTagEnvironment,
  });
  const sourceCommit = new TextDecoder().decode(run(["git", "rev-parse", "HEAD"], {
    cwd: seed,
  })).trim();
  const releaseTagObject = new TextDecoder().decode(run([
    "git", "rev-parse", "refs/tags/v0.2.0",
  ], { cwd: seed })).trim();

  const first = `${scratch}/first-source`;
  const second = `${scratch}/different/depth/second-source`;
  run(["mkdir", "-p", `${scratch}/different/depth`]);
  run(["git", "clone", "-q", "--no-local", seed, first]);
  run(["git", "clone", "-q", "--no-local", seed, second]);
  for (const path of [first, second]) {
    run(["git", "remote", "set-url", "origin", "https://github.com/tompassarelli/wake.git"], {
      cwd: path,
    });
  }
  run(["touch", "-t", "203801020304.05", `${second}/web/runtime/index.mjs`]);
  return Object.freeze({ first, releaseTagObject, second, seed, sourceCommit });
}

function pack(source, output, receipt = `${output}/${receiptName}`) {
  run(["mkdir", "-p", output]);
  run([
    packer,
    "--source-root", source,
    "--version", "v0.2.0",
    "--output", output,
    "--receipt", receipt,
  ]);
  return Object.freeze({
    archive: `${output}/${archiveName}`,
    receipt,
  });
}

describe("@tompassarelli/wake-runtime package", () => {
  test("packs deterministic source-bound production-only release bytes", async () => {
    const scratch = temporaryDirectory("wake-runtime-package");
    try {
      const source = releaseSource(scratch);
      const first = pack(source.first, `${scratch}/first`);
      const second = pack(source.second, `${scratch}/second`);

      const firstArchive = new Uint8Array(await Bun.file(first.archive).arrayBuffer());
      const secondArchive = new Uint8Array(await Bun.file(second.archive).arrayBuffer());
      expect(firstArchive).toEqual(secondArchive);
      expect(await Bun.file(first.receipt).text()).toBe(await Bun.file(second.receipt).text());

      const hiddenInput = "web/runtime/index.mjs";
      run(["git", "update-index", "--assume-unchanged", hiddenInput], {
        cwd: source.first,
      });
      const hiddenPath = `${source.first}/${hiddenInput}`;
      await Bun.write(
        hiddenPath,
        `${await Bun.file(hiddenPath).text()}\nthrow new Error("not in the tagged tree");\n`,
      );
      expect(new TextDecoder().decode(run([
        "git", "status", "--porcelain=v1", "--untracked-files=all",
      ], { cwd: source.first }))).toBe("");
      const hidden = pack(source.first, `${scratch}/hidden-worktree`);
      expect(new Uint8Array(await Bun.file(hidden.archive).arrayBuffer()))
        .toEqual(firstArchive);
      expect(await Bun.file(hidden.receipt).text())
        .toBe(await Bun.file(first.receipt).text());

      const receiptText = await Bun.file(first.receipt).text();
      const receipt = JSON.parse(receiptText);
      expect(receiptText).toBe(canonicalDocument(receipt));
      expect(receipt.artifact).toEqual({
        filename: archiveName,
        sha256: sha256Digest(firstArchive),
        size: firstArchive.byteLength,
      });
      expect(receipt.package).toEqual({
        name: "@tompassarelli/wake-runtime",
        version: "0.2.0",
      });
      expect(receipt.packer).toBe(`bun@${Bun.version}`);
      expect(receipt.schemaVersion).toBe(2);
      expect(receipt.source).toEqual({
        commit: source.sourceCommit,
        releaseTag: "v0.2.0",
        releaseTagObject: source.releaseTagObject,
        repository: "https://github.com/tompassarelli/wake.git",
      });

      const listed = new TextDecoder()
        .decode(run(["tar", "-tzf", first.archive]))
        .trim()
        .split("\n")
        .sort();
      expect(listed).toEqual(expectedFiles);
      expect(listed.some(path => /package\/(?:compiler|plugins|wiki)\/|\.test\./u.test(path)))
        .toBe(false);
      expect(receipt.files.map(file => file.path)).toEqual(expectedFiles);

      run([
        packer,
        "--source-root", source.first,
        "--version", "v0.2.0",
        "--output", `${scratch}/checked`,
        "--check", first.receipt,
      ]);

      const extracted = `${scratch}/extracted`;
      run(["mkdir", "-p", extracted]);
      run(["tar", "-xzf", first.archive, "-C", extracted]);
      const publicModule = await import(`${extracted}/package/index.mjs`);
      expect(Object.keys(publicModule).sort()).toEqual([
        "CheckedValueError",
        "WakeCompilerCompatibilityError",
        "WakeWorkerConfigError",
        "checkWakeCompilerCompatibility",
        "compileCheckedValue",
        "createWakeApplicationAdapter",
        "createWakeBunAdapter",
        "createWakeWorkerHost",
        "installApplication",
        "loadApplicationReceipt",
        "normalizeCheckedValue",
        "rejectProviderInput",
        "renderSafeDocument",
        "wakeRuntimeCompilerContract",
      ]);
      const checkedValue = publicModule.compileCheckedValue({
        kind: "string",
        maxLength: 4,
      });
      expect(checkedValue.normalize("wake")).toBe("wake");
      expect(() => checkedValue.normalize("wake!"))
        .toThrow(expect.any(publicModule.CheckedValueError));
      expect(() => publicModule.rejectProviderInput("invalid content", { field: "body" }))
        .toThrow(expect.objectContaining({
          code: "command/provider-rejected",
          detail: { field: "body" },
          message: "invalid content",
        }));
      const packageJson = await Bun.file(`${extracted}/package/package.json`).json();
      expect(packageJson.exports).toEqual({
        ".": {
          import: "./index.mjs",
          types: "./index.d.ts",
        },
      });
      for (const path of listed.filter(path => path.endsWith(".mjs"))) {
        const sourceText = await Bun.file(`${extracted}/${path}`).text();
        expect(sourceText).not.toMatch(/\.\.\/|node:/u);
      }
    } finally {
      removeTemporaryDirectory(scratch, "wake-runtime-package");
    }
  });

  test("refuses untagged, lightweight-tagged, dirty, wrong-origin, and mismatched releases", () => {
    const scratch = temporaryDirectory("wake-runtime-package-refusal");
    try {
      const source = releaseSource(scratch);
      run(["git", "tag", "-d", "v0.2.0"], { cwd: source.first });
      expect(fails([
        packer, "--source-root", source.first, "--version", "v0.2.0",
        "--output", `${scratch}/untagged`,
      ]).exitCode).not.toBe(0);

      run(["git", "tag", "v0.2.0"], { cwd: source.first });
      expect(fails([
        packer, "--source-root", source.first, "--version", "v0.2.0",
        "--output", `${scratch}/lightweight`,
      ]).exitCode).not.toBe(0);

      run(["git", "tag", "-d", "v0.2.0"], { cwd: source.first });
      run(["git", "tag", "-a", "v0.2.0", "-m", "Wake v0.2.0"], {
        cwd: source.first,
        env: releaseTagEnvironment,
      });
      run(["git", "tag", "-a", "v0.2.1", "-m", "Wake v0.2.1"], {
        cwd: source.first,
        env: releaseTagEnvironment,
      });
      expect(fails([
        packer, "--source-root", source.first, "--version", "v0.2.1",
        "--output", `${scratch}/mismatched`,
      ]).exitCode).not.toBe(0);

      run(["git", "remote", "set-url", "origin", "https://example.invalid/wake.git"], {
        cwd: source.first,
      });
      expect(fails([
        packer, "--source-root", source.first, "--version", "v0.2.0",
        "--output", `${scratch}/origin`,
      ]).exitCode).not.toBe(0);

      run(["git", "remote", "set-url", "origin", "https://github.com/tompassarelli/wake.git"], {
        cwd: source.first,
      });
      run(["touch", `${source.first}/untracked`]);
      expect(fails([
        packer, "--source-root", source.first, "--version", "v0.2.0",
        "--output", `${scratch}/dirty`,
      ]).exitCode).not.toBe(0);
    } finally {
      removeTemporaryDirectory(scratch, "wake-runtime-package-refusal");
    }
  });
});
