function fail(message) {
  throw new TypeError(`wake: ${message}`);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.hasOwn(value, key);
}

function typeKey(type) {
  return JSON.stringify(type);
}

function sameType(left, right) {
  if (left?.kind === "string" && right?.kind === "string") return true;
  if (left?.kind === "list" && right?.kind === "list") {
    return sameType(left.items, right.items);
  }
  return typeKey(left) === typeKey(right);
}

function nullable(type) {
  return type?.kind === "nullable";
}

function withoutNull(type) {
  return nullable(type) ? type.value : type;
}

function storageType(type, stateNames) {
  switch (type) {
    case "String": return { kind: "string" };
    case "Digest": return { kind: "digest" };
    case "Int":
    case "Integer": return { kind: "integer" };
    case "Float":
    case "Double":
    case "Number": return { kind: "number" };
    case "Bool":
    case "Boolean": return { kind: "boolean" };
    case "Instant": return { kind: "instant" };
    case "Keyword": return { kind: "keyword" };
    default:
      if (stateNames.has(type)) return { kind: "keyword" };
      fail(`command field has unsupported storage type '${type}'`);
  }
}

function entityIndexes(checked) {
  const entities = new Map();
  for (const entity of checked.entities ?? []) {
    entities.set(entity.name, {
      ...entity,
      fieldsByName: new Map(entity.fields.map(field => [field.name, field])),
    });
  }
  return entities;
}

function commandEntity(entities, name, label) {
  const entity = entities.get(name);
  if (entity === undefined) fail(`${label} names unknown entity '${name}'`);
  if (entity.identity_field == null) fail(`${label} entity '${name}' has no identity`);
  return entity;
}

function commandField(entity, name, label) {
  const field = entity.fieldsByName.get(name);
  if (field === undefined) fail(`${label} names unknown field '${entity.name}.${name}'`);
  if (field.derived) fail(`${label} cannot use derived field '${entity.name}.${name}'`);
  return field;
}

function fieldValueType(field, entities, stateNames) {
  if (field.value_kind !== "ref") return storageType(field.type, stateNames);
  const target = commandEntity(entities, field.target_entity, `Ref field '${field.name}'`);
  return storageType(target.identity_field.type, stateNames);
}

function expectType(actual, expected, label, { allowNull = false } = {}) {
  if (allowNull && nullable(actual) && sameType(withoutNull(actual), expected)) return;
  if (actual?.kind === "digest" && expected?.kind === "string") return;
  if (!sameType(actual, expected)) {
    fail(`${label} has incompatible type '${actual?.kind ?? "unknown"}', expected '${expected.kind}'`);
  }
}

function expressionType(expression, environment, label) {
  if (!plainObject(expression) || typeof expression.kind !== "string") {
    fail(`${label} is not a checked expression`);
  }
  switch (expression.kind) {
    case "input": {
      const type = environment.inputs.get(expression.name);
      if (type === undefined) fail(`${label} names unknown input '${expression.name}'`);
      return type;
    }
    case "injected": {
      const type = environment.injected.get(expression.name);
      if (type === undefined) fail(`${label} names unavailable injected value '${expression.name}'`);
      return type;
    }
    case "actor":
      if (expression.name !== "id") fail(`${label} may use only the host-derived actor id`);
      return { kind: "string" };
    case "receipt-time": return { kind: "instant" };
    case "artifact-digest": return { kind: "digest" };
    case "literal":
      if (expression.value === null) return { kind: "nullable", value: { kind: "string" } };
      if (expression.type === "keyword") return { kind: "keyword" };
      if (typeof expression.value === "string") return { kind: "string" };
      if (typeof expression.value === "boolean") return { kind: "boolean" };
      if (typeof expression.value === "number") {
        return Number.isSafeInteger(expression.value) ? { kind: "integer" } : { kind: "number" };
      }
      fail(`${label} has a non-scalar literal`);
      break;
    case "list": {
      if (expression.items.length === 0) {
        fail(`${label} cannot infer the type of an empty expression list`);
      }
      const first = expressionType(expression.items[0], environment, `${label}[0]`);
      for (let index = 1; index < expression.items.length; index += 1) {
        expectType(
          expressionType(expression.items[index], environment, `${label}[${index}]`),
          first,
          `${label}[${index}]`,
        );
      }
      return { kind: "list", items: first, maxItems: expression.items.length };
    }
    case "record": {
      const fields = expression.fields.map(field => ({
        name: field.name,
        required: true,
        type: expressionType(field.value, environment, `${label}.${field.name}`),
      }));
      return { kind: "record", fields };
    }
    case "get": {
      const source = expressionType(expression.value, environment, `${label}.value`);
      if (source.kind !== "record") fail(`${label}.value must be a record`);
      const field = source.fields.find(candidate => candidate.name === expression.field);
      if (field === undefined) fail(`${label} names unknown record field '${expression.field}'`);
      return field.type;
    }
    case "if-null": {
      const tested = expressionType(expression.value, environment, `${label}.value`);
      if (!nullable(tested)) fail(`${label}.value must be nullable`);
      const thenType = expressionType(expression.then, environment, `${label}.then`);
      const elseType = expressionType(expression.else, environment, `${label}.else`);
      expectType(thenType, elseType, `${label} branches`);
      return thenType;
    }
    default:
      fail(`${label} uses unknown expression '${expression.kind}'`);
  }
}

function checkCondition(condition, environment, label) {
  const type = expressionType(condition.value, environment, `${label}.value`);
  if (!nullable(type)) fail(`${label} must inspect a nullable expression`);
}

function stateName(value) {
  return typeof value === "string" && value.startsWith(":") ? value.slice(1) : value;
}

function checkStateUpdate(field, machine, source, environment, label) {
  if (machine === undefined) return;
  if (source.value.kind !== "literal" || source.value.type !== "keyword") {
    fail(`${label} state value must be a literal keyword`);
  }
  if (!own(source, "allowedCurrent")) {
    const initial = stateName(machine.initial);
    if (stateName(source.value.value) !== initial) {
      fail(`${label} initial state must be '${initial}'`);
    }
    expressionType(source.value, environment, `${label}.value`);
    return;
  }
  if (source.allowedCurrent?.kind !== "literal"
      || source.allowedCurrent.type !== "keyword") {
    fail(`${label} state transition must use literal keyword current and target states`);
  }
  const target = stateName(source.value.value);
  const current = stateName(source.allowedCurrent.value);
  const sourceState = Object.keys(machine.transitions)
    .find(candidate => stateName(candidate) === current);
  const allowed = (sourceState === undefined ? [] : machine.transitions[sourceState]).map(stateName);
  if (current !== target && !allowed.includes(target)) {
    fail(`${label} transition '${current}' -> '${target}' is not declared`);
  }
  expressionType(source.value, environment, `${label}.value`);
}

function checkFieldExpression({
  entity,
  field,
  expression,
  environment,
  entities,
  stateNames,
  label,
  allowNull,
}) {
  if (allowNull && expression?.kind === "literal" && expression.value === null) return;
  const actual = expressionType(expression, environment, label);
  const expected = fieldValueType(field, entities, stateNames);
  if (field.cardinality === "multi") {
    if (actual.kind !== "list") fail(`${label} must be a bounded list`);
    expectType(actual.items, expected, `${label} item`);
  } else {
    expectType(actual, expected, label, { allowNull });
  }
}

function checkReceipt(command, entities, stateNames, environment) {
  const label = `command '${command.name}' receipt`;
  const receipt = command.receipt;
  const entity = commandEntity(entities, receipt.entity, label);
  if (entity.identity_field.name !== receipt.identityField) {
    fail(`${label} identity field must be '${entity.identity_field.name}'`);
  }
  const expectedBase = [
    [receipt.actorField, { kind: "string" }],
    [receipt.commandField, { kind: "string" }],
    [receipt.inputDigestField, { kind: "digest" }],
    [receipt.createdAtField, { kind: "instant" }],
  ];
  for (const [name, expected] of expectedBase) {
    const field = commandField(entity, name, label);
    if (field.cardinality !== "single") fail(`${label} field '${name}' must be single-cardinality`);
    expectType(fieldValueType(field, entities, stateNames), expected, `${label} field '${name}'`);
  }
  const results = new Map(command.result.map(result => [result.name, result]));
  for (const receiptField of receipt.resultFields) {
    const result = results.get(receiptField.name);
    if (result === undefined) fail(`${label} stores unknown result '${receiptField.name}'`);
    expectType(receiptField.type, result.type, `${label} result '${receiptField.name}'`);
    const field = commandField(entity, receiptField.field, label);
    expectType(
      receiptField.type,
      fieldValueType(field, entities, stateNames),
      `${label} field '${receiptField.field}'`,
    );
  }
  if (receipt.resultFields.length !== command.result.length) {
    fail(`${label} must store every command result exactly once`);
  }
}

function checkCommand(command, checked, indexes) {
  const label = `command '${command.name}'`;
  const environment = { inputs: new Map(), injected: new Map() };
  for (const input of command.input) environment.inputs.set(input.name, input.type);

  for (const injection of command.injections) {
    if (injection.kind === "provider") {
      if (!indexes.providers.has(injection.provider)) {
        fail(`${label} names unbound provider '${injection.provider}'`);
      }
      expressionType(injection.input, environment, `${label} provider '${injection.name}' input`);
    } else if (injection.kind === "canonical-digest") {
      expressionType(
        injection.input,
        environment,
        `${label} canonical digest '${injection.name}' input`,
      );
      expectType(injection.type, { kind: "digest" }, `${label} canonical digest '${injection.name}'`);
    }
    environment.injected.set(injection.name, injection.type);
  }

  const stateByField = new Map((checked.state_machines ?? []).map(machine => [
    `${machine.entity}\u0000${machine.field}`,
    machine,
  ]));
  const guardedSteps = command.steps;
  for (const [stepIndex, step] of guardedSteps.entries()) {
    const stepLabel = `${label} step ${stepIndex + 1} '${step.op}'`;
    if (step.op === "assert") {
      const left = expressionType(step.left, environment, `${stepLabel} left`);
      const right = expressionType(step.right, environment, `${stepLabel} right`);
      expectType(left, right, stepLabel);
      continue;
    }
    if (step.op === "assert-not-contains") {
      const list = expressionType(step.list, environment, `${stepLabel} list`);
      if (list.kind !== "list") fail(`${stepLabel} requires a bounded list`);
      expectType(
        expressionType(step.value, environment, `${stepLabel} value`),
        list.items,
        `${stepLabel} value`,
      );
      continue;
    }
    const entity = commandEntity(indexes.entities, step.entity, stepLabel);
    if (step.op === "require-each") {
      const identities = expressionType(step.identities, environment, `${stepLabel} identities`);
      if (identities.kind !== "list") fail(`${stepLabel} identities must be a bounded list`);
      expectType(
        identities.items,
        storageType(entity.identity_field.type, indexes.stateNames),
        `${stepLabel} identity`,
      );
      if (step.when !== undefined) checkCondition(step.when, environment, `${stepLabel} condition`);
      continue;
    }
    expectType(
      expressionType(step.identity, environment, `${stepLabel} identity`),
      storageType(entity.identity_field.type, indexes.stateNames),
      `${stepLabel} identity`,
      { allowNull: own(step, "when") },
    );
    if (step.when !== undefined) checkCondition(step.when, environment, `${stepLabel} condition`);
    if (step.op === "require") continue;
    if (step.op === "guard") {
      const field = commandField(entity, step.field, stepLabel);
      checkFieldExpression({
        allowNull: true,
        entities: indexes.entities,
        entity,
        environment,
        expression: step.equals,
        field,
        label: `${stepLabel} expected value`,
        stateNames: indexes.stateNames,
      });
      continue;
    }
    for (const source of step.fields) {
      const field = commandField(entity, source.field, stepLabel);
      if (field.identity) fail(`${stepLabel} cannot write immutable identity '${field.name}'`);
      if (step.op === "update" && field.write_policy !== "command") {
        fail(`${stepLabel} can update only command-only fields`);
      }
      if (step.op === "update" && field.cardinality === "single"
          && !own(source, "allowedCurrent")) {
        fail(`${stepLabel} single field '${field.name}' requires :allowed-current`);
      }
      checkFieldExpression({
        allowNull: step.op === "update" || source.omitIfNull === true,
        entities: indexes.entities,
        entity,
        environment,
        expression: source.value,
        field,
        label: `${stepLabel} field '${field.name}'`,
        stateNames: indexes.stateNames,
      });
      if (own(source, "allowedCurrent")) {
        checkFieldExpression({
          allowNull: true,
          entities: indexes.entities,
          entity,
          environment,
          expression: source.allowedCurrent,
          field,
          label: `${stepLabel} allowed current '${field.name}'`,
          stateNames: indexes.stateNames,
        });
      }
      checkStateUpdate(
        field,
        stateByField.get(`${entity.name}\u0000${field.name}`),
        source,
        environment,
        `${stepLabel} field '${field.name}'`,
      );
    }
  }

  for (const choice of command.capabilities) {
    for (const [guardIndex, guard] of (choice.guards ?? []).entries()) {
      const guardLabel = `${label} capability '${choice.capability}' guard ${guardIndex + 1}`;
      const entity = commandEntity(indexes.entities, guard.entity, guardLabel);
      expectType(
        expressionType(guard.identity, environment, `${guardLabel} identity`),
        storageType(entity.identity_field.type, indexes.stateNames),
        `${guardLabel} identity`,
        { allowNull: own(guard, "when") },
      );
      if (guard.when !== undefined) checkCondition(guard.when, environment, `${guardLabel} condition`);
      if (guard.op === "require") continue;
      const field = commandField(entity, guard.field, guardLabel);
      checkFieldExpression({
        allowNull: true,
        entities: indexes.entities,
        entity,
        environment,
        expression: guard.equals,
        field,
        label: `${guardLabel} expected value`,
        stateNames: indexes.stateNames,
      });
    }
  }

  for (const result of command.result) {
    expectType(
      expressionType(result.value, environment, `${label} result '${result.name}'`),
      result.type,
      `${label} result '${result.name}'`,
    );
  }
  checkReceipt(command, indexes.entities, indexes.stateNames, environment);
  return structuredClone(command);
}

export function checkCommandGraph(commands, checked, {
  exportedCapabilities = null,
} = {}) {
  if (!Array.isArray(commands)) fail("commands must be an array");
  if (commands.length > 0 && checked.backend?.kind !== "fram") {
    fail("named commands require (backend :fram)");
  }
  const names = new Set();
  const capabilities = exportedCapabilities === null
    ? null
    : new Set(exportedCapabilities);
  const indexes = {
    entities: entityIndexes(checked),
    providers: new Set((checked.providers ?? []).map(provider => provider.name)),
    stateNames: new Set((checked.defstates ?? []).map(state => state.name)),
  };
  for (const machine of checked.state_machines ?? []) indexes.stateNames.add(machine.state_type);

  return commands.map(command => {
    if (!plainObject(command) || typeof command.name !== "string" || command.name.length === 0) {
      fail("command must have a name");
    }
    if (names.has(command.name)) fail(`command '${command.name}' is duplicated`);
    names.add(command.name);
    for (const step of [
      ...(command.steps ?? []),
      ...(command.capabilities ?? []).flatMap(choice => choice.guards ?? []),
    ]) {
      if (step.entity === "wake.core/command-receipt") {
        fail(`command '${command.name}' cannot target Wake's reserved receipt entity`);
      }
    }
    if (capabilities !== null) {
      for (const choice of command.capabilities) {
        if (!capabilities.has(choice.capability)) {
          fail(`command '${command.name}' names undeclared capability '${choice.capability}'`);
        }
      }
    }
    return checkCommand(command, checked, indexes);
  });
}
