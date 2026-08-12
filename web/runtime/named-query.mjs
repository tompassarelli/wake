import { CheckedValueError, compileCheckedValue } from "./checked-value.mjs";

const QUERY_TIMEOUT_MS = 5_000;
const MAX_PAGE_LIMIT = 247;
const MAX_SINGULAR_ROWS = 4_096;
const MAX_QUERY_PAGES = 32;
const MAX_QUERY_CAPABILITIES = 16;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const FLOAT64 = /^[0-9a-f]{16}$/;
const NO_MATCH = Symbol("no-match");

export class NamedQueryError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = "NamedQueryError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new NamedQueryError(code, message, detail);
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredName(value, label, code = "gateway/invalid-plan") {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} must be a nonempty string`);
  }
  return value;
}

function exactKeys(value, allowed, label, code) {
  if (!plainObject(value)) fail(code, `${label} must be an object`);
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) fail(code, `${label}.${key} is not supported`);
  }
}

function exactRecord(value, keys, label) {
  exactKeys(value, keys, label, "gateway/invalid-plan");
  if (Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) {
    fail("gateway/invalid-plan", `${label} must contain exactly ${keys.join(", ")}`);
  }
}

function canonicalInteger(value, label, { nonnegative = false } = {}) {
  let text;
  if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    text = String(value);
  } else if (typeof value === "string" && INTEGER.test(value)) text = value;
  else fail("gateway/type-mismatch", `${label} must be an exact integer`);

  if (!INTEGER.test(text)) fail("gateway/type-mismatch", `${label} is not a canonical integer`);
  const integer = BigInt(text);
  if (integer < I64_MIN || integer > I64_MAX || (nonnegative && integer < 0n)) {
    fail("gateway/type-mismatch", `${label} is outside FRAM's integer range`);
  }
  return text;
}

function finiteJsonNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}

function floatBits(value, label) {
  if (!finiteJsonNumber(value)) {
    fail("gateway/type-mismatch", `${label} must be a finite JSON number other than negative zero`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function floatValue(bits, label) {
  if (typeof bits !== "string" || !FLOAT64.test(bits)) {
    fail("gateway/data-integrity", `${label} has invalid float bits`);
  }
  const bytes = Uint8Array.from(
    Array.from({ length: 8 }, (_, index) => Number.parseInt(bits.slice(index * 2, index * 2 + 2), 16)),
  );
  const value = new DataView(bytes.buffer).getFloat64(0, false);
  if (!finiteJsonNumber(value)) {
    fail("gateway/data-integrity", `${label} is not exactly representable as a JSON number`);
  }
  return value;
}

function cloneTerm(value, label = "Term", code = "gateway/invalid-plan") {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    fail(code, `${label} must be a tagged Term`);
  }
  switch (value[0]) {
    case "string":
      if (value.length === 2 && typeof value[1] === "string") return ["string", value[1]];
      break;
    case "integer":
      if (value.length === 2 && typeof value[1] === "string" && INTEGER.test(value[1])) {
        const integer = BigInt(value[1]);
        if (integer >= I64_MIN && integer <= I64_MAX) return ["integer", value[1]];
      }
      break;
    case "float64":
      if (value.length === 2 && typeof value[1] === "string" && FLOAT64.test(value[1])) {
        return ["float64", value[1]];
      }
      break;
    case "boolean":
      if (value.length === 2 && typeof value[1] === "boolean") return ["boolean", value[1]];
      break;
    case "keyword":
      if (value.length === 2 && typeof value[1] === "string" && value[1].length > 0) {
        return ["keyword", value[1]];
      }
      break;
    case "instant":
      if (value.length === 3 && typeof value[1] === "string" && INTEGER.test(value[1])
          && typeof value[2] === "string" && INTEGER.test(value[2])) {
        const seconds = BigInt(value[1]);
        const nanos = BigInt(value[2]);
        if (seconds >= I64_MIN && seconds <= I64_MAX && nanos >= 0n && nanos <= 999_999_999n) {
          return ["instant", value[1], value[2]];
        }
      }
      break;
    case "triple":
      if (value.length === 4) {
        return [
          "triple",
          cloneTerm(value[1], `${label}.t1`, code),
          cloneTerm(value[2], `${label}.t2`, code),
          cloneTerm(value[3], `${label}.t3`, code),
        ];
      }
      break;
    default:
      break;
  }
  fail(code, `${label} is not a valid tagged Term`);
}

function termEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (Array.isArray(left[index]) || Array.isArray(right[index])) {
      if (!termEqual(left[index], right[index])) return false;
    } else if (left[index] !== right[index]) return false;
  }
  return true;
}

function termKey(value) {
  const piece = part => `${String(part).length}:${String(part)}`;
  if (value[0] === "triple") {
    return `t${piece(termKey(value[1]))}${piece(termKey(value[2]))}${piece(termKey(value[3]))}`;
  }
  return `a${piece(value[0])}${piece(value[1])}${value.length === 3 ? piece(value[2]) : ""}`;
}

function encodeLiteral(type, value, label) {
  switch (type) {
    case "String":
      if (typeof value !== "string") fail("gateway/type-mismatch", `${label} must be a string`);
      return ["string", value];
    case "Int":
    case "Integer":
      return ["integer", canonicalInteger(value, label)];
    case "Float":
    case "Double":
    case "Number":
      return ["float64", floatBits(value, label)];
    case "Bool":
    case "Boolean":
      if (typeof value !== "boolean") fail("gateway/type-mismatch", `${label} must be a boolean`);
      return ["boolean", value];
    case "Keyword":
      if (typeof value !== "string" || value.length === 0) {
        fail("gateway/type-mismatch", `${label} must be a nonempty keyword spelling`);
      }
      return ["keyword", value];
    case "Instant": {
      if (value instanceof Date && Number.isFinite(value.getTime())) {
        const millis = BigInt(value.getTime());
        const seconds = millis >= 0n ? millis / 1000n : (millis - 999n) / 1000n;
        const nanos = (millis - seconds * 1000n) * 1_000_000n;
        return ["instant", seconds.toString(), nanos.toString()];
      }
      if (!plainObject(value) || !own(value, "epochSeconds") || !own(value, "nanos")
          || Object.keys(value).some(key => key !== "epochSeconds" && key !== "nanos")) {
        fail("gateway/type-mismatch", `${label} must contain only epochSeconds and nanos`);
      }
      const seconds = canonicalInteger(value.epochSeconds, `${label}.epochSeconds`);
      const nanos = canonicalInteger(value.nanos, `${label}.nanos`, { nonnegative: true });
      if (BigInt(nanos) > 999_999_999n) {
        fail("gateway/type-mismatch", `${label}.nanos is outside the nanosecond range`);
      }
      return ["instant", seconds, nanos];
    }
    case "Ref":
      fail("gateway/invalid-plan", `${label} cannot encode an unqualified Ref`);
      break;
    default:
      if (typeof value !== "string" || value.length === 0) {
        fail("gateway/type-mismatch", `${label} must be a nonempty ${type} value`);
      }
      return ["keyword", value];
  }
}

function decodeLiteral(type, value, label) {
  const term = cloneTerm(value, label, "gateway/data-integrity");
  const expected = (tag, length) => {
    if (term[0] !== tag || term.length !== length) {
      fail("gateway/data-integrity", `${label} is not a ${tag} Term`);
    }
  };
  switch (type) {
    case "String":
      expected("string", 2);
      return term[1];
    case "Int":
    case "Integer":
      expected("integer", 2);
      return BigInt(term[1]);
    case "Float":
    case "Double":
    case "Number":
      expected("float64", 2);
      return floatValue(term[1], label);
    case "Bool":
    case "Boolean":
      expected("boolean", 2);
      return term[1];
    case "Instant":
      expected("instant", 3);
      return { epochSeconds: BigInt(term[1]), nanos: Number(term[2]) };
    case "Keyword":
    default:
      expected("keyword", 2);
      return term[1];
  }
}

function templateHole(value, token) {
  return plainObject(value) && Object.keys(value).length === 1 && value.field === token;
}

function compileTemplatePart(value, token, label, state) {
  if (templateHole(value, token)) {
    state.holes += 1;
    return { hole: true };
  }
  if (plainObject(value) && own(value, "field")) {
    fail("gateway/invalid-plan", `${label} contains an unexpected identity hole`);
  }
  if (Array.isArray(value) && value[0] === "triple") {
    if (value.length !== 4) fail("gateway/invalid-plan", `${label} is not a Triple Term`);
    return {
      terms: [
        compileTemplatePart(value[1], token, `${label}.t1`, state),
        compileTemplatePart(value[2], token, `${label}.t2`, state),
        compileTemplatePart(value[3], token, `${label}.t3`, state),
      ],
    };
  }
  return { constant: cloneTerm(value, label) };
}

function compileSubjectTemplate(value, token, label) {
  const state = { holes: 0 };
  const template = compileTemplatePart(value, token, label, state);
  if (state.holes !== 1) fail("gateway/invalid-plan", `${label} must contain one identity hole`);
  return template;
}

function realizeTemplate(template, identity) {
  if (template.hole) return cloneTerm(identity, "identity", "gateway/type-mismatch");
  if (template.constant) return cloneTerm(template.constant);
  return ["triple", ...template.terms.map(part => realizeTemplate(part, identity))];
}

function matchTemplate(template, value) {
  if (template.hole) return cloneTerm(value, "subject identity", "gateway/data-integrity");
  if (template.constant) return termEqual(template.constant, value) ? null : NO_MATCH;
  if (!Array.isArray(value) || value[0] !== "triple" || value.length !== 4) return NO_MATCH;
  let found = null;
  for (let index = 0; index < 3; index += 1) {
    const matched = matchTemplate(template.terms[index], value[index + 1]);
    if (matched === NO_MATCH) return NO_MATCH;
    if (matched !== null) {
      if (found !== null && !termEqual(found, matched)) return NO_MATCH;
      found = matched;
    }
  }
  return found;
}

function typeFamily(type) {
  if (type === "Int" || type === "Integer") return "integer";
  if (type === "Float" || type === "Double" || type === "Number") return "float";
  if (type === "Bool" || type === "Boolean") return "boolean";
  return type;
}

function sourceEntities(surface) {
  if (Array.isArray(surface)) {
    const map = new Map(surface.map(entity => [entity?.name, entity]));
    return name => map.get(name);
  }
  if (surface instanceof Map) return name => surface.get(name);
  if (plainObject(surface) && Array.isArray(surface.entities)) return sourceEntities(surface.entities);
  if (plainObject(surface) && typeof surface.resolveEntity === "function") {
    return name => surface.resolveEntity(name);
  }
  if (typeof surface === "function") return name => surface(name);
  fail("gateway/invalid-plan", "entities must be an entity plan or resolver");
}

function fieldSource(entity, name) {
  if (typeof entity.resolveField === "function") return entity.resolveField(name);
  if (typeof entity.field === "function") return entity.field(name);
  if (entity.fieldsByName instanceof Map) return entity.fieldsByName.get(name);
  if (Array.isArray(entity.fields)) return entity.fields.find(field => field?.name === name);
  return undefined;
}

function createEntitySurface(source) {
  const resolveSource = sourceEntities(source);
  const entities = new Map();
  const encode = plainObject(source) && typeof source.encodeValue === "function"
    ? source.encodeValue.bind(source)
    : encodeLiteral;
  const decode = plainObject(source) && typeof source.decodeValue === "function"
    ? source.decodeValue.bind(source)
    : decodeLiteral;

  function resolve(name) {
    if (entities.has(name)) return entities.get(name);
    const raw = resolveSource(name);
    if (!raw || typeof raw !== "object") {
      fail("gateway/invalid-plan", `named query references unknown entity ${name}`);
    }
    const actualName = requiredName(raw.name ?? name, `entity ${name}.name`);
    if (actualName !== name) fail("gateway/invalid-plan", `entity resolver returned ${actualName} for ${name}`);
    const rawIdentity = raw.identity ?? raw.identityField;
    if (!rawIdentity || typeof rawIdentity !== "object") {
      fail("gateway/invalid-plan", `entity ${name} has no identity plan`);
    }
    const identityName = requiredName(rawIdentity.field ?? rawIdentity.name, `entity ${name} identity field`);
    const identityType = requiredName(rawIdentity.type, `entity ${name} identity type`);
    const identityFieldRaw = fieldSource(raw, identityName) ?? raw.identityField;
    if (!identityFieldRaw) fail("gateway/invalid-plan", `entity ${name} identity field is absent`);
    const identityPredicate = cloneTerm(
      identityFieldRaw.predicateTerm ?? identityFieldRaw.predicate,
      `${name}.${identityName}.predicate`,
    );
    const holeToken = rawIdentity.storageId ?? identityName;
    const rawTemplate = rawIdentity.subjectTemplate;
    const realizeCallback = raw.realizeSubject ?? rawIdentity.realizeSubject;
    const matchCallback = raw.matchSubject ?? rawIdentity.matchSubject;
    let template;
    if (typeof realizeCallback !== "function" || typeof matchCallback !== "function") {
      if (rawTemplate === undefined) {
        fail("gateway/invalid-plan", `entity ${name} has no subject template or subject callbacks`);
      }
      template = compileSubjectTemplate(rawTemplate, holeToken, `${name}.identity.subjectTemplate`);
    }
    const normalized = {
      name,
      raw,
      identity: { name: identityName, type: identityType, predicate: identityPredicate },
      fieldCache: new Map(),
      realize(identity) {
        const term = typeof realizeCallback === "function"
          ? realizeCallback(identity)
          : realizeTemplate(template, identity);
        return cloneTerm(term, `${name} subject`, "gateway/data-integrity");
      },
      match(subject) {
        const term = cloneTerm(subject, `${name} subject`, "gateway/data-integrity");
        const matched = typeof matchCallback === "function" ? matchCallback(term) : matchTemplate(template, term);
        if (matched === null || matched === undefined || matched === NO_MATCH || matched === false) return NO_MATCH;
        return cloneTerm(matched, `${name} identity`, "gateway/data-integrity");
      },
    };
    entities.set(name, normalized);
    return normalized;
  }

  function resolveField(entity, name) {
    if (entity.fieldCache.has(name)) return entity.fieldCache.get(name);
    const raw = fieldSource(entity.raw, name);
    if (!raw || typeof raw !== "object") {
      fail("gateway/invalid-plan", `named query references unknown field ${entity.name}.${name}`);
    }
    const field = {
      name: requiredName(raw.name ?? name, `${entity.name}.${name}.name`),
      type: requiredName(raw.type, `${entity.name}.${name}.type`),
      cardinality: raw.cardinality,
      valueKind: raw.valueKind,
      predicate: cloneTerm(raw.predicateTerm ?? raw.predicate, `${entity.name}.${name}.predicate`),
      targetName: raw.targetEntity ?? raw.targetName ?? raw.target?.name ?? null,
    };
    if (field.name !== name) fail("gateway/invalid-plan", `field resolver returned ${field.name} for ${name}`);
    if (field.cardinality !== "single" && field.cardinality !== "multi") {
      fail("gateway/invalid-plan", `${entity.name}.${name} has invalid cardinality`);
    }
    if (field.valueKind !== "literal" && field.valueKind !== "ref") {
      fail("gateway/invalid-plan", `${entity.name}.${name} has invalid valueKind`);
    }
    if (field.valueKind === "ref") {
      field.targetName = requiredName(field.targetName, `${entity.name}.${name}.targetEntity`);
    } else if (field.targetName !== null && field.targetName !== undefined) {
      fail("gateway/invalid-plan", `${entity.name}.${name} is literal but declares a target entity`);
    }
    entity.fieldCache.set(name, field);
    return field;
  }

  function encodeValue(type, value, label) {
    return cloneTerm(encode(type, value, label), label, "gateway/type-mismatch");
  }

  function decodeField(field, value, label) {
    if (field.valueKind === "ref") {
      const target = resolve(field.targetName);
      const identity = target.match(value);
      if (identity === NO_MATCH) {
        fail("gateway/data-integrity", `${label} does not name a ${target.name}`);
      }
      return decode(target.identity.type, identity, label);
    }
    return decode(field.type, value, label);
  }

  return { resolve, resolveField, encodeValue, decodeField };
}

function parameterMap(parameters, label) {
  if (!Array.isArray(parameters)) fail("gateway/invalid-plan", `${label}.parameters must be an array`);
  const map = new Map();
  const list = parameters.map((parameter, index) => {
    exactRecord(parameter, ["name", "type"], `${label}.parameters[${index}]`);
    const name = requiredName(parameter.name, `${label}.parameters[${index}].name`);
    const type = requiredName(parameter.type, `${label}.parameters[${index}].type`);
    if (type === "Ref") fail("gateway/invalid-plan", `${label} parameter ${name} cannot be an unqualified Ref`);
    if (map.has(name)) fail("gateway/invalid-plan", `${label} parameter ${name} is duplicated`);
    const compiled = { name, type };
    map.set(name, compiled);
    return compiled;
  });
  return { map, list };
}

function bindingMap(bindings, surface, label) {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    fail("gateway/invalid-plan", `${label}.bindings must be a nonempty array`);
  }
  const map = new Map();
  const list = bindings.map((binding, index) => {
    exactRecord(binding, ["name", "entity"], `${label}.bindings[${index}]`);
    const name = requiredName(binding.name, `${label}.bindings[${index}].name`);
    const entityName = requiredName(binding.entity, `${label}.bindings[${index}].entity`);
    if (map.has(name)) fail("gateway/invalid-plan", `${label} binding ${name} is duplicated`);
    const compiled = {
      name,
      entity: surface.resolve(entityName),
      subjectVariable: `wake:q:b:${index}:subject`,
      identityVariable: `wake:q:b:${index}:identity`,
    };
    map.set(name, compiled);
    return compiled;
  });
  return { map, list };
}

function compatibleOperands(left, right) {
  if (left.kind === "binding" || right.kind === "binding") {
    if (left.kind === "binding" && right.kind === "binding") return left.entity.name === right.entity.name;
    const binding = left.kind === "binding" ? left : right;
    const field = left.kind === "field" ? left : right.kind === "field" ? right : null;
    return field !== null && field.field.valueKind === "ref"
      && field.field.targetName === binding.entity.name;
  }
  if (left.kind === "field" && left.field.valueKind === "ref"
      || right.kind === "field" && right.field.valueKind === "ref") {
    return left.kind === "field" && right.kind === "field"
      && left.field.valueKind === "ref" && right.field.valueKind === "ref"
      && left.field.targetName === right.field.targetName;
  }
  return typeFamily(left.type) === typeFamily(right.type);
}

function queryCapabilities(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUERY_CAPABILITIES) {
    fail(
      "gateway/invalid-plan",
      `${label}.capabilities must contain between 1 and ${MAX_QUERY_CAPABILITIES} capabilities`,
    );
  }
  const seen = new Set();
  const capabilities = value.map((capability, index) => {
    const checked = requiredName(capability, `${label}.capabilities[${index}]`);
    if (seen.has(checked)) {
      fail("gateway/invalid-plan", `${label}.capabilities repeats ${checked}`);
    }
    seen.add(checked);
    return checked;
  });
  return Object.freeze(capabilities);
}

function checkedProviderContract(source, label) {
  try {
    return compileCheckedValue(source, { descriptorCode: "gateway/invalid-plan" });
  } catch (error) {
    if (error instanceof CheckedValueError) {
      fail("gateway/invalid-plan", `${label} has an invalid checked value contract`);
    }
    throw error;
  }
}

function compileProviderInput(source, columns, label, usedInternal) {
  if (!plainObject(source)) fail("gateway/invalid-plan", `${label} must be an expression`);
  switch (source.kind) {
    case "column": {
      exactRecord(source, ["kind", "name"], label);
      const name = requiredName(source.name, `${label}.name`);
      const column = columns.get(name);
      if (!column) fail("gateway/invalid-plan", `${label} names unknown query column ${name}`);
      if (!column.internal) {
        fail("gateway/invalid-plan", `${label} may consume only an internal query column`);
      }
      usedInternal.add(name);
      return Object.freeze({ kind: "column", name });
    }
    case "literal": {
      exactRecord(source, ["kind", "value"], label);
      if (source.value !== null
          && typeof source.value !== "string"
          && typeof source.value !== "boolean"
          && !(typeof source.value === "number"
            && Number.isFinite(source.value) && !Object.is(source.value, -0))) {
        fail("gateway/invalid-plan", `${label}.value must be a scalar JSON literal`);
      }
      return Object.freeze({ kind: "literal", value: source.value });
    }
    case "record": {
      exactRecord(source, ["kind", "fields"], label);
      if (!Array.isArray(source.fields)) {
        fail("gateway/invalid-plan", `${label}.fields must be an array`);
      }
      const names = new Set();
      const fields = source.fields.map((field, index) => {
        const fieldLabel = `${label}.fields[${index}]`;
        exactRecord(field, ["name", "value"], fieldLabel);
        const name = requiredName(field.name, `${fieldLabel}.name`);
        if (names.has(name)) fail("gateway/invalid-plan", `${label} repeats field ${name}`);
        names.add(name);
        return Object.freeze({
          name,
          value: compileProviderInput(field.value, columns, `${fieldLabel}.value`, usedInternal),
        });
      });
      return Object.freeze({ fields: Object.freeze(fields), kind: "record" });
    }
    default:
      fail(
        "gateway/invalid-plan",
        `${label}.kind ${String(source.kind)} is not a checked provider input expression`,
      );
  }
}

function resultProviders(source, columns, outputNames, label) {
  if (!Array.isArray(source)) {
    fail("gateway/invalid-plan", `${label}.resultProviders must be an array`);
  }
  const providerNames = new Set();
  const usedInternal = new Set();
  const compiled = source.map((step, index) => {
    const stepLabel = `${label}.resultProviders[${index}]`;
    exactRecord(step, ["name", "provider", "input", "inputType", "outputType"], stepLabel);
    const name = requiredName(step.name, `${stepLabel}.name`);
    const provider = requiredName(step.provider, `${stepLabel}.provider`);
    if (outputNames.has(name)) fail("gateway/invalid-plan", `${label} output ${name} is duplicated`);
    outputNames.add(name);
    if (providerNames.has(name)) fail("gateway/invalid-plan", `${label} repeats result provider ${name}`);
    providerNames.add(name);
    return Object.freeze({
      input: compileProviderInput(step.input, columns, `${stepLabel}.input`, usedInternal),
      inputContract: checkedProviderContract(step.inputType, `${stepLabel}.inputType`),
      name,
      outputContract: checkedProviderContract(step.outputType, `${stepLabel}.outputType`),
      provider,
    });
  });
  for (const column of columns.values()) {
    if (column.internal && !usedInternal.has(column.name)) {
      fail("gateway/invalid-plan", `${label} internal column ${column.name} is not consumed`);
    }
  }
  return Object.freeze(compiled);
}

function checkedProviderRegistry(source, compiled) {
  if (!plainObject(source)) {
    fail("gateway/invalid-plan", "named query runtime providers must be an object");
  }
  const required = new Set();
  for (const name of compiled.names) {
    for (const step of compiled.get(name).resultProviders) required.add(step.provider);
  }
  const registry = new Map();
  for (const name of required) {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)
        || typeof descriptor.value !== "function") {
      fail("gateway/missing-provider", `checked query provider '${name}' is unavailable`);
    }
    registry.set(name, descriptor.value);
  }
  return registry;
}

function compileQuery(entry, surface, queryIndex) {
  exactRecord(
    entry,
    [
      "name",
      "capabilities",
      "parameters",
      "bindings",
      "where",
      "select",
      "resultProviders",
      "result",
      "dependencies",
    ],
    `queries[${queryIndex}]`,
  );
  const name = requiredName(entry.name, `queries[${queryIndex}].name`);
  const label = `query ${name}`;
  const capabilities = queryCapabilities(entry.capabilities, label);
  const parameters = parameterMap(entry.parameters, label);
  const bindings = bindingMap(entry.bindings, surface, label);
  const referencedFields = new Map();
  const predicateFields = new Set();
  let nextFieldVariable = 0;

  function fieldOperand(bindingName, fieldName, operandLabel) {
    const binding = bindings.map.get(requiredName(bindingName, `${operandLabel}.binding`));
    if (!binding) fail("gateway/invalid-plan", `${operandLabel} names unknown binding ${bindingName}`);
    const field = surface.resolveField(binding.entity, requiredName(fieldName, `${operandLabel}.field`));
    const key = `${binding.name}\u0000${field.name}`;
    let reference = referencedFields.get(key);
    if (!reference) {
      const identity = field.name === binding.entity.identity.name;
      reference = {
        binding,
        field,
        variable: identity
          ? binding.identityVariable
          : `wake:q:f:${nextFieldVariable}`,
      };
      if (!identity) nextFieldVariable += 1;
      referencedFields.set(key, reference);
    }
    return reference;
  }

  function operand(raw, operandLabel) {
    if (!plainObject(raw)) fail("gateway/invalid-plan", `${operandLabel} must be an operand`);
    switch (raw.kind) {
      case "parameter": {
        exactRecord(raw, ["kind", "name", "type"], operandLabel);
        const parameter = parameters.map.get(requiredName(raw.name, `${operandLabel}.name`));
        if (!parameter) fail("gateway/invalid-plan", `${operandLabel} names unknown parameter ${raw.name}`);
        if (raw.type !== parameter.type) {
          fail("gateway/invalid-plan", `${operandLabel}.type does not match parameter ${parameter.name}`);
        }
        return { kind: "parameter", parameter, type: parameter.type };
      }
      case "binding": {
        exactRecord(raw, ["kind", "binding", "entity"], operandLabel);
        const binding = bindings.map.get(requiredName(raw.binding, `${operandLabel}.binding`));
        if (!binding) fail("gateway/invalid-plan", `${operandLabel} names unknown binding ${raw.binding}`);
        if (raw.entity !== binding.entity.name) {
          fail("gateway/invalid-plan", `${operandLabel}.entity does not match binding ${binding.name}`);
        }
        return { kind: "binding", binding, entity: binding.entity, type: "Ref" };
      }
      case "field": {
        const fieldKeys = raw.type === "Ref"
          ? ["kind", "binding", "entity", "field", "type", "targetEntity"]
          : ["kind", "binding", "entity", "field", "type"];
        exactRecord(raw, fieldKeys, operandLabel);
        const reference = fieldOperand(raw.binding, raw.field, operandLabel);
        if (raw.entity !== reference.binding.entity.name
            || raw.type !== reference.field.type
            || (reference.field.valueKind === "ref" && raw.targetEntity !== reference.field.targetName)) {
          fail("gateway/invalid-plan", `${operandLabel} metadata does not match its checked field plan`);
        }
        predicateFields.add(reference);
        return { kind: "field", ...reference, type: reference.field.type };
      }
      case "literal": {
        exactRecord(raw, ["kind", "type", "value"], operandLabel);
        const type = requiredName(raw.type, `${operandLabel}.type`);
        return {
          kind: "literal",
          type,
          term: surface.encodeValue(type, raw.value, `${label} literal`),
        };
      }
      default:
        fail("gateway/invalid-plan", `${operandLabel} has unsupported kind ${String(raw.kind)}`);
    }
  }

  if (!Array.isArray(entry.where)) fail("gateway/invalid-plan", `${label}.where must be an array`);
  const predicates = entry.where.map((source, index) => {
    exactRecord(source, ["op", "left", "right"], `${label}.where[${index}]`);
    if (source.op !== "eq") {
      fail("gateway/invalid-plan", `${label}.where[${index}] must be an equality predicate`);
    }
    const left = operand(source.left, `${label}.where[${index}].left`);
    const right = operand(source.right, `${label}.where[${index}].right`);
    if (!compatibleOperands(left, right)) {
      fail("gateway/invalid-plan", `${label}.where[${index}] compares incompatible operands`);
    }
    return { left, right };
  });

  if (!Array.isArray(entry.select) || entry.select.length === 0) {
    fail("gateway/invalid-plan", `${label}.select must be a nonempty array`);
  }
  const outputNames = new Set();
  const columns = entry.select.map((column, index) => {
    if (!plainObject(column)) fail("gateway/invalid-plan", `${label}.select[${index}] must be an object`);
    const columnKeys = column.valueKind === "ref"
      ? ["name", "binding", "entity", "field", "type", "cardinality", "valueKind", "targetEntity"]
      : ["name", "binding", "entity", "field", "type", "cardinality", "valueKind"];
    const internal = column.internal === true;
    exactRecord(
      column,
      internal ? [...columnKeys, "internal"] : columnKeys,
      `${label}.select[${index}]`,
    );
    const outputName = requiredName(column.name, `${label}.select[${index}].name`);
    if (outputNames.has(outputName)) fail("gateway/invalid-plan", `${label} output ${outputName} is duplicated`);
    outputNames.add(outputName);
    const reference = fieldOperand(column.binding, column.field, `${label}.select[${index}]`);
    if (column.entity !== reference.binding.entity.name
        || column.type !== reference.field.type
        || column.cardinality !== reference.field.cardinality
        || column.valueKind !== reference.field.valueKind
        || (reference.field.valueKind === "ref" && column.targetEntity !== reference.field.targetName)) {
      fail("gateway/invalid-plan", `${label} output ${outputName} does not match its checked field plan`);
    }
    return { internal, name: outputName, ...reference };
  });
  const columnsByName = new Map(columns.map(column => [column.name, column]));
  const providers = resultProviders(entry.resultProviders, columnsByName, outputNames, label);
  if (columns.every(column => column.internal)) {
    fail("gateway/invalid-plan", `${label} must expose at least one ordinary field output`);
  }

  if (!plainObject(entry.result)) fail("gateway/invalid-plan", `${label}.result must be an object`);
  const kind = entry.result.kind;
  if (kind !== "one" && kind !== "optional" && kind !== "page") {
    fail("gateway/invalid-plan", `${label}.result.kind is not supported`);
  }
  let defaultLimit = null;
  let maxLimit = null;
  if (kind === "page") {
    exactRecord(entry.result, ["kind", "defaultLimit", "maxLimit"], `${label}.result`);
    defaultLimit = entry.result.defaultLimit;
    maxLimit = entry.result.maxLimit;
    if (!Number.isSafeInteger(defaultLimit) || !Number.isSafeInteger(maxLimit)
        || defaultLimit < 1 || maxLimit < defaultLimit || maxLimit > MAX_PAGE_LIMIT) {
      fail("gateway/invalid-plan", `${label} has invalid page limits`);
    }
    if (columns.some(column => column.field.cardinality === "multi")) {
      fail("gateway/invalid-plan", `${label} cannot page a multi-cardinality projection`);
    }
  } else {
    exactRecord(entry.result, ["kind"], `${label}.result`);
  }

  if (!Array.isArray(entry.dependencies)) {
    fail("gateway/invalid-plan", `${label}.dependencies must be an array`);
  }
  for (const [index, dependency] of entry.dependencies.entries()) {
    exactRecord(dependency, ["entity", "field"], `${label}.dependencies[${index}]`);
    const entity = surface.resolve(requiredName(dependency.entity, `${label}.dependencies[${index}].entity`));
    surface.resolveField(entity, requiredName(dependency.field, `${label}.dependencies[${index}].field`));
  }

  const clauses = [];
  for (const binding of bindings.list) {
    clauses.push({
      rel: "triple",
      args: [
        { var: binding.subjectVariable },
        binding.entity.identity.predicate,
        { var: binding.identityVariable },
      ],
    });
  }
  for (const reference of referencedFields.values()) {
    if (reference.field.name === reference.binding.entity.identity.name) continue;
    if (reference.field.cardinality === "multi" && !predicateFields.has(reference)) continue;
    clauses.push({
      rel: "triple",
      args: [
        { var: reference.binding.subjectVariable },
        reference.field.predicate,
        { var: reference.variable },
      ],
    });
  }

  function loweredOperand(item, encodedParameters) {
    switch (item.kind) {
      case "parameter": return encodedParameters.get(item.parameter.name);
      case "binding": return { var: item.binding.subjectVariable };
      case "field": return { var: item.variable };
      case "literal": return item.term;
      default: throw new TypeError("unreachable named-query operand");
    }
  }

  function lower(encodedParameters) {
    const relation = `wake/named/${name}`;
    const rootColumns = columns.filter(column => column.field.cardinality === "single");
    const headArgs = [
      ...bindings.list.map(binding => ({ var: binding.subjectVariable })),
      ...rootColumns.map(column => ({ var: column.variable })),
    ];
    return {
      find: relation,
      rules: [{
        head: { rel: relation, args: headArgs },
        body: [
          ...clauses,
          ...predicates.map(predicate => ({
            pred: "eq",
            args: [
              loweredOperand(predicate.left, encodedParameters),
              loweredOperand(predicate.right, encodedParameters),
            ],
          })),
        ],
      }],
    };
  }

  return Object.freeze({
    name,
    capabilities,
    parameters: Object.freeze(parameters.list),
    bindings: Object.freeze(bindings.list),
    columns: Object.freeze(columns),
    publicColumns: Object.freeze(columns.filter(column => !column.internal)),
    resultProviders: providers,
    rootColumns: Object.freeze(columns.filter(column => column.field.cardinality === "single")),
    result: Object.freeze({ kind, defaultLimit, maxLimit }),
    lower,
    surface,
  });
}

export function compileNamedQueries(entries, entities) {
  if (!Array.isArray(entries)) fail("gateway/invalid-plan", "named queries must be an array");
  const surface = createEntitySurface(entities);
  const byName = new Map();
  for (const [index, entry] of entries.entries()) {
    const compiled = compileQuery(entry, surface, index);
    if (byName.has(compiled.name)) fail("gateway/invalid-plan", `query ${compiled.name} is duplicated`);
    byName.set(compiled.name, compiled);
  }
  return Object.freeze({
    names: Object.freeze(Array.from(byName.keys())),
    get(name) {
      return byName.get(name);
    },
  });
}

function exactInput(query, input) {
  if (!plainObject(input)) fail("gateway/invalid-input", `query ${query.name} input must be an object`);
  const expected = new Set(query.parameters.map(parameter => parameter.name));
  for (const parameter of query.parameters) {
    if (!own(input, parameter.name)) {
      fail("gateway/invalid-input", `query ${query.name} requires parameter ${parameter.name}`);
    }
  }
  for (const key of Object.keys(input)) {
    if (!expected.has(key)) fail("gateway/invalid-input", `query ${query.name} does not accept parameter ${key}`);
  }
  return new Map(query.parameters.map(parameter => [
    parameter.name,
    query.surface.encodeValue(parameter.type, input[parameter.name], `${query.name}.${parameter.name}`),
  ]));
}

function executionOptions(query, source) {
  exactKeys(source, ["limit", "cursor", "asOf"], `query ${query.name} options`, "gateway/invalid-input");
  const options = {};
  if (own(source, "asOf")) {
    options.asOf = BigInt(canonicalInteger(source.asOf, `${query.name}.asOf`, { nonnegative: true }));
  }
  if (query.result.kind !== "page") {
    if (own(source, "limit") || own(source, "cursor")) {
      fail("gateway/invalid-input", `query ${query.name} is singular and does not accept page options`);
    }
    return options;
  }
  const limit = own(source, "limit") ? source.limit : query.result.defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > query.result.maxLimit) {
    fail("gateway/invalid-input", `query ${query.name} limit must be between 1 and ${query.result.maxLimit}`);
  }
  options.limit = limit;
  if (own(source, "cursor")) {
    options.cursor = cloneTerm(source.cursor, `${query.name}.cursor`, "gateway/invalid-input");
  }
  return options;
}

function requireQueryAuthority(query, value) {
  if (!plainObject(value) || typeof value.id !== "string" || value.id.length === 0
      || !Array.isArray(value.capabilities) || value.capabilities.length === 0
      || value.capabilities.some(capability => (
        typeof capability !== "string" || capability.length === 0
      ))) {
    fail("gateway/forbidden", `query ${query.name} requires host-derived capability grants`);
  }
  const granted = new Set(value.capabilities);
  if (!query.capabilities.some(capability => granted.has(capability))) {
    fail(
      "gateway/forbidden",
      `query ${query.name} requires one of: ${query.capabilities.join(", ")}`,
    );
  }
}

function checkedResponse(response, query, requestedAsOf) {
  if (!plainObject(response) || !Array.isArray(response.result)
      || typeof response.servedVersion !== "bigint"
      || response.servedVersion < 0n || response.servedVersion > I64_MAX) {
    fail("gateway/protocol", `FRAM returned an invalid response for query ${query.name}`);
  }
  if (requestedAsOf !== undefined && response.servedVersion !== requestedAsOf) {
    fail("gateway/protocol", `FRAM did not serve query ${query.name} at its requested snapshot`);
  }
  return response;
}

function pageState(response, query) {
  if (response.page === null || response.page === undefined) {
    return { done: true, nextCursor: null };
  }
  if (!plainObject(response.page) || typeof response.page.done !== "boolean") {
    fail("gateway/protocol", `FRAM returned invalid page metadata for query ${query.name}`);
  }
  if (response.page.done) {
    if (response.page.nextCursor !== null && response.page.nextCursor !== undefined) {
      fail("gateway/protocol", `FRAM returned a cursor for completed query ${query.name}`);
    }
    return { done: true, nextCursor: null };
  }
  if (response.page.nextCursor === null || response.page.nextCursor === undefined) {
    fail("gateway/protocol", `FRAM omitted the continuation cursor for query ${query.name}`);
  }
  return {
    done: false,
    nextCursor: cloneTerm(response.page.nextCursor, `${query.name}.nextCursor`, "gateway/protocol"),
  };
}

function rowGroups(query, rawRows) {
  const width = query.bindings.length + query.rootColumns.length;
  const groups = new Map();
  for (const [rowIndex, raw] of rawRows.entries()) {
    if (!Array.isArray(raw) || raw.length !== width) {
      fail("gateway/protocol", `FRAM returned a malformed row for query ${query.name}`);
    }
    const anchors = raw.slice(0, query.bindings.length).map((term, bindingIndex) => {
      const cloned = cloneTerm(term, `${query.name} row ${rowIndex} binding`, "gateway/protocol");
      if (query.bindings[bindingIndex].entity.match(cloned) === NO_MATCH) {
        fail("gateway/data-integrity", `query ${query.name} returned a subject outside its entity template`);
      }
      return cloned;
    });
    const key = anchors.map(termKey).map(value => `${value.length}:${value}`).join("");
    let group = groups.get(key);
    if (!group) {
      group = { subjects: anchors, terms: new Map() };
      groups.set(key, group);
    }
    for (let index = 0; index < query.rootColumns.length; index += 1) {
      const column = query.rootColumns[index];
      const value = cloneTerm(
        raw[query.bindings.length + index],
        `${query.name}.${column.name}`,
        "gateway/protocol",
      );
      const values = group.terms.get(column.name) ?? [];
      if (!values.some(candidate => termEqual(candidate, value))) values.push(value);
      group.terms.set(column.name, values);
      if (values.length > 1) {
        fail(
          "gateway/data-integrity",
          `query ${query.name} returned more than one live value for ${column.name}`,
          { query: query.name, output: column.name },
        );
      }
    }
  }
  return Array.from(groups.values());
}

function decodeGroup(query, group) {
    const row = {};
    for (const column of query.columns) {
      const values = group.terms.get(column.name) ?? [];
      if (column.field.cardinality === "single" && values.length !== 1) {
        fail(
          "gateway/data-integrity",
          `query ${query.name} omitted its single value for ${column.name}`,
          { query: query.name, output: column.name },
        );
      }
      const decoded = values.map(value => query.surface.decodeField(
        column.field,
        value,
        `${query.name}.${column.name}`,
      ));
      Object.defineProperty(row, column.name, {
        value: column.field.cardinality === "multi" ? decoded : decoded[0],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return row;
}

function evaluateProviderInput(expression, row) {
  switch (expression.kind) {
    case "column":
      return row[expression.name];
    case "literal":
      return expression.value;
    case "record": {
      const value = {};
      for (const field of expression.fields) {
        Object.defineProperty(value, field.name, {
          configurable: true,
          enumerable: true,
          value: evaluateProviderInput(field.value, row),
          writable: true,
        });
      }
      return value;
    }
    default:
      throw new TypeError("unreachable checked provider input expression");
  }
}

function normalizeProviderValue(contract, value, code, label) {
  try {
    return contract.normalize(value, { code, label });
  } catch (error) {
    if (error instanceof CheckedValueError) fail(code, `${label} is invalid`);
    throw error;
  }
}

async function publicRow(query, group, providers, servedVersion) {
  const hydrated = decodeGroup(query, group);
  const row = {};
  for (const column of query.publicColumns) {
    Object.defineProperty(row, column.name, {
      configurable: true,
      enumerable: true,
      value: hydrated[column.name],
      writable: true,
    });
  }
  for (const step of query.resultProviders) {
    const provider = providers.get(step.provider);
    if (typeof provider !== "function") throw new TypeError("unreachable checked query provider");
    const input = normalizeProviderValue(
      step.inputContract,
      evaluateProviderInput(step.input, hydrated),
      "gateway/data-integrity",
      `query ${query.name} provider input`,
    );
    let value;
    try {
      value = await provider(input, Object.freeze({
        query: query.name,
        servedVersion: servedVersion.toString(),
      }));
    } catch (error) {
      fail(
        "gateway/provider-failed",
        `query ${query.name} provider failed`,
        { provider: step.provider },
      );
    }
    const output = normalizeProviderValue(
      step.outputContract,
      value,
      "gateway/provider-output",
      `query ${query.name} provider output ${step.name}`,
    );
    Object.defineProperty(row, step.name, {
      configurable: true,
      enumerable: true,
      value: output,
      writable: true,
    });
  }
  return row;
}

async function hydrateMultiColumn(fram, query, group, column, servedVersion) {
  const bindingIndex = query.bindings.indexOf(column.binding);
  if (bindingIndex < 0) throw new TypeError("unreachable named-query binding");
  const relation = `wake/named/${query.name}/multi/${column.binding.name}/${column.field.name}`;
  const variable = "wake:q:multi:value";
  const structuredQuery = {
    find: relation,
    rules: [{
      head: { rel: relation, args: [{ var: variable }] },
      body: [{
        rel: "triple",
        args: [group.subjects[bindingIndex], column.field.predicate, { var: variable }],
      }],
    }],
  };
  const values = [];
  const seenValues = new Set();
  const seenCursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < MAX_QUERY_PAGES; pageNumber += 1) {
    const page = { limit: MAX_PAGE_LIMIT };
    if (cursor !== undefined) page.cursor = cursor;
    const response = checkedResponse(await fram.query(structuredQuery, {
      timeoutMs: QUERY_TIMEOUT_MS,
      asOf: servedVersion,
      page,
    }), query, servedVersion);
    if (response.result.length > MAX_PAGE_LIMIT) {
      fail("gateway/protocol", `FRAM exceeded the requested page limit for query ${query.name}`);
    }
    for (const raw of response.result) {
      if (!Array.isArray(raw) || raw.length !== 1) {
        fail("gateway/protocol", `FRAM returned a malformed multi-value row for query ${query.name}`);
      }
      const value = cloneTerm(raw[0], `${query.name}.${column.name}`, "gateway/protocol");
      const key = termKey(value);
      if (!seenValues.has(key)) {
        if (values.length >= MAX_SINGULAR_ROWS) {
          fail("gateway/result-limit", `query ${query.name} exceeded its multi-value hydration limit`);
        }
        seenValues.add(key);
        values.push(value);
      }
    }
    const state = pageState(response, query);
    if (state.done) return values;
    const cursorKey = termKey(state.nextCursor);
    if (seenCursors.has(cursorKey)) {
      fail("gateway/protocol", `FRAM repeated a cursor for query ${query.name}`);
    }
    seenCursors.add(cursorKey);
    cursor = state.nextCursor;
  }
  fail("gateway/result-limit", `query ${query.name} exceeded its multi-value page limit`);
}

async function hydrateMultiColumns(fram, query, group, servedVersion) {
  const hydrated = new Map();
  for (const column of query.columns) {
    if (column.field.cardinality !== "multi") continue;
    const key = `${column.binding.name}\u0000${column.field.name}`;
    let values = hydrated.get(key);
    if (values === undefined) {
      values = await hydrateMultiColumn(fram, query, group, column, servedVersion);
      hydrated.set(key, values);
    }
    group.terms.set(column.name, values);
  }
}

async function executePage(fram, query, structuredQuery, options, providers) {
  const page = { limit: options.limit };
  if (options.cursor !== undefined) page.cursor = options.cursor;
  const framOptions = { timeoutMs: QUERY_TIMEOUT_MS, page };
  if (options.asOf !== undefined) framOptions.asOf = options.asOf;
  const response = checkedResponse(await fram.query(structuredQuery, framOptions), query, options.asOf);
  if (response.result.length > options.limit) {
    fail("gateway/protocol", `FRAM exceeded the requested page limit for query ${query.name}`);
  }
  const rows = [];
  for (const group of rowGroups(query, response.result)) {
    rows.push(await publicRow(query, group, providers, response.servedVersion));
  }
  return {
    rows,
    page: pageState(response, query),
    servedVersion: response.servedVersion,
  };
}

async function executeSingular(fram, query, structuredQuery, options, providers) {
  const rawRows = [];
  const seenCursors = new Set();
  let cursor;
  let servedVersion;
  for (let pageNumber = 0; pageNumber < MAX_QUERY_PAGES; pageNumber += 1) {
    const page = { limit: MAX_PAGE_LIMIT };
    if (cursor !== undefined) page.cursor = cursor;
    const framOptions = { timeoutMs: QUERY_TIMEOUT_MS, page };
    if (options.asOf !== undefined) framOptions.asOf = options.asOf;
    const response = checkedResponse(await fram.query(structuredQuery, framOptions), query, options.asOf);
    if (servedVersion === undefined) servedVersion = response.servedVersion;
    else if (response.servedVersion !== servedVersion) {
      fail("gateway/protocol", `FRAM changed snapshots while reading query ${query.name}`);
    }
    if (response.result.length > MAX_PAGE_LIMIT) {
      fail("gateway/protocol", `FRAM exceeded the requested page limit for query ${query.name}`);
    }
    if (response.result.length > MAX_SINGULAR_ROWS - rawRows.length) {
      fail("gateway/result-limit", `query ${query.name} exceeded its singular hydration limit`);
    }
    rawRows.push(...response.result);
    const state = pageState(response, query);
    if (state.done) {
      const groups = rowGroups(query, rawRows);
      if (groups.length === 0 && query.result.kind === "optional") {
        return { row: null, servedVersion };
      }
      if (groups.length !== 1) {
        fail(
          "gateway/data-integrity",
          `query ${query.name} expected one logical row but FRAM returned ${groups.length}`,
          { query: query.name, expected: query.result.kind, actual: groups.length },
        );
      }
      await hydrateMultiColumns(fram, query, groups[0], servedVersion);
      return { row: await publicRow(query, groups[0], providers, servedVersion), servedVersion };
    }
    const key = termKey(state.nextCursor);
    if (seenCursors.has(key)) fail("gateway/protocol", `FRAM repeated a cursor for query ${query.name}`);
    seenCursors.add(key);
    cursor = state.nextCursor;
  }
  fail("gateway/result-limit", `query ${query.name} exceeded its page limit`);
}

export function createNamedQueryRuntime(entries, { fram, entities, providers = {} } = {}) {
  if (!fram || typeof fram.query !== "function") {
    fail("gateway/invalid-plan", "named query runtime requires fram.query");
  }
  const compiled = compileNamedQueries(entries, entities);
  const providerRegistry = checkedProviderRegistry(providers, compiled);
  return Object.freeze({
    names: compiled.names,
    async execute(name, input, options = {}, authority) {
      requiredName(name, "query name", "gateway/invalid-input");
      const query = compiled.get(name);
      if (!query) fail("gateway/unknown-query", `unknown named query ${name}`);
      requireQueryAuthority(query, authority);
      const encodedParameters = exactInput(query, input);
      const checkedOptions = executionOptions(query, options);
      const structuredQuery = query.lower(encodedParameters);
      return query.result.kind === "page"
        ? executePage(fram, query, structuredQuery, checkedOptions, providerRegistry)
        : executeSingular(fram, query, structuredQuery, checkedOptions, providerRegistry);
    },
  });
}
