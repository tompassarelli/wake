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
import { generateDeploymentReceipt } from "./deployment-receipt.mjs";

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

function splitQualified(value, label) {
  if (typeof value !== "string") fail(`${label} must be ALIAS.PORT`);
  const first = value.indexOf(".");
  if (first <= 0 || first !== value.lastIndexOf(".") || first === value.length - 1) {
    fail(`${label} must be ALIAS.PORT`);
  }
  return { alias: value.slice(0, first), name: value.slice(first + 1) };
}

function declaredCompositionTarget(direct, reference, kind, label) {
  const target = splitQualified(reference, label);
  const resolved = direct.find(candidate => candidate.use.alias === target.alias);
  if (resolved === undefined) fail(`${label} names unknown plugin alias '${target.alias}'`);
  const allowed = new Set(resolved.use.allow);
  const requiredContribution = kind === "provider"
    ? "capability"
    : kind === "mount"
      ? "route"
      : kind === "extend"
        ? "schema"
        : "ui";
  if (!allowed.has(requiredContribution)) {
    fail(`${label} requires allowed contribution '${requiredContribution}'`);
  }
  const manifest = resolved.artifact.manifest;
  if (kind === "provider") {
    if (!manifest.exports.providerPorts.includes(target.name)) {
      fail(`${label} names unexported provider port '${target.name}'`);
    }
    return { manifest, resolved, target };
  }
  const port = manifest.extensionPorts.find(candidate => candidate.name === target.name);
  if (port === undefined) fail(`${label} names unknown extension port '${target.name}'`);
  const expectedKind = kind === "mount" ? "route-slot" : kind === "fill" ? "component-slot" : "entity-fields";
  if (port.kind !== expectedKind) {
    fail(`${label} targets ${port.kind}, not ${expectedKind}`);
  }
  return { manifest, port, resolved, target };
}

function checkedRoutePattern(path, parameters, label) {
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const derived = segments
    .filter(segment => segment.startsWith(":"))
    .map(segment => segment.slice(1));
  if (derived.length !== parameters.length
      || derived.some((parameter, index) => parameter !== parameters[index])) {
    fail(`${label} route parameters do not match its checked path`);
  }
  return segments.map(segment => segment.startsWith(":") ? ":" : segment).join("/");
}

function applyApplicationComposition(linked, direct) {
  const providers = (linked.providers ?? []).map(provider => {
    const target = declaredCompositionTarget(
      direct,
      provider.port,
      "provider",
      `provider '${provider.name}'`,
    );
    return {
      name: provider.name,
      port: provider.port,
      package_id: target.manifest.packageId,
      port_name: target.target.name,
    };
  });
  const providerNames = new Set();
  const providerPorts = new Set();
  for (const provider of providers) {
    if (providerNames.has(provider.name)) fail(`provider '${provider.name}' is declared twice`);
    if (providerPorts.has(provider.port)) fail(`provider port '${provider.port}' is bound twice`);
    providerNames.add(provider.name);
    providerPorts.add(provider.port);
  }
  for (const { artifact, use } of direct) {
    for (const port of artifact.manifest.exports.providerPorts) {
      const required = artifact.manifest.requiredHostCapabilities.includes(port)
        || artifact.manifest.requiredHostCapabilities.includes(`provider:${port}`);
      if (required && !providerPorts.has(qualify(use.alias, port))) {
        fail(`plugin '${artifact.manifest.packageId}' requires provider port '${use.alias}.${port}'`);
      }
    }
  }

  const extensions = (linked.extends ?? []).map(extension => {
    const target = declaredCompositionTarget(
      direct,
      extension.port,
      "extend",
      `extend '${extension.port}'`,
    );
    const allowed = new Set(target.port.accepts);
    const fieldNames = new Set();
    for (const field of extension.fields) {
      if (fieldNames.has(field.name)) fail(`extend '${extension.port}' repeats field '${field.name}'`);
      fieldNames.add(field.name);
      if (typeof field.storage_id !== "string" || field.storage_id.length === 0) {
        fail(`extend '${extension.port}' field '${field.name}' requires an explicit storage ID`);
      }
      if (!allowed.has("explicit-storage-id")) {
        fail(`extend '${extension.port}' does not accept explicit storage fields`);
      }
      if (field.opts?.required === true && !allowed.has("immutable")) {
        fail(`extend '${extension.port}' does not accept caller-required immutable fields`);
      }
      if (field.opts?.server === true && !allowed.has("server-injected")) {
        fail(`extend '${extension.port}' does not accept server-injected fields`);
      }
    }
    return {
      fields: extension.fields,
      kind: target.port.kind,
      package_id: target.manifest.packageId,
      port: extension.port,
      target: target.port.target,
    };
  });
  const extensionPorts = new Set();
  const extensionStorageIds = new Set();
  for (const extension of extensions) {
    if (extensionPorts.has(extension.port)) fail(`extension port '${extension.port}' is supplied twice`);
    extensionPorts.add(extension.port);
    for (const field of extension.fields) {
      if (extensionStorageIds.has(field.storage_id)) fail(`application extensions repeat storage ID '${field.storage_id}'`);
      extensionStorageIds.add(field.storage_id);
    }
  }

  let entities = linked.entities;
  const existingStorageIds = new Set();
  for (const entity of entities) {
    if (typeof entity.storage_id === "string") existingStorageIds.add(entity.storage_id);
    for (const field of entity.attrs) {
      if (typeof field.storage_id === "string") existingStorageIds.add(field.storage_id);
    }
  }
  for (const extension of extensions) {
    const targetAlias = splitQualified(extension.port, `extend '${extension.port}'`).alias;
    const targetEntityName = extension.target.includes("/")
      ? extension.target
      : qualify(targetAlias, extension.target);
    const targetEntity = entities.find(entity => entity.name === targetEntityName);
    if (targetEntity === undefined) {
      fail(`extend '${extension.port}' targets missing entity '${extension.target}'`);
    }
    const fieldNames = new Set(targetEntity.attrs.map(field => field.name));
    const additions = extension.fields.map(field => {
      if (fieldNames.has(field.name)) {
        fail(`extend '${extension.port}' collides with field '${targetEntityName}.${field.name}'`);
      }
      if (existingStorageIds.has(field.storage_id)) {
        fail(`extend '${extension.port}' repeats storage ID '${field.storage_id}'`);
      }
      fieldNames.add(field.name);
      existingStorageIds.add(field.storage_id);
      const opts = { ...field.opts };
      if (opts.server === true) opts.write = "command";
      else opts.write = "create";
      delete opts.required;
      delete opts.server;
      return { ...field, opts };
    });
    entities = entities.map(entity => entity.name === targetEntityName
      ? { ...entity, attrs: [...entity.attrs, ...additions] }
      : entity);
  }

  const componentNames = new Set(linked.components.map(component => component.name));
  const fills = (linked.fills ?? []).map(fill => {
    const target = declaredCompositionTarget(direct, fill.port, "fill", `fill '${fill.port}'`);
    if (!componentNames.has(fill.component)) {
      fail(`fill '${fill.port}' names unknown application component '${fill.component}'`);
    }
    const targetName = qualify(target.target.alias, target.port.target);
    const targetComponent = linked.components.find(component => component.name === targetName);
    const replacement = linked.components.find(component => component.name === fill.component);
    if (targetComponent === undefined) {
      fail(`fill '${fill.port}' targets missing plugin component '${target.port.target}'`);
    }
    const missing = targetComponent.props.filter(prop => !replacement.props.includes(prop));
    if (missing.length > 0) {
      fail(`fill '${fill.port}' component '${fill.component}' lacks required props: ${missing.join(", ")}`);
    }
    return {
      component: fill.component,
      package_id: target.manifest.packageId,
      port: fill.port,
      target_component: targetName,
    };
  });

  const mounts = (linked.mounts ?? []).map(mount => {
    const target = declaredCompositionTarget(direct, mount.port, "mount", `mount '${mount.port}'`);
    const targetRoute = qualify(target.target.alias, target.port.target);
    const template = (linked.route_templates ?? []).find(route => route.path === targetRoute);
    if (template === undefined) {
      fail(`mount '${mount.port}' targets missing plugin route template '${target.port.target}'`);
    }
    const parameterContracts = target.port.accepts.filter(value => value !== "route-path");
    const templateParameters = template.parameters ?? [];
    if (parameterContracts.length !== templateParameters.length) {
      fail(`mount '${mount.port}' manifest and route template disagree on parameter arity`);
    }
    if (parameterContracts.some((parameter, index) => parameter !== templateParameters[index])) {
      fail(`mount '${mount.port}' manifest and route template disagree on parameter names`);
    }
    if (mount.parameters.length !== templateParameters.length) {
      fail(`mount '${mount.port}' requires exactly ${templateParameters.length} route parameters`);
    }
    const pattern = checkedRoutePattern(mount.path, mount.parameters, `mount '${mount.port}'`);
    const view = linked.views.find(candidate => candidate.name === template.view_name);
    if (view === undefined) {
      fail(`mount '${mount.port}' targets missing plugin route view '${template.view_name}'`);
    }
    const component = linked.components.find(candidate => candidate.name === view.component);
    if (component === undefined) {
      fail(`mount '${mount.port}' route view names missing component '${view.component}'`);
    }
    return {
      input_parameters: templateParameters,
      package_id: target.manifest.packageId,
      parameters: mount.parameters,
      path: mount.path,
      pattern,
      port: mount.port,
      queries: template.queries ?? [],
      required_props: component.props,
      target_route: targetRoute,
      view_name: template.view_name,
    };
  });
  const mountPorts = new Set();
  const mountPaths = new Set();
  const mountPatterns = new Set();
  for (const mount of mounts) {
    if (mountPorts.has(mount.port)) fail(`route slot '${mount.port}' is mounted twice`);
    if (mountPaths.has(mount.path)) fail(`route path '${mount.path}' is mounted twice`);
    if (mountPatterns.has(mount.pattern)) fail(`route pattern '${mount.pattern}' is mounted twice`);
    mountPorts.add(mount.port);
    mountPaths.add(mount.path);
    mountPatterns.add(mount.pattern);
  }

  const existingRoutes = new Set((linked.router?.routes ?? []).map(route => route.path));
  for (const mount of mounts) {
    if (existingRoutes.has(mount.path)) fail(`route path '${mount.path}' collides with an application route`);
  }
  const mountedRoutes = mounts.map(mount => ({
    input_parameters: mount.input_parameters,
    parameters: mount.parameters,
    path: mount.path,
    queries: mount.queries,
    required_props: mount.required_props,
    view_name: mount.view_name,
  }));
  const router = mountedRoutes.length === 0
    ? linked.router
    : linked.router == null
      ? { default_route: mountedRoutes[0].view_name, routes: mountedRoutes }
      : { ...linked.router, routes: [...linked.router.routes, ...mountedRoutes] };

  const filledComponents = linked.components.map(component => {
    const fill = fills.find(candidate => candidate.target_component === component.name);
    if (fill === undefined) return component;
    return linked.components.find(candidate => candidate.name === fill.component);
  }).filter((component, index, all) => all.findIndex(candidate => candidate.name === component.name) === index);
  const filledViews = linked.views.map(view => {
    const componentFill = fills.find(candidate => candidate.target_component === view.component);
    const selectFill = fills.find(candidate => candidate.target_component === view.select_component);
    return {
      ...view,
      component: componentFill?.component ?? view.component,
      select_component: selectFill?.component ?? view.select_component,
    };
  });

  return {
    ...linked,
    components: filledComponents,
    entities,
    extends: extensions,
    fills,
    mounts,
    providers,
    router,
    views: filledViews,
  };
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
  const queryNames = new Set((program.queries ?? []).map((query) => query.name));
  const routeNames = new Set((program.router?.routes ?? []).map((route) => route.path));

  if (allow.has("schema")) {
    for (const exported of manifest.exports.entities) {
      if (!entityNames.has(exported)) {
        fail(`plugin '${manifest.packageId}' exports missing entity '${exported}'`);
      }
    }
  }
  if (allow.has("query")) {
    for (const exported of manifest.exports.queries) {
      if (!queryNames.has(exported)) {
        fail(`plugin '${manifest.packageId}' exports missing query '${exported}'`);
      }
    }
    for (const declared of queryNames) {
      if (!manifest.exports.queries.includes(declared)) {
        fail(`plugin '${manifest.packageId}' declares unexported query '${declared}'`);
      }
    }
  }
  if (allow.has("route")) {
    for (const exported of manifest.exports.routes) {
      if (!routeNames.has(exported)) {
        fail(`plugin '${manifest.packageId}' exports missing route template '${exported}'`);
      }
    }
    for (const declared of routeNames) {
      if (!manifest.exports.routes.includes(declared)) {
        fail(`plugin '${manifest.packageId}' declares unexported route template '${declared}'`);
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
  const queries = allow.has("query")
    ? (program.queries ?? []).map((query) => ({
        ...query,
        name: qualify(alias, query.name),
        params: query.params.map((parameter) => ({
          ...parameter,
          type: stateNames.has(parameter.type)
            ? qualify(alias, parameter.type)
            : parameter.type,
        })),
        bindings: query.bindings.map((binding) => ({
          ...binding,
          entity_name: entityNames.has(binding.entity_name)
            ? qualify(alias, binding.entity_name)
            : binding.entity_name,
        })),
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
  const routeTemplates = allow.has("route") && program.router != null
    ? program.router.routes.map((route) => ({
        ...route,
        path: qualify(alias, route.path),
        queries: (route.queries ?? []).map((query) => ({
          ...query,
          name: queryNames.has(query.name) ? qualify(alias, query.name) : query.name,
        })),
        view_name: viewNames.has(route.view_name) ? qualify(alias, route.view_name) : route.view_name,
      }))
    : [];

  const renamed = new Map();
  for (const kind of ["entity", "defstate", "publication", "query", "component", "view", "form"]) {
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
    queries,
    routeTemplates,
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
  let routeTemplates = [];
  let theme = root.theme;
  let layout = root.layout;
  const sourceUnits = [root.source_unit];
  const declarationProvenance = [...root.declaration_provenance];
  for (const { artifact, contribution } of direct) {
    linked.entities = appendUnique(linked.entities, contribution.entities, "entity");
    linked.defstates = appendUnique(linked.defstates, contribution.defstates, "defstate");
    linked.publications = appendUnique(linked.publications, contribution.publications, "publication");
    linked.queries = appendUnique(linked.queries ?? [], contribution.queries, "query");
    linked.components = appendUnique(linked.components, contribution.components, "component");
    linked.views = appendUnique(linked.views, contribution.views, "view");
    linked.forms = appendUnique(linked.forms, contribution.forms, "form");
    linked.list_details = appendUnique(
      linked.list_details,
      contribution.listDetails,
      "list detail",
      (detail) => detail.entity_name,
    );
    routeTemplates = appendUnique(
      routeTemplates,
      contribution.routeTemplates,
      "route template",
      (route) => route.path,
    );
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
  linked = applyApplicationComposition({
    ...linked,
    declaration_provenance: declarationProvenance,
    layout,
    plugin_closure: closure,
    route_templates: routeTemplates,
    router,
    semantic_fingerprint: null,
    source_units: sourceUnits,
    theme,
  }, direct);
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

function checkedOperationSurface(checked, resolved) {
  return {
    composition: {
      extensions: semanticValue(checked.extensions ?? []),
      fills: semanticValue(checked.fills ?? []),
      mounts: semanticValue(checked.mounts ?? []),
      providers: semanticValue(checked.providers ?? []),
    },
    exports: operationSurface(resolved),
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
      browserClient: { path: "wake-client.js", sha256: sha256Digest(browserClient) },
      browserJavaScript: { path: "app.js", sha256: sha256Digest(generatedJavaScript) },
      framPlan: { path: "app.fram.json", sha256: sha256Digest(framPlan) },
    },
    checkedApplication: { fingerprint, schemaVersion: checked.schema_version },
    compiler: { name: COMPILER_NAME, sourceCommit: compilerCommit, version: compilerVersion },
    digests: {
      operationSurface: sha256Digest(canonicalDocument(checkedOperationSurface(checked, resolved))),
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
  const { generateWakeClient } = await import("./emit-client.mjs");

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
    resolved,
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
