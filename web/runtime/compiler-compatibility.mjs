const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export const wakeRuntimeCompilerContract = Object.freeze({
  compiler: Object.freeze({
    name: "wake",
    version: "0.1.0",
  }),
  manifestSchemaVersion: 1,
  protocols: Object.freeze({
    framPlanSchemaVersion: 2,
    httpOperationProtocolVersion: 2,
    pluginAbiVersion: 1,
  }),
});

export class WakeCompilerCompatibilityError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "WakeCompilerCompatibilityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WakeCompilerCompatibilityError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) {
    fail("compiler/invalid-metadata", `${label} has an invalid shape`);
  }
}

/**
 * Checks compiler identity and every emitted protocol against this runtime's
 * declared contract. sourceCommit remains exact provenance evidence bound by
 * the canonical manifest; it is not the runtime package's source identity.
 */
export function checkWakeCompilerCompatibility(value) {
  exactKeys(value, ["compiler", "manifestSchemaVersion", "protocols"], "compiler contract input");
  exactKeys(value.compiler, ["name", "sourceCommit", "version"], "compiler metadata");
  if (typeof value.compiler.name !== "string" || value.compiler.name.length === 0) {
    fail("compiler/invalid-metadata", "compiler.name must be a nonempty string");
  }
  if (typeof value.compiler.version !== "string" || !VERSION.test(value.compiler.version)) {
    fail(
      "compiler/invalid-metadata",
      "compiler.version must be an exact major.minor.patch version",
    );
  }
  if (typeof value.compiler.sourceCommit !== "string"
      || !COMMIT.test(value.compiler.sourceCommit)) {
    fail("compiler/invalid-metadata", "compiler.sourceCommit must be one Git commit");
  }
  if (!Number.isSafeInteger(value.manifestSchemaVersion)
      || value.manifestSchemaVersion < 1) {
    fail("compiler/invalid-metadata", "manifestSchemaVersion must be a positive integer");
  }

  const expected = wakeRuntimeCompilerContract;
  exactKeys(value.protocols, Object.keys(expected.protocols), "compiler protocols");
  for (const name of Object.keys(expected.protocols)) {
    if (!Number.isSafeInteger(value.protocols[name]) || value.protocols[name] < 1) {
      fail("compiler/invalid-metadata", `compiler protocols.${name} must be a positive integer`);
    }
  }

  if (value.compiler.name !== expected.compiler.name
      || value.compiler.version !== expected.compiler.version
      || value.manifestSchemaVersion !== expected.manifestSchemaVersion
      || Object.entries(expected.protocols).some(([name, version]) =>
        value.protocols[name] !== version)) {
    fail(
      "compiler/incompatible",
      `Wake runtime requires compiler ${expected.compiler.name} ${expected.compiler.version}`,
    );
  }

  return Object.freeze({
    compiler: Object.freeze({ ...value.compiler }),
    manifestSchemaVersion: value.manifestSchemaVersion,
    protocols: Object.freeze({ ...value.protocols }),
  });
}
