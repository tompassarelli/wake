import { describe, expect, test } from "bun:test";

import {
  canonicalDocument,
  sha256Digest,
} from "../runtime/canonical.mjs";

const webRoot = `${import.meta.dir}/..`;
const packer = `${webRoot}/bin/wake-runtime-pack`;
const receiptPath = `${webRoot}/release/wake-runtime-1.1.0.receipt.json`;
const archiveName = "tompassarelli-wake-runtime-1.1.0.tgz";
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

function run(command) {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return result.stdout;
}

function temporaryDirectory(label) {
  return new TextDecoder()
    .decode(run(["mktemp", "-d", `/tmp/${label}.XXXXXX`]))
    .trim();
}

describe("@tompassarelli/wake-runtime package", () => {
  test("packs a deterministic, receipt-bound production-only artifact", async () => {
    const scratch = temporaryDirectory("wake-runtime-package");
    try {
      const first = `${scratch}/first`;
      const second = `${scratch}/second`;
      run([packer, "--output", first, "--check", receiptPath]);
      run([packer, "--output", second, "--check", receiptPath]);

      const firstArchive = new Uint8Array(
        await Bun.file(`${first}/${archiveName}`).arrayBuffer(),
      );
      const secondArchive = new Uint8Array(
        await Bun.file(`${second}/${archiveName}`).arrayBuffer(),
      );
      expect(firstArchive).toEqual(secondArchive);

      const receiptText = await Bun.file(receiptPath).text();
      const receipt = JSON.parse(receiptText);
      expect(receiptText).toBe(canonicalDocument(receipt));
      expect(receipt.artifact).toEqual({
        filename: archiveName,
        sha256: sha256Digest(firstArchive),
        size: firstArchive.byteLength,
      });
      expect(receipt.package).toEqual({
        name: "@tompassarelli/wake-runtime",
        version: "1.1.0",
      });
      expect(receipt.packer).toBe(`bun@${Bun.version}`);
      expect(receipt.schemaVersion).toBe(1);

      const listed = new TextDecoder()
        .decode(run(["tar", "-tzf", `${first}/${archiveName}`]))
        .trim()
        .split("\n")
        .sort();
      expect(listed).toEqual(expectedFiles);
      expect(listed.some(path => /compiler|plugins|wiki|\.test\./u.test(path)))
        .toBe(false);
      expect(receipt.files.map(file => file.path)).toEqual(expectedFiles);

      const extracted = `${scratch}/extracted`;
      run(["mkdir", "-p", extracted]);
      run(["tar", "-xzf", `${first}/${archiveName}`, "-C", extracted]);
      const publicModule = await import(`${extracted}/package/index.mjs`);
      expect(Object.keys(publicModule).sort()).toEqual([
        "CheckedValueError",
        "WakeWorkerConfigError",
        "compileCheckedValue",
        "createWakeApplicationAdapter",
        "createWakeBunAdapter",
        "createWakeWorkerHost",
        "installApplication",
        "loadApplicationReceipt",
        "normalizeCheckedValue",
        "rejectProviderInput",
        "renderSafeDocument",
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
        const source = await Bun.file(`${extracted}/${path}`).text();
        expect(source).not.toMatch(/\.\.\/|node:/u);
      }
    } finally {
      run(["rm", "-rf", scratch]);
    }
  });
});
