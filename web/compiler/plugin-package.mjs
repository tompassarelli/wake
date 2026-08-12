import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "./canonical.mjs";
import { constants as fileConstants } from "node:fs";
import fileSystemPromises from "node:fs/promises";
import {
  configurationDeclarationDescriptors,
  validateConfigurationSchema,
} from "./plugin-configuration.mjs";

const PACKAGE_SCHEMA_VERSION = 1;
const PLUGIN_ABI_VERSION = 1;
// Package ingestion is bounded before untrusted text reaches a parser.
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_COUNT = 256;
const MAX_SOURCE_PATH_BYTES = 240;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const FORBIDDEN_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();
const NO_ERROR = Symbol("no error");
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

function validateUnicodeText(value, label) {
  if (value.includes("\ufeff")) fail(`${label} must not contain a byte-order mark`);
  if (FORBIDDEN_TEXT_CONTROL.test(value)) fail(`${label} contains a forbidden control character`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        fail(`${label} contains an unpaired Unicode surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${label} contains an unpaired Unicode surrogate`);
    }
  }
  return value;
}

function utf8Bytes(value, label) {
  if (typeof value !== "string") fail(`${label} must be UTF-8 text`);
  validateUnicodeText(value, label);
  return textEncoder.encode(value);
}

function decodeUtf8(bytes, label) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label} must not begin with a UTF-8 byte-order mark`);
  }
  let value;
  try {
    value = textDecoder.decode(bytes);
  } catch (error) {
    throw new TypeError(`wake plugin: ${label} must be valid UTF-8`, { cause: error });
  }
  return validateUnicodeText(value, label);
}

function relativePath(value, label) {
  nonempty(value, label);
  validateUnicodeText(value, label);
  if (value.normalize("NFC") !== value) fail(`${label} must use NFC Unicode normalization`);
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:\//u.test(value)) {
    fail(`${label} must be a package-relative POSIX path`);
  }
  const pieces = value.split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) {
    fail(`${label} escapes its package`);
  }
  return value;
}

function sourcePath(value, label) {
  relativePath(value, label);
  if (!value.endsWith(".bjs")) fail(`${label} must name authored Beagle .bjs source`);
  if (textEncoder.encode(value).byteLength > MAX_SOURCE_PATH_BYTES) {
    fail(`${label} exceeds ${MAX_SOURCE_PATH_BYTES} UTF-8 bytes`);
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
  sourcePath(value.entry, "manifest.entry");
  const sources = uniqueStrings(value.sources, "manifest.sources");
  if (sources.length > MAX_SOURCE_COUNT) {
    fail(`manifest.sources exceeds ${MAX_SOURCE_COUNT} entries`);
  }
  sources.forEach((source, index) => sourcePath(source, `manifest.sources[${index}]`));
  const orderedSources = [...sources].sort();
  if (sources.some((source, index) => source !== orderedSources[index])) {
    fail("manifest.sources must be in canonical path order");
  }
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
  if (textEncoder.encode(canonicalDocument(value)).byteLength > MAX_MANIFEST_BYTES) {
    fail(`manifest exceeds ${MAX_MANIFEST_BYTES} UTF-8 bytes`);
  }
  return value;
}

export function validatePluginArtifact(value) {
  exactKeys(value, ["files", "manifest", "schemaVersion"], "artifact");
  if (value.schemaVersion !== PACKAGE_SCHEMA_VERSION) fail("artifact schemaVersion must be 1");
  const manifest = validatePluginManifest(value.manifest);
  if (!Array.isArray(value.files)) fail("artifact.files must be an array");
  const paths = [];
  let totalBytes = 0;
  for (const [index, source] of value.files.entries()) {
    exactKeys(source, ["content", "mode", "path", "sha256"], `artifact.files[${index}]`);
    paths.push(sourcePath(source.path, `artifact.files[${index}].path`));
    if (source.mode !== "text") fail(`artifact.files[${index}].mode must be text`);
    const contentBytes = utf8Bytes(source.content, `artifact.files[${index}].content`);
    if (contentBytes.byteLength > MAX_SOURCE_BYTES) {
      fail(`artifact.files[${index}].content exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`);
    }
    totalBytes += contentBytes.byteLength;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      fail(`artifact source bytes exceed ${MAX_TOTAL_SOURCE_BYTES} bytes`);
    }
    if (!SHA256.test(source.sha256) || source.sha256 !== sha256Digest(contentBytes)) {
      fail(`artifact.files[${index}].sha256 does not match its content`);
    }
  }
  if (new Set(paths).size !== paths.length) fail("artifact.files contains a duplicate path");
  if (paths.length !== manifest.sources.length
      || paths.some((path, index) => path !== manifest.sources[index])) {
    fail("artifact.files must exactly match manifest.sources in canonical path order");
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
    if (!entry.artifact.endsWith(".wakepkg.json")) {
      fail(`wake.lock.plugins[${index}].artifact must end in .wakepkg.json`);
    }
    if (!SHA256.test(entry.digest)) fail(`wake.lock.plugins[${index}].digest must be sha256:<hex>`);
    exactKeys(entry.source, ["commit", "kind"], `wake.lock.plugins[${index}].source`);
    if (entry.source.kind !== "git") fail(`wake.lock.plugins[${index}].source.kind must be git`);
    if (!COMMIT.test(entry.source.commit)) fail(`wake.lock.plugins[${index}].source.commit must be 40 lowercase hex`);
    if (packageIds.has(entry.packageId)) fail(`wake.lock repeats package ${entry.packageId}`);
    packageIds.add(entry.packageId);
  }
  return value;
}

async function closeAll(handles, primaryError = NO_ERROR) {
  let cleanupError = NO_ERROR;
  const closed = new Set();
  for (const handle of [...handles].reverse()) {
    if (!handle || closed.has(handle)) continue;
    closed.add(handle);
    try {
      await handle.close();
    } catch (error) {
      if (cleanupError === NO_ERROR) cleanupError = error;
    }
  }
  if (primaryError !== NO_ERROR) throw primaryError;
  if (cleanupError !== NO_ERROR) throw cleanupError;
}

async function readOpenFileBytes(handle, maximumBytes, label) {
  let result;
  let primaryError = NO_ERROR;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(`${label} must be a regular file`);
    if (before.size > BigInt(maximumBytes)) {
      fail(`${label} exceeds ${maximumBytes} bytes`);
    }

    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.byteLength - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs
        || BigInt(length) !== after.size) {
      fail(`${label} changed while being read`);
    }
    if (length > maximumBytes) fail(`${label} exceeds ${maximumBytes} bytes`);
    result = buffer.subarray(0, length);
  } catch (error) {
    primaryError = error;
  }
  await closeAll([handle], primaryError);
  return result;
}

async function openStandaloneFile(path, label) {
  try {
    return await fileSystemPromises.open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist`);
    if (error?.code === "ELOOP") fail(`${label} must not be a symlink`);
    throw new TypeError(`wake plugin: ${label} could not be opened as a regular file`, {
      cause: error,
    });
  }
}

async function readStandaloneFileBytes(path, maximumBytes, label) {
  return readOpenFileBytes(await openStandaloneFile(path, label), maximumBytes, label);
}

async function openPackageRoot(packageRoot) {
  if (process.platform !== "linux") {
    fail("descriptor-anchored package reads require Linux /proc/self/fd");
  }

  let root;
  try {
    root = await fileSystemPromises.open(
      packageRoot,
      fileConstants.O_RDONLY
        | fileConstants.O_DIRECTORY
        | fileConstants.O_NOFOLLOW
        | fileConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ENOENT") fail("package root does not exist");
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      fail("package root must be a directory, not a symlink");
    }
    throw new TypeError("wake plugin: package root could not be opened", {
      cause: error,
    });
  }

  let descriptorRoot;
  let primaryError = NO_ERROR;
  try {
    descriptorRoot = await fileSystemPromises.open(
      `/proc/self/fd/${root.fd}`,
      fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | fileConstants.O_NONBLOCK,
    );
    const [rootStats, descriptorStats] = await Promise.all([
      root.stat({ bigint: true }),
      descriptorRoot.stat({ bigint: true }),
    ]);
    if (rootStats.dev !== descriptorStats.dev || rootStats.ino !== descriptorStats.ino) {
      fail("descriptor-anchored package reads require a valid Linux /proc/self/fd");
    }
  } catch (error) {
    primaryError = error instanceof TypeError && error.message.startsWith("wake plugin:")
      ? error
      : new TypeError(
        "wake plugin: descriptor-anchored package reads require Linux /proc/self/fd",
        { cause: error },
      );
  }

  if (primaryError !== NO_ERROR) {
    await closeAll([root, descriptorRoot], primaryError);
  }
  try {
    await closeAll([descriptorRoot]);
  } catch (error) {
    await closeAll([root], error);
  }
  return root;
}

function descriptorChildPath(directory, component) {
  return `/proc/self/fd/${directory.fd}/${component}`;
}

async function openRelativeDirectory(parent, component, label) {
  try {
    return await fileSystemPromises.open(
      descriptorChildPath(parent, component),
      fileConstants.O_RDONLY
        | fileConstants.O_DIRECTORY
        | fileConstants.O_NOFOLLOW
        | fileConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist`);
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      fail(`${label} crosses a symlink or non-directory path`);
    }
    throw new TypeError(`wake plugin: ${label} could not be traversed`, {
      cause: error,
    });
  }
}

async function openRelativeFile(parent, component, label) {
  try {
    return await fileSystemPromises.open(
      descriptorChildPath(parent, component),
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist`);
    if (error?.code === "ELOOP") fail(`${label} must not be a symlink`);
    throw new TypeError(`wake plugin: ${label} could not be opened as a regular file`, {
      cause: error,
    });
  }
}

async function readRelativeFileBytes(directoryCache, path, maximumBytes, label) {
  const components = relativePath(path, label).split("/");
  let parent = directoryCache.get("");
  let prefix = "";
  for (const component of components.slice(0, -1)) {
    prefix = prefix === "" ? component : `${prefix}/${component}`;
    let directory = directoryCache.get(prefix);
    if (!directory) {
      directory = await openRelativeDirectory(parent, component, label);
      directoryCache.set(prefix, directory);
    }
    parent = directory;
  }
  const file = await openRelativeFile(parent, components.at(-1), label);
  return readOpenFileBytes(file, maximumBytes, label);
}

async function readRelativeFileSnapshot(directoryCache, path, maximumBytes, label) {
  const bytes = await readRelativeFileBytes(directoryCache, path, maximumBytes, label);
  return { bytes, text: decodeUtf8(bytes, label) };
}

export async function packPlugin(packageRoot) {
  const root = await openPackageRoot(packageRoot);
  const directoryCache = new Map([["", root]]);
  let result;
  let primaryError = NO_ERROR;
  try {
    const manifestSnapshot = await readRelativeFileSnapshot(
      directoryCache,
      "wake-plugin.json",
      MAX_MANIFEST_BYTES,
      "wake-plugin.json",
    );
    const manifest = validatePluginManifest(
      parseCanonicalDocument(manifestSnapshot.text, "wake-plugin.json"),
    );
    const files = [];
    let totalBytes = 0;
    for (const path of manifest.sources) {
      const snapshot = await readRelativeFileSnapshot(
        directoryCache,
        path,
        MAX_SOURCE_BYTES,
        `manifest source ${path}`,
      );
      totalBytes += snapshot.bytes.byteLength;
      if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
        fail(`manifest source bytes exceed ${MAX_TOTAL_SOURCE_BYTES} bytes`);
      }
      files.push({
        content: snapshot.text,
        mode: "text",
        path,
        sha256: sha256Digest(snapshot.bytes),
      });
    }
    const artifact = { files, manifest, schemaVersion: PACKAGE_SCHEMA_VERSION };
    const bytes = canonicalDocument(artifact);
    result = { artifact, bytes, digest: sha256Digest(bytes) };
  } catch (error) {
    primaryError = error;
  }
  await closeAll(directoryCache.values(), primaryError);
  return result;
}

export function readPluginArtifact(input, expectedDigest, label) {
  if (!SHA256.test(expectedDigest)) fail(`${label} has an invalid digest`);
  const inputBytes = typeof input === "string" ? utf8Bytes(input, label) : input;
  if (!(inputBytes instanceof Uint8Array)) {
    fail(`${label} must be UTF-8 text or raw bytes`);
  }
  if (inputBytes.byteLength > MAX_ARTIFACT_BYTES) {
    fail(`${label} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const actualDigest = sha256Digest(inputBytes);
  if (actualDigest !== expectedDigest) {
    fail(`${label} digest mismatch: expected ${expectedDigest}, received ${actualDigest}`);
  }
  return validatePluginArtifact(parseCanonicalDocument(decodeUtf8(inputBytes, label), label));
}

export async function readPluginArtifactFile(path, expectedDigest, label) {
  const bytes = await readStandaloneFileBytes(path, MAX_ARTIFACT_BYTES, label);
  return readPluginArtifact(bytes, expectedDigest, label);
}

export const pluginContractVersions = Object.freeze({
  packageSchema: PACKAGE_SCHEMA_VERSION,
  pluginAbi: PLUGIN_ABI_VERSION,
});

export const pluginPackageLimits = Object.freeze({
  artifactBytes: MAX_ARTIFACT_BYTES,
  manifestBytes: MAX_MANIFEST_BYTES,
  sourceBytes: MAX_SOURCE_BYTES,
  sourceCount: MAX_SOURCE_COUNT,
  sourcePathBytes: MAX_SOURCE_PATH_BYTES,
  totalSourceBytes: MAX_TOTAL_SOURCE_BYTES,
});

export const pluginPackageReadContract = Object.freeze({
  descriptorNamespace: "/proc/self/fd",
  descendantMounts: "followed",
  descendantSymlinks: "rejected",
  metadataMutationDetection: "best-effort on ordinary Linux filesystems",
  packageRootAncestors: "resolved before descriptor anchoring",
  platform: "linux",
});
