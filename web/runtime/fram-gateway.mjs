import { createNamedQueryRuntime } from "./named-query.mjs";

const PAGE_LIMIT = 128;
const MAX_QUERY_PAGES = 32;
const MAX_QUERY_ROWS = PAGE_LIMIT * MAX_QUERY_PAGES;
const QUERY_TIMEOUT_MS = 5_000;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const FLOAT64 = /^[0-9a-f]{16}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MISMATCH = Symbol("template-mismatch");

export class GatewayError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new GatewayError(code, message, detail);
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function defineOwn(value, key, item) {
  Object.defineProperty(value, key, {
    value: item,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredName(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail("gateway/invalid-plan", `${label} must be a nonempty string`);
  }
  return value;
}

function inputName(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail("gateway/invalid-input", `${label} must be a nonempty string`);
  }
  return value;
}

function canonicalInteger(value, label) {
  let text;
  if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    text = String(value);
  } else if (typeof value === "string" && INTEGER.test(value)) text = value;
  else fail("gateway/type-mismatch", `${label} must be an exact integer`);

  if (!INTEGER.test(text)) fail("gateway/type-mismatch", `${label} is not a canonical integer`);
  const integer = BigInt(text);
  if (integer < I64_MIN || integer > I64_MAX) {
    fail("gateway/type-mismatch", `${label} is outside FRAM's integer range`);
  }
  return text;
}

function exactJsonNumber(value) {
  return Number.isFinite(value) && !Object.is(value, -0);
}

function floatBits(value, label) {
  if (typeof value !== "number" || !exactJsonNumber(value)) {
    fail("gateway/type-mismatch", `${label} must be a finite JSON number other than negative zero`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function floatValue(bits, label) {
  const bytes = Uint8Array.from(
    Array.from({ length: 8 }, (_, index) => Number.parseInt(bits.slice(index * 2, index * 2 + 2), 16)),
  );
  const value = new DataView(bytes.buffer).getFloat64(0, false);
  if (!exactJsonNumber(value)) {
    fail("gateway/data-integrity", `${label} is not exactly representable as a JSON number`);
  }
  return value;
}

function cloneTerm(value, label = "Term") {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    fail("gateway/invalid-plan", `${label} must be a tagged Term`);
  }
  switch (value[0]) {
    case "string":
      if (value.length !== 2 || typeof value[1] !== "string") break;
      return ["string", value[1]];
    case "integer":
      if (value.length !== 2 || typeof value[1] !== "string" || !INTEGER.test(value[1])) break;
      if (BigInt(value[1]) < I64_MIN || BigInt(value[1]) > I64_MAX) break;
      return ["integer", value[1]];
    case "float64":
      if (value.length !== 2 || typeof value[1] !== "string" || !FLOAT64.test(value[1])) break;
      return ["float64", value[1]];
    case "boolean":
      if (value.length !== 2 || typeof value[1] !== "boolean") break;
      return ["boolean", value[1]];
    case "keyword":
      if (value.length !== 2 || typeof value[1] !== "string" || value[1].length === 0) break;
      return ["keyword", value[1]];
    case "instant":
      if (value.length !== 3
          || typeof value[1] !== "string" || !INTEGER.test(value[1])
          || typeof value[2] !== "string" || !INTEGER.test(value[2])) break;
      if (BigInt(value[1]) < I64_MIN || BigInt(value[1]) > I64_MAX
          || BigInt(value[2]) < 0n || BigInt(value[2]) > 999_999_999n) break;
      return ["instant", value[1], value[2]];
    case "triple":
      if (value.length !== 4) break;
      return [
        "triple",
        cloneTerm(value[1], `${label}.t1`),
        cloneTerm(value[2], `${label}.t2`),
        cloneTerm(value[3], `${label}.t3`),
      ];
    default:
      break;
  }
  fail("gateway/invalid-plan", `${label} is not a valid tagged Term`);
}

function termEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!termEqual(a, b)) return false;
    } else if (a !== b) return false;
  }
  return true;
}

function requireAppScope(value, app, label) {
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== "triple"
      || !termEqual(value[1], ["keyword", "wake/app"])
      || !termEqual(value[2], ["keyword", app])) {
    fail("gateway/invalid-plan", `${label} must be scoped to Wake app ${app}`);
  }
}

function termKey(value) {
  const piece = part => `${String(part).length}:${String(part)}`;
  if (value[0] === "triple") {
    return `t${piece(termKey(value[1]))}${piece(termKey(value[2]))}${piece(termKey(value[3]))}`;
  }
  return `a${piece(value[0])}${piece(value[1])}${value.length === 3 ? piece(value[2]) : ""}`;
}

function hole(value, field) {
  return plainObject(value) && Object.keys(value).length === 1 && value.field === field;
}

function compileTemplate(value, field, label, state = { holes: 0 }) {
  if (hole(value, field)) {
    state.holes += 1;
    return { hole: true };
  }
  if (!Array.isArray(value) || value[0] !== "triple" || value.length !== 4) {
    fail("gateway/invalid-plan", `${label} must be a Triple Term containing its identity hole`);
  }
  return {
    tag: "triple",
    terms: [
      compileTemplatePart(value[1], field, `${label}.t1`, state),
      compileTemplatePart(value[2], field, `${label}.t2`, state),
      compileTemplatePart(value[3], field, `${label}.t3`, state),
    ],
    state,
  };
}

function compileTemplatePart(value, field, label, state) {
  if (hole(value, field)) {
    state.holes += 1;
    return { hole: true };
  }
  if (Array.isArray(value) && value[0] === "triple") {
    return compileTemplate(value, field, label, state);
  }
  return { constant: cloneTerm(value, label) };
}

function realizeTemplate(template, identity) {
  if (template.hole) return cloneRuntimeTerm(identity);
  if (template.constant) return cloneRuntimeTerm(template.constant);
  return ["triple", ...template.terms.map(part => realizeTemplate(part, identity))];
}

function matchTemplate(template, value) {
  if (template.hole) return cloneRuntimeTerm(value);
  if (template.constant) return termEqual(template.constant, value) ? null : MISMATCH;
  if (!Array.isArray(value) || value[0] !== "triple" || value.length !== 4) return MISMATCH;
  let found = null;
  for (let index = 0; index < 3; index += 1) {
    const matched = matchTemplate(template.terms[index], value[index + 1]);
    if (matched === MISMATCH) return MISMATCH;
    if (matched !== null) {
      if (found !== null && !termEqual(found, matched)) return MISMATCH;
      found = matched;
    }
  }
  return found;
}

function cloneRuntimeTerm(value) {
  if (!Array.isArray(value)) fail("gateway/protocol", "FRAM returned a malformed Term");
  if (value[0] === "triple") {
    if (value.length !== 4) fail("gateway/protocol", "FRAM returned a malformed Triple Term");
    return ["triple", cloneRuntimeTerm(value[1]), cloneRuntimeTerm(value[2]), cloneRuntimeTerm(value[3])];
  }
  if (["string", "integer", "float64", "boolean", "keyword"].includes(value[0]) && value.length === 2) {
    return [value[0], value[1]];
  }
  if (value[0] === "instant" && value.length === 3) return ["instant", value[1], value[2]];
  fail("gateway/protocol", "FRAM returned a malformed Term");
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
      if (!plainObject(value) || !own(value, "epochSeconds") || !own(value, "nanos")) {
        fail("gateway/type-mismatch", `${label} must contain epochSeconds and nanos`);
      }
      const seconds = canonicalInteger(value.epochSeconds, `${label}.epochSeconds`);
      const nanos = canonicalInteger(value.nanos, `${label}.nanos`);
      if (BigInt(nanos) < 0n || BigInt(nanos) > 999_999_999n) {
        fail("gateway/type-mismatch", `${label}.nanos is outside the nanosecond range`);
      }
      return ["instant", seconds, nanos];
    }
    default:
      if (typeof value !== "string" || value.length === 0) {
        fail("gateway/type-mismatch", `${label} must be a nonempty ${type} value`);
      }
      return ["keyword", value];
  }
}

function decodeLiteral(type, value, label) {
  const expected = (tag, length) => {
    if (!Array.isArray(value) || value[0] !== tag || value.length !== length) {
      fail("gateway/data-integrity", `${label} is not a ${tag} Term`);
    }
  };
  switch (type) {
    case "String":
      expected("string", 2);
      return value[1];
    case "Int":
    case "Integer":
      expected("integer", 2);
      return BigInt(value[1]);
    case "Float":
    case "Double":
    case "Number":
      expected("float64", 2);
      if (!FLOAT64.test(value[1])) fail("gateway/data-integrity", `${label} has invalid float bits`);
      return floatValue(value[1], label);
    case "Bool":
    case "Boolean":
      expected("boolean", 2);
      return value[1];
    case "Instant":
      expected("instant", 3);
      return { epochSeconds: BigInt(value[1]), nanos: Number(value[2]) };
    case "Keyword":
    default:
      expected("keyword", 2);
      return value[1];
  }
}

function compilePlan(plan) {
  if (!plainObject(plan) || plan.schemaVersion !== 2 || plan.backend !== "fram"
      || typeof plan.applicationId !== "string"
      || typeof plan.semanticFingerprint !== "string"
      || !SHA256.test(plan.semanticFingerprint)
      || !Array.isArray(plan.pluginClosure)
      || !Array.isArray(plan.entities)
      || !Array.isArray(plan.queries)
      || !Array.isArray(plan.stateMachines) || !Array.isArray(plan.publications)) {
    fail("gateway/invalid-plan", "expected a Wake FRAM plan with schemaVersion 2");
  }
  const applicationId = requiredName(plan.applicationId, "applicationId");
  const semanticFingerprint = plan.semanticFingerprint;
  const pluginClosure = structuredClone(plan.pluginClosure);
  if (pluginClosure.some(plugin => !plainObject(plugin))) {
    fail("gateway/invalid-plan", "pluginClosure entries must be objects");
  }

  const names = new Set();
  const entities = plan.entities.map((source, entityIndex) => {
    if (!plainObject(source)) fail("gateway/invalid-plan", `entities[${entityIndex}] must be an object`);
    const name = requiredName(source.name, `entities[${entityIndex}].name`);
    if (names.has(name)) fail("gateway/invalid-plan", `entity ${name} is duplicated`);
    names.add(name);
    if (!plainObject(source.identity)) fail("gateway/invalid-plan", `entity ${name} needs an identity`);
    const identity = {
      field: requiredName(source.identity.field, `${name}.identity.field`),
      type: requiredName(source.identity.type, `${name}.identity.type`),
      cardinality: source.identity.cardinality,
      valueKind: source.identity.valueKind,
    };
    if (identity.cardinality !== "single" || identity.valueKind !== "literal") {
      fail("gateway/invalid-plan", `entity ${name} identity must be a single literal field`);
    }
    requireAppScope(
      source.identity.subjectTemplate,
      applicationId,
      `${name}.identity.subjectTemplate`,
    );
    const state = { holes: 0 };
    const template = compileTemplate(
      source.identity.subjectTemplate,
      identity.field,
      `${name}.identity.subjectTemplate`,
      state,
    );
    if (state.holes !== 1) fail("gateway/invalid-plan", `entity ${name} subject template needs one identity hole`);

    if (!Array.isArray(source.fields)) fail("gateway/invalid-plan", `entity ${name} fields must be an array`);
    const fieldNames = new Set();
    const fields = source.fields.map((field, fieldIndex) => {
      if (!plainObject(field)) fail("gateway/invalid-plan", `${name}.fields[${fieldIndex}] must be an object`);
      const fieldName = requiredName(field.name, `${name}.fields[${fieldIndex}].name`);
      if (fieldNames.has(fieldName)) fail("gateway/invalid-plan", `${name}.${fieldName} is duplicated`);
      fieldNames.add(fieldName);
      if (field.cardinality !== "single" && field.cardinality !== "multi") {
        fail("gateway/invalid-plan", `${name}.${fieldName} has invalid cardinality`);
      }
      if (field.valueKind !== "literal" && field.valueKind !== "ref") {
        fail("gateway/invalid-plan", `${name}.${fieldName} has invalid valueKind`);
      }
      if (!["create", "set", "command"].includes(field.write)) {
        fail("gateway/invalid-plan", `${name}.${fieldName} has invalid write policy`);
      }
      const plannedPredicate = cloneTerm(
        field.predicateTerm,
        `${name}.${fieldName}.predicateTerm`,
      );
      requireAppScope(
        plannedPredicate,
        applicationId,
        `${name}.${fieldName}.predicateTerm`,
      );
      return {
        name: fieldName,
        type: requiredName(field.type, `${name}.${fieldName}.type`),
        cardinality: field.cardinality,
        valueKind: field.valueKind,
        write: field.write,
        predicate: plannedPredicate,
        targetName: field.valueKind === "ref"
          ? requiredName(field.targetEntity, `${name}.${fieldName}.targetEntity`)
          : null,
        target: null,
        stateMachine: null,
      };
    });
    const identityField = fields.find(field => field.name === identity.field);
    if (!identityField || identityField.type !== identity.type
        || identityField.cardinality !== "single" || identityField.valueKind !== "literal") {
      fail("gateway/invalid-plan", `entity ${name} identity does not match its field plan`);
    }
    return {
      name,
      identity,
      template,
      fields,
      fieldsByName: new Map(fields.map(field => [field.name, field])),
      identityField,
    };
  });

  const byName = new Map(entities.map(entity => [entity.name, entity]));
  const predicates = new Map();
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.targetName !== null) {
        field.target = byName.get(field.targetName);
        if (!field.target) fail("gateway/invalid-plan", `${entity.name}.${field.name} targets an unknown entity`);
      }
      const key = termKey(field.predicate);
      if (predicates.has(key)) fail("gateway/invalid-plan", "field predicate Terms must be unique");
      predicates.set(key, { entity, field });
    }
  }

  const machineFields = new Set();
  const stateMachines = plan.stateMachines.map((source, machineIndex) => {
    const label = `stateMachines[${machineIndex}]`;
    if (!plainObject(source)) fail("gateway/invalid-plan", `${label} must be an object`);
    const entityName = requiredName(source.entity, `${label}.entity`);
    const fieldName = requiredName(source.field, `${label}.field`);
    const entity = byName.get(entityName);
    if (!entity) fail("gateway/invalid-plan", `${label} names an unknown entity`);
    const field = entity.fieldsByName.get(fieldName);
    if (!field) fail("gateway/invalid-plan", `${label} names an unknown field`);
    if (field.cardinality !== "single" || field.valueKind !== "literal") {
      fail("gateway/invalid-plan", `${entityName}.${fieldName} state must be a single literal`);
    }
    const stateType = requiredName(source.stateType, `${label}.stateType`);
    if (stateType !== field.type) fail("gateway/invalid-plan", `${label} stateType does not match its field`);
    const key = `${entityName}\u0000${fieldName}`;
    if (machineFields.has(key)) fail("gateway/invalid-plan", `${entityName}.${fieldName} has two state machines`);
    machineFields.add(key);
    if (!plainObject(source.transitions)) fail("gateway/invalid-plan", `${label}.transitions must be an object`);
    const states = Object.keys(source.transitions);
    if (states.length === 0 || states.some(state => state.length === 0)) {
      fail("gateway/invalid-plan", `${label}.transitions must declare named states`);
    }
    const transitions = new Map();
    for (const state of states) {
      const targets = source.transitions[state];
      if (!Array.isArray(targets) || targets.some(target => typeof target !== "string" || target.length === 0)) {
        fail("gateway/invalid-plan", `${label}.transitions.${state} must be an array of states`);
      }
      if (new Set(targets).size !== targets.length) {
        fail("gateway/invalid-plan", `${label}.transitions.${state} contains a duplicate target`);
      }
      transitions.set(state, [...targets]);
    }
    for (const [state, targets] of transitions) {
      for (const target of targets) {
        if (!transitions.has(target)) {
          fail("gateway/invalid-plan", `${label} transition ${state} -> ${target} names an unknown state`);
        }
      }
    }
    const initial = requiredName(source.initial, `${label}.initial`);
    if (!transitions.has(initial)) fail("gateway/invalid-plan", `${label}.initial names an unknown state`);
    const machine = { entity, field, stateType, initial, transitions };
    field.stateMachine = machine;
    return machine;
  });

  const publicationNames = new Set();
  const publicationPointers = new Set();
  const publications = plan.publications.map((source, publicationIndex) => {
    const label = `publications[${publicationIndex}]`;
    if (!plainObject(source)) fail("gateway/invalid-plan", `${label} must be an object`);
    const name = requiredName(source.name, `${label}.name`);
    if (publicationNames.has(name)) fail("gateway/invalid-plan", `publication ${name} is duplicated`);
    publicationNames.add(name);
    if (!plainObject(source.owner) || !plainObject(source.revision) || !plainObject(source.states)) {
      fail("gateway/invalid-plan", `${label} must declare owner, revision, and states`);
    }

    const owner = byName.get(requiredName(source.owner.entity, `${label}.owner.entity`));
    const revision = byName.get(requiredName(source.revision.entity, `${label}.revision.entity`));
    if (!owner || !revision) fail("gateway/invalid-plan", `${label} names an unknown entity`);
    const pointer = owner.fieldsByName.get(requiredName(source.owner.pointer, `${label}.owner.pointer`));
    const ownerField = revision.fieldsByName.get(
      requiredName(source.revision.ownerField, `${label}.revision.ownerField`),
    );
    const stateField = revision.fieldsByName.get(
      requiredName(source.revision.stateField, `${label}.revision.stateField`),
    );
    if (!pointer || !ownerField || !stateField) {
      fail("gateway/invalid-plan", `${label} names an unknown publication field`);
    }
    if (pointer.valueKind !== "ref" || pointer.cardinality !== "single"
        || pointer.target !== revision || pointer.write !== "command") {
      fail("gateway/invalid-plan", `${label} owner pointer must be a command-only Ref to its revision`);
    }
    if (ownerField.valueKind !== "ref" || ownerField.cardinality !== "single"
        || ownerField.target !== owner || ownerField.write !== "create") {
      fail("gateway/invalid-plan", `${label} revision owner must be a create-only Ref to its owner`);
    }
    if (stateField.valueKind !== "literal" || stateField.cardinality !== "single"
        || stateField.write !== "command" || !stateField.stateMachine) {
      fail("gateway/invalid-plan", `${label} revision state must be a command-only state field`);
    }

    const states = {
      draft: requiredName(source.states.draft, `${label}.states.draft`),
      published: requiredName(source.states.published, `${label}.states.published`),
      retired: requiredName(source.states.retired, `${label}.states.retired`),
    };
    if (new Set(Object.values(states)).size !== 3
        || !Object.values(states).every(state => stateField.stateMachine.transitions.has(state))) {
      fail("gateway/invalid-plan", `${label} publication states must be distinct declared states`);
    }
    if (stateField.stateMachine.initial !== states.draft
        || !stateField.stateMachine.transitions.get(states.draft).includes(states.published)
        || !stateField.stateMachine.transitions.get(states.published).includes(states.retired)) {
      fail("gateway/invalid-plan", `${label} publication lifecycle is not supported by its state machine`);
    }
    const pointerKey = `${owner.name}\u0000${pointer.name}`;
    if (publicationPointers.has(pointerKey)) {
      fail("gateway/invalid-plan", `${owner.name}.${pointer.name} has two publication policies`);
    }
    publicationPointers.add(pointerKey);
    return { name, owner, pointer, revision, ownerField, stateField, states };
  });
  return {
    applicationId,
    semanticFingerprint,
    pluginClosure,
    entities,
    byName,
    predicates,
    stateMachines,
    publications,
    publicationsByName: new Map(publications.map(publication => [publication.name, publication])),
  };
}

function encodeField(field, value, label) {
  if (field.valueKind === "ref") {
    const identity = encodeLiteral(field.target.identity.type, value, label);
    return realizeTemplate(field.target.template, identity);
  }
  return encodeLiteral(field.type, value, label);
}

function decodeField(field, value, label) {
  if (field.valueKind === "ref") {
    const identity = matchTemplate(field.target.template, value);
    if (identity === MISMATCH || identity === null) {
      fail("gateway/data-integrity", `${label} does not name a ${field.target.name}`);
    }
    return decodeLiteral(field.target.identity.type, identity, label);
  }
  return decodeLiteral(field.type, value, label);
}

function readQuery(entity, identity) {
  const subject = identity === undefined
    ? { var: "subject" }
    : realizeTemplate(entity.template, identity);
  const identityValue = identity === undefined ? { var: "identity" } : identity;
  return {
    find: `wake/read/${entity.name}`,
    rules: [{
      head: {
        rel: `wake/read/${entity.name}`,
        args: [subject, { var: "predicate" }, { var: "value" }],
      },
      body: [
        {
          rel: "triple",
          args: [subject, entity.identityField.predicate, identityValue],
        },
        {
          rel: "triple",
          args: [subject, { var: "predicate" }, { var: "value" }],
        },
      ],
    }],
  };
}

function changesQuery() {
  return {
    find: "wake/changes",
    rules: [{
      head: {
        rel: "wake/changes",
        args: [{ var: "where" }, { var: "action" }, { var: "proposition" }],
      },
      body: [{
        rel: "occurrence",
        args: [{ var: "where" }, { var: "action" }, { var: "proposition" }],
      }],
    }],
  };
}

async function drainQuery(fram, query, baseOptions) {
  let cursor;
  let pages = 0;
  let servedVersion;
  const rows = [];
  while (true) {
    pages += 1;
    const options = {
      ...baseOptions,
      page: { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
    };
    const response = await fram.query(query, options);
    if (!plainObject(response) || !Array.isArray(response.result)
        || (typeof response.servedVersion !== "bigint" && !Number.isSafeInteger(response.servedVersion))) {
      fail("gateway/protocol", "FRAM returned an invalid query response");
    }
    if (servedVersion === undefined) servedVersion = BigInt(response.servedVersion);
    else if (servedVersion !== BigInt(response.servedVersion)) {
      fail("gateway/protocol", "FRAM changed the served version inside a cursor-pinned read");
    }
    const done = !response.page || response.page.done === true;
    if (!done && (response.page.nextCursor === null || response.page.nextCursor === undefined)) {
      fail("gateway/protocol", "FRAM omitted the next cursor for an unfinished page");
    }
    const exceedsRows = response.result.length > MAX_QUERY_ROWS - rows.length;
    if (!exceedsRows) rows.push(...response.result);
    if (exceedsRows || (!done && pages >= MAX_QUERY_PAGES)) {
      return { rows, servedVersion, limited: true };
    }
    if (done) break;
    cursor = response.page.nextCursor;
  }
  return { rows, servedVersion, limited: false };
}

function mergeRows(entity, rawRows) {
  const groups = new Map();
  for (const raw of rawRows) {
    if (!Array.isArray(raw) || raw.length !== 3) {
      fail("gateway/protocol", "FRAM returned a malformed entity query row");
    }
    const [subject, predicate, value] = raw;
    const identity = matchTemplate(entity.template, subject);
    if (identity === MISMATCH || identity === null) continue;
    const field = entity.fields.find(candidate => termEqual(candidate.predicate, predicate));
    if (!field) continue;
    const key = termKey(subject);
    let group = groups.get(key);
    if (!group) {
      const row = Object.create(null);
      defineOwn(
        row,
        entity.identity.field,
        decodeLiteral(entity.identity.type, identity, `${entity.name} identity`),
      );
      for (const planned of entity.fields) {
        if (planned.cardinality === "multi") defineOwn(row, planned.name, []);
      }
      group = { row, terms: new Map([[entity.identity.field, [cloneRuntimeTerm(identity)]]]) };
      groups.set(key, group);
    }
    const decoded = decodeField(field, value, `${entity.name}.${field.name}`);
    if (field.cardinality === "multi") {
      const seen = group.terms.get(field.name) ?? [];
      if (!seen.some(term => termEqual(term, value))) {
        seen.push(cloneRuntimeTerm(value));
        group.terms.set(field.name, seen);
        group.row[field.name].push(decoded);
      }
    } else if (!own(group.row, field.name)) {
      defineOwn(group.row, field.name, decoded);
      group.terms.set(field.name, [cloneRuntimeTerm(value)]);
    } else if (!termEqual(group.terms.get(field.name)[0], value)) {
      fail("gateway/data-integrity", `${entity.name}.${field.name} has more than one live value`);
    }
  }
  return Array.from(groups.values(), group => {
    const row = {};
    for (const [name, value] of Object.entries(group.row)) defineOwn(row, name, value);
    return row;
  });
}

function referenceRequirement(field, value) {
  const identity = matchTemplate(field.target.template, value);
  if (identity === MISMATCH || identity === null) {
    fail("gateway/invalid-plan", `${field.target.name} reference template could not be realized`);
  }
  return {
    subject: value,
    predicate: field.target.identityField.predicate,
    value: identity,
  };
}

function uniqueRequirements(requirements) {
  const seen = new Set();
  return requirements.filter(requirement => {
    const key = [requirement.subject, requirement.predicate, requirement.value]
      .map(termKey)
      .map(value => `${value.length}:${value}`)
      .join("");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function creationValues(entity, values) {
  const effective = { ...values };
  for (const field of entity.fields) {
    const machine = field.stateMachine;
    if (!machine) continue;
    if (own(effective, field.name)) {
      const supplied = encodeField(field, effective[field.name], `${entity.name}.${field.name}`);
      const initial = encodeField(field, machine.initial, `${entity.name}.${field.name}`);
      if (!termEqual(supplied, initial)) {
        fail(
          "gateway/invalid-transition",
          `${entity.name}.${field.name} must be created in ${machine.initial}`,
        );
      }
    } else {
      effective[field.name] = machine.initial;
    }
  }
  return effective;
}

function mutationFields(entity, values) {
  const planned = [];
  for (const field of entity.fields) {
    if (field.name === entity.identity.field || !own(values, field.name)) continue;
    const label = `${entity.name}.${field.name}`;
    const inputs = field.cardinality === "multi"
      ? (() => {
          if (!Array.isArray(values[field.name])) fail("gateway/type-mismatch", `${label} must be an array`);
          return values[field.name];
        })()
      : [values[field.name]];
    planned.push({ field, inputs, label });
  }

  const fields = [];
  const requirements = [];
  for (const { field, inputs, label } of planned) {
    if (field.cardinality === "multi") {
      for (const value of inputs) {
        const encoded = encodeField(field, value, label);
        fields.push({ predicate: field.predicate, value: encoded, cardinality: "multi" });
        if (field.valueKind === "ref") requirements.push(referenceRequirement(field, encoded));
      }
    } else {
      const encoded = encodeField(field, inputs[0], label);
      fields.push({ predicate: field.predicate, value: encoded, cardinality: "single" });
      if (field.valueKind === "ref") requirements.push(referenceRequirement(field, encoded));
    }
  }
  return { fields, requireUnique: uniqueRequirements(requirements) };
}

function replacementField(entity, field, value) {
  const label = `${entity.name}.${field.name}`;
  const inputs = field.cardinality === "multi"
      ? (() => {
        if (!Array.isArray(value)) fail("gateway/type-mismatch", `${label} must be an array`);
        return value;
      })()
    : [value];
  const values = inputs.map(input => encodeField(field, input, label));
  const requireUnique = field.valueKind === "ref"
    ? uniqueRequirements(values.map(encoded => referenceRequirement(field, encoded)))
    : [];
  const planned = { predicate: field.predicate, values, cardinality: field.cardinality };
  if (field.stateMachine) {
    if (inputs.length !== 1 || typeof inputs[0] !== "string"
        || !field.stateMachine.transitions.has(inputs[0])) {
      fail("gateway/invalid-transition", `${label} target state is not declared`);
    }
    const target = inputs[0];
    const allowed = [];
    for (const [state, targets] of field.stateMachine.transitions) {
      if (targets.includes(target)) allowed.push(state);
    }
    if (!allowed.includes(target)) allowed.push(target);
    planned.allowedCurrent = allowed.map(state => encodeField(field, state, label));
  }
  return { field: planned, requireUnique };
}

export function createFramGateway(plan, { fram, schema } = {}) {
  const compiled = compilePlan(plan);
  if (!fram || typeof fram.query !== "function") {
    fail("gateway/invalid-client", "fram.query is required");
  }
  if (!schema || typeof schema.createUnique !== "function"
      || typeof schema.updateUnique !== "function"
      || typeof schema.updateUniqueMany !== "function") {
    fail("gateway/invalid-client", "the FRAM schema client is incomplete");
  }
  const namedQueries = createNamedQueryRuntime(plan.queries, {
    fram,
    entities: plan.entities,
  });

  const entityNamed = name => {
    inputName(name, "entity");
    const entity = compiled.byName.get(name);
    if (!entity) fail("gateway/unknown-entity", `unknown entity ${name}`, { entity: name });
    return entity;
  };

  const fieldNamed = (entity, name) => {
    inputName(name, "field");
    const field = entity.fieldsByName.get(name);
    if (!field) {
      fail("gateway/unknown-field", `unknown field ${entity.name}.${name}`, { entity: entity.name, field: name });
    }
    return field;
  };

  const publicationNamed = name => {
    inputName(name, "publication");
    const publication = compiled.publicationsByName.get(name);
    if (!publication) {
      fail("gateway/unknown-publication", `unknown publication ${name}`, { publication: name });
    }
    return publication;
  };

  return Object.freeze({
    applicationId: compiled.applicationId,
    semanticFingerprint: compiled.semanticFingerprint,

    async executeQuery(name, input, options = {}) {
      return namedQueries.execute(name, input, options);
    },

    async list(entityName) {
      const entity = entityNamed(entityName);
      const response = await drainQuery(fram, readQuery(entity), { timeoutMs: QUERY_TIMEOUT_MS });
      if (response.limited) {
        fail("gateway/result-limit", `${entity.name} list exceeds Wake's ${MAX_QUERY_ROWS}-row read limit`);
      }
      return { rows: mergeRows(entity, response.rows), servedVersion: response.servedVersion };
    },

    async get(entityName, identityValue) {
      const entity = entityNamed(entityName);
      const identity = encodeLiteral(entity.identity.type, identityValue, `${entity.name}.${entity.identity.field}`);
      const response = await drainQuery(fram, readQuery(entity, identity), { timeoutMs: QUERY_TIMEOUT_MS });
      if (response.limited) {
        fail("gateway/result-limit", `${entity.name} lookup exceeds Wake's ${MAX_QUERY_ROWS}-row read limit`);
      }
      const rows = mergeRows(entity, response.rows);
      if (rows.length > 1) fail("gateway/data-integrity", `${entity.name} identity resolved more than once`);
      return { row: rows[0] ?? null, servedVersion: response.servedVersion };
    },

    async create(entityName, values) {
      const entity = entityNamed(entityName);
      if (!plainObject(values)) fail("gateway/invalid-input", "values must be a plain object");
      for (const name of Object.keys(values)) {
        const field = fieldNamed(entity, name);
        if (field.write === "command") {
          fail(
            "gateway/write-policy",
            `${entity.name}.${field.name} can only be written by a domain command`,
          );
        }
      }
      if (!own(values, entity.identity.field)) {
        fail("gateway/missing-identity", `create requires ${entity.name}.${entity.identity.field}`);
      }
      const identityTerm = encodeLiteral(
        entity.identity.type,
        values[entity.identity.field],
        `${entity.name}.${entity.identity.field}`,
      );
      const identity = decodeLiteral(entity.identity.type, identityTerm, `${entity.name}.${entity.identity.field}`);
      const mutation = mutationFields(entity, creationValues(entity, values));
      const input = {
        subject: realizeTemplate(entity.template, identityTerm),
        identity: { predicate: entity.identityField.predicate, value: identityTerm },
        fields: mutation.fields,
      };
      if (mutation.requireUnique.length > 0) input.requireUnique = mutation.requireUnique;
      const result = await schema.createUnique(input);
      if (!plainObject(result) || typeof result.servedVersion !== "bigint") {
        fail("gateway/protocol", "FRAM schema create returned an invalid result");
      }
      return { created: true, identity, servedVersion: result.servedVersion };
    },

    async set(entityName, identityValue, fieldName, value) {
      const entity = entityNamed(entityName);
      const field = fieldNamed(entity, fieldName);
      if (field.name === entity.identity.field) {
        fail("gateway/identity-mutation", `${entity.name}.${field.name} is immutable`);
      }
      if (field.write !== "set") {
        fail(
          "gateway/write-policy",
          `${entity.name}.${field.name} does not allow generic set`,
        );
      }
      const identityTerm = encodeLiteral(entity.identity.type, identityValue, `${entity.name}.${entity.identity.field}`);
      const identity = decodeLiteral(entity.identity.type, identityTerm, `${entity.name}.${entity.identity.field}`);
      const replacement = replacementField(entity, field, value);
      const subject = realizeTemplate(entity.template, identityTerm);
      const input = {
        identity: { predicate: entity.identityField.predicate, value: identityTerm },
        field: replacement.field,
        requireUnique: uniqueRequirements([{
          subject,
          predicate: entity.identityField.predicate,
          value: identityTerm,
        }, ...replacement.requireUnique]),
      };
      const result = await schema.updateUnique(input);
      if (!plainObject(result) || typeof result.servedVersion !== "bigint" || typeof result.changed !== "boolean") {
        fail("gateway/protocol", "FRAM schema update returned an invalid result");
      }
      return { changed: result.changed, identity, servedVersion: result.servedVersion };
    },

    async publish(publicationName, ownerIdentity, revisionIdentity, expectedPointer) {
      const publication = publicationNamed(publicationName);
      const {
        owner,
        pointer,
        revision,
        ownerField,
        stateField,
        states,
      } = publication;
      const ownerIdentityTerm = encodeLiteral(
        owner.identity.type,
        ownerIdentity,
        `${owner.name}.${owner.identity.field}`,
      );
      const revisionIdentityTerm = encodeLiteral(
        revision.identity.type,
        revisionIdentity,
        `${revision.name}.${revision.identity.field}`,
      );
      const expectedIdentityTerm = expectedPointer === null
        ? null
        : encodeLiteral(
            revision.identity.type,
            expectedPointer,
            `${owner.name}.${pointer.name}`,
          );
      const ownerSubject = realizeTemplate(owner.template, ownerIdentityTerm);
      const revisionSubject = realizeTemplate(revision.template, revisionIdentityTerm);
      const expectedSubject = expectedIdentityTerm === null
        ? null
        : realizeTemplate(revision.template, expectedIdentityTerm);
      const ownerValue = encodeField(ownerField, ownerIdentity, `${revision.name}.${ownerField.name}`);
      const publishedValue = encodeField(stateField, states.published, `${revision.name}.${stateField.name}`);
      const draftValue = encodeField(stateField, states.draft, `${revision.name}.${stateField.name}`);
      const retiredValue = encodeField(stateField, states.retired, `${revision.name}.${stateField.name}`);

      const updates = [
        {
          identity: { predicate: owner.identityField.predicate, value: ownerIdentityTerm },
          fields: [{
            predicate: pointer.predicate,
            values: [revisionSubject],
            cardinality: "single",
            allowedCurrent: expectedSubject === null ? [] : [expectedSubject],
          }],
        },
        {
          identity: { predicate: revision.identityField.predicate, value: revisionIdentityTerm },
          fields: [
            {
              predicate: ownerField.predicate,
              values: [ownerValue],
              cardinality: "single",
              allowedCurrent: [ownerValue],
            },
            {
              predicate: stateField.predicate,
              values: [publishedValue],
              cardinality: "single",
              allowedCurrent: [draftValue, publishedValue],
            },
          ],
        },
      ];
      const requirements = [
        {
          subject: ownerSubject,
          predicate: owner.identityField.predicate,
          value: ownerIdentityTerm,
        },
        {
          subject: revisionSubject,
          predicate: revision.identityField.predicate,
          value: revisionIdentityTerm,
        },
      ];
      if (expectedSubject !== null && !termEqual(expectedSubject, revisionSubject)) {
        const previousOwner = encodeField(
          ownerField,
          ownerIdentity,
          `${revision.name}.${ownerField.name}`,
        );
        const previousPublished = encodeField(
          stateField,
          states.published,
          `${revision.name}.${stateField.name}`,
        );
        const previousRetired = encodeField(
          stateField,
          states.retired,
          `${revision.name}.${stateField.name}`,
        );
        updates.push({
          identity: { predicate: revision.identityField.predicate, value: expectedIdentityTerm },
          fields: [
            {
              predicate: ownerField.predicate,
              values: [previousOwner],
              cardinality: "single",
              allowedCurrent: [previousOwner],
            },
            {
              predicate: stateField.predicate,
              values: [previousRetired],
              cardinality: "single",
              allowedCurrent: [previousPublished, previousRetired],
            },
          ],
        });
        requirements.push({
          subject: expectedSubject,
          predicate: revision.identityField.predicate,
          value: expectedIdentityTerm,
        });
      }

      const result = await schema.updateUniqueMany({
        updates,
        requireUnique: uniqueRequirements(requirements),
      });
      if (!plainObject(result) || typeof result.servedVersion !== "bigint"
          || typeof result.changed !== "boolean" || !Array.isArray(result.subjects)
          || result.subjects.length !== updates.length) {
        fail("gateway/protocol", "FRAM schema publication update returned an invalid result");
      }
      return {
        changed: result.changed,
        owner: decodeLiteral(owner.identity.type, ownerIdentityTerm, `${owner.name} identity`),
        revision: decodeLiteral(
          revision.identity.type,
          revisionIdentityTerm,
          `${revision.name} identity`,
        ),
        previous: expectedIdentityTerm === null
          ? null
          : decodeLiteral(
              revision.identity.type,
              expectedIdentityTerm,
              `${revision.name} identity`,
            ),
        servedVersion: result.servedVersion,
      };
    },

    async changes(sinceVersion) {
      const lowerExclusive = BigInt(canonicalInteger(sinceVersion, "sinceVersion"));
      if (lowerExclusive < 0n) fail("gateway/invalid-input", "sinceVersion must be nonnegative");
      const response = await drainQuery(fram, changesQuery(), {
        timeoutMs: QUERY_TIMEOUT_MS,
        since: { lowerExclusive, upper: "current" },
      });
      if (response.limited) {
        return { resync: true, changes: [], servedVersion: response.servedVersion };
      }
      const affected = new Map();
      for (const raw of response.rows) {
        if (!Array.isArray(raw) || raw.length !== 3) {
          fail("gateway/protocol", "FRAM returned a malformed occurrence query row");
        }
        const proposition = raw[2];
        if (!Array.isArray(proposition) || proposition[0] !== "triple" || proposition.length !== 4) {
          fail("gateway/protocol", "FRAM returned a malformed occurrence proposition");
        }
        const exactProposition = cloneRuntimeTerm(proposition);
        const entry = compiled.predicates.get(termKey(exactProposition[2]));
        if (!entry || !termEqual(entry.field.predicate, exactProposition[2])) continue;
        const identityTerm = matchTemplate(entry.entity.template, exactProposition[1]);
        if (identityTerm === MISMATCH || identityTerm === null) continue;
        const key = termKey(identityTerm);
        let identities = affected.get(entry.entity.name);
        if (!identities) {
          identities = new Map();
          affected.set(entry.entity.name, identities);
        }
        if (!identities.has(key)) {
          identities.set(
            key,
            decodeLiteral(entry.entity.identity.type, identityTerm, `${entry.entity.name} identity`),
          );
        }
      }
      const changes = compiled.entities
        .filter(entity => affected.has(entity.name))
        .map(entity => ({ entity: entity.name, identities: Array.from(affected.get(entity.name).values()) }));
      return { changes, servedVersion: response.servedVersion };
    },
  });
}
