import { compileCheckedValue as validateCheckedValueDescriptor } from "../runtime/checked-value.mjs";

const CHECKED_VALUE_RUNTIME_SOURCE = (await Bun.file(
  new URL("../runtime/checked-value.mjs", import.meta.url),
).text()).replace(/^export /gmu, "");

const SAFE_DOCUMENT_RUNTIME_SOURCE = (await Bun.file(
  new URL("../runtime/safe-document.mjs", import.meta.url),
).text())
  .replace(/^import \{ compileCheckedValue \} from "\.\/checked-value\.mjs";\n/u, "")
  .replace(/^export /gmu, "");

const PRIMITIVE_TYPES = Object.freeze({
  Bool: Object.freeze({ kind: "boolean" }),
  Boolean: Object.freeze({ kind: "boolean" }),
  Double: Object.freeze({ kind: "number" }),
  Digest: Object.freeze({ kind: "digest" }),
  Float: Object.freeze({ kind: "number" }),
  Instant: Object.freeze({ kind: "instant" }),
  Int: Object.freeze({ kind: "integer" }),
  Integer: Object.freeze({ kind: "integer" }),
  Keyword: Object.freeze({ kind: "keyword" }),
  Number: Object.freeze({ kind: "number" }),
  String: Object.freeze({ kind: "string" }),
});

function fail(message) {
  throw new TypeError(`wake client generation: ${message}`);
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function uniqueNames(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    const name = nonempty(entry?.name, `${label} name`);
    if (seen.has(name)) fail(`${label} repeats '${name}'`);
    seen.add(name);
  }
}

function normalizedStateName(value, label) {
  const name = nonempty(value, label);
  const normalized = name.startsWith(":") ? name.slice(1) : name;
  if (normalized.length === 0) fail(`${label} must not be empty after keyword normalization`);
  return normalized;
}

function stateTypes(checked) {
  const result = new Map();
  for (const state of checked.defstates ?? []) {
    const name = nonempty(state?.name, "state type name");
    if (result.has(name)) fail(`state type '${name}' is duplicated`);
    if (state.transitions === null || typeof state.transitions !== "object"
        || Array.isArray(state.transitions)) {
      fail(`state type '${name}' has no checked transitions`);
    }
    const values = Object.keys(state.transitions).map((value) => (
      normalizedStateName(value, `state type '${name}' state`)
    ));
    if (values.length === 0 || new Set(values).size !== values.length) {
      fail(`state type '${name}' must declare unique states`);
    }
    result.set(name, values);
  }
  return result;
}

function entitiesByName(checked) {
  const result = new Map();
  for (const entity of checked.entities ?? []) {
    const name = nonempty(entity?.name, "entity name");
    if (result.has(name)) fail(`entity '${name}' is duplicated`);
    result.set(name, entity);
  }
  return result;
}

function queryValueDescriptor(type, states, label) {
  if (Object.hasOwn(PRIMITIVE_TYPES, type)) return { ...PRIMITIVE_TYPES[type] };
  const values = states.get(type);
  if (values !== undefined) return { kind: "keyword", values: [...values] };
  fail(`${label} has unsupported type '${type}'`);
}

function queryColumnDescriptor(column, states, entities, label) {
  const cardinality = column?.cardinality;
  if (cardinality !== "single" && cardinality !== "multi") {
    fail(`${label} has invalid cardinality '${cardinality}'`);
  }
  if (column.value_kind === "ref") {
    if (column.type !== "Ref") fail(`${label} reference has non-Ref type '${column.type}'`);
    const targetName = nonempty(column.target_entity, `${label} target entity`);
    const target = entities.get(targetName);
    if (target === undefined || target.identity_field == null) {
      fail(`${label} targets entity '${targetName}' without a checked identity`);
    }
    if (target.identity_field.value_kind === "ref" || target.identity_field.type === "Ref") {
      fail(`${label} targets entity '${targetName}' with a reference identity`);
    }
    return {
      cardinality,
      name: nonempty(column.name, `${label} name`),
      value: {
        entity: targetName,
        kind: "reference",
        value: queryValueDescriptor(
          target.identity_field.type,
          states,
          `${label} target identity`,
        ),
      },
    };
  }
  if (column.value_kind !== "literal") fail(`${label} has invalid value kind`);
  if (column.type === "Ref") fail(`${label} has an unqualified Ref type`);
  return {
    cardinality,
    name: nonempty(column.name, `${label} name`),
    value: queryValueDescriptor(column.type, states, label),
  };
}

function nonnegativeBound(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be nonnegative`);
  return value;
}

function commandValueDescriptor(source, label, active = new Set()) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    fail(`${label} is not a checked value type`);
  }
  if (active.has(source)) fail(`${label} is recursively cyclic`);
  active.add(source);
  try {
    switch (source.kind) {
      case "string": {
        const result = { kind: "string" };
        for (const [key, name] of [
          ["minLength", "minimum length"],
          ["maxLength", "maximum length"],
          ["maxBytes", "maximum bytes"],
        ]) {
          if (source[key] !== undefined) result[key] = nonnegativeBound(source[key], `${label} ${name}`);
        }
        if (result.minLength !== undefined && result.maxLength !== undefined
            && result.minLength > result.maxLength) {
          fail(`${label} minimum length exceeds maximum length`);
        }
        return result;
      }
      case "integer":
      case "number":
      case "boolean":
      case "instant":
      case "keyword":
      case "digest":
        return { kind: source.kind };
      case "nullable":
        return {
          kind: "nullable",
          value: commandValueDescriptor(source.value, `${label} nullable value`, active),
        };
      case "list":
        return {
          items: commandValueDescriptor(source.items, `${label} list item`, active),
          kind: "list",
          maxItems: nonnegativeBound(source.maxItems, `${label} maximum items`),
          ...(source.normalizer === undefined ? {} : { normalizer: source.normalizer }),
        };
      case "record": {
        if (!Array.isArray(source.fields)) fail(`${label} record fields must be an array`);
        uniqueNames(source.fields, `${label} record field`);
        return {
          fields: source.fields.map((field) => ({
            name: field.name,
            required: field.required === true,
            value: commandValueDescriptor(field.type, `${label}.${field.name}`, active),
          })),
          kind: "record",
        };
      }
      case "bounded":
      case "literal":
      case "enum":
      case "tagged":
      case "ref":
        return structuredClone(source);
      default:
        fail(`${label} has unsupported kind '${source.kind}'`);
    }
  } finally {
    active.delete(source);
  }
}

function queryDescriptors(checked, states, entities) {
  const queries = checked.queries ?? [];
  if (!Array.isArray(queries)) fail("checked queries must be an array");
  uniqueNames(queries, "query");
  return queries.map((query) => {
    if (!Array.isArray(query.capabilities) || !Array.isArray(query.params)
        || !Array.isArray(query.columns)) {
      fail(`query '${query.name}' has an invalid checked shape`);
    }
    const capabilities = query.capabilities.map((capability) => (
      nonempty(capability, `query '${query.name}' capability`)
    ));
    if (capabilities.length < 1 || capabilities.length > 16
        || new Set(capabilities).size !== capabilities.length) {
      fail(`query '${query.name}' must declare from 1 through 16 unique capabilities`);
    }
    uniqueNames(query.params, `query '${query.name}' parameter`);
    uniqueNames(query.columns, `query '${query.name}' column`);
    const publicColumns = query.columns.filter(column => column.internal !== true);
    const resultProviders = query.result_providers ?? [];
    if (!Array.isArray(resultProviders)) {
      fail(`query '${query.name}' result providers must be an array`);
    }
    uniqueNames(resultProviders, `query '${query.name}' result provider`);
    const publicNames = new Set(publicColumns.map(column => column.name));
    for (const provider of resultProviders) {
      if (publicNames.has(provider.name)) {
        fail(`query '${query.name}' result repeats '${provider.name}'`);
      }
      publicNames.add(provider.name);
    }
    if (!["one", "optional", "page"].includes(query.result_kind)) {
      fail(`query '${query.name}' has invalid result kind '${query.result_kind}'`);
    }
    const result = {
      columns: [
        ...publicColumns.map((column) => queryColumnDescriptor(
          column,
          states,
          entities,
          `query '${query.name}' column '${column.name}'`,
        )),
        ...resultProviders.map(provider => ({
          cardinality: "single",
          name: nonempty(provider.name, `query '${query.name}' result provider name`),
          value: commandValueDescriptor(
            provider.output_type,
            `query '${query.name}' result provider '${provider.name}'`,
          ),
        })),
      ],
      kind: query.result_kind,
    };
    if (query.result_kind === "page") {
      result.defaultLimit = nonnegativeBound(
        query.default_limit,
        `query '${query.name}' default limit`,
      );
      result.maxLimit = nonnegativeBound(query.max_limit, `query '${query.name}' maximum limit`);
      if (result.defaultLimit < 1 || result.maxLimit < 1
          || result.defaultLimit > result.maxLimit) {
        fail(`query '${query.name}' has invalid page limits`);
      }
    }
    return {
      capabilities,
      input: query.params.map((parameter) => ({
        name: parameter.name,
        required: true,
        value: queryValueDescriptor(
          parameter.type,
          states,
          `query '${query.name}' parameter '${parameter.name}'`,
        ),
      })),
      name: query.name,
      result,
    };
  });
}

function commandDescriptors(checked) {
  const commands = checked.commands ?? [];
  if (!Array.isArray(commands)) fail("checked commands must be an array");
  uniqueNames(commands, "command");
  return commands.map((command) => {
    if (!Array.isArray(command.input) || !Array.isArray(command.result)
        || !Array.isArray(command.capabilities)) {
      fail(`command '${command.name}' has an invalid checked shape`);
    }
    uniqueNames(command.input, `command '${command.name}' input`);
    uniqueNames(command.result, `command '${command.name}' result`);
    const capabilities = command.capabilities.map((choice) => (
      nonempty(choice?.capability, `command '${command.name}' capability`)
    ));
    if (new Set(capabilities).size !== capabilities.length) {
      fail(`command '${command.name}' repeats a capability`);
    }
    if (!Number.isSafeInteger(command.normalizerVersion)
        || command.normalizerVersion < 1) {
      fail(`command '${command.name}' has invalid normalizer version`);
    }
    return {
      capabilities,
      input: command.input.map((field) => ({
        name: field.name,
        required: field.required === true,
        value: commandValueDescriptor(field.type, `command '${command.name}' input '${field.name}'`),
      })),
      name: command.name,
      normalizerVersion: command.normalizerVersion,
      result: command.result.map((field) => ({
        name: field.name,
        required: true,
        value: commandValueDescriptor(field.type, `command '${command.name}' result '${field.name}'`),
      })),
    };
  });
}

function operationDescriptors(checked) {
  const states = stateTypes(checked);
  return {
    commands: commandDescriptors(checked),
    queries: queryDescriptors(checked, states, entitiesByName(checked)),
  };
}

function checkedSafeDocumentDescriptor(checked) {
  const declarations = checked.value_types ?? [];
  if (!Array.isArray(declarations)) fail("checked value types must be an array");
  const matches = declarations.filter(declaration => (
    declaration?.name === "SafeDocument" || declaration?.name?.endsWith(".SafeDocument")
  ));
  if (matches.length > 1) fail("value type 'SafeDocument' is duplicated");
  if (matches.length === 0) return null;
  try {
    return validateCheckedValueDescriptor(matches[0].descriptor, {
      descriptorCode: "wake-client/invalid-safe-document-descriptor",
    }).descriptor;
  } catch (error) {
    fail(`value type 'SafeDocument' is invalid: ${error.message}`);
  }
}

export function generateWakeClient(checked) {
  if (checked === null || typeof checked !== "object"
      || typeof checked.semantic_fingerprint !== "string") {
    fail("a checked application fingerprint is required");
  }
  const fingerprint = checked.semantic_fingerprint;
  const applicationId = nonempty(checked.application_id, "checked application ID");
  const descriptors = operationDescriptors(checked);
  const safeDocument = checkedSafeDocumentDescriptor(checked);
  const safeDocumentSource = safeDocument === null ? "" : `
const { compileCheckedValue: compileSafeDocumentValue } = (() => {
${CHECKED_VALUE_RUNTIME_SOURCE}
  return { compileCheckedValue };
})();

const { renderSafeDocument: renderCheckedSafeDocument } = ((compileCheckedValue) => {
${SAFE_DOCUMENT_RUNTIME_SOURCE}
  return { renderSafeDocument };
})(compileSafeDocumentValue);

export const safeDocumentDescriptor = deepFreeze(${JSON.stringify(safeDocument)});
const safeDocumentCodec = compileSafeDocumentValue(safeDocumentDescriptor);

export function normalizeSafeDocument(value) {
  return safeDocumentCodec.normalize(value, {
    code: "safe-document/type-mismatch",
    label: "SafeDocument",
  });
}

export function renderSafeDocument(value, {
  document: documentObject = globalThis.document,
  resolveSafeUrl = null,
} = {}) {
  return renderCheckedSafeDocument(value, {
    descriptor: safeDocumentDescriptor,
    document: documentObject,
    resolveSafeUrl,
  });
}
`;
  return `// wake: checked-application ${fingerprint}
// Generated by Wake. Side-effect-free application metadata and value codecs.
export const applicationId = ${JSON.stringify(applicationId)};
export const semanticFingerprint = ${JSON.stringify(fingerprint)};

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

export const operations = deepFreeze(${JSON.stringify(descriptors)});

function indexDescriptors(entries, label) {
  const index = Object.create(null);
  for (const entry of entries) {
    if (Object.hasOwn(index, entry.name)) throw new TypeError(label + " repeats " + entry.name);
    Object.defineProperty(index, entry.name, { enumerable: true, value: entry });
  }
  return Object.freeze(index);
}

const queryIndex = indexDescriptors(operations.queries, "checked query");
const commandIndex = indexDescriptors(operations.commands, "checked command");
const integerPattern = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const i64Minimum = -(1n << 63n);
const i64Maximum = (1n << 63n) - 1n;

function descriptorNamed(index, name, label) {
  if (typeof name !== "string" || !Object.hasOwn(index, name)) {
    throw new TypeError("unknown checked " + label + " " + String(name));
  }
  return index[name];
}

function ownData(value, name, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(label + "." + name + " must be an enumerable data property");
  }
  return descriptor.value;
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedInteger(value, label) {
  let text;
  if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    text = String(value);
  } else if (typeof value === "string" && integerPattern.test(value)) text = value;
  else throw new TypeError(label + " must be an exact integer");
  const integer = BigInt(text);
  if (integer < i64Minimum || integer > i64Maximum) {
    throw new TypeError(label + " is outside the signed 64-bit range");
  }
  return text;
}

function unicodeScalarLength(value, label) {
  let count = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new TypeError(label + " contains an unpaired surrogate");
    }
    count += 1;
  }
  return count;
}

function normalizedArray(value, descriptor, label, maximum, normalizer) {
  if (!Array.isArray(value)) throw new TypeError(label + " must be an array");
  if (maximum !== undefined && value.length > maximum) {
    throw new TypeError(label + " exceeds " + maximum + " items");
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)
        || Number(key) >= value.length) {
      throw new TypeError(label + " contains an unsupported property");
    }
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(label + " must be dense");
    result.push(normalizeValue(ownData(value, String(index), label), descriptor, label + "[" + index + "]"));
  }
  if (normalizer === undefined) return deepFreeze(result);
  if (normalizer !== "sort-unique") {
    throw new TypeError(label + " has an unknown list normalizer");
  }
  const unique = new Map(result.map(item => [JSON.stringify(item), item]));
  return deepFreeze([...unique.entries()]
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
    .map(entry => entry[1]));
}

function normalizedRecord(value, fields, label) {
  if (!plainObject(value)) throw new TypeError(label + " must be a plain object");
  const expected = Object.create(null);
  for (const field of fields) {
    Object.defineProperty(expected, field.name, { enumerable: true, value: field });
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.hasOwn(expected, key)) {
      throw new TypeError(label + " contains an unsupported property " + String(key));
    }
  }
  const result = Object.create(null);
  for (const field of fields) {
    if (!Object.hasOwn(value, field.name)) {
      if (field.required) throw new TypeError(label + " requires " + field.name);
      continue;
    }
    Object.defineProperty(result, field.name, {
      enumerable: true,
      value: normalizeValue(
        ownData(value, field.name, label),
        field.value,
        label + "." + field.name,
      ),
    });
  }
  return deepFreeze(result);
}

function normalizeValue(value, descriptor, label) {
  switch (descriptor.kind) {
    case "string": {
      if (typeof value !== "string") throw new TypeError(label + " must be a string");
      const length = unicodeScalarLength(value, label);
      if (descriptor.minLength !== undefined && length < descriptor.minLength) {
        throw new TypeError(label + " is shorter than " + descriptor.minLength + " scalars");
      }
      if (descriptor.maxLength !== undefined && length > descriptor.maxLength) {
        throw new TypeError(label + " is longer than " + descriptor.maxLength + " scalars");
      }
      if (descriptor.maxBytes !== undefined
          && new TextEncoder().encode(value).byteLength > descriptor.maxBytes) {
        throw new TypeError(label + " exceeds " + descriptor.maxBytes + " UTF-8 bytes");
      }
      return value;
    }
    case "integer":
      return normalizedInteger(value, label);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError(label + " must be a finite JSON number other than negative zero");
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new TypeError(label + " must be boolean");
      return value;
    case "keyword":
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(label + " must be a nonempty keyword spelling");
      }
      if (descriptor.values !== undefined && !descriptor.values.includes(value)) {
        throw new TypeError(label + " is not a declared state");
      }
      return value;
    case "digest":
      if (typeof value !== "string" || !digestPattern.test(value)) {
        throw new TypeError(label + " must be a canonical sha256 digest");
      }
      return value;
    case "instant": {
      const checked = normalizedRecord(value, [
        { name: "epochSeconds", required: true, value: { kind: "integer" } },
        { name: "nanos", required: true, value: { kind: "integer" } },
      ], label);
      const nanos = BigInt(checked.nanos);
      if (nanos < 0n || nanos > 999999999n) {
        throw new TypeError(label + ".nanos is outside the nanosecond range");
      }
      const result = Object.create(null);
      Object.defineProperty(result, "epochSeconds", {
        enumerable: true,
        value: checked.epochSeconds,
      });
      Object.defineProperty(result, "nanos", { enumerable: true, value: Number(nanos) });
      return deepFreeze(result);
    }
    case "nullable":
      return value === null ? null : normalizeValue(value, descriptor.value, label);
    case "list":
      return normalizedArray(
        value,
        descriptor.items,
        label,
        descriptor.maxItems,
        descriptor.normalizer,
      );
    case "record":
      return normalizedRecord(value, descriptor.fields, label);
    case "bounded":
      return compileSafeDocumentValue(descriptor).normalize(value, {
        code: "wake-client/type-mismatch",
        label,
      });
    case "reference":
      return normalizeValue(value, descriptor.value, label);
    default:
      throw new TypeError(label + " has an unknown checked value type");
  }
}

function normalizedQueryRow(descriptor, value, label) {
  return normalizedRecord(value, descriptor.result.columns.map((column) => ({
    name: column.name,
    required: true,
    value: column.cardinality === "multi"
      ? { items: column.value, kind: "list" }
      : column.value,
  })), label);
}

export function queryDescriptor(name) {
  return descriptorNamed(queryIndex, name, "query");
}

export function commandDescriptor(name) {
  return descriptorNamed(commandIndex, name, "command");
}

export function normalizeQueryInput(name, value) {
  const descriptor = queryDescriptor(name);
  return normalizedRecord(value, descriptor.input, "query " + name + " input");
}

export function normalizeQueryResult(name, value) {
  const descriptor = queryDescriptor(name);
  const label = "query " + name + " result";
  if (descriptor.result.kind === "optional" && value === null) return null;
  if (descriptor.result.kind === "page") {
    return normalizedArray(
      value,
      { fields: descriptor.result.columns.map((column) => ({
        name: column.name,
        required: true,
        value: column.cardinality === "multi"
          ? { items: column.value, kind: "list" }
          : column.value,
      })), kind: "record" },
      label,
      descriptor.result.maxLimit,
    );
  }
  return normalizedQueryRow(descriptor, value, label);
}

export function normalizeCommandInput(name, value) {
  const descriptor = commandDescriptor(name);
  return normalizedRecord(value, descriptor.input, "command " + name + " input");
}

export function normalizeCommandResult(name, value) {
  const descriptor = commandDescriptor(name);
  return normalizedRecord(value, descriptor.result, "command " + name + " result");
}
${safeDocumentSource}
`;
}
