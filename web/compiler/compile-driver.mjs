import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "./canonical.mjs";
import {
  pluginContractVersions,
  readPluginArtifactFile,
  validateWakeLock,
} from "./plugin-package.mjs";
import { checkCommandGraph } from "./command-contract.mjs";
import { checkedDeclarationProgramFromBundle } from "./checked-declarations.mjs";
import { linkCheckedDeclarations } from "./declaration-linker.mjs";
import { generateDeploymentReceipt } from "./deployment-receipt.mjs";

const DRIVER_SCHEMA_VERSION = 1;
const FRAM_PLAN_SCHEMA_VERSION = 2;
const HTTP_OPERATION_PROTOCOL_VERSION = 2;
const COMPILER_NAME = "wake";
const BUNDLE_SCHEMA_VERSION = 4;
const WAKE_CORE_SOURCE_ID = "web/wake/core.bjs";
const WAKE_IR_SOURCE_ID = "web/compiler/ir.bjs";

const CONTRIBUTION_NAMES = new Map([
  ["IrSchemaContribution", "schema"],
  ["IrQueryContribution", "query"],
  ["IrCommandContribution", "command"],
  ["IrCapabilityContribution", "capability"],
  ["IrUiContribution", "ui"],
  ["IrRouteContribution", "route"],
]);

const EXPORT_CONTRIBUTIONS = new Map([
  ["entities", "schema"],
  ["fields", "schema"],
  ["states", "schema"],
  ["state_values", "schema"],
  ["value_types", "schema"],
  ["entity_fields_ports", "schema"],
  ["provider_ports", "capability"],
  ["capabilities", "capability"],
  ["queries", "query"],
  ["commands", "command"],
  ["renderers", "ui"],
  ["components", "ui"],
  ["views", "ui"],
  ["component_slots", "ui"],
  ["route_templates", "route"],
  ["route_slots", "route"],
]);

function fail(message) {
  throw new TypeError(`wake-compile: ${message}`);
}

function dirname(path) {
  const end = path.lastIndexOf("/");
  return end <= 0 ? "/" : path.slice(0, end);
}

function join(root, relative) {
  return `${root.replace(/\/+$/u, "")}/${relative}`;
}

function sourceIdentity(path, text) {
  const repository = Bun.spawnSync(
    ["git", "-C", dirname(path), "rev-parse", "--show-toplevel"],
    { stderr: "pipe", stdout: "pipe" },
  );
  if (repository.exitCode === 0) {
    const root = repository.stdout.toString().trim().replace(/\/+$/u, "");
    if (path.startsWith(`${root}/`)) {
      const relative = path.slice(root.length + 1);
      const tracked = Bun.spawnSync(
        ["git", "-C", root, "ls-files", "--error-unmatch", "--", relative],
        { stderr: "pipe", stdout: "pipe" },
      );
      if (tracked.exitCode === 0) return relative;
    }
  }
  return `external/${sha256Digest(text).slice("sha256:".length)}.bjs`;
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!["--dist", "--mode", "--source", "--output"].includes(option)
        || value === undefined) {
      fail(`driver rejects unsupported option ${option ?? "<missing>"}`);
    }
    if (values.has(option)) fail(`driver repeats ${option}`);
    values.set(option, value);
  }
  for (const option of ["--dist", "--mode", "--source", "--output"]) {
    if (!values.has(option)) fail(`driver requires ${option}`);
  }
  const mode = values.get("--mode");
  if (!["all", "fram", "js"].includes(mode)) fail(`unknown driver mode ${mode}`);
  const source = nonempty(values.get("--source"), "source path");
  if (!source.startsWith("/")) fail("source path must be absolute");
  if (!source.endsWith(".bjs")) fail("Wake source must use the .bjs extension");
  return {
    dist: nonempty(values.get("--dist"), "compiler distribution"),
    mode,
    output: nonempty(values.get("--output"), "output path"),
    source,
  };
}

function semanticValue(value, active = new Set()) {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return value;
  }
  if (value === undefined) return null;
  if (typeof value !== "object") fail(`cannot fingerprint ${typeof value}`);
  if (active.has(value)) fail("cannot fingerprint a cyclic compiler value");
  active.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => semanticValue(item, active));
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (["_tag", "linked_declarations", "semantic_fingerprint"].includes(key)) continue;
      result[key] = semanticValue(value[key], active);
    }
    if (typeof value._tag === "string") result.tag = value._tag;
    return result;
  } finally {
    active.delete(value);
  }
}

function suppliedSource(sourceId, text, authority) {
  return {
    sourceId,
    bytesBase64: Buffer.from(text).toString("base64"),
    authority,
  };
}

function checkedBundle(beagle, cwd, entrySourceId, sources, label) {
  const request = {
    kind: "beagle.checked-bundle.request",
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    entrySourceId,
    sources,
  };
  const result = Bun.spawnSync([beagle, "ast-bundle"], {
    cwd,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.toString().trim();
    fail(`${label} checked bundle failed${diagnostic.length === 0 ? "" : `: ${diagnostic}`}`);
  }
  try {
    return JSON.parse(result.stdout.toString());
  } catch (error) {
    throw new TypeError(`wake-compile: ${label} produced invalid checked-bundle JSON`, {
      cause: error,
    });
  }
}

function exactSourceTexts(bundles, available) {
  const sourceIds = new Set();
  for (const bundle of bundles) {
    for (const module of bundle.modules) sourceIds.add(module.sourceId);
  }
  return Object.fromEntries([...sourceIds].map((sourceId) => {
    const text = available[sourceId];
    if (typeof text !== "string") fail(`checked closure lacks exact bytes for '${sourceId}'`);
    return [sourceId, text];
  }));
}

async function checkedModels({ beagle, webRoot }) {
  const coreText = await Bun.file(join(webRoot, "wake/core.bjs")).text();
  const irText = await Bun.file(join(webRoot, "compiler/ir.bjs")).text();
  const coreBundle = checkedBundle(beagle, webRoot, WAKE_CORE_SOURCE_ID, [
    suppliedSource(WAKE_CORE_SOURCE_ID, coreText, "trusted"),
  ], "wake.core model");
  const irBundle = checkedBundle(beagle, webRoot, WAKE_IR_SOURCE_ID, [
    suppliedSource(WAKE_IR_SOURCE_ID, irText, "trusted"),
  ], "wake.ir model");
  return { coreBundle, coreText, irBundle, irText };
}

function decodePackageSource({
  beagle,
  compilerVersion,
  cwd,
  entrySourceId,
  label,
  models,
  sources,
}) {
  const available = Object.fromEntries(sources.map((source) => [source.sourceId, source.text]));
  available[WAKE_CORE_SOURCE_ID] = models.coreText;
  available[WAKE_IR_SOURCE_ID] = models.irText;
  const inputBundle = checkedBundle(beagle, cwd, entrySourceId, [
    ...sources.map((source) => suppliedSource(source.sourceId, source.text, "package")),
    suppliedSource(WAKE_CORE_SOURCE_ID, models.coreText, "trusted"),
  ], label);
  return checkedDeclarationProgramFromBundle(inputBundle, {
    compilerVersion,
    sourceTexts: exactSourceTexts(
      [inputBundle, models.coreBundle, models.irBundle], available,
    ),
    wakeCoreModelBundle: models.coreBundle,
    wakeIrModelBundle: models.irBundle,
  });
}

async function readCanonicalLock(lockPath) {
  const file = Bun.file(lockPath);
  if (!(await file.exists())) fail(`plugin imports require adjacent ${lockPath}`);
  return validateWakeLock(parseCanonicalDocument(await file.text(), lockPath));
}

async function loadCheckedPlugins({
  application,
  beagle,
  compilerVersion,
  models,
  sourcePath,
}) {
  const compositions = application.program.root.application.plugins;
  if (compositions.length === 0) return [];
  const lockPath = join(dirname(sourcePath), "wake.lock");
  const lockDir = dirname(lockPath);
  const lock = await readCanonicalLock(lockPath);
  const requested = new Map();
  for (const composition of compositions) {
    const use = composition.use;
    const prior = requested.get(use.package_id);
    if (prior !== undefined && prior !== use.version) {
      fail(`application requests two versions of plugin '${use.package_id}'`);
    }
    requested.set(use.package_id, use.version);
  }
  const locks = new Map(lock.plugins.map((entry) => [entry.packageId, entry]));
  if (locks.size !== requested.size
      || [...requested].some(([packageId, version]) => locks.get(packageId)?.version !== version)) {
    fail("wake.lock must exactly pin every directly used plugin and no others");
  }
  const plugins = [];
  for (const [packageId, version] of requested) {
    const lockEntry = locks.get(packageId);
    const artifactPath = join(lockDir, lockEntry.artifact);
    const artifact = await readPluginArtifactFile(
      artifactPath, lockEntry.digest, lockEntry.artifact,
    );
    if (artifact.manifest.packageId !== packageId || artifact.manifest.version !== version) {
      fail(`locked artifact identity does not match ${packageId}@${version}`);
    }
    const entry = artifact.files.find((file) => file.path === artifact.manifest.entry);
    if (entry === undefined) fail(`plugin '${packageId}' entry is absent`);
    const sources = artifact.files.map((file) => ({ sourceId: file.path, text: file.content }));
    const checked = decodePackageSource({
      beagle,
      compilerVersion,
      cwd: lockDir,
      entrySourceId: artifact.manifest.entry,
      label: `plugin '${packageId}'`,
      models,
      sources,
    });
    plugins.push({ artifact, checked, lockEntry });
  }
  return plugins;
}

function storageProjection(checked) {
  return {
    applicationId: checked.application_id,
    entities: checked.entities.map((entity) => ({
      fields: entity.fields.map((field) => ({ name: field.name, storageId: field.storage_id })),
      name: entity.name,
      storageId: entity.storage_id,
    })),
  };
}

function stateSchema(checked) {
  return {
    entities: checked.entities.map((entity) => ({
      fields: entity.fields.map((field) => ({
        cardinality: field.cardinality,
        derived: field.derived,
        identity: field.identity,
        name: field.name,
        storageId: field.storage_id,
        targetEntity: field.target_entity,
        type: field.type,
        write: field.write_policy,
      })),
      name: entity.name,
      storageId: entity.storage_id,
    })),
    publications: semanticValue(checked.publications),
    stateMachines: semanticValue(checked.state_machines),
  };
}

function contributionNames(entries, label) {
  return entries.map((entry) => {
    const name = CONTRIBUTION_NAMES.get(entry._tag);
    if (name === undefined) fail(`${label} has unknown contribution '${entry._tag}'`);
    return name;
  });
}

function pluginConfiguration(bindings) {
  const result = {};
  for (const [field, values] of Object.entries(bindings)) {
    if (field === "_tag") continue;
    if (!Array.isArray(values)) fail(`plugin bindings '${field}' must be a vector`);
    for (const binding of values) {
      const name = binding.role.name;
      if (Object.hasOwn(result, name)) fail(`plugin configuration repeats '${name}'`);
      result[name] = semanticValue(binding.value);
    }
  }
  return result;
}

function pluginManifestEntries(linked) {
  return linked.plugins.map((instance) => {
    const evidence = instance.evidence;
    return {
      alias: instance.alias,
      allowedContributions: contributionNames(
        instance.use.allow, `plugin '${instance.alias}' allow list`,
      ),
      artifactDigest: evidence.artifact_digest,
      configuration: pluginConfiguration(instance.use.bindings),
      configurationDigest: evidence.configuration_digest,
      durableSchemaVersion: evidence.durable_schema_version,
      migrationOrdinal: evidence.migration_ordinal,
      packageId: evidence.package_id,
      source: { commit: evidence.source_revision, kind: evidence.source_kind },
      version: evidence.version,
    };
  });
}

function operationSurface(linked) {
  return linked.plugins.map((instance) => {
    const allowed = new Set(contributionNames(
      instance.use.allow, `plugin '${instance.alias}' allow list`,
    ));
    const source = instance.checked.program.root.plugin;
    const exports = {};
    for (const [field, contribution] of EXPORT_CONTRIBUTIONS) {
      if (allowed.has(contribution)) exports[field] = semanticValue(source.exports[field]);
    }
    return {
      alias: instance.alias,
      exports,
      packageId: source.identity.package_id,
      version: source.identity.version,
    };
  });
}

function checkedOperationSurface(checked, linked) {
  return {
    composition: {
      extensions: semanticValue(checked.extensions ?? []),
      fills: semanticValue(checked.fills ?? []),
      mounts: semanticValue(checked.mounts ?? []),
      providers: semanticValue(checked.providers ?? []),
    },
    commands: semanticValue(checked.commands ?? []),
    exports: operationSurface(linked),
    queries: semanticValue(checked.queries ?? []),
  };
}

function compilerSourceCommit(webRoot) {
  const result = Bun.spawnSync(["git", "-C", webRoot, "rev-parse", "HEAD"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const commit = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    fail("could not determine the Wake source commit");
  }
  return commit;
}

function applicationManifest({
  browserClient,
  checked,
  compilerCommit,
  compilerVersion,
  fingerprint,
  framPlan,
  generatedJavaScript,
  linked,
}) {
  const hostCapabilities = [...new Set(linked.plugins.flatMap((instance) =>
    instance.checked.program.root.plugin.required_providers.map((port) => port.name)))].sort();
  return {
    applicationId: checked.application_id,
    artifacts: {
      browserClient: { path: "wake-client.js", sha256: sha256Digest(browserClient) },
      browserJavaScript: { path: "app.js", sha256: sha256Digest(generatedJavaScript) },
      framPlan: { path: "app.fram.json", sha256: sha256Digest(framPlan) },
    },
    checkedApplication: { fingerprint, schemaVersion: checked.schema_version },
    compiler: { name: COMPILER_NAME, sourceCommit: compilerCommit, version: compilerVersion },
    digests: {
      operationSurface: sha256Digest(canonicalDocument(checkedOperationSurface(checked, linked))),
      stateSchema: sha256Digest(canonicalDocument(stateSchema(checked))),
      storageProjection: sha256Digest(canonicalDocument(storageProjection(checked))),
    },
    hostCapabilities,
    plugins: pluginManifestEntries(linked),
    protocols: {
      framPlanSchemaVersion: FRAM_PLAN_SCHEMA_VERSION,
      httpOperationProtocolVersion: HTTP_OPERATION_PROTOCOL_VERSION,
      pluginAbiVersion: pluginContractVersions.pluginAbi,
    },
    schemaVersion: DRIVER_SCHEMA_VERSION,
  };
}

async function writeOutput(path, contents) {
  if (path === "-") {
    await Bun.write(Bun.stdout, contents);
    return;
  }
  await Bun.write(path, contents);
}

async function main() {
  const options = parseArguments(Bun.argv.slice(2));
  const compilerDirectory = import.meta.dir;
  const webRoot = dirname(compilerDirectory);
  const packageDocument = JSON.parse(await Bun.file(join(webRoot, "package.json")).text());
  const compilerVersion = nonempty(packageDocument.version, "Wake compiler version");
  const beagleRoot = process.env.BEAGLE_ROOT ?? `${process.env.HOME}/code/beagle/main`;
  const beagle = process.env.BEAGLE ?? join(beagleRoot, "bin/beagle");
  const models = await checkedModels({ beagle, webRoot });
  const sourceText = await Bun.file(options.source).text();
  const applicationSourceId = sourceIdentity(options.source, sourceText);
  const application = decodePackageSource({
    beagle,
    compilerVersion,
    cwd: dirname(options.source),
    entrySourceId: applicationSourceId,
    label: "application",
    models,
    sources: [{ sourceId: applicationSourceId, text: sourceText }],
  });
  const plugins = await loadCheckedPlugins({
    application, beagle, compilerVersion, models, sourcePath: options.source,
  });
  const linked = linkCheckedDeclarations({ application, plugins, compilerVersion });

  const distUrl = Bun.pathToFileURL(`${options.dist.replace(/\/+$/u, "")}/`);
  const { check_linked_declaration_program: checkLinkedDeclarations } = await import(
    new URL("graph.js", distUrl).href
  );
  if (typeof checkLinkedDeclarations !== "function") {
    fail("compiled graph lacks check-linked-declaration-program");
  }
  const { gen_program_bang: generateProgram } = await import(new URL("codegen.js", distUrl).href);
  const { gen_fram: generateFram } = await import(new URL("emit-fram.js", distUrl).href);
  const { generateWakeClient } = await import("./emit-client.mjs");

  const checkedGraph = checkLinkedDeclarations(linked);
  const checked = {
    ...checkedGraph,
    commands: checkCommandGraph(checkedGraph.commands ?? [], checkedGraph),
  };
  const fingerprint = sha256Digest(canonicalDocument(semanticValue(checked)));
  const checkedWithFingerprint = { ...checked, semantic_fingerprint: fingerprint };

  if (options.mode === "js") {
    const generated = `// wake: checked-application ${fingerprint}\n${generateProgram(checkedWithFingerprint)}`;
    await writeOutput(options.output, generated);
    return;
  }
  if (options.mode === "fram") {
    await writeOutput(options.output, generateFram(checkedWithFingerprint));
    return;
  }

  const generatedJavaScript = `// wake: checked-application ${fingerprint}\n${generateProgram(checkedWithFingerprint)}`;
  const browserClient = generateWakeClient(checkedWithFingerprint);
  const framPlan = generateFram(checkedWithFingerprint);
  const manifest = applicationManifest({
    browserClient,
    checked: checkedWithFingerprint,
    compilerCommit: compilerSourceCommit(webRoot),
    compilerVersion,
    fingerprint,
    framPlan,
    generatedJavaScript,
    linked,
  });
  const manifestDocument = canonicalDocument(manifest);
  const deploymentReceipt = generateDeploymentReceipt({
    browserClient,
    browserJavaScript: generatedJavaScript,
    framPlan,
    manifest: manifestDocument,
  });
  await Bun.write(join(options.output, "app.js"), generatedJavaScript);
  await Bun.write(join(options.output, "wake-client.js"), browserClient);
  await Bun.write(join(options.output, "app.fram.json"), framPlan);
  await Bun.write(join(options.output, "app.wake.manifest.json"), manifestDocument);
  await Bun.write(join(options.output, "app.wake.deployment.json"), deploymentReceipt);
}

await main();
