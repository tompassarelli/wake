import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "./canonical.mjs";
import {
  pluginContractVersions,
  readPluginArtifact,
  validateWakeLock,
} from "./plugin-package.mjs";

const DRIVER_SCHEMA_VERSION = 1;
const FRAM_PLAN_SCHEMA_VERSION = 2;
const HTTP_OPERATION_PROTOCOL_VERSION = 2;
const COMPILER_NAME = "wake";

function fail(message) {
  throw new TypeError(`wake-compile: ${message}`);
}

function dirname(path) {
  const end = path.lastIndexOf("/");
  return end <= 0 ? "/" : path.slice(0, end);
}

function basename(path) {
  const end = path.lastIndexOf("/");
  return path.slice(end + 1);
}

function join(root, relative) {
  return `${root.replace(/\/+$/u, "")}/${relative}`;
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
    if (!["--dist", "--mode", "--source", "--output"].includes(option) || value === undefined) {
      fail("driver requires --dist, --mode, --source, and --output");
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
    if (Array.isArray(value)) {
      return value.map((item) => semanticValue(item, active));
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "_tag" || key === "semantic_fingerprint") continue;
      result[key] = semanticValue(value[key], active);
    }
    if (typeof value._tag === "string") result.tag = value._tag;
    return result;
  } finally {
    active.delete(value);
  }
}

function configurationValue(value) {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) return value.map(configurationValue);
  if (value?._tag === "Sym") return { symbol: value.name };
  if (value?._tag === "Kw") return { keyword: value.name };
  if (value?._tag === "SexprVec") return value.items.map(configurationValue);
  return semanticValue(value);
}

function validateConfigurationType(value, descriptor, label) {
  const kind = descriptor?.kind;
  if (kind === "string" && typeof value !== "string") fail(`${label} must be a string`);
  if (kind === "integer" && !Number.isSafeInteger(value)) fail(`${label} must be an integer`);
  if (kind === "boolean" && typeof value !== "boolean") fail(`${label} must be boolean`);
  if (kind === "symbol" && value?._tag !== "Sym") fail(`${label} must be a symbol`);
  if (kind === "keyword" && value?._tag !== "Kw") fail(`${label} must be a keyword`);
  if (kind === "record" && value?._tag !== "SexprVec") fail(`${label} must be a record vector`);
}

function checkedConfiguration(use, manifest) {
  const supplied = new Map((use.config ?? []).map((entry) => [entry.key, entry.value]));
  for (const key of supplied.keys()) {
    if (!(key in manifest.configuration)) {
      fail(`use '${use.package_id}' supplies unknown configuration '${key}'`);
    }
  }
  const result = {};
  for (const key of Object.keys(manifest.configuration).sort()) {
    const descriptor = manifest.configuration[key];
    if (!supplied.has(key)) {
      if (descriptor.required) fail(`use '${use.package_id}' requires configuration '${key}'`);
      continue;
    }
    const value = supplied.get(key);
    validateConfigurationType(value, descriptor.type, `use '${use.package_id}' configuration '${key}'`);
    result[key] = configurationValue(value);
  }
  return result;
}

function checkedAllow(use, manifest) {
  const available = new Set(manifest.contributions);
  for (const contribution of use.allow ?? []) {
    if (!available.has(contribution)) {
      fail(`use '${use.package_id}' allows undeclared contribution '${contribution}'`);
    }
  }
  return [...use.allow];
}

function qualify(alias, name) {
  return `${alias}.${name}`;
}

function qualifyEntity(entity, alias, manifest, entityNames, stateNames) {
  const localName = entity.name;
  const entityStorageId = manifest.storageIds.entities[localName];
  if (typeof entityStorageId !== "string") {
    fail(`plugin '${manifest.packageId}' entity '${localName}' has no fixed storage ID`);
  }
  const attrs = entity.attrs.map((attr) => {
    const key = `${localName}/${attr.name}`;
    const storageId = manifest.storageIds.fields[key];
    if (typeof storageId !== "string") {
      fail(`plugin '${manifest.packageId}' field '${key}' has no fixed storage ID`);
    }
    const opts = { ...(attr.opts ?? {}) };
    if (entityNames.has(opts["target-entity"])) {
      opts["target-entity"] = qualify(alias, opts["target-entity"]);
    }
    const type = stateNames.has(attr.type) ? qualify(alias, attr.type) : attr.type;
    return { ...attr, opts, storage_id: storageId, type };
  });
  return {
    ...entity,
    attrs,
    name: qualify(alias, localName),
    storage_id: entityStorageId,
  };
}

function qualifyPluginProgram(program, use, manifest) {
  if (program.application != null) fail(`plugin '${manifest.packageId}' must not declare application`);
  if (program.backend != null) fail(`plugin '${manifest.packageId}' must not select a backend`);
  if (program.persist != null) fail(`plugin '${manifest.packageId}' must not declare persistence`);
  if ((program.uses ?? []).length > 0) {
    fail(`plugin '${manifest.packageId}' entry cannot contain nested use in plugin ABI 1`);
  }

  const alias = use.alias;
  const allow = new Set(checkedAllow(use, manifest));
  const entityNames = new Set(program.entities.map((entity) => entity.name));
  const stateNames = new Set(program.defstates.map((state) => state.name));
  const componentNames = new Set(program.components.map((component) => component.name));
  const viewNames = new Set(program.views.map((view) => view.name));

  if (allow.has("schema")) {
    for (const exported of manifest.exports.entities) {
      if (!entityNames.has(exported)) {
        fail(`plugin '${manifest.packageId}' exports missing entity '${exported}'`);
      }
    }
  }

  const entities = allow.has("schema")
    ? program.entities.map((entity) => qualifyEntity(entity, alias, manifest, entityNames, stateNames))
    : [];
  const defstates = allow.has("schema")
    ? program.defstates.map((state) => ({ ...state, name: qualify(alias, state.name) }))
    : [];
  const publications = allow.has("schema")
    ? program.publications.map((publication) => ({
        ...publication,
        name: qualify(alias, publication.name),
        owner_entity: entityNames.has(publication.owner_entity)
          ? qualify(alias, publication.owner_entity)
          : publication.owner_entity,
        revision_entity: entityNames.has(publication.revision_entity)
          ? qualify(alias, publication.revision_entity)
          : publication.revision_entity,
      }))
    : [];
  const components = allow.has("ui")
    ? program.components.map((component) => ({
        ...component,
        name: qualify(alias, component.name),
      }))
    : [];
  const views = allow.has("ui")
    ? program.views.map((view) => ({
        ...view,
        component: componentNames.has(view.component) ? qualify(alias, view.component) : view.component,
        entity_name: entityNames.has(view.entity_name) ? qualify(alias, view.entity_name) : view.entity_name,
        name: qualify(alias, view.name),
        select_component: componentNames.has(view.select_component)
          ? qualify(alias, view.select_component)
          : view.select_component,
        tabs: (view.tabs ?? []).map((tab) => ({
          ...tab,
          entity_name: entityNames.has(tab.entity_name) ? qualify(alias, tab.entity_name) : tab.entity_name,
        })),
      }))
    : [];
  const listDetails = allow.has("ui")
    ? program.list_details.map((detail) => ({
        ...detail,
        entity_name: entityNames.has(detail.entity_name)
          ? qualify(alias, detail.entity_name)
          : detail.entity_name,
      }))
    : [];
  const forms = allow.has("ui")
    ? program.forms.map((form) => ({
        ...form,
        entity_name: entityNames.has(form.entity_name) ? qualify(alias, form.entity_name) : form.entity_name,
        name: qualify(alias, form.name),
      }))
    : [];
  const router = allow.has("route") && program.router != null
    ? {
        ...program.router,
        default_route: viewNames.has(program.router.default_route)
          ? qualify(alias, program.router.default_route)
          : program.router.default_route,
        routes: program.router.routes.map((route) => ({
          ...route,
          view_name: viewNames.has(route.view_name) ? qualify(alias, route.view_name) : route.view_name,
        })),
      }
    : null;

  const renamed = new Map();
  for (const kind of ["entity", "defstate", "publication", "component", "view", "form"]) {
    renamed.set(kind, true);
  }
  const declarationProvenance = program.declaration_provenance
    .filter((entry) => !["ns", "backend", "persist", "application", "use"].includes(entry.kind))
    .map((entry) => ({
      ...entry,
      name: renamed.has(entry.kind) ? qualify(alias, entry.name) : entry.name,
    }));

  return {
    components,
    declarationProvenance,
    defstates,
    entities,
    forms,
    layout: allow.has("ui") ? (program.layout ?? null) : null,
    listDetails,
    publications,
    router,
    sourceUnit: program.source_unit,
    theme: allow.has("ui") ? (program.theme ?? null) : null,
    views,
  };
}

function appendUnique(existing, additions, label, name = (value) => value.name) {
  const seen = new Set(existing.map(name));
  for (const value of additions) {
    const key = name(value);
    if (seen.has(key)) fail(`linked application repeats ${label} '${key}'`);
    seen.add(key);
  }
  return [...existing, ...additions];
}

function mergeRouter(current, incoming, packageId) {
  if (incoming === null) return current;
  if (current === null) return incoming;
  return {
    ...current,
    routes: appendUnique(current.routes, incoming.routes, "route path", (route) => route.path),
    default_route: current.default_route || incoming.default_route,
  };
}

async function readCanonicalLock(lockPath) {
  const file = Bun.file(lockPath);
  if (!(await file.exists())) fail(`plugin imports require adjacent ${lockPath}`);
  return validateWakeLock(parseCanonicalDocument(await file.text(), lockPath));
}

async function loadPlugin(lockDir, entry) {
  const artifactPath = join(lockDir, entry.artifact);
  const file = Bun.file(artifactPath);
  if (!(await file.exists())) fail(`locked artifact does not exist: ${entry.artifact}`);
  const text = await file.text();
  const artifact = readPluginArtifact(text, entry.digest, entry.artifact);
  if (artifact.manifest.packageId !== entry.packageId || artifact.manifest.version !== entry.version) {
    fail(`locked artifact identity does not match ${entry.packageId}@${entry.version}`);
  }
  return { artifact, entry };
}

function maximumMigrationOrdinal(manifest) {
  return manifest.migrations.reduce((maximum, migration) => {
    const ordinal = Number.isSafeInteger(migration.ordinal) ? migration.ordinal : 0;
    return Math.max(maximum, ordinal);
  }, 0);
}

async function linkProgram(root, sourcePath, compilerVersion, parseProgramAt) {
  const uses = root.uses ?? [];
  if (uses.length === 0) {
    return {
      linked: {
        ...root,
        plugin_closure: [],
        semantic_fingerprint: null,
        source_units: [root.source_unit],
      },
      resolved: [],
    };
  }

  const lockPath = join(dirname(sourcePath), "wake.lock");
  const lockDir = dirname(lockPath);
  const lock = await readCanonicalLock(lockPath);
  const locks = new Map(lock.plugins.map((entry) => [entry.packageId, entry]));
  const loaded = new Map();
  const load = async (packageId, version) => {
    const entry = locks.get(packageId);
    if (entry === undefined || entry.version !== version) {
      fail(`wake.lock does not pin exact ${packageId}@${version}`);
    }
    if (!loaded.has(packageId)) loaded.set(packageId, await loadPlugin(lockDir, entry));
    return loaded.get(packageId);
  };

  const direct = [];
  for (const use of uses) {
    const resolved = await load(use.package_id, use.version);
    const manifest = resolved.artifact.manifest;
    if (manifest.compatibleWake !== compilerVersion) {
      fail(`${manifest.packageId}@${manifest.version} requires Wake ${manifest.compatibleWake}, not ${compilerVersion}`);
    }
    for (const dependency of manifest.dependencies) await load(dependency.packageId, dependency.version);
    direct.push({ ...resolved, use });
  }

  for (const { artifact, use } of direct) {
    const configuration = checkedConfiguration(use, artifact.manifest);
    const entryFile = artifact.files.find((file) => file.path === artifact.manifest.entry);
    if (entryFile === undefined) fail(`plugin '${artifact.manifest.packageId}' entry is absent`);
    const program = parseProgramAt(
      entryFile.content,
      artifact.manifest.entry,
      artifact.manifest.packageId,
      artifact.manifest.version,
    );
    const contribution = qualifyPluginProgram(program, use, artifact.manifest);
    direct.find((candidate) => candidate.use === use).configuration = configuration;
    direct.find((candidate) => candidate.use === use).contribution = contribution;
  }

  let linked = { ...root };
  let router = root.router;
  let theme = root.theme;
  let layout = root.layout;
  const sourceUnits = [root.source_unit];
  const declarationProvenance = [...root.declaration_provenance];
  for (const { artifact, contribution } of direct) {
    linked.entities = appendUnique(linked.entities, contribution.entities, "entity");
    linked.defstates = appendUnique(linked.defstates, contribution.defstates, "defstate");
    linked.publications = appendUnique(linked.publications, contribution.publications, "publication");
    linked.components = appendUnique(linked.components, contribution.components, "component");
    linked.views = appendUnique(linked.views, contribution.views, "view");
    linked.forms = appendUnique(linked.forms, contribution.forms, "form");
    linked.list_details = appendUnique(
      linked.list_details,
      contribution.listDetails,
      "list detail",
      (detail) => detail.entity_name,
    );
    router = mergeRouter(router, contribution.router, artifact.manifest.packageId);
    if (contribution.theme !== null) {
      if (theme !== null) fail(`plugin '${artifact.manifest.packageId}' conflicts with application theme`);
      theme = contribution.theme;
    }
    if (contribution.layout !== null) {
      if (layout !== null) fail(`plugin '${artifact.manifest.packageId}' conflicts with application layout`);
      layout = contribution.layout;
    }
    sourceUnits.push(contribution.sourceUnit);
    declarationProvenance.push(...contribution.declarationProvenance);
  }

  const closure = direct.map(({ artifact, configuration, entry, use }) => ({
    alias: use.alias,
    allowedContributions: [...use.allow],
    artifactDigest: entry.digest,
    configuration,
    configurationDigest: sha256Digest(canonicalDocument(configuration)),
    durableSchemaVersion: artifact.manifest.durableSchemaVersion,
    migrationOrdinal: maximumMigrationOrdinal(artifact.manifest),
    packageId: artifact.manifest.packageId,
    source: { ...entry.source },
    version: artifact.manifest.version,
  }));
  linked = {
    ...linked,
    declaration_provenance: declarationProvenance,
    layout,
    plugin_closure: closure,
    router,
    semantic_fingerprint: null,
    source_units: sourceUnits,
    theme,
  };
  return { linked, resolved: direct };
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

function operationSurface(resolved) {
  return resolved.map(({ artifact, use }) => {
    const allowed = new Set(use.allow);
    const exports = {};
    const categoryContribution = {
      capabilities: "capability",
      commands: "command",
      components: "ui",
      entities: "schema",
      providerPorts: "capability",
      queries: "query",
      routes: "route",
      states: "schema",
      valueTypes: "schema",
    };
    for (const [category, contribution] of Object.entries(categoryContribution)) {
      if (allowed.has(contribution) && category in artifact.manifest.exports) {
        exports[category] = artifact.manifest.exports[category];
      }
    }
    return { exports, packageId: artifact.manifest.packageId, version: artifact.manifest.version };
  });
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
  checked,
  compilerCommit,
  compilerVersion,
  fingerprint,
  framPlan,
  generatedJavaScript,
  resolved,
}) {
  const plugins = checked.plugin_closure.map((plugin) => ({
    alias: plugin.alias,
    allowedContributions: plugin.allowedContributions,
    artifactDigest: plugin.artifactDigest,
    configuration: plugin.configuration,
    configurationDigest: plugin.configurationDigest,
    durableSchemaVersion: plugin.durableSchemaVersion,
    migrationOrdinal: plugin.migrationOrdinal,
    packageId: plugin.packageId,
    source: plugin.source,
    version: plugin.version,
  }));
  const hostCapabilities = [...new Set(
    resolved.flatMap(({ artifact }) => artifact.manifest.requiredHostCapabilities),
  )].sort();
  return {
    applicationId: checked.application_id,
    artifacts: {
      browserJavaScript: { path: "app.js", sha256: sha256Digest(generatedJavaScript) },
      framPlan: { path: "app.fram.json", sha256: sha256Digest(framPlan) },
    },
    checkedApplication: { fingerprint, schemaVersion: checked.schema_version },
    compiler: { name: COMPILER_NAME, sourceCommit: compilerCommit, version: compilerVersion },
    digests: {
      operationSurface: sha256Digest(canonicalDocument(operationSurface(resolved))),
      stateSchema: sha256Digest(canonicalDocument(stateSchema(checked))),
      storageProjection: sha256Digest(canonicalDocument(storageProjection(checked))),
    },
    hostCapabilities,
    plugins,
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
  const distUrl = Bun.pathToFileURL(`${options.dist.replace(/\/+$/u, "")}/`);
  const { parse_program_at: parseProgramAt } = await import(new URL("reader.js", distUrl).href);
  const { check_program: checkProgram } = await import(new URL("graph.js", distUrl).href);
  const { gen_program_bang: generateProgram } = await import(new URL("codegen.js", distUrl).href);
  const { gen_fram: generateFram } = await import(new URL("emit-fram.js", distUrl).href);

  const sourceText = await Bun.file(options.source).text();
  const root = parseProgramAt(sourceText, basename(options.source), "application", compilerVersion);
  const { linked, resolved } = await linkProgram(
    root,
    options.source,
    compilerVersion,
    parseProgramAt,
  );
  const checked = checkProgram(linked);
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
  const framPlan = generateFram(checkedWithFingerprint);
  const manifest = applicationManifest({
    checked: checkedWithFingerprint,
    compilerCommit: compilerSourceCommit(webRoot),
    compilerVersion,
    fingerprint,
    framPlan,
    generatedJavaScript,
    resolved,
  });
  await Bun.write(join(options.output, "app.js"), generatedJavaScript);
  await Bun.write(join(options.output, "app.fram.json"), framPlan);
  await Bun.write(join(options.output, "app.wake.manifest.json"), canonicalDocument(manifest));
}

await main();
