function fail(message) {
  throw new TypeError(`wake checked Beagle: ${message}`);
}

const CHECKED_PROGRAM_KIND = "beagle.checked-program";
const CHECKED_PROGRAM_SCHEMA_VERSION = 1;
const WAKE_PROVIDER_NAMESPACE = "wake.core";
const CHECKED_PROGRAM_KEYS = new Set([
  "externs", "forms", "gen-class", "kind", "mode", "namespace", "phase",
  "requires", "schemaVersion", "sourceId", "target",
]);
const HTML_TAGS = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "button", "input", "form", "label", "textarea", "select", "option",
  "ul", "ol", "li", "a", "img", "section", "header", "footer", "nav",
  "main", "table", "tr", "td", "th", "thead", "tbody",
]);

function basename(path) {
  const end = path.lastIndexOf("/");
  return path.slice(end + 1);
}

function callName(node, label) {
  if (node?.node !== "call" || node.fn?.node !== "ref") {
    fail(`${label} must be a checked Wake constructor call`);
  }
  if (!Array.isArray(node.args)) fail(`${label} call is missing checked arguments`);
  return node.fn.name;
}

function wakeName(name, alias, label) {
  const slash = name.indexOf("/");
  if (slash === -1 || name.slice(0, slash) !== alias) {
    fail(`${label} must use a checked wake/* binding, got '${name}'`);
  }
  return name.slice(slash + 1);
}

function isInferredType(type, name) {
  return type?.kind === "prim" && type.name === name;
}

function callArguments(node, alias, expected, resultType, label) {
  const actual = wakeName(callName(node, label), alias, label);
  if (actual !== expected) {
    fail(`${label} must call wake/${expected}, not '${actual}'`);
  }
  if (!isInferredType(node.inferredType, resultType)) {
    fail(
      `${label} must infer exact ${resultType}, got '${node.inferredType?.name ?? "missing"}'`,
    );
  }
  return node.args;
}

function literal(node, kind, label) {
  if (node?.node !== "literal" || node.kind !== kind) {
    fail(`${label} must be a ${kind} literal`);
  }
  if (kind === "nil") return null;
  const expected = new Map([
    ["bool", "boolean"],
    ["keyword", "string"],
    ["number", "number"],
    ["string", "string"],
  ]).get(kind);
  if (expected !== undefined && typeof node.value !== expected) {
    fail(`${label} has an invalid ${kind} literal payload`);
  }
  return node.value;
}

function stringLiteral(node, label) {
  return literal(node, "string", label);
}

function keywordLiteral(node, label) {
  return literal(node, "keyword", label);
}

function integerLiteral(node, label) {
  const value = literal(node, "number", label);
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    fail(`${label} must be a safe non-negative-zero integer literal`);
  }
  return value;
}

function vectorItems(node, label) {
  if (node?.node !== "vec" || !Array.isArray(node.items)) {
    fail(`${label} must be a vector`);
  }
  return node.items;
}

function mapPairs(node, label) {
  if (node?.node !== "map" || !Array.isArray(node.pairs)) {
    fail(`${label} must be a map`);
  }
  return node.pairs;
}

function uniqueObject(entries, label) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    if (Object.hasOwn(result, key)) fail(`${label} repeats '${key}'`);
    result[key] = value;
  }
  return result;
}

function keywordMap(node, label) {
  return uniqueObject(mapPairs(node, label).map(({ key, val }) => [
    keywordLiteral(key, `${label} key`),
    keywordLiteral(val, `${label} value`),
  ]), label);
}

function transitionMap(node, label) {
  return uniqueObject(mapPairs(node, label).map(({ key, val }) => [
    `:${keywordLiteral(key, `${label} state`)}`,
    vectorItems(val, `${label} targets`).map((target) =>
      `:${keywordLiteral(target, `${label} target`)}`),
  ]), label);
}

function annotationName(form) {
  return form?.node === "def" && form.ann?.kind === "prim"
    ? form.ann.name
    : null;
}

function declarationKind(form, alias) {
  const annotation = annotationName(form);
  if (annotation === null || !annotation.startsWith(`${alias}/`)) return null;
  return annotation.slice(alias.length + 1);
}

function declarations(ast, alias, kind) {
  const found = ast.forms.filter((form) => declarationKind(form, alias) === kind);
  for (const form of found) {
    if (typeof form.name !== "string" || form.name.length === 0) {
      fail(`${kind} declaration has an invalid binding name`);
    }
    if (form.dynamic !== false || form.doc !== false) {
      fail(`declaration '${form.name}' must be an ordinary generated def`);
    }
    if (!isInferredType(form.value?.inferredType, kind)) {
      fail(`declaration '${form.name}' must infer exact ${kind}, got '${form.value?.inferredType?.name ?? "missing"}'`);
    }
  }
  return found;
}

function recordIndex(ast) {
  const records = new Map();
  for (const form of ast.forms.filter((candidate) => candidate.node === "record")) {
    if (records.has(form.name)) fail(`checked projection repeats record '${form.name}'`);
    if (!Array.isArray(form.fields)) fail(`record '${form.name}' is missing checked fields`);
    const fieldNames = new Set();
    for (const field of form.fields) {
      if (typeof field.name !== "string" || field.name.length === 0) {
        fail(`record '${form.name}' has an invalid field name`);
      }
      if (fieldNames.has(field.name)) {
        fail(`record '${form.name}' repeats field '${field.name}'`);
      }
      fieldNames.add(field.name);
    }
    records.set(form.name, form);
  }
  return records;
}

function recordNamed(records, name, label) {
  const record = records.get(name);
  if (record === undefined) fail(`${label} names missing generated record '${name}'`);
  return record;
}

function wakeFieldType(type, alias, entityByRecord, label) {
  let cardinality = "single";
  let valueType = type;
  if (type?.kind === "app" && type.name === "Vec") {
    if (type.args.length !== 1) fail(`${label} Vec type must have one argument`);
    cardinality = "multi";
    [valueType] = type.args;
  }

  if (valueType?.kind === "app" && valueType.name === `${alias}/Ref`) {
    if (valueType.args.length !== 1 || valueType.args[0]?.kind !== "prim") {
      fail(`${label} wake/Ref must name one entity record type`);
    }
    const targetEntity = entityByRecord.get(valueType.args[0].name);
    if (targetEntity === undefined) {
      fail(`${label} references unknown entity record '${valueType.args[0].name}'`);
    }
    return { cardinality, targetEntity, type: "Ref" };
  }

  if (valueType?.kind !== "prim") {
    fail(`${label} has unsupported Beagle type shape '${valueType?.kind ?? "missing"}'`);
  }
  if (valueType.name.includes("/")) {
    fail(`${label} has unsupported imported type '${valueType.name}'`);
  }
  return { cardinality, targetEntity: null, type: valueType.name };
}

function projectedPosition(sourceText, characterOffset) {
  const characters = Array.from(sourceText);
  if (!Number.isSafeInteger(characterOffset)
      || characterOffset < 0
      || characterOffset > characters.length) {
    fail(`projection source offset ${characterOffset} is outside the input`);
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
  return {
    column,
    line,
    utf16Offset: characters.slice(0, characterOffset).join("").length,
  };
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

function invocationSource(node, alias, macro, expectedSourceId, sourceText, label) {
  const provenance = node?.provenance;
  const source = provenance?.source;
  const chain = provenance?.macroExpansion?.chain;
  if (source?.canonical !== true
      || source.origin !== "synthetic"
      || source.sourceId !== expectedSourceId
      || !Number.isSafeInteger(source.pos)
      || source.pos < 1
      || !Number.isSafeInteger(source.span)
      || source.span < 1
      || !Number.isSafeInteger(source.line)
      || source.line < 1
      || !Number.isSafeInteger(source.col)
      || source.col < 0) {
    fail(`${label} lacks exact canonical macro invocation provenance`);
  }
  if (!Array.isArray(chain)
      || chain.length !== 1
      || chain[0]?.depth !== 0
      || chain[0]?.name !== `${alias}/${macro}`) {
    fail(`${label} must come directly from wake/${macro}`);
  }
  const projected = projectedPosition(sourceText, source.pos - 1);
  if (projected.line !== source.line || projected.column !== source.col) {
    fail(`${label} projection provenance does not match its source position`);
  }
  projectedPosition(sourceText, source.pos - 1 + source.span);
  return source;
}

function sameInvocation(left, right) {
  return left.sourceId === right.sourceId
    && left.pos === right.pos
    && left.span === right.span
    && left.line === right.line
    && left.col === right.col;
}

function validateExpressionProvenance(
  node,
  alias,
  macro,
  expectedSourceId,
  sourceText,
  expectedInvocation,
  label,
) {
  const source = invocationSource(
    node,
    alias,
    macro,
    expectedSourceId,
    sourceText,
    label,
  );
  if (!sameInvocation(source, expectedInvocation)) {
    fail(`${label} does not come from its descriptor macro invocation`);
  }
  if (node.node === "literal" || node.node === "ref") return;
  if (node.node === "call") {
    validateExpressionProvenance(
      node.fn,
      alias,
      macro,
      expectedSourceId,
      sourceText,
      expectedInvocation,
      `${label} callee`,
    );
    for (const [index, argument] of (node.args ?? []).entries()) {
      validateExpressionProvenance(
        argument,
        alias,
        macro,
        expectedSourceId,
        sourceText,
        expectedInvocation,
        `${label} argument ${index + 1}`,
      );
    }
    return;
  }
  if (node.node === "vec") {
    for (const [index, item] of (node.items ?? []).entries()) {
      validateExpressionProvenance(
        item,
        alias,
        macro,
        expectedSourceId,
        sourceText,
        expectedInvocation,
        `${label} item ${index + 1}`,
      );
    }
    return;
  }
  if (node.node === "map") {
    for (const [index, pair] of (node.pairs ?? []).entries()) {
      validateExpressionProvenance(
        pair.key,
        alias,
        macro,
        expectedSourceId,
        sourceText,
        expectedInvocation,
        `${label} key ${index + 1}`,
      );
      validateExpressionProvenance(
        pair.val,
        alias,
        macro,
        expectedSourceId,
        sourceText,
        expectedInvocation,
        `${label} value ${index + 1}`,
      );
    }
    return;
  }
  fail(`${label} uses unsupported checked expression node '${node.node ?? "missing"}'`);
}

function sourceSpan(form, sourceId, expectedSourceId, sourceText, label) {
  const source = form.provenance.source;
  if (source.sourceId !== expectedSourceId) {
    fail(`${label} provenance source does not match the checked input identity`);
  }
  const start = projectedPosition(sourceText, source.pos - 1);
  const end = projectedPosition(sourceText, source.pos - 1 + source.span);
  const startPosition = sourcePosition(sourceText, start.utf16Offset);
  const endPosition = sourcePosition(sourceText, end.utf16Offset);
  return {
    _tag: "SourceSpan",
    source_id: sourceId,
    start_offset: start.utf16Offset,
    end_offset: end.utf16Offset,
    start_line: startPosition.line,
    start_column: startPosition.column,
    end_line: endPosition.line,
    end_column: endPosition.column,
  };
}

function repeatedName(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} repeats '${value}'`);
    seen.add(value);
  }
}

function descriptorName(form, value, label) {
  if (value !== form.name) {
    fail(`${label} descriptor name '${value}' does not match binding '${form.name}'`);
  }
  return value;
}

function queryOperand(node, alias, label) {
  const name = wakeName(callName(node, label), alias, label);
  if (name === "field") {
    const args = callArguments(node, alias, "field", "QueryOperand", label);
    if (args.length !== 2) fail(`${label} wake/field has wrong arity`);
    return {
      _tag: "IrQueryOperand",
      kind: "field",
      name: null,
      binding: keywordLiteral(args[0], `${label} binding`),
      field: keywordLiteral(args[1], `${label} field`),
      value: null,
    };
  }
  if (name === "parameter") {
    const args = callArguments(node, alias, "parameter", "QueryOperand", label);
    if (args.length !== 1) fail(`${label} wake/parameter has wrong arity`);
    return {
      _tag: "IrQueryOperand",
      kind: "parameter",
      name: keywordLiteral(args[0], `${label} parameter`),
      binding: null,
      field: null,
      value: null,
    };
  }
  if (name === "query-binding") {
    const args = callArguments(node, alias, "query-binding", "QueryOperand", label);
    if (args.length !== 1) fail(`${label} wake/query-binding has wrong arity`);
    return {
      _tag: "IrQueryOperand",
      kind: "binding",
      name: null,
      binding: keywordLiteral(args[0], `${label} binding`),
      field: null,
      value: null,
    };
  }
  const literalKinds = new Map([
    ["tag", ["Keyword", keywordLiteral]],
    ["string-value", ["String", stringLiteral]],
    ["integer-value", ["Integer", integerLiteral]],
    ["boolean-value", ["Bool", (value, valueLabel) => literal(value, "bool", valueLabel)]],
  ]);
  const literalKind = literalKinds.get(name);
  if (literalKind !== undefined) {
    const args = callArguments(node, alias, name, "QueryOperand", label);
    if (args.length !== 1) fail(`${label} wake/${name} has wrong arity`);
    const [type, decode] = literalKind;
    return {
      _tag: "IrQueryOperand",
      kind: "literal",
      name: type,
      binding: null,
      field: null,
      value: name === "tag"
        ? `:${decode(args[0], `${label} value`)}`
        : decode(args[0], `${label} value`),
    };
  }
  fail(`${label} uses unsupported Wake query constructor '${name}'`);
}

function queryPredicate(node, alias, label) {
  const args = callArguments(node, alias, "eq", "QueryPredicate", label);
  if (args.length !== 2) fail(`${label} wake/eq has wrong arity`);
  return {
    _tag: "IrQueryPredicate",
    op: "eq",
    left: queryOperand(args[0], alias, `${label} left`),
    right: queryOperand(args[1], alias, `${label} right`),
  };
}

function querySelection(node, alias, label) {
  const args = callArguments(node, alias, "select", "QuerySelection", label);
  if (args.length !== 2) fail(`${label} wake/select has wrong arity`);
  const operand = queryOperand(args[1], alias, `${label} field`);
  if (operand.kind !== "field") fail(`${label} must select a bound field`);
  return {
    _tag: "IrQuerySelect",
    name: keywordLiteral(args[0], `${label} name`),
    binding: operand.binding,
    field: operand.field,
  };
}

function uiAttribute(node, alias, label) {
  const name = wakeName(callName(node, label), alias, label);
  if (name === "static-attr") {
    const args = callArguments(node, alias, "static-attr", "UiAttr", label);
    if (args.length !== 1) fail(`${label} wake/static-attr has wrong arity`);
    return { type: "static", value: stringLiteral(args[0], `${label} value`) };
  }
  if (name === "bind-attr") {
    const args = callArguments(node, alias, "bind-attr", "UiAttr", label);
    if (args.length !== 1) fail(`${label} wake/bind-attr has wrong arity`);
    return { type: "bind", prop: keywordLiteral(args[0], `${label} prop`) };
  }
  fail(`${label} uses unsupported Wake UI attribute '${name}'`);
}

function uiElement(node, alias, props, label) {
  const args = callArguments(node, alias, "element", "UiNode", label);
  if (args.length !== 3) fail(`${label} wake/element has wrong arity`);
  const attrs = uniqueObject(mapPairs(args[1], `${label} attributes`).map(({ key, val }) => {
    const attrName = keywordLiteral(key, `${label} attribute name`);
    const attr = uiAttribute(val, alias, `${label} :${attrName}`);
    if (attr.type === "bind" && !props.has(attr.prop)) {
      fail(`${label} :${attrName} binds unknown component prop '${attr.prop}'`);
    }
    return [attrName, attr];
  }), `${label} attribute`);
  const tag = keywordLiteral(args[0], `${label} tag`);
  if (!HTML_TAGS.has(tag)) fail(`${label} uses unknown HTML tag '${tag}'`);
  return {
    _tag: "IrElement",
    tag,
    attrs,
    children: vectorItems(args[2], `${label} children`).map((child, index) =>
      uiElement(child, alias, props, `${label} child ${index + 1}`)),
  };
}

function route(node, alias, label) {
  const args = callArguments(node, alias, "route", "RouteSpec", label);
  if (args.length !== 2) fail(`${label} wake/route has wrong arity`);
  return {
    _tag: "IrRoute",
    path: keywordLiteral(args[0], `${label} path`),
    view_name: keywordLiteral(args[1], `${label} view`),
    queries: [],
    parameters: [],
    input_parameters: [],
    required_props: [],
  };
}

export function programFromCheckedAst(
  ast,
  { sourcePath, sourceText, expectedSourceId, compilerVersion },
) {
  if (ast === null || typeof ast !== "object" || Array.isArray(ast)) {
    fail("input is not a checked-program object");
  }
  const envelopeKeys = Object.keys(ast);
  if (envelopeKeys.length !== CHECKED_PROGRAM_KEYS.size
      || envelopeKeys.some((key) => !CHECKED_PROGRAM_KEYS.has(key))) {
    fail("input has an unsupported checked-program v1 envelope");
  }
  if (ast?.kind !== CHECKED_PROGRAM_KIND
      || ast.schemaVersion !== CHECKED_PROGRAM_SCHEMA_VERSION
      || ast.phase !== "checked") {
    fail("input is not a supported checked-program v1 projection");
  }
  if (ast?.target !== "js") fail(`expected a beagle/js program, got '${ast?.target}'`);
  if (ast.mode !== "strict") fail(`expected strict Beagle input, got '${ast.mode}'`);
  if (ast["gen-class"] !== false) fail("beagle/js input must not enable gen-class");
  if (typeof ast.namespace !== "string"
      || ast.namespace.length === 0
      || !Array.isArray(ast.forms)
      || !Array.isArray(ast.requires)
      || !Array.isArray(ast.externs)
      || typeof ast.sourceId !== "string"
      || typeof expectedSourceId !== "string"
      || typeof sourceText !== "string") {
    fail("projection is missing namespace or forms");
  }
  const wakeImports = (ast.requires ?? []).filter((entry) =>
    entry?.ns === WAKE_PROVIDER_NAMESPACE);
  if (wakeImports.length !== 1
      || typeof wakeImports[0].alias !== "string"
      || wakeImports[0].alias.length === 0
      || wakeImports[0].refer !== false) {
    fail("input must import exactly [wake.core :as ALIAS] without :refer");
  }
  const wakeAlias = wakeImports[0].alias;
  if (ast.sourceId !== expectedSourceId) {
    fail(`projection source '${ast.sourceId}' does not match input identity '${expectedSourceId}'`);
  }

  const consumed = new Set();
  const invocationByForm = new Map();
  const checkedDeclarations = (kind, macro) => {
    const found = declarations(ast, wakeAlias, kind);
    for (const form of found) {
      consumed.add(form);
      const invocation = invocationSource(
        form,
        wakeAlias,
        macro,
        expectedSourceId,
        sourceText,
        `${kind} declaration '${form.name}'`,
      );
      invocationByForm.set(form, invocation);
      validateExpressionProvenance(
        form.value,
        wakeAlias,
        macro,
        expectedSourceId,
        sourceText,
        invocation,
        `${kind} declaration '${form.name}' value`,
      );
    }
    return found;
  };
  const takeCompanion = (form, owner, macro, label) => {
    if (consumed.has(form)) fail(`${label} is shared by multiple Wake declarations`);
    const source = invocationSource(
      form,
      wakeAlias,
      macro,
      expectedSourceId,
      sourceText,
      label,
    );
    if (!sameInvocation(source, invocationByForm.get(owner))) {
      fail(`${label} does not come from the same macro invocation as '${owner.name}'`);
    }
    consumed.add(form);
    return form;
  };

  const records = recordIndex(ast);
  const entityForms = checkedDeclarations("EntitySpec", "defentity");
  const entitySpecs = entityForms.map((form) => {
    const args = callArguments(
      form.value,
      wakeAlias,
      "->EntitySpec",
      "EntitySpec",
      `entity '${form.name}'`,
    );
    if (args.length !== 5) fail(`entity '${form.name}' has an invalid checked descriptor`);
    return {
      form,
      binding: form.name,
      name: descriptorName(
        form,
        stringLiteral(args[0], `entity '${form.name}' name`),
        `entity '${form.name}'`,
      ),
      recordName: stringLiteral(args[1], `entity '${form.name}' record`),
      identity: keywordLiteral(args[2], `entity '${form.name}' identity`),
      writes: keywordMap(args[3], `entity '${form.name}' writes`),
      storageId: literal(args[4], "nil", `entity '${form.name}' storage ID`),
    };
  });
  const entityNames = new Set();
  const entityRecords = new Set();
  for (const { name, recordName } of entitySpecs) {
    if (entityNames.has(name)) fail(`entity '${name}' is declared twice`);
    if (entityRecords.has(recordName)) fail(`entity record '${recordName}' is used twice`);
    entityNames.add(name);
    entityRecords.add(recordName);
  }
  const entityByRecord = new Map(entitySpecs.map(({ name, recordName }) => [recordName, name]));

  const entities = entitySpecs.map((spec) => {
    const record = takeCompanion(
      recordNamed(records, spec.recordName, `entity '${spec.name}'`),
      spec.form,
      "defentity",
      `entity '${spec.name}' record '${spec.recordName}'`,
    );
    const fieldNames = new Set(record.fields.map((field) => field.name));
    if (!fieldNames.has(spec.identity)) {
      fail(`entity '${spec.name}' identity names unknown field '${spec.identity}'`);
    }
    for (const [field, policy] of Object.entries(spec.writes)) {
      if (!fieldNames.has(field)) {
        fail(`entity '${spec.name}' write policy names unknown field '${field}'`);
      }
      if (!new Set(["create", "set", "command"]).has(policy)) {
        fail(`field '${spec.name}.${field}' write policy must be :create, :set, or :command`);
      }
      if (field === spec.identity) {
        fail(`identity field '${spec.name}.${field}' cannot declare a write policy`);
      }
    }
    const attrs = record.fields.map((field) => {
      const decoded = wakeFieldType(
        field.ann,
        wakeAlias,
        entityByRecord,
        `field '${spec.name}.${field.name}'`,
      );
      const opts = {};
      if (field.name === spec.identity) opts.identity = true;
      if (decoded.cardinality === "multi") opts.many = true;
      if (decoded.targetEntity !== null) opts["target-entity"] = decoded.targetEntity;
      if (spec.writes[field.name] !== undefined) opts.write = spec.writes[field.name];
      return {
        _tag: "IrAttr",
        name: field.name,
        storage_id: null,
        type: decoded.type,
        opts,
      };
    });
    return {
      _tag: "IrEntity",
      name: spec.name,
      storage_id: spec.storageId,
      attrs,
    };
  });

  const stateForms = checkedDeclarations("StateSpec", "defstate");
  const defstates = stateForms.map((form) => {
    const args = callArguments(
      form.value,
      wakeAlias,
      "->StateSpec",
      "StateSpec",
      `state '${form.name}'`,
    );
    if (args.length !== 4) fail(`state '${form.name}' has an invalid checked descriptor`);
    descriptorName(
      form,
      stringLiteral(args[0], `state '${form.name}' descriptor name`),
      `state '${form.name}'`,
    );
    const enumName = stringLiteral(args[1], `state '${form.name}' enum`);
    const enumForms = ast.forms.filter((candidate) =>
      candidate.node === "defenum" && candidate.name === enumName);
    if (enumForms.length !== 1) {
      fail(`state '${form.name}' must name exactly one enum '${enumName}'`);
    }
    const enumForm = takeCompanion(
      enumForms[0],
      form,
      "defstate",
      `state '${form.name}' enum '${enumName}'`,
    );
    if (!Array.isArray(enumForm.values) || enumForm.values.length === 0) {
      fail(`state '${form.name}' enum '${enumName}' must declare values`);
    }
    repeatedName(enumForm.values, `state '${form.name}' enum`);
    const transitions = transitionMap(args[3], `state '${form.name}' transitions`);
    const transitionStates = Object.keys(transitions).map((state) => state.slice(1)).sort();
    const enumStates = [...enumForm.values].sort();
    if (JSON.stringify(transitionStates) !== JSON.stringify(enumStates)) {
      fail(`state '${form.name}' transitions must cover enum '${enumName}' exactly`);
    }
    for (const targets of Object.values(transitions)) {
      if (targets.some((target) => !enumForm.values.includes(target.slice(1)))) {
        fail(`state '${form.name}' transition target is outside enum '${enumName}'`);
      }
    }
    const initial = `:${keywordLiteral(args[2], `state '${form.name}' initial`)}`;
    if (!enumForm.values.includes(initial.slice(1))) {
      fail(`state '${form.name}' initial value is outside enum '${enumName}'`);
    }
    return {
      _tag: "IrDefstate",
      name: enumName,
      transitions,
      initial,
    };
  });
  repeatedName(defstates.map((state) => state.name), "state declaration");

  const queryForms = checkedDeclarations("QuerySpec", "defquery");
  const queries = queryForms.map((form) => {
    const args = callArguments(
      form.value,
      wakeAlias,
      "->QuerySpec",
      "QuerySpec",
      `query '${form.name}'`,
    );
    if (args.length !== 9) fail(`query '${form.name}' has an invalid checked descriptor`);
    const name = descriptorName(
      form,
      stringLiteral(args[0], `query '${form.name}' name`),
      `query '${form.name}'`,
    );
    const paramsRecordName = stringLiteral(args[1], `query '${form.name}' params record`);
    const expectedParamsRecord = `${form.name}-params`;
    if (paramsRecordName !== "" && paramsRecordName !== expectedParamsRecord) {
      fail(`query '${form.name}' params companion must be '${expectedParamsRecord}'`);
    }
    const paramsRecord = paramsRecordName === "" ? null : takeCompanion(
      recordNamed(records, paramsRecordName, `query '${form.name}'`),
      form,
      "defquery",
      `query '${form.name}' params record '${paramsRecordName}'`,
    );
    const bindingsRecordName = stringLiteral(
      args[2],
      `query '${form.name}' bindings record`,
    );
    const expectedBindingsRecord = `${form.name}-bindings`;
    if (bindingsRecordName !== expectedBindingsRecord) {
      fail(`query '${form.name}' bindings companion must be '${expectedBindingsRecord}'`);
    }
    const bindingsRecord = takeCompanion(
      recordNamed(records, bindingsRecordName, `query '${form.name}'`),
      form,
      "defquery",
      `query '${form.name}' bindings record '${bindingsRecordName}'`,
    );
    const resultKind = keywordLiteral(args[6], `query '${form.name}' result`);
    if (resultKind !== "page") {
      fail(`query '${form.name}' checked slice currently supports only :page`);
    }
    const defaultLimit = integerLiteral(args[7], `query '${form.name}' default limit`);
    const maxLimit = integerLiteral(args[8], `query '${form.name}' max limit`);
    if (defaultLimit <= 0 || defaultLimit > maxLimit || maxLimit > 247) {
      fail(
        `query '${form.name}' page limits must be positive integers with default <= max <= 247`,
      );
    }
    const capabilities = vectorItems(
      args[3],
      `query '${form.name}' capabilities`,
    ).map((capability) => stringLiteral(capability, `query '${form.name}' capability`));
    repeatedName(capabilities, `query '${form.name}' capability`);
    const params = (paramsRecord?.fields ?? []).map((field) => ({
      _tag: "IrQueryParam",
      name: field.name,
      type: wakeFieldType(
        field.ann,
        wakeAlias,
        entityByRecord,
        `query '${form.name}' param '${field.name}'`,
      ).type,
    }));
    const bindings = bindingsRecord.fields.map((field) => {
      if (field.ann?.kind !== "prim") {
        fail(`query '${form.name}' binding '${field.name}' must name an entity record`);
      }
      const entityName = entityByRecord.get(field.ann.name);
      if (entityName === undefined) {
        fail(`query '${form.name}' binding '${field.name}' names unknown entity record '${field.ann.name}'`);
      }
      return {
        _tag: "IrQueryBinding",
        name: field.name,
        entity_name: entityName,
      };
    });
    const selection = vectorItems(args[5], `query '${form.name}' selection`).map(
      (selectionValue, index) => querySelection(
        selectionValue,
        wakeAlias,
        `query '${form.name}' selection ${index + 1}`,
      ),
    );
    repeatedName(params.map((parameter) => parameter.name), `query '${form.name}' parameter`);
    repeatedName(bindings.map((binding) => binding.name), `query '${form.name}' binding`);
    repeatedName(selection.map((item) => item.name), `query '${form.name}' output`);
    return {
      _tag: "IrQuery",
      name,
      capabilities,
      params,
      bindings,
      predicates: vectorItems(args[4], `query '${form.name}' predicates`).map(
        (predicate, index) => queryPredicate(
          predicate,
          wakeAlias,
          `query '${form.name}' predicate ${index + 1}`,
        ),
      ),
      selection,
      result_kind: resultKind,
      page: {
        _tag: "IrQueryPage",
        default_limit: defaultLimit,
        max_limit: maxLimit,
      },
    };
  });
  repeatedName(queries.map((query) => query.name), "query declaration");

  const componentForms = checkedDeclarations("ComponentSpec", "component");
  const components = componentForms.map((form) => {
    const args = callArguments(
      form.value,
      wakeAlias,
      "->ComponentSpec",
      "ComponentSpec",
      `component '${form.name}'`,
    );
    if (args.length !== 3) fail(`component '${form.name}' has an invalid checked descriptor`);
    const name = descriptorName(
      form,
      stringLiteral(args[0], `component '${form.name}' name`),
      `component '${form.name}'`,
    );
    const propsRecordName = stringLiteral(args[1], `component '${form.name}' props record`);
    const expectedPropsRecord = `${form.name}-props`;
    if (propsRecordName !== expectedPropsRecord) {
      fail(`component '${form.name}' props companion must be '${expectedPropsRecord}'`);
    }
    const propsRecord = takeCompanion(
      recordNamed(records, propsRecordName, `component '${form.name}'`),
      form,
      "component",
      `component '${form.name}' props record '${propsRecordName}'`,
    );
    const props = propsRecord.fields.map((field) => field.name);
    repeatedName(props, `component '${form.name}' prop`);
    const propSet = new Set(props);
    const bodyValues = vectorItems(args[2], `component '${form.name}' body`);
    if (bodyValues.length === 0) fail(`component '${form.name}' requires at least one root element`);
    return {
      _tag: "IrComponent",
      name,
      props,
      body: bodyValues.map(
        (element, index) => uiElement(
          element,
          wakeAlias,
          propSet,
          `component '${form.name}' element ${index + 1}`,
        ),
      ),
    };
  });
  repeatedName(components.map((component) => component.name), "component declaration");

  const viewForms = checkedDeclarations("ViewSpec", "view");
  const views = viewForms.map((form) => {
    const args = callArguments(
      form.value,
      wakeAlias,
      "->ViewSpec",
      "ViewSpec",
      `view '${form.name}'`,
    );
    if (args.length !== 4) fail(`view '${form.name}' has an invalid checked descriptor`);
    return {
      _tag: "IrView",
      name: descriptorName(
        form,
        stringLiteral(args[0], `view '${form.name}' name`),
        `view '${form.name}'`,
      ),
      entity_name: keywordLiteral(args[1], `view '${form.name}' entity`),
      component: keywordLiteral(args[2], `view '${form.name}' component`),
      add_fields: [],
      title: stringLiteral(args[3], `view '${form.name}' title`),
      select_component: null,
      tabs: [],
      filters: [],
      date_filters: [],
    };
  });
  repeatedName(views.map((view) => view.name), "view declaration");
  const componentNames = new Set(components.map((component) => component.name));
  for (const view of views) {
    if (!entityNames.has(view.entity_name)) {
      fail(`view '${view.name}' names unknown entity '${view.entity_name}'`);
    }
    if (!componentNames.has(view.component)) {
      fail(`view '${view.name}' names unknown component '${view.component}'`);
    }
  }

  const routerForm = checkedDeclarations("RouterSpec", "routes");
  if (routerForm.length > 1) fail("only one wake/routes declaration is allowed");
  const router = routerForm.length === 0 ? null : (() => {
    const form = routerForm[0];
    const args = callArguments(
      form.value,
      wakeAlias,
      "->RouterSpec",
      "RouterSpec",
      "routes",
    );
    if (args.length !== 2) fail("routes has an invalid checked descriptor");
    const routes = vectorItems(args[1], "routes entries").map((entry, index) =>
      route(entry, wakeAlias, `route ${index + 1}`));
    if (routes.length === 0) fail("routes requires at least one route entry");
    repeatedName(routes.map((entry) => entry.path), "route path");
    const viewNames = new Set(views.map((view) => view.name));
    for (const entry of routes) {
      if (!viewNames.has(entry.view_name)) {
        fail(`route '${entry.path}' names unknown view '${entry.view_name}'`);
      }
    }
    const defaultRoute = keywordLiteral(args[0], "routes default");
    if (!routes.some((entry) => entry.path === defaultRoute)) {
      fail(`routes default names unknown route '${defaultRoute}'`);
    }
    return {
      _tag: "IrRouter",
      default_route: defaultRoute,
      routes,
    };
  })();

  const applicationForms = checkedDeclarations("ApplicationSpec", "application");
  if (applicationForms.length !== 1) {
    fail(`expected exactly one ApplicationSpec declaration, found ${applicationForms.length}`);
  }
  const [applicationForm] = applicationForms;
  const applicationArgs = callArguments(
    applicationForm.value,
    wakeAlias,
    "->ApplicationSpec",
    "ApplicationSpec",
    "application",
  );
  if (applicationArgs.length !== 1) fail("application has an invalid checked descriptor");
  const applicationId = stringLiteral(applicationArgs[0], "application ID");
  if (applicationId.length === 0) fail("application ID must be nonempty");
  const backendForms = checkedDeclarations("BackendSpec", "backend");
  if (backendForms.length !== 1) {
    fail(`expected exactly one BackendSpec declaration, found ${backendForms.length}`);
  }
  const [backendForm] = backendForms;
  const backendArgs = callArguments(
    backendForm.value,
    wakeAlias,
    "->BackendSpec",
    "BackendSpec",
    "backend",
  );
  if (backendArgs.length !== 1) fail("backend has an invalid checked descriptor");
  const backendKind = keywordLiteral(backendArgs[0], "backend kind");
  if (backendKind !== "fram") fail(`backend must be :fram, got ':${backendKind}'`);

  const sourceName = basename(sourcePath);
  const sourceId = `application:${sourceName}`;
  const sourceUnit = {
    _tag: "IrSourceUnit",
    source_id: sourceId,
    path: sourceName,
    package_id: "application",
    package_version: compilerVersion,
  };
  const provenance = (form, kind, name) => ({
    _tag: "IrDeclarationProvenance",
    kind,
    name,
    provenance: {
      _tag: "IrProvenance",
      source: sourceUnit,
      span: sourceSpan(
        form,
        sourceId,
        expectedSourceId,
        sourceText,
        `${kind} '${name}'`,
      ),
    },
  });
  const declarationEntries = [
    [applicationForm, "application", applicationId],
    [backendForm, "backend", backendKind],
    ...entityForms.map((form, index) => [form, "entity", entities[index].name]),
    ...stateForms.map((form, index) => [form, "defstate", defstates[index].name]),
    ...queryForms.map((form, index) => [form, "query", queries[index].name]),
    ...componentForms.map((form, index) => [form, "component", components[index].name]),
    ...viewForms.map((form, index) => [form, "view", views[index].name]),
    ...(routerForm.length === 0 ? [] : [[routerForm[0], "routes", "routes"]]),
  ].sort((left, right) => ast.forms.indexOf(left[0]) - ast.forms.indexOf(right[0]));

  for (const form of ast.forms) {
    if (!consumed.has(form)) {
      const suffix = typeof form?.name === "string" ? ` '${form.name}'` : "";
      fail(`unsupported top-level checked form ${form?.node ?? "missing"}${suffix}`);
    }
  }

  return {
    _tag: "IrProgram",
    source_unit: sourceUnit,
    application: {
      _tag: "IrApplication",
      id: applicationId,
      span: sourceSpan(
        applicationForm,
        sourceId,
        expectedSourceId,
        sourceText,
        "application",
      ),
    },
    uses: [],
    providers: [],
    value_types: [],
    provider_ports: [],
    extends: [],
    fills: [],
    mounts: [],
    declaration_provenance: declarationEntries.map(([form, kind, name]) =>
      provenance(form, kind, name)),
    ns: ast.namespace,
    backend: {
      _tag: "IrBackend",
      kind: backendKind,
    },
    entities,
    persist: null,
    defstates,
    publications: [],
    queries,
    commands: [],
    list_details: [],
    forms: [],
    theme: null,
    components,
    views,
    router,
    layout: null,
  };
}
