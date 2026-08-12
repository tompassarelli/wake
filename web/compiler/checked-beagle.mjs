function fail(message) {
  throw new TypeError(`wake checked Beagle: ${message}`);
}

const CHECKED_PROGRAM_KIND = "beagle.checked-program";
const CHECKED_PROGRAM_SCHEMA_VERSION = 1;
const WAKE_PROVIDER_NAMESPACE = "wake.dsl";

function basename(path) {
  const end = path.lastIndexOf("/");
  return path.slice(end + 1);
}

function callName(node, label) {
  if (node?.node !== "call" || node.fn?.node !== "ref") {
    fail(`${label} must be a checked Wake constructor call`);
  }
  return node.fn.name;
}

function wakeName(name, alias, label) {
  const slash = name.indexOf("/");
  if (slash === -1 || name.slice(0, slash) !== alias) {
    fail(`${label} must use a checked wake/* binding, got '${name}'`);
  }
  return name.slice(slash + 1);
}

function callArguments(node, alias, expected, label) {
  const actual = wakeName(callName(node, label), alias, label);
  if (actual !== expected) {
    fail(`${label} must call wake/${expected}, not '${actual}'`);
  }
  const inferred = node.inferredType;
  if (inferred?.kind !== "prim" || inferred.name === "Any") {
    fail(`${label} lacks an exact checked inferred type`);
  }
  return node.args;
}

function literal(node, kind, label) {
  if (node?.node !== "literal" || node.kind !== kind) {
    fail(`${label} must be a ${kind} literal`);
  }
  return kind === "nil" ? null : node.value;
}

function stringLiteral(node, label) {
  return literal(node, "string", label);
}

function keywordLiteral(node, label) {
  return literal(node, "keyword", label);
}

function integerLiteral(node, label) {
  return literal(node, "number", label);
}

function vectorItems(node, label) {
  if (node?.node !== "vec") fail(`${label} must be a vector`);
  return node.items;
}

function mapPairs(node, label) {
  if (node?.node !== "map") fail(`${label} must be a map`);
  return node.pairs;
}

function keywordMap(node, label) {
  return Object.fromEntries(mapPairs(node, label).map(({ key, val }) => [
    keywordLiteral(key, `${label} key`),
    keywordLiteral(val, `${label} value`),
  ]));
}

function transitionMap(node, label) {
  return Object.fromEntries(mapPairs(node, label).map(({ key, val }) => [
    keywordLiteral(key, `${label} state`),
    vectorItems(val, `${label} targets`).map((target) =>
      keywordLiteral(target, `${label} target`)),
  ]));
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
    if (!isType(form.value?.inferredType, alias, kind)) {
      fail(`declaration '${form.name}' must infer exact ${kind}, got '${form.value?.inferredType?.name ?? "missing"}'`);
    }
  }
  return found;
}

function oneDeclaration(ast, alias, kind) {
  const found = declarations(ast, alias, kind);
  if (found.length !== 1) {
    fail(`expected exactly one ${kind} declaration, found ${found.length}`);
  }
  return found[0];
}

function recordIndex(ast) {
  const records = new Map();
  for (const form of ast.forms.filter((candidate) => candidate.node === "record")) {
    if (records.has(form.name)) fail(`checked projection repeats record '${form.name}'`);
    records.set(form.name, form);
  }
  return records;
}

function recordNamed(records, name, label) {
  const record = records.get(name);
  if (record === undefined) fail(`${label} names missing generated record '${name}'`);
  return record;
}

function isType(type, alias, name) {
  return type?.name === name || type?.name === `${alias}/${name}`;
}

function wakeFieldType(type, alias, entityByRecord, label) {
  let cardinality = "single";
  let valueType = type;
  if (type?.kind === "app" && isType(type, alias, "Vec")) {
    if (type.args.length !== 1) fail(`${label} Vec type must have one argument`);
    cardinality = "multi";
    [valueType] = type.args;
  }

  if (valueType?.kind === "app" && isType(valueType, alias, "Ref")) {
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
  const typeName = valueType.name === "Int" ? "Integer" : valueType.name;
  return { cardinality, targetEntity: null, type: typeName };
}

function sourceSpan(sourceId) {
  return {
    _tag: "SourceSpan",
    source_id: sourceId,
    start_offset: 0,
    end_offset: 0,
    start_line: 1,
    start_column: 1,
    end_line: 1,
    end_column: 1,
  };
}

function queryOperand(node, alias, label) {
  const name = wakeName(callName(node, label), alias, label);
  const args = node.args;
  if (name === "field") {
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
    if (args.length !== 1) fail(`${label} wake/${name} has wrong arity`);
    const [type, decode] = literalKind;
    return {
      _tag: "IrQueryOperand",
      kind: "literal",
      name: type,
      binding: null,
      field: null,
      value: decode(args[0], `${label} value`),
    };
  }
  fail(`${label} uses unsupported Wake query constructor '${name}'`);
}

function queryPredicate(node, alias, label) {
  const args = callArguments(node, alias, "eq", label);
  if (args.length !== 2) fail(`${label} wake/eq has wrong arity`);
  return {
    _tag: "IrQueryPredicate",
    op: "eq",
    left: queryOperand(args[0], alias, `${label} left`),
    right: queryOperand(args[1], alias, `${label} right`),
  };
}

function querySelection(node, alias, label) {
  const args = callArguments(node, alias, "select", label);
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
    const args = callArguments(node, alias, "static-attr", label);
    if (args.length !== 1) fail(`${label} wake/static-attr has wrong arity`);
    return { type: "static", value: stringLiteral(args[0], `${label} value`) };
  }
  if (name === "bind-attr") {
    const args = callArguments(node, alias, "bind-attr", label);
    if (args.length !== 1) fail(`${label} wake/bind-attr has wrong arity`);
    return { type: "bind", prop: keywordLiteral(args[0], `${label} prop`) };
  }
  fail(`${label} uses unsupported Wake UI attribute '${name}'`);
}

function uiElement(node, alias, label) {
  const args = callArguments(node, alias, "element", label);
  if (args.length !== 3) fail(`${label} wake/element has wrong arity`);
  const attrs = Object.fromEntries(mapPairs(args[1], `${label} attributes`).map(({ key, val }) => {
    const attrName = keywordLiteral(key, `${label} attribute name`);
    return [attrName, uiAttribute(val, alias, `${label} :${attrName}`)];
  }));
  return {
    _tag: "IrElement",
    tag: keywordLiteral(args[0], `${label} tag`),
    attrs,
    children: vectorItems(args[2], `${label} children`).map((child, index) =>
      uiElement(child, alias, `${label} child ${index + 1}`)),
  };
}

function route(node, alias, label) {
  const args = callArguments(node, alias, "route", label);
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

export function programFromCheckedAst(ast, { sourcePath, compilerVersion }) {
  if (ast?.kind !== CHECKED_PROGRAM_KIND
      || ast.schemaVersion !== CHECKED_PROGRAM_SCHEMA_VERSION
      || ast.phase !== "checked") {
    fail("input is not a supported checked-program v1 projection");
  }
  if (ast?.target !== "js") fail(`expected a beagle/js program, got '${ast?.target}'`);
  if (ast.mode !== "strict") fail(`expected strict Beagle input, got '${ast.mode}'`);
  if (typeof ast.namespace !== "string" || !Array.isArray(ast.forms)) {
    fail("projection is missing namespace or forms");
  }
  const wakeImports = (ast.requires ?? []).filter((entry) =>
    entry?.ns === WAKE_PROVIDER_NAMESPACE);
  if (wakeImports.length !== 1
      || typeof wakeImports[0].alias !== "string"
      || wakeImports[0].alias.length === 0
      || wakeImports[0].refer !== false) {
    fail("input must import exactly [wake.dsl :as ALIAS] without :refer");
  }
  const wakeAlias = wakeImports[0].alias;
  if (ast.sourceId !== sourcePath) {
    fail(`projection source '${ast.sourceId}' does not match input '${sourcePath}'`);
  }

  const records = recordIndex(ast);
  const entityForms = declarations(ast, wakeAlias, "EntitySpec");
  const entitySpecs = entityForms.map((form) => {
    const args = callArguments(form.value, wakeAlias, "->EntitySpec", `entity '${form.name}'`);
    if (args.length !== 5) fail(`entity '${form.name}' has an invalid checked descriptor`);
    return {
      binding: form.name,
      name: stringLiteral(args[0], `entity '${form.name}' name`),
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
    const record = recordNamed(records, spec.recordName, `entity '${spec.name}'`);
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

  const stateForms = declarations(ast, wakeAlias, "StateSpec");
  const defstates = stateForms.map((form) => {
    const args = callArguments(form.value, wakeAlias, "->StateSpec", `state '${form.name}'`);
    if (args.length !== 4) fail(`state '${form.name}' has an invalid checked descriptor`);
    const enumName = stringLiteral(args[1], `state '${form.name}' enum`);
    const enumForms = ast.forms.filter((candidate) =>
      candidate.node === "defenum" && candidate.name === enumName);
    if (enumForms.length !== 1) {
      fail(`state '${form.name}' must name exactly one enum '${enumName}'`);
    }
    const [enumForm] = enumForms;
    const transitions = transitionMap(args[3], `state '${form.name}' transitions`);
    const transitionStates = Object.keys(transitions).sort();
    const enumStates = [...enumForm.values].sort();
    if (JSON.stringify(transitionStates) !== JSON.stringify(enumStates)) {
      fail(`state '${form.name}' transitions must cover enum '${enumName}' exactly`);
    }
    for (const targets of Object.values(transitions)) {
      if (targets.some((target) => !enumForm.values.includes(target))) {
        fail(`state '${form.name}' transition target is outside enum '${enumName}'`);
      }
    }
    return {
      _tag: "IrDefstate",
      name: enumName,
      transitions,
      initial: keywordLiteral(args[2], `state '${form.name}' initial`),
    };
  });

  const queryForms = declarations(ast, wakeAlias, "QuerySpec");
  const queries = queryForms.map((form) => {
    const args = callArguments(form.value, wakeAlias, "->QuerySpec", `query '${form.name}'`);
    if (args.length !== 9) fail(`query '${form.name}' has an invalid checked descriptor`);
    const paramsRecordName = stringLiteral(args[1], `query '${form.name}' params record`);
    const paramsRecord = paramsRecordName === "" ? null : recordNamed(
      records,
      paramsRecordName,
      `query '${form.name}'`,
    );
    const bindingsRecord = recordNamed(
      records,
      stringLiteral(args[2], `query '${form.name}' bindings record`),
      `query '${form.name}'`,
    );
    const resultKind = keywordLiteral(args[6], `query '${form.name}' result`);
    if (resultKind !== "page") {
      fail(`query '${form.name}' checked slice currently supports only :page`);
    }
    const defaultLimit = integerLiteral(args[7], `query '${form.name}' default limit`);
    const maxLimit = integerLiteral(args[8], `query '${form.name}' max limit`);
    if (!Number.isSafeInteger(defaultLimit)
        || !Number.isSafeInteger(maxLimit)
        || defaultLimit <= 0
        || defaultLimit > maxLimit
        || maxLimit > 247) {
      fail(`query '${form.name}' page limits must satisfy 0 < default <= max <= 247`);
    }
    return {
      _tag: "IrQuery",
      name: stringLiteral(args[0], `query '${form.name}' name`),
      capabilities: vectorItems(args[3], `query '${form.name}' capabilities`).map(
        (capability) => stringLiteral(capability, `query '${form.name}' capability`),
      ),
      params: (paramsRecord?.fields ?? []).map((field) => ({
        _tag: "IrQueryParam",
        name: field.name,
        type: wakeFieldType(
          field.ann,
          wakeAlias,
          entityByRecord,
          `query '${form.name}' param '${field.name}'`,
        ).type,
      })),
      bindings: bindingsRecord.fields.map((field) => {
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
      }),
      predicates: vectorItems(args[4], `query '${form.name}' predicates`).map(
        (predicate, index) => queryPredicate(
          predicate,
          wakeAlias,
          `query '${form.name}' predicate ${index + 1}`,
        ),
      ),
      selection: vectorItems(args[5], `query '${form.name}' selection`).map(
        (selection, index) => querySelection(
          selection,
          wakeAlias,
          `query '${form.name}' selection ${index + 1}`,
        ),
      ),
      result_kind: resultKind,
      page: {
        _tag: "IrQueryPage",
        default_limit: defaultLimit,
        max_limit: maxLimit,
      },
    };
  });

  const componentForms = declarations(ast, wakeAlias, "ComponentSpec");
  const components = componentForms.map((form) => {
    const args = callArguments(form.value, wakeAlias, "->ComponentSpec", `component '${form.name}'`);
    if (args.length !== 3) fail(`component '${form.name}' has an invalid checked descriptor`);
    const propsRecord = recordNamed(
      records,
      stringLiteral(args[1], `component '${form.name}' props record`),
      `component '${form.name}'`,
    );
    return {
      _tag: "IrComponent",
      name: stringLiteral(args[0], `component '${form.name}' name`),
      props: propsRecord.fields.map((field) => field.name),
      body: vectorItems(args[2], `component '${form.name}' body`).map(
        (element, index) => uiElement(
          element,
          wakeAlias,
          `component '${form.name}' element ${index + 1}`,
        ),
      ),
    };
  });

  const viewForms = declarations(ast, wakeAlias, "ViewSpec");
  const views = viewForms.map((form) => {
    const args = callArguments(form.value, wakeAlias, "->ViewSpec", `view '${form.name}'`);
    if (args.length !== 4) fail(`view '${form.name}' has an invalid checked descriptor`);
    return {
      _tag: "IrView",
      name: stringLiteral(args[0], `view '${form.name}' name`),
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

  const routerForm = declarations(ast, wakeAlias, "RouterSpec");
  if (routerForm.length > 1) fail("only one wake/routes declaration is allowed");
  const router = routerForm.length === 0 ? null : (() => {
    const form = routerForm[0];
    const args = callArguments(form.value, wakeAlias, "->RouterSpec", "routes");
    if (args.length !== 2) fail("routes has an invalid checked descriptor");
    return {
      _tag: "IrRouter",
      default_route: keywordLiteral(args[0], "routes default"),
      routes: vectorItems(args[1], "routes entries").map((entry, index) =>
        route(entry, wakeAlias, `route ${index + 1}`)),
    };
  })();

  const applicationForm = oneDeclaration(ast, wakeAlias, "ApplicationSpec");
  const applicationArgs = callArguments(
    applicationForm.value,
    wakeAlias,
    "->ApplicationSpec",
    "application",
  );
  if (applicationArgs.length !== 1) fail("application has an invalid checked descriptor");
  const backendForm = oneDeclaration(ast, wakeAlias, "BackendSpec");
  const backendArgs = callArguments(
    backendForm.value,
    wakeAlias,
    "->BackendSpec",
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
  const provenance = (kind, name) => ({
    _tag: "IrDeclarationProvenance",
    kind,
    name,
    provenance: {
      _tag: "IrProvenance",
      source: sourceUnit,
      span: sourceSpan(sourceId),
    },
  });

  return {
    _tag: "IrProgram",
    source_unit: sourceUnit,
    application: {
      _tag: "IrApplication",
      id: stringLiteral(applicationArgs[0], "application ID"),
      span: sourceSpan(sourceId),
    },
    uses: [],
    providers: [],
    value_types: [],
    provider_ports: [],
    extends: [],
    fills: [],
    mounts: [],
    declaration_provenance: [
      provenance("application", "application"),
      provenance("backend", "fram"),
      ...entities.map((entity) => provenance("entity", entity.name)),
      ...defstates.map((state) => provenance("defstate", state.name)),
      ...queries.map((query) => provenance("query", query.name)),
      ...components.map((component) => provenance("component", component.name)),
      ...views.map((view) => provenance("view", view.name)),
      ...(router === null ? [] : [provenance("routes", "routes")]),
    ],
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
