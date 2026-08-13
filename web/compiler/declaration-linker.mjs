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

function exactRef(index, ref, tag, label) {
  if (ref?._tag !== tag || index.get(nominalKey(ref)) !== ref) {
    fail(`${label} is not an exact ${tag} reference`);
  }
  return ref;
}

function nominalIndex(declarations, tag, label) {
  const result = new Map();
  for (const declaration of array(declarations, label)) {
    const ref = declaration.ref;
    if (ref?._tag !== tag) fail(`${label} contains the wrong reference type`);
    const key = nominalKey(ref);
    if (result.has(key)) fail(`${label} repeats '${ref.declaration_id}'`);
    result.set(key, ref);
  }
  return result;
}

function valueTypeIndex(program, label) {
  const result = new Map();
  for (const declaration of array(program.value_types, `${label} value types`)) {
    if (declaration?._tag !== "IrValueTypeDeclarationSpec") {
      fail(`${label} value types contain an unsupported declaration`);
    }
    const definitions = array(declaration.definitions, `${label} value type definitions`);
    for (const definition of definitions) {
      if (definition?._tag !== "IrValueTypeDefinition"
          || definition.ref?._tag !== "IrValueTypeRef") {
        fail(`${label} value type definitions contain an unsupported definition`);
      }
      const key = nominalKey(definition.ref);
      if (result.has(key)) {
        fail(`${label} value type definitions repeat '${definition.ref.declaration_id}'`);
      }
      result.set(key, { declaration, definition });
    }
    const root = result.get(nominalKey(declaration.root));
    if (declaration.root?._tag !== "IrValueTypeRef" || root?.definition.ref !== declaration.root) {
      fail(`${label} value type root is not its exact declared definition`);
    }
  }
  return result;
}

function recordEntries(value, label) {
  if (value?._tag !== "IrRecordValue") fail(`${label} must be a record value`);
  const result = new Map();
  for (const entry of array(value.fields, `${label} fields`)) {
    if (entry?._tag !== "IrValueRecordEntry") fail(`${label} has an invalid field entry`);
    const name = nonempty(entry.name, `${label} field name`);
    if (result.has(name)) fail(`${label} repeats field '${name}'`);
    result.set(name, entry.value);
  }
  return result;
}

function closedValue(value, label) {
  switch (value?._tag) {
    case "IrLiteralStringValue":
    case "IrLiteralKeywordValue":
      return nonempty(value.value, label);
    case "IrLiteralIntegerValue":
      if (!Number.isSafeInteger(value.value) || Object.is(value.value, -0)) {
        fail(`${label} must be a safe integer`);
      }
      return value.value;
    case "IrLiteralBooleanValue":
      if (typeof value.value !== "boolean") fail(`${label} must be boolean`);
      return value.value;
    case "IrLiteralNilValue":
      if (value.unit !== null) fail(`${label} has an invalid nil value`);
      return null;
    case "IrRecordValue": {
      const result = Object.create(null);
      for (const [name, field] of recordEntries(value, label)) {
        result[name] = closedValue(field, `${label}.${name}`);
      }
      return result;
    }
    case "IrListValue":
      return array(value.items, `${label} items`)
        .map((item, index) => closedValue(item, `${label}[${index}]`));
    default:
      fail(`${label} must be a closed literal value, not '${value?._tag ?? "missing"}'`);
  }
}

function exactRole(context, ref, tag, label) {
  if (ref?._tag !== tag) fail(`${label} has the wrong role reference type`);
  const role = context.roles.get(nominalKey(ref));
  if (role?.ref !== ref) fail(`${label} is not an exact declared role reference`);
  const binding = context.bindings.get(nominalKey(ref));
  if (binding === undefined) fail(`${label} has no exact binding`);
  return binding;
}

function checkedBound(bound, context, label) {
  let value;
  switch (bound?._tag) {
    case "IrLiteralBound":
      value = bound.value;
      break;
    case "IrConfiguredBound":
      value = exactRole(context, bound.role, "IrIntRoleRef", label).value;
      break;
    case "IrConfiguredProjectionBound": {
      const projection = bound.projection;
      if (projection?._tag !== "IrConfigProjection") {
        fail(`${label} has an invalid configured projection`);
      }
      const binding = exactRole(context, projection.role, "IrValueRoleRef", label);
      value = closedValue(binding.value, `${label} configured value`);
      for (const part of array(projection.path, `${label} projection path`)) {
        nonempty(part, `${label} projection path part`);
        if (value === null || typeof value !== "object" || Array.isArray(value)
            || !Object.hasOwn(value, part)) {
          fail(`${label} projection misses '${part}'`);
        }
        value = value[part];
      }
      break;
    }
    default:
      fail(`${label} uses unsupported bound '${bound?._tag ?? "missing"}'`);
  }
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    fail(`${label} must resolve to a safe integer`);
  }
  return value;
}

function optionalBound(bound, context, label, { nonnegative = false } = {}) {
  if (bound === null) return null;
  const value = checkedBound(bound, context, label);
  if (nonnegative && value < 0) fail(`${label} must be nonnegative`);
  return value;
}

function valueMetrics(semantic, children = []) {
  return {
    semantic,
    depth: children.length === 0 ? 1 : 1 + Math.max(...children.map((child) => child.depth)),
    nodes: 1 + children.reduce((sum, child) => sum + child.nodes, 0),
  };
}

function scalarValue(value, tag, label, validate = () => {}) {
  if (value?._tag !== tag) fail(`${label} must be ${tag}`);
  validate(value.value);
  return valueMetrics(value.value);
}

function checkedLiteral(literal, label) {
  switch (literal?._tag) {
    case "IrStringLiteral":
      if (typeof literal.value !== "string") fail(`${label} has an invalid string literal`);
      return { tag: "IrLiteralStringValue", value: literal.value };
    case "IrIntegerLiteral":
      if (!Number.isSafeInteger(literal.value) || Object.is(literal.value, -0)) {
        fail(`${label} has an invalid integer literal`);
      }
      return { tag: "IrLiteralIntegerValue", value: literal.value };
    case "IrBooleanLiteral":
      if (typeof literal.value !== "boolean") fail(`${label} has an invalid boolean literal`);
      return { tag: "IrLiteralBooleanValue", value: literal.value };
    case "IrKeywordLiteral":
      return {
        tag: "IrLiteralKeywordValue",
        value: nonempty(literal.value, `${label} keyword literal`),
      };
    case "IrNilLiteral":
      if (literal.unit !== null) fail(`${label} has an invalid nil literal`);
      return { tag: "IrLiteralNilValue", value: null };
    default:
      fail(`${label} uses unsupported literal type '${literal?._tag ?? "missing"}'`);
  }
}

function literalMatch(value, literal, label) {
  const expected = checkedLiteral(literal, label);
  if (value?._tag !== expected.tag) fail(`${label} does not match its exact literal`);
  let actual = value.value;
  if (expected.tag === "IrLiteralStringValue" && typeof actual !== "string") {
    fail(`${label} has an invalid string value`);
  }
  if (expected.tag === "IrLiteralIntegerValue"
      && (!Number.isSafeInteger(actual) || Object.is(actual, -0))) {
    fail(`${label} has an invalid integer value`);
  }
  if (expected.tag === "IrLiteralBooleanValue" && typeof actual !== "boolean") {
    fail(`${label} has an invalid boolean value`);
  }
  if (expected.tag === "IrLiteralKeywordValue") {
    actual = nonempty(actual, `${label} keyword value`);
  }
  if (expected.tag === "IrLiteralNilValue") {
    if (value.unit !== null) fail(`${label} has an invalid nil value`);
    actual = null;
  }
  if (!Object.is(actual, expected.value)) {
    fail(`${label} does not match its exact literal`);
  }
  return valueMetrics(expected.value);
}

function recordTypeFields(fields, label) {
  const result = new Map();
  for (const field of array(fields, `${label} fields`)) {
    if (field?._tag !== "IrValueRecordField") fail(`${label} has an invalid field`);
    const name = nonempty(field.name, `${label} field name`);
    if (result.has(name)) fail(`${label} repeats field '${name}'`);
    if (typeof field.required !== "boolean") fail(`${label}.${name} required flag is invalid`);
    result.set(name, field);
  }
  return result;
}

function checkedRecord(value, fields, context, label, fixed = new Map()) {
  const supplied = recordEntries(value, label);
  const declared = recordTypeFields(fields, label);
  for (const name of fixed.keys()) {
    if (declared.has(name)) fail(`${label} type repeats discriminator '${name}'`);
  }
  for (const name of supplied.keys()) {
    if (!declared.has(name) && !fixed.has(name)) fail(`${label} has unknown field '${name}'`);
  }
  const semantic = Object.create(null);
  const children = [];
  for (const [name, expected] of fixed) {
    const item = supplied.get(name);
    if (item === undefined) fail(`${label}.${name} is required`);
    const checked = literalMatch(item, expected, `${label}.${name}`);
    semantic[name] = checked.semantic;
    children.push(checked);
  }
  for (const [name, field] of declared) {
    const item = supplied.get(name);
    if (item === undefined) {
      if (field.required) fail(`${label}.${name} is required`);
      continue;
    }
    const checked = checkedValue(item, field.value_type, context, `${label}.${name}`);
    semantic[name] = checked.semantic;
    children.push(checked);
  }
  return valueMetrics(semantic, children);
}

function validateEnvelope(result, envelope, context, label) {
  if (envelope?._tag !== "IrValueEnvelopeSpec") fail(`${label} has an invalid envelope`);
  const maximumBytes = optionalBound(
    envelope.maximum_bytes, context, `${label} maximum bytes`, { nonnegative: true },
  );
  const maximumDepth = optionalBound(
    envelope.maximum_depth, context, `${label} maximum depth`, { nonnegative: true },
  );
  const maximumNodes = optionalBound(
    envelope.maximum_nodes, context, `${label} maximum nodes`, { nonnegative: true },
  );
  const bytes = utf8Length(canonicalJson(result.semantic));
  if (maximumBytes !== null && bytes > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte envelope`);
  }
  if (maximumDepth !== null && result.depth > maximumDepth) {
    fail(`${label} exceeds its depth-${maximumDepth} envelope`);
  }
  if (maximumNodes !== null && result.nodes > maximumNodes) {
    fail(`${label} exceeds its ${maximumNodes}-node envelope`);
  }
}

function checkedValue(value, type, context, label) {
  switch (type?._tag) {
    case "IrStringValueType": {
      const result = scalarValue(value, "IrLiteralStringValue", label, (item) => {
        if (typeof item !== "string") fail(`${label} must contain a string`);
      });
      const minimum = optionalBound(type.minimum_scalars, context, `${label} minimum scalars`, {
        nonnegative: true,
      });
      const maximum = optionalBound(type.maximum_scalars, context, `${label} maximum scalars`, {
        nonnegative: true,
      });
      const maximumBytes = optionalBound(type.maximum_bytes, context, `${label} maximum bytes`, {
        nonnegative: true,
      });
      if (minimum !== null && maximum !== null && minimum > maximum) {
        fail(`${label} has inverted string bounds`);
      }
      const scalars = [...result.semantic].length;
      if ((minimum !== null && scalars < minimum)
          || (maximum !== null && scalars > maximum)
          || (maximumBytes !== null && utf8Length(result.semantic) > maximumBytes)) {
        fail(`${label} is outside its string bounds`);
      }
      return result;
    }
    case "IrIntegerValueType": {
      const result = scalarValue(value, "IrLiteralIntegerValue", label, (item) => {
        if (!Number.isSafeInteger(item) || Object.is(item, -0)) {
          fail(`${label} must contain a safe integer`);
        }
      });
      const minimum = optionalBound(type.minimum, context, `${label} minimum`);
      const maximum = optionalBound(type.maximum, context, `${label} maximum`);
      if (minimum !== null && maximum !== null && minimum > maximum) {
        fail(`${label} has inverted integer bounds`);
      }
      if ((minimum !== null && result.semantic < minimum)
          || (maximum !== null && result.semantic > maximum)) {
        fail(`${label} is outside its integer bounds`);
      }
      return result;
    }
    case "IrBooleanValueType":
      return scalarValue(value, "IrLiteralBooleanValue", label, (item) => {
        if (typeof item !== "boolean") fail(`${label} must contain boolean`);
      });
    case "IrDigestValueType":
      return scalarValue(value, "IrLiteralStringValue", label, (item) => {
        if (!SHA256.test(item)) fail(`${label} must be a canonical sha256 digest`);
      });
    case "IrInstantValueType": {
      const fields = recordEntries(value, label);
      if (fields.size !== 2 || !fields.has("epochSeconds") || !fields.has("nanos")) {
        fail(`${label} must contain exactly epochSeconds and nanos`);
      }
      const epochSeconds = scalarValue(
        fields.get("epochSeconds"), "IrLiteralIntegerValue", `${label}.epochSeconds`,
        (item) => {
          if (!Number.isSafeInteger(item) || Object.is(item, -0)) {
            fail(`${label}.epochSeconds must contain a safe integer`);
          }
        },
      );
      const nanos = scalarValue(
        fields.get("nanos"), "IrLiteralIntegerValue", `${label}.nanos`,
        (item) => {
          if (!Number.isSafeInteger(item) || item < 0 || item > 999_999_999) {
            fail(`${label}.nanos is outside the nanosecond range`);
          }
        },
      );
      return valueMetrics({
        epochSeconds: epochSeconds.semantic,
        nanos: nanos.semantic,
      }, [epochSeconds, nanos]);
    }
    case "IrKeywordValueType": {
      const result = scalarValue(value, "IrLiteralKeywordValue", label, (item) => {
        nonempty(item, label);
      });
      const allowed = array(type.allowed, `${label} allowed keywords`);
      unique(allowed, (item) => item, `${label} allowed keywords`);
      if (!allowed.includes(result.semantic)) fail(`${label} is outside its closed keyword set`);
      return result;
    }
    case "IrEnumValueType": {
      const allowed = array(type.allowed, `${label} enum literals`);
      allowed.forEach((literal, index) => checkedLiteral(literal, `${label} enum ${index}`));
      unique(allowed, (literal) => canonicalJson(literal), `${label} enum literals`);
      const literal = allowed.find((candidate) => {
        try {
          literalMatch(value, candidate, label);
          return true;
        } catch (error) {
          if (error instanceof TypeError
              && error.message.startsWith("wake declaration linker:")) return false;
          throw error;
        }
      });
      if (literal === undefined) fail(`${label} is outside its closed enum set`);
      return literalMatch(value, literal, label);
    }
    case "IrEntityReferenceValueType":
      exactRef(context.entities, type.entity, "IrEntityRef", `${label} entity type`);
      return scalarValue(value, "IrLiteralStringValue", label, (item) => nonempty(item, label));
    case "IrStateValueType": {
      exactRef(context.states, type.state, "IrStateRef", `${label} state type`);
      const result = scalarValue(value, "IrLiteralKeywordValue", label, (item) => nonempty(item, label));
      const state = context.stateDeclarations.get(nominalKey(type.state));
      if (!state.values.some((entry) => entry.value === result.semantic)) {
        fail(`${label} is outside its exact state`);
      }
      return result;
    }
    case "IrRecordValueType":
      return checkedRecord(value, type.fields, context, label);
    case "IrTaggedValueType": {
      const tagField = nonempty(type.tag_field, `${label} tag field`);
      const variants = array(type.variants, `${label} variants`);
      unique(variants, (variant) => variant.tag, `${label} variants`);
      const supplied = recordEntries(value, label);
      const discriminator = supplied.get(tagField);
      if (discriminator?._tag !== "IrLiteralStringValue") {
        fail(`${label}.${tagField} must be a string discriminator`);
      }
      const variant = variants.find((candidate) => candidate.tag === discriminator.value);
      if (variant === undefined) fail(`${label} has unknown tag '${discriminator.value}'`);
      return checkedRecord(
        value,
        variant.fields,
        context,
        label,
        new Map([[tagField, { _tag: "IrStringLiteral", value: variant.tag }]]),
      );
    }
    case "IrListValueType": {
      if (value?._tag !== "IrListValue") fail(`${label} must be a list value`);
      const items = array(value.items, `${label} items`);
      const minimum = optionalBound(type.minimum_items, context, `${label} minimum items`, {
        nonnegative: true,
      });
      const maximum = optionalBound(type.maximum_items, context, `${label} maximum items`, {
        nonnegative: true,
      });
      if (minimum !== null && maximum !== null && minimum > maximum) {
        fail(`${label} has inverted list bounds`);
      }
      if ((minimum !== null && items.length < minimum)
          || (maximum !== null && items.length > maximum)) {
        fail(`${label} is outside its list bounds`);
      }
      const checked = items.map((item, index) =>
        checkedValue(item, type.item, context, `${label}[${index}]`));
      if (type.normalization !== null) {
        if (type.normalization?._tag !== "IrSortUniqueList") {
          fail(`${label} uses unsupported list normalization '${type.normalization?._tag ?? "missing"}'`);
        }
        const keys = checked.map((item) => canonicalJson(item.semantic));
        if (keys.some((key, index) => index > 0 && key <= keys[index - 1])) {
          fail(`${label} is not in canonical sort-unique order`);
        }
      }
      return valueMetrics(checked.map((item) => item.semantic), checked);
    }
    case "IrNullableValueType":
      return value?._tag === "IrLiteralNilValue"
        ? literalMatch(value, { _tag: "IrNilLiteral", unit: null }, label)
        : checkedValue(value, type.value_type, context, label);
    case "IrNamedValueType": {
      const entry = context.valueTypes.get(nominalKey(type.value_type));
      if (type.value_type?._tag !== "IrValueTypeRef" || entry?.definition.ref !== type.value_type) {
        fail(`${label} names a non-exact value type reference`);
      }
      let active = context.activeNamed.get(value);
      if (active === undefined) {
        active = new Set();
        context.activeNamed.set(value, active);
      }
      const key = nominalKey(type.value_type);
      if (active.has(key)) fail(`${label} contains a non-consuming named type cycle`);
      active.add(key);
      try {
        const result = checkedValue(value, entry.definition.spec, context, label);
        if (entry.declaration.root === type.value_type && entry.declaration.envelope !== null) {
          validateEnvelope(result, entry.declaration.envelope, context, label);
        }
        return result;
      } finally {
        active.delete(key);
      }
    }
    case "IrLiteralValueType":
      return literalMatch(value, type.literal, label);
    case "IrExtensionValueType":
      exactRef(
        context.entityFieldsPorts,
        type.port,
        "IrEntityFieldsPortRef",
        `${label} extension type`,
      );
      fail(`${label} cannot bind an extension value at compile time`);
      break;
    default:
      fail(`${label} uses unsupported value type '${type?._tag ?? "missing"}'`);
  }
}

function validateBindings(use, program, label) {
  const plugin = program.root.plugin;
  const roles = roleIndex(plugin.configuration, `${label} plugin configuration`);
  const claimed = new Set();
  const bindings = new Map();
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
      bindings.set(key, binding);
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
  const states = nominalIndex(program.states, "IrStateRef", `${label} states`);
  const context = {
    activeNamed: new WeakMap(),
    bindings,
    entities: nominalIndex(program.entities, "IrEntityRef", `${label} entities`),
    entityFieldsPorts: nominalIndex(
      program.entity_fields_ports,
      "IrEntityFieldsPortRef",
      `${label} entity-fields ports`,
    ),
    roles,
    stateDeclarations: new Map(program.states.map((state) => [nominalKey(state.ref), state])),
    states,
    valueTypes: valueTypeIndex(program, label),
  };
  for (const binding of use.bindings.values) {
    const role = roles.get(`IrValueRoleRef\u0000${binding.role.declaration_id}`);
    checkedValue(
      binding.value,
      role.value_type,
      context,
      `${label} value binding '${binding.role.name}'`,
    );
  }
}

function validateComposition(composition, pluginProgram, exported, application, label) {
  const use = composition.use;
  validateBindings(use, pluginProgram, label);
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
  const applicationNeedsReceipt = applicationProgram.commands.length !== 0
    || applicationProgram.root.application.plugins.length !== 0
    || applicationProgram.receipt_entity !== null
    || applicationProgram.receipt_fields.length !== 0;
  const applicationReceipt = applicationNeedsReceipt
    ? coreReceipt(applicationProgram, "application")
    : null;
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
  const preparedArtifacts = new Map();
  const usedArtifacts = new Set();
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
    let prepared = preparedArtifacts.get(key);
    if (prepared === undefined) {
      const pluginProgram = declarationProgram(
        suppliedPlugin.checked, "IrPluginDeclarationRoot", `${label} checked source`,
      );
      validateReceipt(pluginProgram, applicationReceipt, `${label} checked source`);
      claimReceiptFields(pluginProgram, label);
      const declared = declarationIndex(pluginProgram, label);
      prepared = {
        exported: exportedIndex(pluginProgram, declared, label),
        manifest: validateManifest(
          pluginProgram,
          suppliedPlugin.artifact,
          suppliedPlugin.lockEntry,
          compilerVersion,
          label,
        ),
        pluginProgram,
      };
      preparedArtifacts.set(key, prepared);
    }
    const { exported, manifest, pluginProgram } = prepared;
    usedArtifacts.add(key);
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
  }
  const unused = [...artifacts].find(([key]) => !usedArtifacts.has(key));
  if (unused !== undefined) {
    const plugin = unused[1];
    fail(`locked plugin '${plugin.artifact.manifest.packageId}' is not used by the application`);
  }
  return {
    _tag: "IrLinkedDeclarationProgram",
    application,
    plugins: instances,
  };
}
