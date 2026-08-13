import { canonicalJson, sha256Digest } from "./canonical.mjs";
import { pluginContractVersions } from "./plugin-package.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const CORE_RECEIPT_ENTITY_ID = "wake.core/command-receipt";
const CORE_RECEIPT_FIELD_IDS = Object.freeze([
  "actor", "command", "created-at", "id", "input-digest",
].map((name) => `wake.core/command-receipt/${name}`));

const EXPORT_CATEGORIES = new Map([
  ["entities", ["entities", (value) => [value.ref]]],
  ["fields", ["entities", (value) => [
    ...value.fields.map((field) => field.ref),
    ...value.derived_fields.map((field) => field.ref),
  ]]],
  ["states", ["states", (value) => [value.ref]]],
  ["state_values", ["states", (value) => value.values.map((entry) => entry.ref)]],
  ["value_types", ["value_types", (value) => [value.root]]],
  ["provider_ports", ["provider_ports", (value) => [value.ref]]],
  ["renderers", ["renderers", (value) => [value.ref]]],
  ["capabilities", ["capabilities", (value) => [value.ref]]],
  ["queries", ["queries", (value) => [value.ref]]],
  ["commands", ["commands", (value) => [value.ref]]],
  ["components", ["components", (value) => [value.ref]]],
  ["views", ["views", (value) => [value.ref]]],
  ["route_templates", ["route_templates", (value) => [value.ref]]],
  ["entity_fields_ports", ["entity_fields_ports", (value) => [value.ref]]],
  ["component_slots", ["component_slots", (value) => [value.ref]]],
  ["route_slots", ["route_slots", (value) => [value.ref]]],
]);

const BINDING_CATEGORIES = new Map([
  ["ints", ["ints", "IrImportedIntRoleRef", "IrIntRoleRef"]],
  ["strings", ["strings", "IrImportedStringRoleRef", "IrStringRoleRef"]],
  ["bools", ["bools", "IrImportedBoolRoleRef", "IrBoolRoleRef"]],
  ["keywords", ["keywords", "IrImportedKeywordRoleRef", "IrKeywordRoleRef"]],
  ["entity_names", ["entity_names", "IrImportedEntityNameRoleRef", "IrEntityNameRoleRef"]],
  ["field_names", ["field_names", "IrImportedFieldNameRoleRef", "IrFieldNameRoleRef"]],
  ["state_names", ["state_names", "IrImportedStateNameRoleRef", "IrStateNameRoleRef"]],
  [
    "state_value_names",
    ["state_value_names", "IrImportedStateValueNameRoleRef", "IrStateValueNameRoleRef"],
  ],
  [
    "external_entities",
    ["external_entities", "IrImportedExternalEntityRoleRef", "IrExternalEntityRoleRef"],
  ],
  ["values", ["values", "IrImportedValueRoleRef", "IrValueRoleRef"]],
]);

const COMPOSITION_PORTS = new Map([
  ["providers", ["port", "IrImportedProviderPortRef", "provider_ports"]],
  ["extensions", ["port", "IrImportedEntityFieldsPortRef", "entity_fields_ports"]],
  ["fills", ["slot", "IrImportedComponentSlotRef", "component_slots"]],
  ["mounts", ["slot", "IrImportedRouteSlotRef", "route_slots"]],
]);

function fail(message) {
  throw new TypeError(`wake declaration linker: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be a vector`);
  return value;
}

function unique(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) fail(`${label} repeats '${identity}'`);
    seen.add(identity);
  }
}

function nominalKey(ref) {
  return `${ref?._tag ?? "missing"}\u0000${ref?.declaration_id ?? "missing"}`;
}

function exactSemantic(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function contributionTag(kind) {
  return `Ir${kind[0].toUpperCase()}${kind.slice(1)}Contribution`;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function compatibleVersion(requirement, version, label) {
  nonempty(requirement, label);
  if (!VERSION.test(version)) fail(`compiler version '${version}' is not exact`);
  if (requirement === version) return;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.x$/u.exec(requirement);
  const [major, minor] = version.split(".");
  if (match === null || match[1] !== major || match[2] !== minor) {
    fail(`${label} '${requirement}' excludes Wake ${version}`);
  }
}

function declarationProgram(checked, expectedRoot, label) {
  object(checked, label);
  if (checked._tag !== "IrCheckedDeclarationProgram") {
    fail(`${label} is not checked declaration evidence`);
  }
  const program = object(checked.program, `${label} program`);
  if (program._tag !== "IrDeclarationProgram" || program.root?._tag !== expectedRoot) {
    fail(`${label} has the wrong declaration root`);
  }
  array(checked.declaration_provenance, `${label} declaration provenance`);
  return program;
}

function coreReceipt(program, label) {
  const entity = program.receipt_entity;
  if (entity?.ref?.declaration_id !== CORE_RECEIPT_ENTITY_ID) {
    fail(`${label} lacks the sealed command receipt entity`);
  }
  unique(program.receipt_fields, (field) => field.ref.declaration_id, `${label} receipt fields`);
  const fields = new Map(program.receipt_fields.map((field) => [field.ref.declaration_id, field]));
  const selected = CORE_RECEIPT_FIELD_IDS.map((declarationId) => fields.get(declarationId));
  if (selected.some((field) => field === undefined)) {
    fail(`${label} lacks the sealed command receipt fields`);
  }
  return { entity, fields: selected };
}

function validateReceipt(program, canonical, label) {
  const receipt = coreReceipt(program, label);
  if (!exactSemantic(receipt, canonical)) {
    fail(`${label} diverges from the application command receipt core`);
  }
}

function declarationIndex(program, label) {
  const byExport = new Map();
  const add = (ref) => {
    const key = nominalKey(ref);
    if (byExport.has(key)) fail(`${label} repeats declaration '${ref.declaration_id}'`);
    byExport.set(key, ref);
  };
  for (const [exportField, [programField, refs]] of EXPORT_CATEGORIES) {
    for (const declaration of array(program[programField], `${label} ${programField}`)) {
      refs(declaration).forEach(add);
    }
    if (!Array.isArray(program.root.plugin.exports[exportField])) {
      fail(`${label} exports omit ${exportField}`);
    }
  }
  return byExport;
}

function exportedIndex(program, declared, label) {
  const exported = new Map();
  for (const exportField of EXPORT_CATEGORIES.keys()) {
    for (const ref of program.root.plugin.exports[exportField]) {
      const key = nominalKey(ref);
      if (declared.get(key) !== ref) {
        fail(`${label} exports unknown ${ref?._tag ?? "declaration"} '${ref?.declaration_id ?? "missing"}'`);
      }
      if (exported.has(key)) fail(`${label} exports '${ref.declaration_id}' more than once`);
      exported.set(key, ref);
    }
  }
  return exported;
}

function roleIndex(configuration, label) {
  const roles = new Map();
  for (const [field, [, , localTag]] of BINDING_CATEGORIES) {
    for (const spec of array(configuration[field], `${label} ${field}`)) {
      if (spec.ref?._tag !== localTag) fail(`${label} ${field} has the wrong role type`);
      const key = nominalKey(spec.ref);
      if (roles.has(key)) fail(`${label} repeats role '${spec.ref.declaration_id}'`);
      roles.set(key, spec);
    }
  }
  return roles;
}

function importedTarget(ref, expectedTag, useRef, label) {
  if (ref?._tag !== expectedTag || ref.use !== useRef) {
    fail(`${label} is not owned by its exact plugin use`);
  }
  nonempty(ref.declaration_id, `${label} declaration ID`);
  nonempty(ref.name, `${label} name`);
  return ref;
}

function validateBindings(use, plugin, label) {
  const roles = roleIndex(plugin.configuration, `${label} plugin configuration`);
  const claimed = new Set();
  for (const [bindingField, [configField, importedTag, localTag]] of BINDING_CATEGORIES) {
    for (const binding of array(use.bindings[bindingField], `${label} ${bindingField}`)) {
      const imported = importedTarget(
        binding.role, importedTag, use.ref, `${label} ${bindingField} binding`,
      );
      const key = `${localTag}\u0000${imported.declaration_id}`;
      const role = roles.get(key);
      if (role === undefined || role.ref.name !== imported.name) {
        fail(`${label} binds unknown ${configField} role '${imported.declaration_id}'`);
      }
      if (claimed.has(key)) fail(`${label} binds role '${imported.declaration_id}' more than once`);
      claimed.add(key);
      if (bindingField === "field_names") {
        const expected = role.target._tag === "IrReceiptFieldNameRoleTarget"
          ? "IrReceiptFieldDeclarationNameValue"
          : "IrEntityFieldDeclarationNameValue";
        if (binding.value?._tag !== expected) {
          fail(`${label} field-name binding '${imported.name}' has the wrong target kind`);
        }
      }
      if (bindingField === "ints"
          && ((role.minimum !== null && binding.value < role.minimum)
            || (role.maximum !== null && binding.value > role.maximum))) {
        fail(`${label} integer binding '${imported.name}' is outside its declared bounds`);
      }
      if (bindingField === "strings") {
        const scalars = [...binding.value].length;
        const bytes = utf8Length(binding.value);
        if ((role.min_scalars !== null && scalars < role.min_scalars)
            || (role.max_scalars !== null && scalars > role.max_scalars)
            || (role.max_bytes !== null && bytes > role.max_bytes)) {
          fail(`${label} string binding '${imported.name}' is outside its declared bounds`);
        }
      }
      if (bindingField === "keywords" && !role.allowed.includes(binding.value)) {
        fail(`${label} keyword binding '${imported.name}' is outside its closed allowed set`);
      }
      if (new Set(["entity_names", "field_names", "state_names", "state_value_names"])
        .has(bindingField)) {
        const wrapper = bindingField === "field_names" ? binding.value.name : binding.value;
        nonempty(wrapper?.value, `${label} declaration-name binding '${imported.name}'`);
      }
    }
  }
  if (claimed.size !== roles.size) {
    const missing = [...roles].find(([key]) => !claimed.has(key));
    fail(`${label} does not bind plugin role '${missing[1].ref.declaration_id}'`);
  }
}

function validateComposition(composition, pluginProgram, exported, application, label) {
  const use = composition.use;
  validateBindings(use, pluginProgram.root.plugin, label);
  for (const [field, [refField, expectedTag, exportField]] of COMPOSITION_PORTS) {
    const requiredContribution = new Map([
      ["providers", "capability"],
      ["extensions", "schema"],
      ["fills", "ui"],
      ["mounts", "route"],
    ]).get(field);
    if (composition[field].length !== 0
        && !use.allow.some((entry) => entry._tag === contributionTag(requiredContribution))) {
      fail(`${label} ${field} require allowed ${requiredContribution} contribution`);
    }
    const exportedRefs = new Set(pluginProgram.root.plugin.exports[exportField]);
    for (const item of array(composition[field], `${label} ${field}`)) {
      const imported = importedTarget(item[refField], expectedTag, use.ref, `${label} ${field}`);
      const exportedRef = exported.get(
        `${expectedTag.replace("IrImported", "Ir")}\u0000${imported.declaration_id}`,
      );
      if (exportedRef === undefined || exportedRef.name !== imported.name
          || !exportedRefs.has(exportedRef)) {
        fail(`${label} ${field} names unexported '${imported.declaration_id}'`);
      }
    }
  }
  const localComponents = new Set(application.components.map((component) => component.ref));
  for (const fill of composition.fills) {
    if (!localComponents.has(fill.component)) {
      fail(`${label} fills a component slot with a non-application component`);
    }
  }
  const localEntities = new Set(application.entities.map((entity) => entity.ref));
  for (const binding of use.bindings.external_entities) {
    if (!localEntities.has(binding.value)) {
      fail(`${label} binds an external entity outside the application`);
    }
  }
}

function validateManifest(program, artifact, lockEntry, compilerVersion, label) {
  const manifest = object(artifact.manifest, `${label} manifest`);
  const identity = program.root.plugin.identity;
  if (identity.package_id !== manifest.packageId || identity.version !== manifest.version
      || identity.package_id !== lockEntry.packageId || identity.version !== lockEntry.version) {
    fail(`${label} source, artifact, and lock identities disagree`);
  }
  compatibleVersion(identity.compatible_wake, compilerVersion, `${label} source compatibility`);
  compatibleVersion(manifest.compatibleWake, compilerVersion, `${label} envelope compatibility`);
  if (identity.plugin_abi_version !== pluginContractVersions.pluginAbi
      || manifest.pluginAbiVersion !== identity.plugin_abi_version) {
    fail(`${label} plugin ABI does not match Wake`);
  }
  if (manifest.durableSchemaVersion !== identity.durable_schema_version) {
    fail(`${label} durable schema version disagrees with its source`);
  }
  const entry = artifact.files.find((file) => file.path === manifest.entry);
  if (entry === undefined || program.source_unit.source_id !== manifest.entry
      || program.source_unit.package_id !== identity.package_id
      || program.source_unit.package_version !== identity.version) {
    fail(`${label} checked entry does not match its artifact`);
  }
  return manifest;
}

function evidence(manifest, identity, migrations, lockEntry, use) {
  const migrationOrdinal = migrations.reduce((maximum, migration) => {
    if (!Number.isSafeInteger(migration.ordinal) || migration.ordinal < 1) {
      fail("plugin migration ordinal must be a positive safe integer");
    }
    return Math.max(maximum, migration.ordinal);
  }, 0);
  if (!SHA256.test(lockEntry.digest)) fail("plugin lock artifact digest is invalid");
  if (lockEntry.source?.kind !== "git" || !COMMIT.test(lockEntry.source.commit)) {
    fail("plugin lock source evidence is invalid");
  }
  return {
    _tag: "IrPluginArtifactEvidence",
    package_id: manifest.packageId,
    version: manifest.version,
    artifact_digest: lockEntry.digest,
    source_kind: lockEntry.source.kind,
    source_revision: lockEntry.source.commit,
    artifact_path: lockEntry.artifact,
    entry_path: manifest.entry,
    configuration_digest: sha256Digest(canonicalJson(use.bindings)),
    durable_schema_version: identity.durable_schema_version,
    migration_ordinal: migrationOrdinal,
  };
}

export function linkCheckedDeclarations({ application, plugins, compilerVersion }) {
  compatibleVersion(compilerVersion, compilerVersion, "compiler version");
  const applicationProgram = declarationProgram(
    application, "IrApplicationDeclarationRoot", "application",
  );
  const applicationReceipt = coreReceipt(applicationProgram, "application");
  const receiptDeclarations = new Map();
  const claimReceiptFields = (program, label) => {
    for (const field of program.receipt_fields) {
      if (CORE_RECEIPT_FIELD_IDS.includes(field.ref.declaration_id)) continue;
      const key = nominalKey(field.ref);
      if (receiptDeclarations.has(key)) {
        fail(`${label} repeats receipt field '${field.ref.declaration_id}' across programs`);
      }
      receiptDeclarations.set(key, field);
    }
  };
  claimReceiptFields(applicationProgram, "application");
  const supplied = array(plugins, "plugins");
  const artifacts = new Map();
  for (const [index, plugin] of supplied.entries()) {
    object(plugin, `plugin ${index + 1}`);
    const manifest = object(plugin.artifact?.manifest, `plugin ${index + 1} manifest`);
    const key = `${manifest.packageId}\u0000${manifest.version}`;
    if (artifacts.has(key)) fail(`plugins repeat ${manifest.packageId}@${manifest.version}`);
    artifacts.set(key, plugin);
  }
  const instances = [];
  const aliases = new Set();
  for (const [index, composition] of applicationProgram.root.application.plugins.entries()) {
    const use = composition.use;
    const label = `plugin use '${use.ref.name}'`;
    const key = `${use.package_id}\u0000${use.version}`;
    const suppliedPlugin = artifacts.get(key);
    if (suppliedPlugin === undefined) {
      fail(`${label} lacks exact locked source ${use.package_id}@${use.version}`);
    }
    const pluginProgram = declarationProgram(
      suppliedPlugin.checked, "IrPluginDeclarationRoot", `${label} checked source`,
    );
    validateReceipt(pluginProgram, applicationReceipt, `${label} checked source`);
    claimReceiptFields(pluginProgram, label);
    const declared = declarationIndex(pluginProgram, label);
    const exported = exportedIndex(pluginProgram, declared, label);
    const manifest = validateManifest(
      pluginProgram,
      suppliedPlugin.artifact,
      suppliedPlugin.lockEntry,
      compilerVersion,
      label,
    );
    const allowed = use.allow.map((entry) => entry._tag);
    unique(allowed, (value) => value, `${label} allowed contributions`);
    const available = new Set(pluginProgram.root.plugin.contributions.map((entry) => entry._tag));
    if (allowed.some((entry) => !available.has(entry))) {
      fail(`${label} allows a contribution absent from plugin source`);
    }
    validateComposition(composition, pluginProgram, exported, applicationProgram, label);
    const alias = nonempty(use.ref.name, `${label} alias`);
    if (alias.includes(".")) fail(`${label} alias must not contain '.'`);
    if (aliases.has(alias)) fail(`application repeats plugin alias '${alias}'`);
    aliases.add(alias);
    instances.push({
      _tag: "IrLinkedPluginInstance",
      alias,
      use,
      composition,
      checked: suppliedPlugin.checked,
      evidence: evidence(
        manifest,
        pluginProgram.root.plugin.identity,
        pluginProgram.root.plugin.migrations,
        suppliedPlugin.lockEntry,
        use,
      ),
    });
    artifacts.delete(key);
  }
  if (artifacts.size !== 0) {
    const plugin = artifacts.values().next().value;
    fail(`locked plugin '${plugin.artifact.manifest.packageId}' is not used by the application`);
  }
  return {
    _tag: "IrLinkedDeclarationProgram",
    application,
    plugins: instances,
  };
}
