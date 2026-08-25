import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const webRoot = `${import.meta.dir}/..`;

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

test("wake-compile stages the complete Beagle runtime for a fresh graph import", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-compiler-staging-"));
  try {
    const stagedWeb = join(temporary, "web");
    const stagedBin = join(stagedWeb, "bin");
    const stagedCompiler = join(stagedWeb, "compiler");
    const stagedWake = join(stagedWeb, "wake");
    const runtime = join(temporary, "runtime");
    const cache = join(temporary, "cache");
    const source = join(temporary, "application.bjs");
    const builder = join(temporary, "beagle-build");

    mkdirSync(stagedBin, { recursive: true });
    mkdirSync(stagedCompiler, { recursive: true });
    mkdirSync(stagedWake, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    copyFileSync(join(webRoot, "bin", "wake-compile"), join(stagedBin, "wake-compile"));
    writeFileSync(join(stagedWeb, "package.json"), '{"type":"module"}\n');
    writeFileSync(source, "#lang beagle/js\n");
    for (const module of ["ir", "graph", "ui", "js-ast", "emit-store", "codegen"]) {
      writeFileSync(join(stagedWake, `${module}.bjs`), `;; ${module}\n`);
    }
    writeFileSync(join(runtime, "core.js"), "export const core = true;\n");
    writeFileSync(join(runtime, "hamt.js"), "export const hamt = true;\n");
    writeFileSync(join(runtime, "exception-info.js"), "export class ExceptionInfo extends Error {}\n");

    writeExecutable(builder, `#!/usr/bin/env bash
set -euo pipefail
source="${'$'}{@: -2:1}"
output="${'$'}{!#}"
case "${'$'}source" in
  *graph.bjs) printf '%s\\n' "import { ExceptionInfo } from './beagle/exception-info.js';" 'function check_linked_declaration_program(value) { return value ?? ExceptionInfo; }' > "${'$'}output" ;;
  *emit-store.bjs) printf '%s\\n' 'function gen_store() { return "{}"; }' 'export { gen_store as "gen-store" };' > "${'$'}output" ;;
  *) printf '%s\\n' 'function generated() { return null; }' > "${'$'}output" ;;
esac
`);
    writeFileSync(join(stagedCompiler, "compile-driver.mjs"), `
import { pathToFileURL } from "node:url";

const dist = Bun.argv[Bun.argv.indexOf("--dist") + 1];
const graph = await import(new URL("graph.js", pathToFileURL(dist.replace(/\\/+$/u, "") + "/")).href);
if (typeof graph.check_linked_declaration_program !== "function") process.exit(1);
const emitStore = await import(new URL("emit-store.js", pathToFileURL(dist.replace(/\\/+$/u, "") + "/")).href);
if (emitStore["gen-store"]() !== "{}") process.exit(1);
`);

    const result = Bun.spawnSync(
      [join(stagedBin, "wake-compile"), "--store", source, "-"],
      {
        cwd: stagedWeb,
        env: {
          ...process.env,
          BEAGLE_BUILD: builder,
          BEAGLE_RUNTIME_DIR: runtime,
          WAKE_COMPILE_CACHE: cache,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, 30_000);
