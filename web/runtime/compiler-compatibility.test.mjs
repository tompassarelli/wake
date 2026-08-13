import { describe, expect, test } from "bun:test";

import {
  checkWakeCompilerCompatibility,
  wakeRuntimeCompilerContract,
} from "./compiler-compatibility.mjs";

const compilerCommit = "deef83bc1d218fb125067c05802c96158a3d7390";

function compatibility() {
  return {
    compiler: {
      name: "wake",
      sourceCommit: compilerCommit,
      version: "0.1.0",
    },
    manifestSchemaVersion: 1,
    protocols: {
      framPlanSchemaVersion: 2,
      httpOperationProtocolVersion: 2,
      pluginAbiVersion: 1,
    },
  };
}

function withCompiler(mutate) {
  const value = compatibility();
  mutate(value.compiler);
  return value;
}

describe("Wake runtime compiler compatibility", () => {
  test("accepts the exact 0.1.0 compiler contract independently of runtime source", () => {
    const checked = checkWakeCompilerCompatibility(compatibility());

    expect(checked).toEqual(compatibility());
    expect(checked.compiler.sourceCommit).toBe(compilerCommit);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(checked.compiler)).toBe(true);
    expect(Object.isFrozen(checked.protocols)).toBe(true);
    expect(wakeRuntimeCompilerContract).toEqual({
      compiler: { name: "wake", version: "0.1.0" },
      manifestSchemaVersion: 1,
      protocols: compatibility().protocols,
    });
  });

  test("rejects null, extended, and malformed compiler metadata", () => {
    for (const value of [
      { ...compatibility(), compiler: null },
      withCompiler(compiler => { compiler.unexpected = true; }),
      withCompiler(compiler => { compiler.sourceCommit = "deef83bc"; }),
      withCompiler(compiler => { compiler.version = "0.1"; }),
    ]) {
      expect(() => checkWakeCompilerCompatibility(value)).toThrow(
        expect.objectContaining({ code: "compiler/invalid-metadata" }),
      );
    }
  });

  test("rejects exact but incompatible compiler and protocol contracts", () => {
    const compilerMismatch = withCompiler(compiler => { compiler.version = "0.1.1"; });
    const protocolMismatch = compatibility();
    protocolMismatch.protocols.pluginAbiVersion = 2;

    for (const value of [compilerMismatch, protocolMismatch]) {
      expect(() => checkWakeCompilerCompatibility(value)).toThrow(
        expect.objectContaining({ code: "compiler/incompatible" }),
      );
    }
  });
});
