import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "./canonical.mjs";
import {
  configurationDeclarationDescriptors,
  validateConfigurationSchema,
} from "./plugin-configuration.mjs";

const PACKAGE_SCHEMA_VERSION = 1;
const PLUGIN_ABI_VERSION = 1;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const CONTRIBUTIONS = new Set([
  "schema",
  "query",
  "command",
  "capability",
  "ui",
  "route",
]);

function fail(message) {
  throw new TypeError(`wake plugin: ${message}`);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function exactVersion(value, label) {
  nonempty(value, label);
  if (!VERSION.test(value)) fail(`${label} must be an exact major.minor.patch version`);
  return value;
}

function relativePath(value, label) {
  nonempty(value, label);
  if (value.startsWith("/") || value.includes("\\")) {
    fail(`${label} must be a package-relative POSIX path`);
  }
  const pieces = value.split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) {
    fail(`${label} escapes its package`);
  }
  return value;
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`${label} must be an array of nonempty strings`);
  }
  if (new Set(value).size !== value.length) fail(`${label} contains a duplicate`);
  return value;
}

function validateConfiguration(value) {
  validateConfigurationSchema(value, "manifest.configuration", fail);
}

function validateConfigurationDeclarations(manifest) {
  for (const descriptor of configurationDeclarationDescriptors(manifest.configuration)) {
    const { declarationId, declarationKind, path } = descriptor;
    if (declarationKind === "entity" && !(declarationId in manifest.storageIds.entities)) {
      fail(`manifest.configuration.${path}.type.declarationId names unknown entity '${declarationId}'`);
    }
    if (declarationKind === "field" && !(declarationId in manifest.storageIds.fields)) {
      fail(`manifest.configuration.${path}.type.declarationId names unknown field '${declarationId}'`);
    }
  }
}

function validateExports(value) {
  if (!plainObject(value)) fail("manifest.exports must be an object");
  const allowed = new Set([
    "capabilities",
    "commands",
    "components",
    "entities",
    "providerPorts",
    "queries",
    "routes",
    "states",
    "valueTypes",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`manifest.exports contains unknown category ${key}`);
    uniqueStrings(value[key], `manifest.exports.${key}`);
  }
  for (const required of ["capabilities", "commands", "components", "entities", "providerPorts", "queries", "routes"]) {
    if (!(required in value)) fail(`manifest.exports requires ${required}`);
  }
}

function validateExtensionPorts(value) {
  if (!Array.isArray(value)) fail("manifest.extensionPorts must be an array");
  const names = new Set();
  for (const [index, port] of value.entries()) {
    const label = `manifest.extensionPorts[${index}]`;
    exactKeys(port, ["accepts", "cardinality", "kind", "name", "target"], label);
    nonempty(port.name, `${label}.name`);
    nonempty(port.target, `${label}.target`);
    if (names.has(port.name)) fail(`manifest.extensionPorts repeats ${port.name}`);
    names.add(port.name);
    uniqueStrings(port.accepts, `${label}.accepts`);
    if (!new Set(["entity-fields", "component-slot", "route-slot"]).has(port.kind)) {
      fail(`${label}.kind is not supported`);
    }
    if (!new Set(["one", "many"]).has(port.cardinality)) {
      fail(`${label}.cardinality must be one or many`);
    }
  }
}

function validateStorageIds(value) {
  exactKeys(value, ["entities", "fields"], "manifest.storageIds");
  const all = new Set();
  for (const [kind, entries] of Object.entries(value)) {
    if (!plainObject(entries)) fail(`manifest.storageIds.${kind} must be an object`);
    for (const [role, storageId] of Object.entries(entries)) {
      nonempty(role, `manifest.storageIds.${kind} role`);
      nonempty(storageId, `manifest.storageIds.${kind}.${role}`);
      if (all.has(storageId)) fail(`manifest.storageIds repeats ${storageId}`);
      all.add(storageId);
    }
  }
}

export function validatePluginManifest(value) {
  exactKeys(value, [
    "compatibleWake",
    "configuration",
    "contributions",
    "dependencies",
    "durableSchemaVersion",
    "entry",
    "exports",
    "extensionPorts",
    "migrations",
    "packageId",
    "pluginAbiVersion",
    "requiredHostCapabilities",
    "schemaVersion",
    "sources",
    "storageIds",
    "version",
  ], "manifest");
  if (value.schemaVersion !== PACKAGE_SCHEMA_VERSION) fail("manifest schemaVersion must be 1");
  if (value.pluginAbiVersion !== PLUGIN_ABI_VERSION) fail("manifest pluginAbiVersion must be 1");
  nonempty(value.packageId, "manifest.packageId");
  exactVersion(value.version, "manifest.version");
  exactVersion(value.compatibleWake, "manifest.compatibleWake");
  relativePath(value.entry, "manifest.entry");
  const sources = uniqueStrings(value.sources, "manifest.sources");
  sources.forEach((source, index) => relativePath(source, `manifest.sources[${index}]`));
  if (!sources.includes(value.entry)) fail("manifest.entry must be listed in manifest.sources");
  const contributions = uniqueStrings(value.contributions, "manifest.contributions");
  for (const contribution of contributions) {
    if (!CONTRIBUTIONS.has(contribution)) fail(`manifest has unknown contribution ${contribution}`);
  }
  if (!Array.isArray(value.dependencies)) fail("manifest.dependencies must be an array");
  for (const [index, dependency] of value.dependencies.entries()) {
    exactKeys(dependency, ["packageId", "version"], `manifest.dependencies[${index}]`);
    nonempty(dependency.packageId, `manifest.dependencies[${index}].packageId`);
    exactVersion(dependency.version, `manifest.dependencies[${index}].version`);
  }
  validateConfiguration(value.configuration);
  validateExports(value.exports);
  validateExtensionPorts(value.extensionPorts);
  uniqueStrings(value.requiredHostCapabilities, "manifest.requiredHostCapabilities");
  validateStorageIds(value.storageIds);
  validateConfigurationDeclarations(value);
  for (const entity of value.exports.entities) {
    if (!(entity in value.storageIds.entities)) {
      fail(`manifest.storageIds.entities is missing exported entity ${entity}`);
    }
  }
  if (!Number.isSafeInteger(value.durableSchemaVersion) || value.durableSchemaVersion < 1) {
    fail("manifest.durableSchemaVersion must be a positive integer");
  }
  if (!Array.isArray(value.migrations)) fail("manifest.migrations must be an array");
  return value;
}

export function validatePluginArtifact(value) {
  exactKeys(value, ["files", "manifest", "schemaVersion"], "artifact");
  if (value.schemaVersion !== PACKAGE_SCHEMA_VERSION) fail("artifact schemaVersion must be 1");
  const manifest = validatePluginManifest(value.manifest);
  if (!Array.isArray(value.files)) fail("artifact.files must be an array");
  const paths = [];
  for (const [index, source] of value.files.entries()) {
    exactKeys(source, ["content", "mode", "path", "sha256"], `artifact.files[${index}]`);
    paths.push(relativePath(source.path, `artifact.files[${index}].path`));
    if (source.mode !== "text") fail(`artifact.files[${index}].mode must be text`);
    if (typeof source.content !== "string") fail(`artifact.files[${index}].content must be UTF-8 text`);
    if (!SHA256.test(source.sha256) || source.sha256 !== sha256Digest(source.content)) {
      fail(`artifact.files[${index}].sha256 does not match its content`);
    }
  }
  if (new Set(paths).size !== paths.length) fail("artifact.files contains a duplicate path");
  const expected = [...manifest.sources].sort();
  const actual = [...paths].sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    fail("artifact.files must exactly match manifest.sources");
  }
  return value;
}

export function validateWakeLock(value) {
  exactKeys(value, ["pluginAbiVersion", "plugins", "schemaVersion"], "wake.lock");
  if (value.schemaVersion !== 1) fail("wake.lock schemaVersion must be 1");
  if (value.pluginAbiVersion !== PLUGIN_ABI_VERSION) fail("wake.lock pluginAbiVersion must be 1");
  if (!Array.isArray(value.plugins)) fail("wake.lock plugins must be an array");
  const packageIds = new Set();
  for (const [index, entry] of value.plugins.entries()) {
    exactKeys(entry, ["artifact", "digest", "packageId", "source", "version"], `wake.lock.plugins[${index}]`);
    nonempty(entry.packageId, `wake.lock.plugins[${index}].packageId`);
    exactVersion(entry.version, `wake.lock.plugins[${index}].version`);
    relativePath(entry.artifact, `wake.lock.plugins[${index}].artifact`);
    if (!SHA256.test(entry.digest)) fail(`wake.lock.plugins[${index}].digest must be sha256:<hex>`);
    exactKeys(entry.source, ["commit", "kind"], `wake.lock.plugins[${index}].source`);
    if (entry.source.kind !== "git") fail(`wake.lock.plugins[${index}].source.kind must be git`);
    if (!COMMIT.test(entry.source.commit)) fail(`wake.lock.plugins[${index}].source.commit must be 40 lowercase hex`);
    if (packageIds.has(entry.packageId)) fail(`wake.lock repeats package ${entry.packageId}`);
    packageIds.add(entry.packageId);
  }
  return value;
}

function joined(root, path) {
  return `${root.replace(/\/+$/u, "")}/${path}`;
}

function isSymlink(path) {
  const result = Bun.spawnSync(["test", "-L", path], {
    stderr: "ignore",
    stdout: "ignore",
  });
  return result.exitCode === 0;
}

export async function packPlugin(packageRoot) {
  if (isSymlink(packageRoot)) fail("package root must not be a symlink");
  const manifestPath = joined(packageRoot, "wake-plugin.json");
  if (isSymlink(manifestPath)) fail("wake-plugin.json must not be a symlink");
  const manifestText = await Bun.file(manifestPath).text();
  const manifest = validatePluginManifest(parseCanonicalDocument(manifestText, "wake-plugin.json"));
  const files = [];
  for (const path of [...manifest.sources].sort()) {
    const sourcePath = joined(packageRoot, path);
    const prefixes = path.split("/");
    for (let index = 1; index <= prefixes.length; index += 1) {
      if (isSymlink(joined(packageRoot, prefixes.slice(0, index).join("/")))) {
        fail(`manifest source ${path} crosses a symlink`);
      }
    }
    const file = Bun.file(sourcePath);
    if (!(await file.exists())) fail(`manifest source ${path} does not exist`);
    const stats = await file.stat();
    if (!stats.isFile()) fail(`manifest source ${path} must be a regular file`);
    const content = await file.text();
    files.push({ content, mode: "text", path, sha256: sha256Digest(content) });
  }
  const artifact = { files, manifest, schemaVersion: PACKAGE_SCHEMA_VERSION };
  const bytes = canonicalDocument(artifact);
  return { artifact, bytes, digest: sha256Digest(bytes) };
}

export function readPluginArtifact(text, expectedDigest, label) {
  if (!SHA256.test(expectedDigest)) fail(`${label} has an invalid digest`);
  const actualDigest = sha256Digest(text);
  if (actualDigest !== expectedDigest) {
    fail(`${label} digest mismatch: expected ${expectedDigest}, received ${actualDigest}`);
  }
  return validatePluginArtifact(parseCanonicalDocument(text, label));
}

export const pluginContractVersions = Object.freeze({
  packageSchema: PACKAGE_SCHEMA_VERSION,
  pluginAbi: PLUGIN_ABI_VERSION,
});
