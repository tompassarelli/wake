import { canonicalDocument, sha256Digest } from "./canonical.mjs";
import { CheckedValueError, compileCheckedValue } from "./checked-value.mjs";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_EXPRESSION_DEPTH = 32;
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
const checkedValueContracts = new WeakMap();

export class CommandError extends Error {
  constructor(code, message, detail = undefined, options = undefined) {
    super(message, options);
    this.name = "CommandError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function rejectProviderInput(message, detail = undefined) {
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("provider rejection message must be a nonempty string");
  }
  throw new CommandError(
    "command/provider-rejected",
    message,
    detail === undefined ? undefined : frozenSnapshot(detail),
  );
}

function fail(code, message, detail, options) {
  throw new CommandError(code, message, detail, options);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function exactKeys(value, required, optional, label) {
  if (!plainObject(value)) fail("command/invalid-plan", `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!own(value, key)) fail("command/invalid-plan", `${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("command/invalid-plan", `${label}.${key} is unknown`);
  }
}

function nonempty(value, label, code = "command/invalid-plan") {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} must be a nonempty string`);
  }
  return value;
}

function uniqueNames(values, label) {
  const names = new Set();
  for (const value of values) {
    if (names.has(value.name)) fail("command/invalid-plan", `${label} repeats '${value.name}'`);
    names.add(value.name);
  }
}

function cloneJson(value) {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!plainObject(value)) fail("command/type-mismatch", "value must be JSON data");
  const result = {};
  for (const [key, item] of Object.entries(value)) defineData(result, key, cloneJson(item));
  return result;
}

function defineData(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function frozenSnapshot(value) {
  return deepFreeze(cloneJson(value));
}

function boundedContract(type, label) {
  const existing = checkedValueContracts.get(type);
  if (existing !== undefined) return existing;
  try {
    const contract = compileCheckedValue(type, { descriptorCode: "command/invalid-plan" });
    checkedValueContracts.set(type, contract);
    return contract;
  } catch (error) {
    if (error instanceof CheckedValueError) {
      fail("command/invalid-plan", `${label} is not a valid bounded value descriptor`);
    }
    throw error;
  }
}

function validateType(type, label) {
  if (!plainObject(type)) fail("command/invalid-plan", `${label} must be a type descriptor`);
  const kind = nonempty(type.kind, `${label}.kind`);
  switch (kind) {
    case "string":
      exactKeys(type, ["kind"], ["maxBytes", "maxLength", "minLength"], label);
      break;
    case "integer":
    case "number":
    case "boolean":
    case "instant":
    case "keyword":
    case "digest":
      exactKeys(type, ["kind"], [], label);
      break;
    case "nullable":
      exactKeys(type, ["kind", "value"], [], label);
      validateType(type.value, `${label}.value`);
      break;
    case "list":
      exactKeys(type, ["kind", "items", "maxItems"], ["normalizer"], label);
      if (!Number.isSafeInteger(type.maxItems) || type.maxItems < 0) {
        fail("command/invalid-plan", `${label}.maxItems must be a nonnegative integer`);
      }
      validateType(type.items, `${label}.items`);
      if (own(type, "normalizer") && type.normalizer !== "sort-unique") {
        fail("command/invalid-plan", `${label}.normalizer must be sort-unique`);
      }
      break;
    case "record":
      exactKeys(type, ["kind", "fields"], [], label);
      if (!Array.isArray(type.fields)) fail("command/invalid-plan", `${label}.fields must be an array`);
      type.fields.forEach((field, index) => validateInputField(field, `${label}.fields[${index}]`));
      uniqueNames(type.fields, `${label}.fields`);
      break;
    case "bounded":
      boundedContract(type, label);
      break;
    default:
      fail("command/invalid-plan", `${label}.kind '${kind}' is unsupported`);
  }
  for (const bound of ["maxBytes", "maxLength", "minLength"]) {
    if (own(type, bound) && (!Number.isSafeInteger(type[bound]) || type[bound] < 0)) {
      fail("command/invalid-plan", `${label}.${bound} must be a nonnegative integer`);
    }
  }
  return type;
}

function normalizeValue(value, type, label, code = "command/type-mismatch") {
  switch (type.kind) {
    case "bounded":
      try {
        return boundedContract(type, label).normalize(value, { code, label });
      } catch (error) {
        if (error instanceof CheckedValueError) fail(code, error.message);
        throw error;
      }
    case "string": {
      if (typeof value !== "string") fail(code, `${label} must be a string`);
      const length = [...value].length;
      const bytes = new TextEncoder().encode(value).byteLength;
      if (own(type, "minLength") && length < type.minLength) {
        fail(code, `${label} is shorter than ${type.minLength} scalar values`);
      }
      if (own(type, "maxLength") && length > type.maxLength) {
        fail(code, `${label} exceeds ${type.maxLength} scalar values`);
      }
      if (own(type, "maxBytes") && bytes > type.maxBytes) {
        fail(code, `${label} exceeds ${type.maxBytes} UTF-8 bytes`);
      }
      return value;
    }
    case "integer": {
      const spelling = typeof value === "bigint"
        ? value.toString()
        : typeof value === "number" && Number.isSafeInteger(value)
        && !Object.is(value, -0)
        ? String(value)
        : typeof value === "string" && INTEGER.test(value)
          ? value
          : null;
      if (spelling === null) fail(code, `${label} must be an exact integer`);
      const integer = BigInt(spelling);
      if (integer < MIN_I64 || integer > MAX_I64) {
        fail(code, `${label} must fit a signed 64-bit integer`);
      }
      return spelling;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
        fail(code, `${label} must be a finite JSON number other than negative zero`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail(code, `${label} must be boolean`);
      return value;
    case "keyword":
      if (typeof value !== "string" || value.length === 0) fail(code, `${label} must be a keyword spelling`);
      return value;
    case "digest":
      if (typeof value !== "string" || !DIGEST.test(value)) {
        fail(code, `${label} must be a canonical sha256 digest`);
      }
      return value;
    case "instant": {
      if (!plainObject(value) || !own(value, "epochSeconds") || !own(value, "nanos")
          || Object.keys(value).length !== 2) {
        fail(code, `${label} must contain only epochSeconds and nanos`);
      }
      const epochSeconds = normalizeValue(value.epochSeconds, { kind: "integer" }, `${label}.epochSeconds`, code);
      const nanos = normalizeValue(value.nanos, { kind: "integer" }, `${label}.nanos`, code);
      if (BigInt(nanos) < 0n || BigInt(nanos) > 999_999_999n) {
        fail(code, `${label}.nanos is outside the nanosecond range`);
      }
      return { epochSeconds, nanos: Number(nanos) };
    }
    case "nullable":
      return value === null ? null : normalizeValue(value, type.value, label, code);
    case "list": {
      if (!Array.isArray(value)) fail(code, `${label} must be an array`);
      if (value.length > type.maxItems) fail(code, `${label} accepts at most ${type.maxItems} items`);
      const normalized = value.map((item, index) => (
        normalizeValue(item, type.items, `${label}[${index}]`, code)
      ));
      if (type.normalizer !== "sort-unique") return normalized;
      const byCanonical = new Map(normalized.map(item => [canonicalDocument(item), item]));
      return [...byCanonical.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, item]) => item);
    }
    case "record": {
      if (!plainObject(value)) fail(code, `${label} must be an object`);
      const allowed = new Set(type.fields.map(field => field.name));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(code, `${label}.${key} is unknown`);
      }
      const result = {};
      for (const field of type.fields) {
        if (!own(value, field.name)) {
          if (field.required) fail(code, `${label}.${field.name} is required`);
          continue;
        }
        defineData(
          result,
          field.name,
          normalizeValue(value[field.name], field.type, `${label}.${field.name}`, code),
        );
      }
      return result;
    }
    default:
      fail("command/invalid-plan", `${label} uses an unsupported type`);
  }
}

function validateInputField(field, label) {
  exactKeys(field, ["name", "type"], ["required"], label);
  nonempty(field.name, `${label}.name`);
  if (own(field, "required") && typeof field.required !== "boolean") {
    fail("command/invalid-plan", `${label}.required must be boolean`);
  }
  validateType(field.type, `${label}.type`);
  return field;
}

function validateExpression(expression, label, depth = 0) {
  if (depth > MAX_EXPRESSION_DEPTH) {
    fail("command/invalid-plan", `${label} exceeds expression depth ${MAX_EXPRESSION_DEPTH}`);
  }
  if (!plainObject(expression)) fail("command/invalid-plan", `${label} must be an expression`);
  const kind = nonempty(expression.kind, `${label}.kind`);
  switch (kind) {
    case "literal":
      exactKeys(expression, ["kind", "value"], ["type"], label);
      if (own(expression, "type") && expression.type !== "keyword") {
        fail("command/invalid-plan", `${label}.type must be keyword when present`);
      }
      cloneJson(expression.value);
      break;
    case "input":
    case "injected":
    case "actor":
      exactKeys(expression, ["kind", "name"], [], label);
      nonempty(expression.name, `${label}.name`);
      break;
    case "receipt-time":
    case "artifact-digest":
      exactKeys(expression, ["kind"], [], label);
      break;
    case "list":
      exactKeys(expression, ["kind", "items"], [], label);
      if (!Array.isArray(expression.items)) fail("command/invalid-plan", `${label}.items must be an array`);
      expression.items.forEach((item, index) => validateExpression(item, `${label}.items[${index}]`, depth + 1));
      break;
    case "record":
      exactKeys(expression, ["kind", "fields"], [], label);
      if (!Array.isArray(expression.fields)) fail("command/invalid-plan", `${label}.fields must be an array`);
      for (const [index, field] of expression.fields.entries()) {
        exactKeys(field, ["name", "value"], [], `${label}.fields[${index}]`);
        nonempty(field.name, `${label}.fields[${index}].name`);
        validateExpression(field.value, `${label}.fields[${index}].value`, depth + 1);
      }
      uniqueNames(expression.fields, `${label}.fields`);
      break;
    case "get":
      exactKeys(expression, ["kind", "value", "field"], [], label);
      nonempty(expression.field, `${label}.field`);
      validateExpression(expression.value, `${label}.value`, depth + 1);
      break;
    case "if-null":
      exactKeys(expression, ["kind", "value", "then", "else"], [], label);
      validateExpression(expression.value, `${label}.value`, depth + 1);
      validateExpression(expression.then, `${label}.then`, depth + 1);
      validateExpression(expression.else, `${label}.else`, depth + 1);
      break;
    default:
      fail("command/invalid-plan", `${label}.kind '${kind}' is unsupported`);
  }
  return expression;
}

function validateWhen(when, label) {
  exactKeys(when, ["kind", "value"], [], label);
  if (when.kind !== "null" && when.kind !== "non-null") {
    fail("command/invalid-plan", `${label}.kind must be null or non-null`);
  }
  validateExpression(when.value, `${label}.value`);
}

function validateCapabilityChoice(choice, label) {
  exactKeys(choice, ["capability"], ["guards"], label);
  nonempty(choice.capability, `${label}.capability`);
  if (own(choice, "guards")) {
    if (!Array.isArray(choice.guards)) fail("command/invalid-plan", `${label}.guards must be an array`);
    choice.guards.forEach((guard, index) => validateStep(guard, `${label}.guards[${index}]`));
    if (choice.guards.some(guard => guard.op !== "require" && guard.op !== "guard")) {
      fail("command/invalid-plan", `${label}.guards accept only require and guard steps`);
    }
  }
  return choice;
}

function validateStep(step, label) {
  if (!plainObject(step)) fail("command/invalid-plan", `${label} must be an object`);
  const op = nonempty(step.op, `${label}.op`);
  if (op === "require") {
    exactKeys(step, ["op", "entity", "identity"], ["when"], label);
  } else if (op === "require-each") {
    exactKeys(step, ["op", "entity", "identities"], ["when"], label);
    validateExpression(step.identities, `${label}.identities`);
  } else if (op === "assert") {
    exactKeys(step, ["op", "left", "right"], [], label);
    validateExpression(step.left, `${label}.left`);
    validateExpression(step.right, `${label}.right`);
    return step;
  } else if (op === "assert-not-contains") {
    exactKeys(step, ["op", "list", "value"], [], label);
    validateExpression(step.list, `${label}.list`);
    validateExpression(step.value, `${label}.value`);
    return step;
  } else if (op === "guard") {
    exactKeys(step, ["op", "entity", "identity", "field", "equals"], ["when"], label);
    nonempty(step.field, `${label}.field`);
    validateExpression(step.equals, `${label}.equals`);
  } else if (op === "create") {
    exactKeys(step, ["op", "entity", "identity", "fields"], ["when"], label);
    if (!Array.isArray(step.fields)) fail("command/invalid-plan", `${label}.fields must be an array`);
    step.fields.forEach((field, index) => {
      const fieldLabel = `${label}.fields[${index}]`;
      exactKeys(field, ["field", "value"], ["omitIfNull"], fieldLabel);
      nonempty(field.field, `${fieldLabel}.field`);
      if (own(field, "omitIfNull") && typeof field.omitIfNull !== "boolean") {
        fail("command/invalid-plan", `${fieldLabel}.omitIfNull must be boolean`);
      }
      validateExpression(field.value, `${fieldLabel}.value`);
    });
  } else if (op === "update") {
    exactKeys(step, ["op", "entity", "identity", "fields"], ["when"], label);
    if (!Array.isArray(step.fields) || step.fields.length === 0) {
      fail("command/invalid-plan", `${label}.fields must be a nonempty array`);
    }
    step.fields.forEach((field, index) => {
      const fieldLabel = `${label}.fields[${index}]`;
      exactKeys(field, ["field", "value"], ["allowedCurrent"], fieldLabel);
      nonempty(field.field, `${fieldLabel}.field`);
      validateExpression(field.value, `${fieldLabel}.value`);
      if (own(field, "allowedCurrent")) {
        validateExpression(field.allowedCurrent, `${fieldLabel}.allowedCurrent`);
      }
    });
  } else {
    fail("command/invalid-plan", `${label}.op '${op}' is unsupported`);
  }
  nonempty(step.entity, `${label}.entity`);
  if (op !== "require-each") validateExpression(step.identity, `${label}.identity`);
  if (own(step, "when")) validateWhen(step.when, `${label}.when`);
  return step;
}

function validateInjection(injection, label) {
  exactKeys(injection, ["name", "kind", "type"], ["provider", "input", "storageId"], label);
  nonempty(injection.name, `${label}.name`);
  if (!["canonical-digest", "generated-id", "provider", "server-value"].includes(injection.kind)) {
    fail("command/invalid-plan", `${label}.kind '${injection.kind}' is unsupported`);
  }
  validateType(injection.type, `${label}.type`);
  if (injection.kind === "provider") {
    nonempty(injection.provider, `${label}.provider`);
    validateExpression(injection.input, `${label}.input`);
  } else if (injection.kind === "canonical-digest") {
    if (own(injection, "provider")) {
      fail("command/invalid-plan", `${label} canonical-digest cannot name a provider`);
    }
    validateExpression(injection.input, `${label}.input`);
    if (injection.type.kind !== "digest") {
      fail("command/invalid-plan", `${label} canonical-digest output type must be digest`);
    }
  } else if (injection.kind === "server-value") {
    nonempty(injection.storageId, `${label}.storageId`);
    if (own(injection, "provider") || own(injection, "input")) {
      fail("command/invalid-plan", `${label} server-value cannot name a provider or input`);
    }
  } else if (own(injection, "provider") || own(injection, "input") || own(injection, "storageId")) {
    fail("command/invalid-plan", `${label} generated-id cannot name a provider or input`);
  }
  return injection;
}

function validateReceipt(receipt, label) {
  exactKeys(receipt, [
    "entity",
    "identityField",
    "actorField",
    "commandField",
    "inputDigestField",
    "createdAtField",
    "resultFields",
  ], [], label);
  for (const key of ["entity", "identityField", "actorField", "commandField", "inputDigestField", "createdAtField"]) {
    nonempty(receipt[key], `${label}.${key}`);
  }
  if (!Array.isArray(receipt.resultFields)) {
    fail("command/invalid-plan", `${label}.resultFields must be an array`);
  }
  receipt.resultFields.forEach((field, index) => {
    const fieldLabel = `${label}.resultFields[${index}]`;
    exactKeys(field, ["name", "field", "type"], [], fieldLabel);
    nonempty(field.name, `${fieldLabel}.name`);
    nonempty(field.field, `${fieldLabel}.field`);
    validateType(field.type, `${fieldLabel}.type`);
  });
  uniqueNames(receipt.resultFields, `${label}.resultFields`);
  return receipt;
}

function validateCommand(command, index) {
  const label = `commands[${index}]`;
  exactKeys(command, [
    "name",
    "capabilities",
    "normalizerVersion",
    "input",
    "injections",
    "steps",
    "result",
    "receipt",
  ], [], label);
  nonempty(command.name, `${label}.name`);
  if (!Array.isArray(command.capabilities) || command.capabilities.length === 0) {
    fail("command/invalid-plan", `${label}.capabilities must be a nonempty array`);
  }
  command.capabilities.forEach((choice, choiceIndex) => (
    validateCapabilityChoice(choice, `${label}.capabilities[${choiceIndex}]`)
  ));
  uniqueNames(command.capabilities.map(choice => ({ name: choice.capability })), `${label}.capabilities`);
  if (!Number.isSafeInteger(command.normalizerVersion) || command.normalizerVersion < 1) {
    fail("command/invalid-plan", `${label}.normalizerVersion must be a positive integer`);
  }
  if (!Array.isArray(command.input)) fail("command/invalid-plan", `${label}.input must be an array`);
  command.input.forEach((field, fieldIndex) => validateInputField(field, `${label}.input[${fieldIndex}]`));
  uniqueNames(command.input, `${label}.input`);
  if (!Array.isArray(command.injections)) fail("command/invalid-plan", `${label}.injections must be an array`);
  command.injections.forEach((injection, injectionIndex) => (
    validateInjection(injection, `${label}.injections[${injectionIndex}]`)
  ));
  uniqueNames(command.injections, `${label}.injections`);
  if (!Array.isArray(command.steps) || command.steps.length === 0) {
    fail("command/invalid-plan", `${label}.steps must be a nonempty array`);
  }
  command.steps.forEach((step, stepIndex) => validateStep(step, `${label}.steps[${stepIndex}]`));
  if (!Array.isArray(command.result)) fail("command/invalid-plan", `${label}.result must be an array`);
  command.result.forEach((field, resultIndex) => {
    const resultLabel = `${label}.result[${resultIndex}]`;
    exactKeys(field, ["name", "type", "value"], [], resultLabel);
    nonempty(field.name, `${resultLabel}.name`);
    validateType(field.type, `${resultLabel}.type`);
    validateExpression(field.value, `${resultLabel}.value`);
  });
  uniqueNames(command.result, `${label}.result`);
  validateReceipt(command.receipt, `${label}.receipt`);
  const receiptResults = new Set(command.receipt.resultFields.map(field => field.name));
  for (const result of command.result) {
    if (!receiptResults.has(result.name)) {
      fail("command/invalid-plan", `${label}.result '${result.name}' has no receipt field`);
    }
  }
  return command;
}

function compileCommands(plan) {
  if (!plainObject(plan) || plan.schemaVersion !== 2 || plan.backend !== "fram"
      || typeof plan.applicationId !== "string" || plan.applicationId.length === 0
      || typeof plan.semanticFingerprint !== "string" || plan.semanticFingerprint.length === 0
      || !Array.isArray(plan.commands)) {
    fail("command/invalid-plan", "expected a Wake FRAM plan with checked commands");
  }
  const commands = plan.commands.map(validateCommand);
  uniqueNames(commands, "commands");
  return Object.freeze({
    applicationId: plan.applicationId,
    byName: new Map(commands.map(command => [command.name, command])),
    semanticFingerprint: plan.semanticFingerprint,
  });
}

function normalizedInput(command, value) {
  if (!plainObject(value)) fail("command/invalid-input", "command input must be an object");
  const allowed = new Set(command.input.map(field => field.name));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("command/invalid-input", `command input.${key} is unknown`);
  }
  const result = {};
  for (const field of command.input) {
    if (!own(value, field.name)) {
      if (field.required === true) fail("command/invalid-input", `command input.${field.name} is required`);
      continue;
    }
    defineData(
      result,
      field.name,
      normalizeValue(
        value[field.name],
        field.type,
        `command input.${field.name}`,
        "command/invalid-input",
      ),
    );
  }
  return result;
}

function evaluate(expression, environment, depth = 0) {
  if (depth > MAX_EXPRESSION_DEPTH) fail("command/invalid-plan", "expression depth exceeded");
  switch (expression.kind) {
    case "literal":
      return cloneJson(expression.value);
    case "input":
      if (!own(environment.input, expression.name)) {
        fail("command/missing-value", `input '${expression.name}' is absent`);
      }
      return environment.input[expression.name];
    case "injected":
      if (!own(environment.injected, expression.name)) {
        fail("command/missing-value", `injected value '${expression.name}' is absent`);
      }
      return environment.injected[expression.name];
    case "actor":
      if (!own(environment.actor, expression.name)) {
        fail("command/missing-value", `actor field '${expression.name}' is absent`);
      }
      return environment.actor[expression.name];
    case "receipt-time":
      return environment.receiptTime;
    case "artifact-digest":
      return environment.semanticFingerprint;
    case "list":
      return expression.items.map(item => evaluate(item, environment, depth + 1));
    case "record": {
      const result = {};
      for (const field of expression.fields) {
        defineData(result, field.name, evaluate(field.value, environment, depth + 1));
      }
      return result;
    }
    case "get": {
      const value = evaluate(expression.value, environment, depth + 1);
      if (!plainObject(value) || !own(value, expression.field)) {
        fail("command/missing-value", `expression field '${expression.field}' is absent`);
      }
      return value[expression.field];
    }
    case "if-null":
      return evaluate(expression.value, environment, depth + 1) === null
        ? evaluate(expression.then, environment, depth + 1)
        : evaluate(expression.else, environment, depth + 1);
    default:
      fail("command/invalid-plan", `unsupported expression '${expression.kind}'`);
  }
}

function stepEnabled(step, environment) {
  if (!own(step, "when")) return true;
  const value = evaluate(step.when.value, environment);
  return step.when.kind === "null" ? value === null : value !== null;
}

function checkedIdentity(storage, entity, value, label) {
  const identity = storage.identity(entity, value, label);
  if (!plainObject(identity) || !own(identity, "subject")
      || !own(identity, "predicate") || !own(identity, "value")) {
    fail("command/invalid-storage", `${label} identity codec returned an invalid result`);
  }
  return identity;
}

function checkedField(storage, entity, fieldName, value, label) {
  const field = storage.field(entity, fieldName, value, label);
  if (!plainObject(field) || !own(field, "predicate") || !own(field, "value")
      || !["single", "multi"].includes(field.cardinality)) {
    fail("command/invalid-storage", `${label} field codec returned an invalid result`);
  }
  if (own(field, "requireUnique") && !Array.isArray(field.requireUnique)) {
    fail("command/invalid-storage", `${label} field codec requireUnique must be an array`);
  }
  return field;
}

function addRequirement(requirements, requirement) {
  const key = canonicalDocument(requirement);
  if (!requirements.has(key)) requirements.set(key, requirement);
}

function encodedValues(storage, entity, fieldName, raw, label) {
  if (raw === null) return { cardinality: "single", predicate: null, requirements: [], values: [] };
  const rawValues = Array.isArray(raw) ? raw : [raw];
  const encoded = rawValues.map((value, index) => (
    checkedField(storage, entity, fieldName, value, `${label}[${index}]`)
  ));
  if (encoded.length === 0) {
    const field = storage.field(entity, fieldName, undefined, label);
    if (!plainObject(field) || !own(field, "predicate") || field.cardinality !== "multi") {
      fail("command/invalid-storage", `${label} empty multi field codec returned an invalid result`);
    }
    return { cardinality: "multi", predicate: field.predicate, requirements: [], values: [] };
  }
  const cardinality = encoded[0].cardinality;
  const predicate = encoded[0].predicate;
  if (encoded.some(field => field.cardinality !== cardinality
      || canonicalDocument(field.predicate) !== canonicalDocument(predicate))) {
    fail("command/invalid-storage", `${label} field codec is inconsistent`);
  }
  if (cardinality === "single" && encoded.length !== 1) {
    fail("command/cardinality", `${label} accepts one value`);
  }
  return {
    cardinality,
    predicate,
    requirements: encoded.flatMap(field => field.requireUnique ?? []),
    values: encoded.map(field => field.value),
  };
}

function compileTransaction(command, environment, storage, receiptId, result, authorityGuards) {
  const creates = [];
  const updates = [];
  const requirements = new Map();
  const updateCells = new Map();

  for (const [stepIndex, step] of [...authorityGuards, ...command.steps].entries()) {
    if (!stepEnabled(step, environment)) continue;
    const label = `${command.name}.steps[${stepIndex}]`;
    if (step.op === "assert") {
      const left = evaluate(step.left, environment);
      const right = evaluate(step.right, environment);
      if (canonicalDocument(left) !== canonicalDocument(right)) {
        fail("command/assertion-failed", `${label} equality assertion failed`);
      }
      continue;
    }
    if (step.op === "assert-not-contains") {
      const list = evaluate(step.list, environment);
      const value = evaluate(step.value, environment);
      if (!Array.isArray(list)) {
        fail("command/type-mismatch", `${label} assertion requires a bounded list`);
      }
      const expected = canonicalDocument(value);
      if (list.some(item => canonicalDocument(item) === expected)) {
        fail("command/assertion-failed", `${label} list contains a forbidden value`);
      }
      continue;
    }
    if (step.op === "require-each") {
      const identities = evaluate(step.identities, environment);
      if (!Array.isArray(identities)) {
        fail("command/type-mismatch", `${label}.identities must be a bounded list`);
      }
      for (const [identityIndex, value] of identities.entries()) {
        const identity = checkedIdentity(
          storage,
          step.entity,
          value,
          `${label}.identities[${identityIndex}]`,
        );
        addRequirement(requirements, {
          subject: identity.subject,
          predicate: identity.predicate,
          value: identity.value,
        });
      }
      continue;
    }
    const identity = checkedIdentity(
      storage,
      step.entity,
      evaluate(step.identity, environment),
      `${label}.identity`,
    );
    if (step.op === "require") {
      addRequirement(requirements, {
        subject: identity.subject,
        predicate: identity.predicate,
        value: identity.value,
      });
      continue;
    }
    if (step.op === "create") {
      const fields = [];
      for (const [fieldIndex, source] of step.fields.entries()) {
        const fieldLabel = `${label}.fields[${fieldIndex}]`;
        const raw = evaluate(source.value, environment);
        if (raw === null) {
          if (source.omitIfNull === true) continue;
          fail("command/null-field", `${fieldLabel} evaluated to null without omitIfNull`);
        }
        const values = Array.isArray(raw) ? raw : [raw];
        if (values.length === 0) {
          const empty = encodedValues(storage, step.entity, source.field, raw, fieldLabel);
          if (empty.cardinality !== "multi") fail("command/cardinality", `${fieldLabel} cannot be empty`);
          continue;
        }
        for (const [valueIndex, value] of values.entries()) {
          const field = checkedField(storage, step.entity, source.field, value, `${fieldLabel}[${valueIndex}]`);
          fields.push({ predicate: field.predicate, value: field.value, cardinality: field.cardinality });
          for (const requirement of field.requireUnique ?? []) addRequirement(requirements, requirement);
        }
      }
      creates.push({
        subject: identity.subject,
        identity: { predicate: identity.predicate, value: identity.value },
        fields,
      });
      continue;
    }

    const fields = [];
    const sources = step.op === "guard"
      ? [{ field: step.field, value: step.equals, allowedCurrent: step.equals }]
      : step.fields;
    for (const [fieldIndex, source] of sources.entries()) {
      const fieldLabel = `${label}.fields[${fieldIndex}]`;
      const desiredRaw = evaluate(source.value, environment);
      const desired = encodedValues(storage, step.entity, source.field, desiredRaw, `${fieldLabel}.value`);
      let allowedCurrent;
      if (own(source, "allowedCurrent")) {
        const allowedRaw = evaluate(source.allowedCurrent, environment);
        const allowed = encodedValues(storage, step.entity, source.field, allowedRaw, `${fieldLabel}.allowedCurrent`);
        if (desired.predicate === null) desired.predicate = allowed.predicate;
        if (allowed.predicate !== null && canonicalDocument(desired.predicate) !== canonicalDocument(allowed.predicate)) {
          fail("command/invalid-storage", `${fieldLabel} codecs disagree on predicate`);
        }
        allowedCurrent = allowed.values;
        for (const requirement of allowed.requirements) addRequirement(requirements, requirement);
      }
      if (desired.predicate === null) {
        const empty = storage.field(step.entity, source.field, undefined, fieldLabel);
        if (!plainObject(empty) || empty.cardinality !== "single" || !own(empty, "predicate")) {
          fail("command/invalid-storage", `${fieldLabel} clear codec returned an invalid result`);
        }
        desired.predicate = empty.predicate;
        desired.cardinality = "single";
      }
      if (desired.cardinality === "single" && allowedCurrent === undefined) {
        fail("command/unguarded-update", `${fieldLabel} single-cardinality update needs allowedCurrent`);
      }
      const cell = canonicalDocument([identity.subject, desired.predicate]);
      const field = {
        predicate: desired.predicate,
        values: desired.values,
        cardinality: desired.cardinality,
      };
      if (allowedCurrent !== undefined) field.allowedCurrent = allowedCurrent;
      const prior = updateCells.get(cell);
      if (prior !== undefined) {
        if (prior.op !== "guard" || step.op !== "update"
            || canonicalDocument(prior.field.allowedCurrent)
              !== canonicalDocument(field.allowedCurrent)) {
          fail("command/duplicate-update", `${fieldLabel} targets a repeated field cell`);
        }
        prior.field.values = field.values;
        for (const requirement of desired.requirements) addRequirement(requirements, requirement);
        continue;
      }
      fields.push(field);
      updateCells.set(cell, { field, op: step.op });
      for (const requirement of desired.requirements) addRequirement(requirements, requirement);
    }
    if (fields.length > 0) {
      updates.push({
        identity: { predicate: identity.predicate, value: identity.value },
        fields,
      });
    }
  }

  const receipt = command.receipt;
  const receiptIdentity = checkedIdentity(storage, receipt.entity, receiptId, `${command.name}.receipt.identity`);
  const receiptValues = [
    [receipt.actorField, environment.actor.id],
    [receipt.commandField, command.name],
    [receipt.inputDigestField, environment.inputDigest],
    [receipt.createdAtField, environment.receiptTime],
    ...receipt.resultFields.map(field => [field.field, result[field.name]]),
  ];
  const receiptFields = [];
  for (const [fieldName, value] of receiptValues) {
    if (value === null || value === undefined) continue;
    const field = checkedField(storage, receipt.entity, fieldName, value, `${command.name}.receipt.${fieldName}`);
    receiptFields.push({ predicate: field.predicate, value: field.value, cardinality: field.cardinality });
    for (const requirement of field.requireUnique ?? []) addRequirement(requirements, requirement);
  }
  creates.push({
    subject: receiptIdentity.subject,
    identity: { predicate: receiptIdentity.predicate, value: receiptIdentity.value },
    fields: receiptFields,
  });

  return {
    creates,
    updates,
    requireUnique: [...requirements.values()],
  };
}

function recoveredReceipt(command, receiptId, inputDigest, actor, receiptValue) {
  const wrapper = plainObject(receiptValue) && own(receiptValue, "row") ? receiptValue : { row: receiptValue };
  const row = wrapper.row;
  if (row === null || row === undefined) return null;
  if (!plainObject(row)) fail("command/receipt-corrupt", "stored command receipt must be an object");
  const receipt = command.receipt;
  if (row[receipt.actorField] !== actor.id || row[receipt.commandField] !== command.name) {
    fail("command/receipt-corrupt", "stored command receipt identity does not match its command");
  }
  if (row[receipt.inputDigestField] !== inputDigest) {
    fail("command/idempotency-conflict", "request ID was already used with different command input", {
      command: command.name,
      receiptId,
    });
  }
  const result = {};
  for (const field of receipt.resultFields) {
    if (!own(row, field.field)) {
      if (field.type.kind === "nullable") {
        defineData(result, field.name, null);
        continue;
      }
      fail(
        "command/receipt-corrupt",
        `receipt.${field.field} is missing required command result '${field.name}'`,
      );
    }
    defineData(
      result,
      field.name,
      normalizeValue(
        row[field.field],
        field.type,
        `receipt.${field.field}`,
        "command/receipt-corrupt",
      ),
    );
  }
  const createdAt = normalizeValue(
    row[receipt.createdAtField],
    { kind: "instant" },
    `receipt.${receipt.createdAtField}`,
    "command/receipt-corrupt",
  );
  return Object.freeze({
    command: command.name,
    createdAt,
    inputDigest,
    receiptId,
    replayed: true,
    result: Object.freeze(result),
    ...(own(wrapper, "servedVersion") ? { servedVersion: wrapper.servedVersion } : {}),
  });
}

function checkedActor(value) {
  if (!plainObject(value) || typeof value.id !== "string" || value.id.length === 0
      || !Array.isArray(value.capabilities)
      || value.capabilities.some(capability => typeof capability !== "string" || capability.length === 0)) {
    fail("command/invalid-authority", "invoke requires a host-derived actor and capabilities");
  }
  return Object.freeze({
    capabilities: Object.freeze([...value.capabilities]),
    id: value.id,
  });
}

export function createCommandRuntime(plan, {
  generateId,
  now,
  providers = {},
  readReceipt,
  schema,
  serverValues = {},
  storage,
} = {}) {
  const compiled = compileCommands(plan);
  if (!schema || typeof schema.transactUnique !== "function") {
    fail("command/invalid-client", "schema.transactUnique is required");
  }
  if (!storage || typeof storage.identity !== "function" || typeof storage.field !== "function") {
    fail("command/invalid-storage", "storage identity and field codecs are required");
  }
  if (typeof readReceipt !== "function" || typeof now !== "function" || typeof generateId !== "function") {
    fail("command/invalid-host", "readReceipt, now, and generateId host functions are required");
  }
  if (!plainObject(providers)) fail("command/invalid-host", "providers must be an object");
  if (!plainObject(serverValues)) {
    fail("command/invalid-host", "serverValues must be an object");
  }
  const serverValueTypes = new Map();
  for (const command of plan.commands) {
    for (const injection of command.injections ?? []) {
      if (injection.kind !== "server-value") continue;
      const prior = serverValueTypes.get(injection.storageId);
      if (prior !== undefined && canonicalDocument(prior) !== canonicalDocument(injection.type)) {
        fail("command/invalid-plan", `server value '${injection.storageId}' has conflicting types`);
      }
      serverValueTypes.set(injection.storageId, injection.type);
    }
  }
  const suppliedServerKeys = Reflect.ownKeys(serverValues);
  if (suppliedServerKeys.some(key => typeof key !== "string")
      || suppliedServerKeys.length !== serverValueTypes.size
      || suppliedServerKeys.some(key => !serverValueTypes.has(key))) {
    fail("command/invalid-host", "serverValues must exactly match checked server-value storage IDs");
  }
  const checkedServerValues = {};
  for (const [storageId, type] of serverValueTypes) {
    const descriptor = Object.getOwnPropertyDescriptor(serverValues, storageId);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail("command/invalid-host", `serverValues.${storageId} must be an enumerable data property`);
    }
    defineData(
      checkedServerValues,
      storageId,
      deepFreeze(normalizeValue(
        descriptor.value,
        type,
        `serverValues.${storageId}`,
        "command/invalid-host",
      )),
    );
  }
  deepFreeze(checkedServerValues);

  async function invoke(commandName, requestId, input, authority) {
    nonempty(commandName, "command", "command/invalid-input");
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
      fail("command/invalid-input", "requestId must be 1-200 portable identifier characters");
    }
    const command = compiled.byName.get(commandName);
    if (!command) fail("command/unknown", `unknown command '${commandName}'`);
    const actor = checkedActor(authority);
    const granted = new Set(actor.capabilities);
    const grantedChoices = command.capabilities.filter(choice => granted.has(choice.capability));
    const authorityChoice = grantedChoices.find(choice => (choice.guards ?? []).length === 0)
      ?? grantedChoices[0];
    if (authorityChoice === undefined) {
      fail(
        "command/forbidden",
        `command '${commandName}' requires one of: ${command.capabilities.map(choice => choice.capability).join(", ")}`,
      );
    }

    const normalized = deepFreeze(normalizedInput(command, input));
    const inputDigest = sha256Digest(canonicalDocument({
      actor: actor.id,
      applicationId: compiled.applicationId,
      command: command.name,
      input: normalized,
      normalizerVersion: command.normalizerVersion,
    }));
    const receiptId = sha256Digest(canonicalDocument({
      actor: actor.id,
      applicationId: compiled.applicationId,
      command: command.name,
      requestId,
    }));

    const prior = recoveredReceipt(
      command,
      receiptId,
      inputDigest,
      actor,
      await readReceipt(command.receipt.entity, receiptId),
    );
    if (prior !== null) return prior;

    const receiptTime = deepFreeze(normalizeValue(
      await now(),
      { kind: "instant" },
      "host receipt time",
      "command/provider-output",
    ));
    const environment = {
      actor,
      injected: {},
      input: normalized,
      inputDigest,
      receiptTime,
      semanticFingerprint: compiled.semanticFingerprint,
    };
    for (const injection of command.injections) {
      let value;
      if (injection.kind === "generated-id") {
        value = await generateId(Object.freeze({
          actor: actor.id,
          command: command.name,
          name: injection.name,
          requestId,
        }));
      } else if (injection.kind === "canonical-digest") {
        value = sha256Digest(canonicalDocument(evaluate(injection.input, environment)));
      } else if (injection.kind === "server-value") {
        value = checkedServerValues[injection.storageId];
      } else {
        const provider = providers[injection.provider];
        if (typeof provider !== "function") {
          fail("command/missing-provider", `provider '${injection.provider}' is not bound`);
        }
        try {
          value = await provider(
            frozenSnapshot(evaluate(injection.input, environment)),
            Object.freeze({ actor, command: command.name }),
          );
        } catch (error) {
          if (error instanceof CommandError && error.code === "command/provider-rejected") {
            throw error;
          }
          fail(
            "command/provider-failed",
            `provider '${injection.provider}' failed`,
            { provider: injection.provider },
            { cause: error },
          );
        }
      }
      defineData(
        environment.injected,
        injection.name,
        deepFreeze(normalizeValue(
          value,
          injection.type,
          `injection '${injection.name}'`,
          "command/provider-output",
        )),
      );
    }

    const result = {};
    for (const field of command.result) {
      defineData(
        result,
        field.name,
        normalizeValue(
          evaluate(field.value, environment),
          field.type,
          `result '${field.name}'`,
          "command/result-invalid",
        ),
      );
    }
    const transaction = compileTransaction(
      command,
      environment,
      storage,
      receiptId,
      result,
      authorityChoice.guards ?? [],
    );
    try {
      const committed = await schema.transactUnique(transaction);
      if (!plainObject(committed) || typeof committed.servedVersion !== "bigint") {
        fail("command/protocol", "schema.transactUnique returned an invalid result");
      }
      return Object.freeze({
        command: command.name,
        createdAt: receiptTime,
        inputDigest,
        receiptId,
        replayed: false,
        result: Object.freeze(result),
        servedVersion: committed.servedVersion,
      });
    } catch (error) {
      let recovered;
      try {
        recovered = recoveredReceipt(
          command,
          receiptId,
          inputDigest,
          actor,
          await readReceipt(command.receipt.entity, receiptId),
        );
      } catch (recoveryError) {
        if (recoveryError instanceof CommandError) throw recoveryError;
        fail(
          "command/ambiguous-outcome",
          "command outcome could not be recovered after submission failed",
          { command: command.name, receiptId },
          { cause: recoveryError },
        );
      }
      if (recovered !== null) return recovered;
      throw error;
    }
  }

  return Object.freeze({ invoke });
}
