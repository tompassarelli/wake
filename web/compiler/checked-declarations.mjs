import { canonicalJson, sha256Digest } from "./canonical.mjs";

const BUNDLE_KIND = "beagle.checked-bundle";
const BUNDLE_SCHEMA_VERSION = 1;
const CHECKED_PROGRAM_KIND = "beagle.checked-program";
const CHECKED_PROGRAM_SCHEMA_VERSION = 1;
const WAKE_CORE_NAMESPACE = "wake.core";
const WAKE_CORE_SOURCE_ID = "web/wake/core.bjs";
const WAKE_IR_NAMESPACE = "wake.ir";
const WAKE_IR_SOURCE_ID = "web/compiler/ir.bjs";

// These hashes make the checked model artifacts evidence for the compiler's
// own source, rather than caller-selected schemas that happen to type-check.
export const CHECKED_DECLARATION_MODEL = Object.freeze({
  wakeCoreSourceSha256:
    "sha256:cd21559fc26a3baf1473d6d18cdf97d67ef410d8575809bc85810eda5f274f96",
  wakeIrSourceSha256:
    "sha256:690f27cdb64a292368a023e7ea414f3ceb5f87c07e5486a2c227004560c5471c",
});

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BUILTIN_TYPES = new Set([
  "Any", "Bool", "Float", "Int", "Keyword", "Nil", "String",
]);
const CONTAINER_TYPES = new Set(["HVec", "List", "Map", "Vec"]);
const INTERNAL_TYPE_NAMES = new Map([
  ["UiAttr", "IrUiAttrSpec"],
  ["UiCondition", "IrUiConditionSpec"],
  ["UiNode", "IrDeclarationUiNode"],
]);
const INTERNAL_CONSTRUCTOR_NAMES = new Map([
  ["StaticAttr", "IrStaticUiAttr"],
  ["BindAttr", "IrBoundUiAttr"],
  ["Element", "IrDeclarationElement"],
  ["WhenNode", "IrDeclarationWhen"],
]);
const PUBLIC_TYPE_NAMES = new Map(
  [...INTERNAL_TYPE_NAMES].map(([publicName, internalName]) => [internalName, publicName]),
);

const CATEGORY_FIELDS = new Map([
  ["EntityDeclarationSpec", "entities"],
  ["StateDeclarationSpec", "states"],
  ["ValueTypeDeclarationSpec", "value_types"],
  ["ProviderPortSpec", "provider_ports"],
  ["RendererSpec", "renderers"],
  ["CapabilitySpec", "capabilities"],
  ["QueryDeclarationSpec", "queries"],
  ["CommandSpec", "commands"],
  ["ComponentDeclarationSpec", "components"],
  ["ViewDeclarationSpec", "views"],
  ["RouteTemplateSpec", "route_templates"],
  ["EntityFieldsPortSpec", "entity_fields_ports"],
  ["ComponentSlotSpec", "component_slots"],
  ["RouteSlotSpec", "route_slots"],
]);

const MACRO_TYPES = new Map(Object.entries({
  defcapability: ["CapabilityRef", "CapabilitySpec"],
  "defstate-model": [
    "StateRef", "StateValueRef", "StateValueSpec", "StateDeclarationSpec",
  ],
  "defexternal-entity-role": ["ExternalEntityRoleRef", "ExternalEntityRoleSpec"],
  "defentity-model": [
    "record", "EntityRef", "FieldRef", "FieldSpec", "EntityDeclarationSpec",
  ],
  "defvalue-type": [
    "ValueTypeRef", "ValueTypeDefinition", "ValueTypeDeclarationSpec",
  ],
  "defprovider-port": ["ProviderPortRef", "ProviderPortSpec"],
  defrenderer: ["RendererRef", "RendererSpec"],
  defcommand: ["CommandRef", "CommandSpec"],
  "defquery-model": ["QueryRef", "QueryDeclarationSpec"],
  "defcomponent-model": ["ComponentRef", "ComponentDeclarationSpec"],
  "defview-model": ["ViewRef", "ViewDeclarationSpec"],
  "defroute-template": ["RouteTemplateRef", "RouteTemplateSpec"],
  "defentity-fields-port": ["EntityFieldsPortRef", "EntityFieldsPortSpec"],
  "defcomponent-slot": ["ComponentSlotRef", "ComponentSlotSpec"],
  "defroute-slot": ["RouteSlotRef", "RouteSlotSpec"],
  "defint-role": ["IntRoleRef", "IntRoleSpec"],
  "defstring-role": ["StringRoleRef", "StringRoleSpec"],
  "defbool-role": ["BoolRoleRef", "BoolRoleSpec"],
  "defkeyword-role": ["KeywordRoleRef", "KeywordRoleSpec"],
  "defentity-name-role": ["EntityNameRoleRef", "EntityNameRoleSpec"],
  "deffield-name-role": ["FieldNameRoleRef", "FieldNameRoleSpec"],
  "defstate-name-role": ["StateNameRoleRef", "StateNameRoleSpec"],
  "defstate-value-name-role": ["StateValueNameRoleRef", "StateValueNameRoleSpec"],
  "defvalue-role": ["ValueRoleRef", "ValueRoleSpec"],
  "defplugin-configuration": ["PluginConfigurationSchema"],
  "defplugin-exports": ["PluginExports"],
  defplugin: ["PluginIdentity", "PluginSpec"],
  "defplugin-use": ["PluginUseRef"],
  "imported-int-binding": ["ImportedIntRoleRef", "IntBinding"],
  "imported-string-binding": ["ImportedStringRoleRef", "StringBinding"],
  "imported-bool-binding": ["ImportedBoolRoleRef", "BoolBinding"],
  "imported-keyword-binding": ["ImportedKeywordRoleRef", "KeywordBinding"],
  "imported-entity-name-binding": ["ImportedEntityNameRoleRef", "EntityNameBinding"],
  "imported-field-name-binding": ["ImportedFieldNameRoleRef", "FieldNameBinding"],
  "imported-state-name-binding": ["ImportedStateNameRoleRef", "StateNameBinding"],
  "imported-state-value-name-binding": [
    "ImportedStateValueNameRoleRef", "StateValueNameBinding",
  ],
  "imported-external-entity-binding": [
    "ImportedExternalEntityRoleRef", "ExternalEntityBinding",
  ],
  "imported-value-binding": ["ImportedValueRoleRef", "ValueBinding"],
  "defplugin-bindings": ["PluginBindings"],
  "bind-provider": ["ImportedProviderPortRef", "ProviderBindingSpec"],
  "extend-entity-fields": ["ImportedEntityFieldsPortRef", "ExtendSpec"],
  "fill-component-slot": ["ImportedComponentSlotRef", "FillSpec"],
  "mount-route-slot": ["ImportedRouteSlotRef", "MountSpec"],
  "use-plugin": ["PluginUseSpec", "PluginComposition"],
  "application-root": ["ApplicationRootSpec"],
}));

const NOMINAL_PREFIXES = new Map(Object.entries({
  EntityRef: "entity",
  FieldRef: "field",
  StateRef: "state",
  StateValueRef: "state-value",
  ValueTypeRef: "value-type",
  ProviderPortRef: "provider-port",
  RendererRef: "renderer",
  CapabilityRef: "capability",
  QueryRef: "query",
  CommandRef: "command",
  ComponentRef: "component",
  ViewRef: "view",
  RouteTemplateRef: "route-template",
  EntityFieldsPortRef: "entity-fields-port",
  ComponentSlotRef: "component-slot",
  RouteSlotRef: "route-slot",
  PluginUseRef: "plugin-use",
  IntRoleRef: "int-role",
  StringRoleRef: "string-role",
  BoolRoleRef: "bool-role",
  KeywordRoleRef: "keyword-role",
  EntityNameRoleRef: "entity-name-role",
  FieldNameRoleRef: "field-name-role",
  StateNameRoleRef: "state-name-role",
  StateValueNameRoleRef: "state-value-name-role",
  ExternalEntityRoleRef: "external-entity-role",
  ValueRoleRef: "value-role",
  ImportedIntRoleRef: "imported-int",
  ImportedStringRoleRef: "imported-string",
  ImportedBoolRoleRef: "imported-bool",
  ImportedKeywordRoleRef: "imported-keyword",
  ImportedEntityNameRoleRef: "imported-entity-name",
  ImportedFieldNameRoleRef: "imported-field-name",
  ImportedStateNameRoleRef: "imported-state-name",
  ImportedStateValueNameRoleRef: "imported-state-value-name",
  ImportedExternalEntityRoleRef: "imported-external-entity",
  ImportedValueRoleRef: "imported-value",
  ImportedProviderPortRef: "imported-provider",
  ImportedEntityFieldsPortRef: "imported-entity-fields",
  ImportedComponentSlotRef: "imported-component-slot",
  ImportedRouteSlotRef: "imported-route-slot",
}));

function fail(message) {
  throw new TypeError(`wake checked declarations: ${message}`);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unsupported fields`);
  }
}

function objectEntries(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object keyed by source ID`);
  }
  return Object.entries(value);
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function validateSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be a sha256 digest`);
  }
}

function canonicalDigest(value) {
  return sha256Digest(canonicalJson(value));
}

function validateType(type, label) {
  if (type === null || typeof type !== "object" || Array.isArray(type)) {
    fail(`${label} is not a checked type`);
  }
  switch (type.kind) {
    case "prim":
    case "var":
      exactKeys(type, ["kind", "name"], label);
      nonemptyString(type.name, `${label} name`);
      return;
    case "app":
      exactKeys(type, ["args", "kind", "name"], label);
      nonemptyString(type.name, `${label} name`);
      if (!Array.isArray(type.args)) fail(`${label} arguments must be a vector`);
      type.args.forEach((argument, index) =>
        validateType(argument, `${label} argument ${index + 1}`));
      return;
    case "union":
      exactKeys(type, ["kind", "members"], label);
      if (!Array.isArray(type.members) || type.members.length === 0) {
        fail(`${label} must contain union members`);
      }
      type.members.forEach((member, index) =>
        validateType(member, `${label} member ${index + 1}`));
      return;
    default:
      fail(`${label} uses unsupported type kind '${type.kind ?? "missing"}'`);
  }
}

function validateProvenance(provenance, label) {
  const hasMacro = provenance?.macroExpansion !== undefined;
  exactKeys(provenance, hasMacro ? ["macroExpansion", "source"] : ["source"], label);
  if (hasMacro) {
    exactKeys(provenance.macroExpansion, ["chain"], `${label} macro expansion`);
    if (!Array.isArray(provenance.macroExpansion.chain)) {
      fail(`${label} macro expansion chain must be a vector`);
    }
    provenance.macroExpansion.chain.forEach((entry, index) => {
      exactKeys(entry, ["depth", "name"], `${label} macro ${index + 1}`);
      if (!Number.isSafeInteger(entry.depth) || entry.depth < 0) {
        fail(`${label} macro ${index + 1} has an invalid depth`);
      }
      nonemptyString(entry.name, `${label} macro ${index + 1} name`);
    });
  }
  exactKeys(
    provenance.source,
    ["canonical", "col", "line", "origin", "pos", "sourceId", "span"],
    `${label} source`,
  );
}

function expressionKeys(node, keys) {
  return node.provenance === undefined ? keys : [...keys, "provenance"];
}

function validateOptionalProvenance(node, label) {
  if (node.provenance !== undefined) validateProvenance(node.provenance, label);
}

function validateExpression(node, label) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    fail(`${label} is not a checked expression`);
  }
  switch (node.node) {
    case "literal":
      exactKeys(
        node,
        expressionKeys(node, node.kind === "nil"
          ? ["kind", "node"]
          : ["kind", "node", "value"]),
        label,
      );
      validateOptionalProvenance(node, `${label} provenance`);
      return;
    case "ref":
      exactKeys(node, expressionKeys(node, ["name", "node"]), label);
      nonemptyString(node.name, `${label} name`);
      validateOptionalProvenance(node, `${label} provenance`);
      return;
    case "call":
      exactKeys(node, expressionKeys(node, ["args", "fn", "inferredType", "node"]), label);
      if (!Array.isArray(node.args)) fail(`${label} arguments must be a vector`);
      validateType(node.inferredType, `${label} inferred type`);
      validateOptionalProvenance(node, `${label} provenance`);
      validateExpression(node.fn, `${label} callee`);
      node.args.forEach((argument, index) =>
        validateExpression(argument, `${label} argument ${index + 1}`));
      return;
    case "vec":
      exactKeys(node, expressionKeys(node, ["inferredType", "items", "node"]), label);
      if (!Array.isArray(node.items)) fail(`${label} items must be a vector`);
      validateType(node.inferredType, `${label} inferred type`);
      validateOptionalProvenance(node, `${label} provenance`);
      node.items.forEach((item, index) =>
        validateExpression(item, `${label} item ${index + 1}`));
      return;
    case "map":
      exactKeys(node, expressionKeys(node, ["inferredType", "node", "pairs"]), label);
      if (!Array.isArray(node.pairs)) fail(`${label} pairs must be a vector`);
      validateType(node.inferredType, `${label} inferred type`);
      validateOptionalProvenance(node, `${label} provenance`);
      node.pairs.forEach((pair, index) => {
        exactKeys(pair, ["key", "val"], `${label} pair ${index + 1}`);
        validateExpression(pair.key, `${label} key ${index + 1}`);
        validateExpression(pair.val, `${label} value ${index + 1}`);
      });
      return;
    default:
      fail(`${label} uses unsupported checked node '${node.node ?? "missing"}'`);
  }
}

function validateEntryProjection(ast, label) {
  if (ast?.kind !== CHECKED_PROGRAM_KIND
      || ast.schemaVersion !== CHECKED_PROGRAM_SCHEMA_VERSION
      || ast.phase !== "checked"
      || ast.target !== "js"
      || ast.mode !== "strict") {
    fail(`${label} is not a strict checked beagle/js projection`);
  }
  if (!Array.isArray(ast.forms) || !Array.isArray(ast.requires)
      || !Array.isArray(ast.externs)) {
    fail(`${label} is missing checked forms, requires, or externs`);
  }
  const projection = { ...ast };
  delete projection.projectionSha256;
  validateSha(ast.projectionSha256, `${label} projection digest`);
  if (ast.projectionSha256 !== canonicalDigest(projection)) {
    fail(`${label} projection digest does not match its canonical payload`);
  }
}

function validateBundle(bundle, sourceTexts, label) {
  exactKeys(bundle, [
    "checkedBundleSha256", "entryProjection", "entrySourceId", "kind",
    "modules", "schemaVersion", "sourceClosureSha256",
  ], label);
  if (bundle.kind !== BUNDLE_KIND || bundle.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    fail(`${label} is not a supported checked bundle`);
  }
  nonemptyString(bundle.entrySourceId, `${label} entry source ID`);
  if (!Array.isArray(bundle.modules) || bundle.modules.length === 0) {
    fail(`${label} is missing its checked source closure`);
  }
  const moduleById = new Map();
  for (const [index, module] of bundle.modules.entries()) {
    const moduleLabel = `${label} module ${index + 1}`;
    exactKeys(module, [
      "authority", "interfaceSha256", "namespace", "requires", "sourceId",
      "sourceSha256",
    ], moduleLabel);
    nonemptyString(module.sourceId, `${moduleLabel} source ID`);
    nonemptyString(module.namespace, `${moduleLabel} namespace`);
    if (!new Set(["package", "trusted"]).has(module.authority)) {
      fail(`${moduleLabel} has unsupported authority '${module.authority}'`);
    }
    validateSha(module.sourceSha256, `${moduleLabel} source digest`);
    validateSha(module.interfaceSha256, `${moduleLabel} interface digest`);
    if (!Array.isArray(module.requires)) fail(`${moduleLabel} requires must be a vector`);
    if (moduleById.has(module.sourceId)) fail(`${label} repeats source '${module.sourceId}'`);
    const sourceText = sourceTexts[module.sourceId];
    if (typeof sourceText !== "string") fail(`${label} lacks exact bytes for '${module.sourceId}'`);
    if (sha256Digest(sourceText) !== module.sourceSha256) {
      fail(`${label} source digest does not match exact bytes for '${module.sourceId}'`);
    }
    moduleById.set(module.sourceId, module);
  }
  if (!moduleById.has(bundle.entrySourceId)) fail(`${label} closure omits its entry module`);
  validateSha(bundle.sourceClosureSha256, `${label} closure digest`);
  if (bundle.sourceClosureSha256 !== canonicalDigest({
    entrySourceId: bundle.entrySourceId,
    modules: bundle.modules,
  })) {
    fail(`${label} source closure digest does not match its canonical payload`);
  }
  const response = { ...bundle };
  delete response.checkedBundleSha256;
  validateSha(bundle.checkedBundleSha256, `${label} response digest`);
  if (bundle.checkedBundleSha256 !== canonicalDigest(response)) {
    fail(`${label} response digest does not match its canonical payload`);
  }
  validateEntryProjection(bundle.entryProjection, `${label} entry projection`);
  if (bundle.entryProjection.sourceId !== bundle.entrySourceId) {
    fail(`${label} projection does not name its entry source`);
  }
  const entryModule = moduleById.get(bundle.entrySourceId);
  if (bundle.entryProjection.namespace !== entryModule.namespace
      || bundle.entryProjection.sourceSha256 !== entryModule.sourceSha256) {
    fail(`${label} projection does not match its entry closure module`);
  }
  return { entryModule, moduleById, projection: bundle.entryProjection };
}

function baseTypeName(type) {
  if (type?.kind !== "prim") return null;
  const slash = type.name.lastIndexOf("/");
  return slash === -1 ? type.name : type.name.slice(slash + 1);
}

function definitionMap(projection, kind) {
  const definitions = new Map();
  for (const candidate of projection.forms) {
    const form = kind === "public" ? candidate?.form : candidate;
    if (kind === "public" && candidate?.node !== "js-export") continue;
    if (form?.node !== "record" && form?.node !== "defunion") continue;
    if (definitions.has(form.name)) fail(`${kind} model repeats '${form.name}'`);
    definitions.set(form.name, form);
  }
  return definitions;
}

function normalizePublicType(type) {
  if (type.kind === "prim") {
    if (type.name === "Keyword") return { kind: "prim", name: "String" };
    if (BUILTIN_TYPES.has(type.name)) return type;
    return {
      kind: "prim",
      name: INTERNAL_TYPE_NAMES.get(type.name) ?? `Ir${type.name}`,
    };
  }
  if (type.kind === "app") {
    return { ...type, args: type.args.map(normalizePublicType) };
  }
  if (type.kind === "union") {
    return { ...type, members: type.members.map(normalizePublicType) };
  }
  fail(`public model uses unsupported type kind '${type.kind}'`);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizedDefinition(form) {
  const internalName = (name) => INTERNAL_TYPE_NAMES.get(name) ?? `Ir${name}`;
  const internalConstructor = (name) =>
    INTERNAL_CONSTRUCTOR_NAMES.get(name) ?? `Ir${name}`;
  if (form.node === "record") {
    return {
      node: "record",
      name: internalName(form.name),
      fields: form.fields.map((field) => ({
        name: field.name,
        ann: normalizePublicType(field.ann),
      })),
    };
  }
  return {
    node: "defunion",
    name: internalName(form.name),
    "type-params": form["type-params"],
    members: form.members.map(internalConstructor),
    "member-fields": Object.fromEntries(Object.entries(form["member-fields"])
        .map(([member, fields]) => [internalConstructor(member), fields.map((field) => ({
        name: field.name,
        ann: normalizePublicType(field.ann),
      }))])),
  };
}

function internalDefinitionShape(form) {
  if (form.node === "record") {
    return { node: form.node, name: form.name, fields: form.fields };
  }
  return {
    node: form.node,
    name: form.name,
    "type-params": form["type-params"],
    members: form.members,
    "member-fields": form["member-fields"],
  };
}

function validateModels(publicProjection, internalProjection) {
  const publicDefinitions = definitionMap(publicProjection, "public");
  const internalDefinitions = definitionMap(internalProjection, "internal");
  const declarationProgram = internalDefinitions.get("IrDeclarationProgram");
  const checkedProgram = internalDefinitions.get("IrCheckedDeclarationProgram");
  if (declarationProgram?.node !== "record") {
    fail("internal model is missing IrDeclarationProgram");
  }
  if (checkedProgram?.node !== "record"
      || checkedProgram.fields.length !== 2
      || checkedProgram.fields[0].name !== "program"
      || checkedProgram.fields[0].ann?.name !== "IrDeclarationProgram"
      || checkedProgram.fields[1].name !== "declaration-provenance") {
    fail("internal model is missing the exact checked declaration wrapper");
  }
  const reachable = new Set();
  const visitType = (type) => {
    if (type.kind === "prim") visit(type.name);
    else if (type.kind === "app") type.args.forEach(visitType);
    else if (type.kind === "union") type.members.forEach(visitType);
    else fail(`internal model has unsupported type kind '${type.kind}'`);
  };
  const visit = (name) => {
    if (reachable.has(name) || !internalDefinitions.has(name)) return;
    reachable.add(name);
    const form = internalDefinitions.get(name);
    for (const field of form.fields ?? []) visitType(field.ann);
    for (const fields of Object.values(form["member-fields"] ?? {})) {
      fields.forEach((field) => visitType(field.ann));
    }
  };
  visit("IrDeclarationProgram");
  for (const name of reachable) {
    if (name === "IrDeclarationProgram" || name === "IrDeclarationRoot"
        || name === "IrSourceUnit") continue;
    if (!name.startsWith("Ir")) continue;
    const publicName = PUBLIC_TYPE_NAMES.get(name) ?? name.slice(2);
    const publicForm = publicDefinitions.get(publicName);
    if (publicForm === undefined) continue;
    if (!sameJson(
      normalizedDefinition(publicForm),
      internalDefinitionShape(internalDefinitions.get(name)),
    )) {
      fail(`public ${publicName} does not exactly mirror internal ${name}`);
    }
  }
  for (const typeName of CATEGORY_FIELDS.keys()) {
    if (!reachable.has(`Ir${typeName}`) || !publicDefinitions.has(typeName)) {
      fail(`closed declaration model omits ${typeName}`);
    }
  }
  return { internalDefinitions, publicDefinitions, reachable };
}

function projectedPosition(sourceText, characterOffset) {
  const characters = Array.from(sourceText);
  if (!Number.isSafeInteger(characterOffset)
      || characterOffset < 0 || characterOffset > characters.length) {
    fail(`source offset ${characterOffset} is outside the checked input`);
  }
  let line = 1;
  let column = 0;
  for (let index = 0; index < characterOffset; index += 1) {
    if (characters[index] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { column, line, utf16Offset: characters.slice(0, characterOffset).join("").length };
}

function sourcePosition(sourceText, utf16Offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < utf16Offset; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { column, line };
}

function invocationLength(sourceText, characterOffset, expectedHead, label) {
  const characters = Array.from(sourceText);
  if (characters[characterOffset] !== "(") fail(`${label} does not begin at a list`);
  let headEnd = characterOffset + 1;
  while (headEnd < characters.length
         && !/\s|\(|\)|\[|\]|\{|\}/u.test(characters[headEnd])) headEnd += 1;
  if (characters.slice(characterOffset + 1, headEnd).join("") !== expectedHead) {
    fail(`${label} does not name ${expectedHead}`);
  }
  const opening = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
  const closing = new Set(opening.values());
  const stack = [];
  let inString = false;
  let escaped = false;
  let inComment = false;
  for (let index = characterOffset; index < characters.length; index += 1) {
    const character = characters[index];
    if (inComment) {
      if (character === "\n") inComment = false;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === ";") inComment = true;
    else if (character === "\"") inString = true;
    else if (opening.has(character)) stack.push(opening.get(character));
    else if (closing.has(character)) {
      if (stack.pop() !== character) fail(`${label} has unbalanced delimiters`);
      if (stack.length === 0) return index + 1 - characterOffset;
    }
  }
  fail(`${label} is unterminated`);
}

function sameInvocation(left, right) {
  return left.sourceId === right.sourceId && left.pos === right.pos
    && left.span === right.span && left.line === right.line && left.col === right.col;
}

function exactInvocation(provenance, alias, macro, sourceId, sourceText, label) {
  const source = provenance?.source;
  const chain = provenance?.macroExpansion?.chain;
  if (source?.canonical !== true || source.origin !== "synthetic"
      || source.sourceId !== sourceId || !Number.isSafeInteger(source.pos)
      || source.pos < 1 || !Number.isSafeInteger(source.span) || source.span < 1
      || !Number.isSafeInteger(source.line) || source.line < 1
      || !Number.isSafeInteger(source.col) || source.col < 0
      || !Array.isArray(chain) || chain.length !== 1
      || chain[0]?.depth !== 0 || chain[0]?.name !== `${alias}/${macro}`) {
    fail(`${label} lacks exact compiler-owned wake/${macro} provenance`);
  }
  const projected = projectedPosition(sourceText, source.pos - 1);
  if (projected.line !== source.line || projected.column !== source.col) {
    fail(`${label} provenance does not match its source position`);
  }
  if (source.span !== invocationLength(
    sourceText, source.pos - 1, `${alias}/${macro}`, label,
  )) {
    fail(`${label} provenance does not cover its exact macro invocation`);
  }
  return source;
}

function validateExpressionInvocation(node, invocation, alias, macro, sourceId, sourceText, label) {
  const actual = exactInvocation(node.provenance, alias, macro, sourceId, sourceText, label);
  if (!sameInvocation(actual, invocation)) {
    fail(`${label} does not come from its declaration invocation`);
  }
  if (node.node === "call") {
    validateExpressionInvocation(
      node.fn, invocation, alias, macro, sourceId, sourceText, `${label} callee`,
    );
    node.args.forEach((argument, index) => validateExpressionInvocation(
      argument, invocation, alias, macro, sourceId, sourceText,
      `${label} argument ${index + 1}`,
    ));
  } else if (node.node === "vec") {
    node.items.forEach((item, index) => validateExpressionInvocation(
      item, invocation, alias, macro, sourceId, sourceText, `${label} item ${index + 1}`,
    ));
  } else if (node.node === "map") {
    node.pairs.forEach((pair, index) => {
      validateExpressionInvocation(
        pair.key, invocation, alias, macro, sourceId, sourceText, `${label} key ${index + 1}`,
      );
      validateExpressionInvocation(
        pair.val, invocation, alias, macro, sourceId, sourceText,
        `${label} value ${index + 1}`,
      );
    });
  }
}

function sourceSpan(source, sourceUnit, sourceText) {
  const start = projectedPosition(sourceText, source.pos - 1);
  const end = projectedPosition(sourceText, source.pos - 1 + source.span);
  const startPosition = sourcePosition(sourceText, start.utf16Offset);
  const endPosition = sourcePosition(sourceText, end.utf16Offset);
  return {
    _tag: "SourceSpan",
    source_id: sourceUnit.source_id,
    start_offset: start.utf16Offset,
    end_offset: end.utf16Offset,
    start_line: startPosition.line,
    start_column: startPosition.column,
    end_line: endPosition.line,
    end_column: endPosition.column,
  };
}

function fieldKey(name) {
  return name.replaceAll("-", "_");
}

function inferredName(node) {
  return baseTypeName(node?.inferredType);
}

function typeNameForNode(node) {
  if (node?.node === "literal") {
    return new Map([
      ["bool", "Bool"], ["keyword", "Keyword"], ["nil", "Nil"],
      ["number", "Int"], ["string", "String"],
    ]).get(node.kind) ?? null;
  }
  return inferredName(node);
}

function isOptional(type) {
  return type?.kind === "union"
    && type.members.some((member) => baseTypeName(member) === "Nil");
}

function checkedDeclarationDecoder(projection, schema, alias, sourceId, sourceText) {
  const forms = projection.forms;
  const formIndex = new Map(forms.map((form, index) => [form, index]));
  const defs = new Map();
  const records = new Map();
  for (const [index, form] of forms.entries()) {
    if (form?.node === "def") {
      exactKeys(form, ["ann", "doc", "dynamic", "name", "node", "provenance", "value"], `form ${index + 1}`);
      validateType(form.ann, `definition '${form.name}' annotation`);
      validateProvenance(form.provenance, `definition '${form.name}' provenance`);
      validateExpression(form.value, `definition '${form.name}' value`);
      if (defs.has(form.name)) fail(`projection repeats definition '${form.name}'`);
      defs.set(form.name, form);
    } else if (form?.node === "record") {
      exactKeys(form, ["fields", "name", "node", "provenance"], `form ${index + 1}`);
      if (!Array.isArray(form.fields)) fail(`record '${form.name}' fields must be a vector`);
      validateProvenance(form.provenance, `record '${form.name}' provenance`);
      if (records.has(form.name)) fail(`projection repeats record '${form.name}'`);
      records.set(form.name, form);
    } else {
      fail(`unsupported top-level checked form '${form?.node ?? "missing"}'`);
    }
  }

  const consumed = new Set();
  const decoded = new Map();
  const decoding = new Set();
  const invocationByForm = new Map();
  const macroGroups = new Map();

  const macroOwner = (form, typeName) => {
    const chain = form.provenance?.macroExpansion?.chain;
    if (!Array.isArray(chain) || chain.length === 0) return null;
    if (chain.length !== 1 || chain[0]?.depth !== 0
        || typeof chain[0]?.name !== "string"
        || !chain[0].name.startsWith(`${alias}/`)) {
      fail(`definition '${form.name}' has unsupported macro provenance`);
    }
    const macro = chain[0].name.slice(alias.length + 1);
    const allowed = MACRO_TYPES.get(macro);
    if (allowed === undefined || !allowed.includes(typeName)) {
      fail(`definition '${form.name}' of type ${typeName} is not owned by wake/${macro}`);
    }
    const invocation = exactInvocation(
      form.provenance, alias, macro, sourceId, sourceText, `definition '${form.name}'`,
    );
    validateExpressionInvocation(
      form.value, invocation, alias, macro, sourceId, sourceText,
      `definition '${form.name}' value`,
    );
    invocationByForm.set(form, { invocation, macro });
    const key = `${invocation.pos}:${invocation.span}:${macro}`;
    const group = macroGroups.get(key) ?? { forms: [], invocation, macro };
    group.forms.push(form);
    macroGroups.set(key, group);
    return macro;
  };

  const expectedDefinition = (name, label) => {
    const form = defs.get(name);
    if (form === undefined) fail(`${label} names missing definition '${name}'`);
    return form;
  };

  const decodeType = (node, expected, label, options = {}) => {
    if (expected.kind === "union") {
      if (node.node === "literal" && node.kind === "nil" && isOptional(expected)) return null;
      const actual = node.node === "ref" && !node.name.includes("/")
        ? baseTypeName(defs.get(node.name)?.ann)
        : typeNameForNode(node);
      const member = expected.members.find((candidate) => baseTypeName(candidate) === actual)
        ?? expected.members.find((candidate) => {
          const definition = schema.publicDefinitions.get(baseTypeName(candidate));
          return definition?.node === "defunion" && definition.members.includes(actual);
        });
      if (member === undefined) fail(`${label} does not match its closed union type`);
      return decodeType(node, member, label, options);
    }
    if (expected.kind === "app") {
      if (expected.name === "Vec" || expected.name === "List" || expected.name === "HVec") {
        if (node.node !== "vec") fail(`${label} must be a checked vector`);
        const itemTypes = expected.name === "HVec" ? expected.args : null;
        if (itemTypes !== null && node.items.length !== itemTypes.length) {
          fail(`${label} has the wrong tuple length`);
        }
        return node.items.map((item, index) => decodeType(
          item,
          itemTypes === null ? expected.args[0] : itemTypes[index],
          `${label} item ${index + 1}`,
        ));
      }
      if (expected.name === "Map") {
        if (node.node !== "map") fail(`${label} must be a checked map`);
        const result = {};
        for (const [index, pair] of node.pairs.entries()) {
          const key = decodeType(pair.key, expected.args[0], `${label} key ${index + 1}`);
          if (typeof key !== "string") fail(`${label} keys must decode to strings`);
          if (Object.hasOwn(result, key)) fail(`${label} repeats key '${key}'`);
          result[key] = decodeType(pair.val, expected.args[1], `${label} value ${index + 1}`);
        }
        return result;
      }
      fail(`${label} uses unsupported container type '${expected.name}'`);
    }
    const expectedName = baseTypeName(expected);
    if (expectedName === null) fail(`${label} has an unsupported expected type`);
    if (expectedName === "Nil") {
      if (node.node !== "literal" || node.kind !== "nil") fail(`${label} must be nil`);
      return null;
    }
    if (new Set(["Bool", "Float", "Int", "Keyword", "String"]).has(expectedName)) {
      if (expectedName === "Bool" && node.node === "ref"
          && new Set(["true", "false"]).has(node.name)) {
        return node.name === "true";
      }
      if (node.node !== "literal") fail(`${label} must be a ${expectedName} literal`);
      const actual = typeNameForNode(node);
      if (actual !== expectedName && !(expectedName === "Float" && actual === "Int")) {
        fail(`${label} must be a ${expectedName} literal`);
      }
      return node.value;
    }
    if (node.node === "ref") {
      if (node.name.includes("/")) fail(`${label} cannot use external value '${node.name}'`);
      const target = expectedDefinition(node.name, label);
      const actual = baseTypeName(target.ann);
      const expectedDefinitionShape = schema.publicDefinitions.get(expectedName);
      if (actual !== expectedName
          && !(expectedDefinitionShape?.node === "defunion"
            && expectedDefinitionShape.members.includes(actual))) {
        fail(`${label} reference '${node.name}' has type ${actual}, expected ${expectedName}`);
      }
      return decodeDefinition(target);
    }
    if (node.node !== "call" || node.fn?.node !== "ref") {
      fail(`${label} must be a checked ${expectedName} constructor call`);
    }
    const constructor = node.fn.name;
    const expectedPrefix = `${alias}/->`;
    if (!constructor.startsWith(expectedPrefix)) {
      fail(`${label} must use a checked wake.core constructor`);
    }
    const actualName = constructor.slice(expectedPrefix.length);
    if (inferredName(node) !== actualName) {
      fail(`${label} constructor result does not match its inferred type`);
    }
    let fields;
    let publicTag;
    const definition = schema.publicDefinitions.get(expectedName);
    if (definition?.node === "record") {
      if (actualName !== expectedName) {
        fail(`${label} must construct ${expectedName}, not ${actualName}`);
      }
      fields = definition.fields;
      publicTag = expectedName;
    } else if (definition?.node === "defunion") {
      if (!definition.members.includes(actualName)) {
        fail(`${label} constructs ${actualName}, outside ${expectedName}`);
      }
      fields = definition["member-fields"][actualName];
      publicTag = actualName;
    } else {
      fail(`${label} names unknown checked model type ${expectedName}`);
    }
    if (NOMINAL_PREFIXES.has(publicTag) && options.allowNominalConstructor !== publicTag) {
      fail(`${label} directly constructs nominal ${publicTag}; use its declaration macro`);
    }
    if (node.args.length !== fields.length) {
      fail(`${label} ${actualName} constructor has wrong arity`);
    }
    const result = { _tag: `Ir${publicTag}` };
    fields.forEach((field, index) => {
      result[fieldKey(field.name)] = decodeType(
        node.args[index], field.ann, `${label} field '${field.name}'`,
      );
    });
    if (NOMINAL_PREFIXES.has(publicTag)) {
      const declarationId = result.declaration_id;
      const name = result.name;
      const token = result.provenance_token;
      nonemptyString(declarationId, `${label} declaration ID`);
      nonemptyString(name, `${label} name`);
      const expectedToken = `wake:macro:${NOMINAL_PREFIXES.get(publicTag)}:${declarationId}`;
      if (token !== expectedToken) fail(`${label} has a nondeterministic provenance token`);
    }
    if (publicTag === "PluginIdentity") {
      const expectedToken = `wake:macro:plugin:${result.package_id}@${result.version}`;
      if (result.provenance_token !== expectedToken) {
        fail(`${label} has a nondeterministic plugin provenance token`);
      }
    }
    return result;
  };

  const decodeDefinition = (form) => {
    if (decoded.has(form)) return decoded.get(form);
    if (decoding.has(form)) fail(`definition '${form.name}' forms a value cycle`);
    decoding.add(form);
    try {
      const typeName = baseTypeName(form.ann);
      if (typeName === null || !schema.publicDefinitions.has(typeName)) {
        fail(`definition '${form.name}' has unsupported model type '${form.ann?.name ?? "missing"}'`);
      }
      const macro = macroOwner(form, typeName);
      if (NOMINAL_PREFIXES.has(typeName) && macro === null) {
        fail(`definition '${form.name}' directly constructs nominal ${typeName}`);
      }
      if (macro === null) {
        const source = form.provenance.source;
        if (source?.canonical !== false || source.origin !== "original"
            || source.sourceId !== sourceId) {
          fail(`helper definition '${form.name}' lacks original checked-source provenance`);
        }
      }
      const value = decodeType(
        form.value,
        { kind: "prim", name: typeName },
        `definition '${form.name}'`,
        { allowNominalConstructor: NOMINAL_PREFIXES.has(typeName) ? typeName : null },
      );
      consumed.add(form);
      decoded.set(form, value);
      return value;
    } finally {
      decoding.delete(form);
    }
  };

  const roots = forms.filter((form) => form.node === "def"
    && new Set(["PluginSpec", "ApplicationRootSpec"]).has(baseTypeName(form.ann)));
  if (roots.length !== 1) {
    fail(`expected exactly one plugin or application declaration root, found ${roots.length}`);
  }
  const rootForm = roots[0];
  const rootType = baseTypeName(rootForm.ann);
  const rootValue = decodeDefinition(rootForm);
  const categories = Object.fromEntries([...CATEGORY_FIELDS.values()].map((field) => [field, []]));
  for (const form of forms) {
    if (form.node !== "def") continue;
    const category = CATEGORY_FIELDS.get(baseTypeName(form.ann));
    if (category !== undefined) categories[category].push(decodeDefinition(form));
  }

  for (const form of forms) {
    if (form.node !== "def") continue;
    const typeName = baseTypeName(form.ann);
    if (form.provenance?.macroExpansion !== undefined
        || NOMINAL_PREFIXES.has(typeName)) {
      decodeDefinition(form);
    }
  }

  for (const entityForm of forms.filter((form) =>
    form.node === "def" && baseTypeName(form.ann) === "EntityDeclarationSpec")) {
    const entity = decoded.get(entityForm);
    const record = records.get(entity.record_name);
    if (record === undefined) {
      fail(`entity '${entityForm.name}' names missing record '${entity.record_name}'`);
    }
    const owner = invocationByForm.get(entityForm);
    const chain = record.provenance?.macroExpansion?.chain;
    const recordMacro = chain?.[0]?.name;
    if (chain?.length !== 1 || chain[0]?.depth !== 0
        || recordMacro !== `${alias}/defentity-model`) {
      fail(`entity record '${record.name}' is not owned by wake/defentity-model`);
    }
    const invocation = exactInvocation(
      record.provenance, alias, "defentity-model", sourceId, sourceText,
      `entity record '${record.name}'`,
    );
    if (!sameInvocation(invocation, owner.invocation)) {
      fail(`entity record '${record.name}' does not share its entity invocation`);
    }
    consumed.add(record);
    const key = `${invocation.pos}:${invocation.span}:defentity-model`;
    macroGroups.get(key).forms.push(record);
  }

  for (const form of forms) {
    if (!consumed.has(form)) {
      fail(`top-level ${form.node} '${form.name}' is outside the declaration graph`);
    }
  }

  const formsByType = (typeName) => forms.filter((form) =>
    form.node === "def" && baseTypeName(form.ann) === typeName);
  const pluginRefForms = formsByType("PluginUseRef");
  const pluginUseForms = formsByType("PluginUseSpec");
  const compositionForms = formsByType("PluginComposition");
  const pluginRefs = new Set(pluginRefForms.map((form) => decoded.get(form)));
  if (rootType === "PluginSpec"
      && (pluginRefForms.length !== 0 || pluginUseForms.length !== 0
        || compositionForms.length !== 0)) {
    fail("plugin declarations cannot contain host plugin-use pairs");
  }
  for (const refForm of pluginRefForms) {
    const ref = decoded.get(refForm);
    if (refForm.name !== `${ref.name}-ref`) {
      fail(`plugin-use reference '${refForm.name}' does not match '${ref.name}'`);
    }
    const uses = pluginUseForms.filter((form) => decoded.get(form).ref === ref);
    if (uses.length !== 1 || uses[0].name !== ref.name) {
      fail(`plugin-use reference '${refForm.name}' must have exactly one matching use-plugin`);
    }
    const use = decoded.get(uses[0]);
    const compositions = compositionForms.filter((form) => decoded.get(form).use === use);
    if (compositions.length !== 1 || compositions[0].name !== `${ref.name}-composition`) {
      fail(`plugin use '${ref.name}' must have exactly one matching composition`);
    }
  }
  for (const useForm of pluginUseForms) {
    if (!pluginRefs.has(decoded.get(useForm).ref)) {
      fail(`plugin use '${useForm.name}' has an orphaned PluginUseRef`);
    }
  }
  for (const form of forms) {
    const typeName = form.node === "def" ? baseTypeName(form.ann) : null;
    if (!typeName?.startsWith("Imported")) continue;
    const value = decoded.get(form);
    if (value?._tag?.endsWith("Ref") && !pluginRefs.has(value.use)) {
      fail(`imported reference '${form.name}' has an orphaned PluginUseRef`);
    }
  }

  const primaryForm = (group) => group.forms.find((form) => {
    if (form.node !== "def") return false;
    const type = baseTypeName(form.ann);
    return !NOMINAL_PREFIXES.has(type)
      && !new Set(["FieldSpec", "StateValueSpec", "ValueTypeDefinition"]).has(type);
  }) ?? group.forms.find((form) => form.node === "def") ?? group.forms[0];

  return {
    categories,
    formIndex,
    macroGroups,
    primaryForm,
    rootForm,
    rootType,
    rootValue,
  };
}

function exactSourceSet(sourceTexts, bundles) {
  const expected = new Set();
  bundles.forEach((bundle) => bundle.modules.forEach((module) => expected.add(module.sourceId)));
  const actual = objectEntries(sourceTexts, "source texts").map(([sourceId, text]) => {
    nonemptyString(sourceId, "source text ID");
    if (typeof text !== "string") fail(`source '${sourceId}' bytes must be text`);
    return sourceId;
  });
  if (actual.length !== expected.size || actual.some((sourceId) => !expected.has(sourceId))) {
    fail("source texts must exactly cover the checked bundle closures");
  }
}

export function checkedDeclarationProgramFromBundle(
  bundle,
  {
    compilerVersion,
    sourceTexts,
    wakeCoreModelBundle,
    wakeIrModelBundle,
  },
) {
  nonemptyString(compilerVersion, "compiler version");
  const checked = validateBundle(bundle, sourceTexts, "input bundle");
  const publicModel = validateBundle(
    wakeCoreModelBundle, sourceTexts, "wake.core model bundle",
  );
  const internalModel = validateBundle(
    wakeIrModelBundle, sourceTexts, "wake.ir model bundle",
  );
  exactSourceSet(sourceTexts, [bundle, wakeCoreModelBundle, wakeIrModelBundle]);

  if (wakeCoreModelBundle.entrySourceId !== WAKE_CORE_SOURCE_ID
      || publicModel.entryModule.namespace !== WAKE_CORE_NAMESPACE
      || publicModel.entryModule.authority !== "trusted"
      || publicModel.entryModule.sourceSha256
        !== CHECKED_DECLARATION_MODEL.wakeCoreSourceSha256) {
    fail("wake.core model bundle is not the compiler-owned checked model");
  }
  if (wakeIrModelBundle.entrySourceId !== WAKE_IR_SOURCE_ID
      || internalModel.entryModule.namespace !== WAKE_IR_NAMESPACE
      || internalModel.entryModule.authority !== "trusted"
      || internalModel.entryModule.sourceSha256
        !== CHECKED_DECLARATION_MODEL.wakeIrSourceSha256) {
    fail("wake.ir model bundle is not the compiler-owned checked model");
  }
  const inputWakeCore = [...checked.moduleById.values()].filter((module) =>
    module.namespace === WAKE_CORE_NAMESPACE);
  if (inputWakeCore.length !== 1 || inputWakeCore[0].authority !== "trusted"
      || inputWakeCore[0].sourceId !== WAKE_CORE_SOURCE_ID
      || inputWakeCore[0].sourceSha256 !== publicModel.entryModule.sourceSha256
      || inputWakeCore[0].interfaceSha256 !== publicModel.entryModule.interfaceSha256) {
    fail("input bundle is not closed over the compiler-owned trusted wake.core interface");
  }

  const wakeImports = checked.projection.requires.filter((entry) =>
    entry?.ns === WAKE_CORE_NAMESPACE);
  if (wakeImports.length !== 1 || typeof wakeImports[0].alias !== "string"
      || wakeImports[0].alias.length === 0 || wakeImports[0].refer !== false) {
    fail("input must import exactly [wake.core :as ALIAS] without :refer");
  }
  const entryRequiresWake = checked.entryModule.requires.filter((entry) =>
    entry?.namespace === WAKE_CORE_NAMESPACE && entry?.sourceId === WAKE_CORE_SOURCE_ID);
  if (entryRequiresWake.length !== 1) {
    fail("input closure does not bind its wake.core require to the trusted provider");
  }

  const schema = validateModels(publicModel.projection, internalModel.projection);
  const sourceText = sourceTexts[bundle.entrySourceId];
  const decoded = checkedDeclarationDecoder(
    checked.projection,
    schema,
    wakeImports[0].alias,
    bundle.entrySourceId,
    sourceText,
  );
  const sourceName = bundle.entrySourceId.slice(bundle.entrySourceId.lastIndexOf("/") + 1);
  const identity = decoded.rootType === "PluginSpec"
    ? decoded.rootValue.identity
    : null;
  const sourceUnit = {
    _tag: "IrSourceUnit",
    source_id: bundle.entrySourceId,
    path: sourceName,
    package_id: identity?.package_id ?? "application",
    package_version: identity?.version ?? compilerVersion,
  };
  const declarationProvenance = [...decoded.macroGroups.values()]
    .sort((left, right) => left.invocation.pos - right.invocation.pos)
    .map((group) => {
      const primary = decoded.primaryForm(group);
      return {
        _tag: "IrDeclarationProvenance",
        kind: group.macro,
        name: primary.name,
        provenance: {
          _tag: "IrProvenance",
          source: sourceUnit,
          span: sourceSpan(group.invocation, sourceUnit, sourceText),
        },
      };
    });

  const program = {
    _tag: "IrDeclarationProgram",
    source_unit: sourceUnit,
    ns: checked.projection.namespace,
    root: decoded.rootType === "PluginSpec"
      ? { _tag: "IrPluginDeclarationRoot", plugin: decoded.rootValue }
      : { _tag: "IrApplicationDeclarationRoot", application: decoded.rootValue },
    ...decoded.categories,
  };
  return {
    _tag: "IrCheckedDeclarationProgram",
    program,
    declaration_provenance: declarationProvenance,
  };
}
