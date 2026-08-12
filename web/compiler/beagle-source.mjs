function fail(message) {
  throw new TypeError(`wake Beagle source: ${message}`);
}

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

function localName(name) {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

function callArguments(node, expected, label) {
  const actual = localName(callName(node, label));
  if (actual !== expected) {
    fail(`${label} must call wake/${expected}, not '${actual}'`);
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

function declarationKind(form) {
  const annotation = annotationName(form);
  if (annotation === null || !annotation.startsWith("wake.dsl/")) return null;
  return annotation.slice("wake.dsl/".length);
}

function declarations(ast, kind) {
  return ast.forms.filter((form) => declarationKind(form) === kind);
}

function oneDeclaration(ast, kind) {
  const found = declarations(ast, kind);
  if (found.length !== 1) {
    fail(`expected exactly one ${kind} declaration, found ${found.length}`);
  }
  return found[0];
}

function recordIndex(ast) {
  return new Map(ast.forms
    .filter((form) => form.node === "record")
    .map((form) => [form.name, form]));
}

function recordNamed(records, name, label) {
  const record = records.get(name);
  if (record === undefined) fail(`${label} names missing generated record '${name}'`);
  return record;
}

function isType(type, name) {
  return type?.name === name || localName(type?.name ?? "") === name;
}

function wakeFieldType(type, entityByRecord, label) {
  let cardinality = "single";
  let valueType = type;
  if (type?.kind === "app" && isType(type, "Vec")) {
    if (type.args.length !== 1) fail(`${label} Vec type must have one argument`);
    cardinality = "multi";
    [valueType] = type.args;
  }

  if (valueType?.kind === "app" && isType(valueType, "Ref")) {
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

function queryOperand(node, label) {
  const name = localName(callName(node, label));
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

function queryPredicate(node, label) {
  const args = callArguments(node, "eq", label);
  if (args.length !== 2) fail(`${label} wake/eq has wrong arity`);
  return {
    _tag: "IrQueryPredicate",
    op: "eq",
    left: queryOperand(args[0], `${label} left`),
    right: queryOperand(args[1], `${label} right`),
  };
}

function querySelection(node, label) {
  const args = callArguments(node, "select", label);
  if (args.length !== 2) fail(`${label} wake/select has wrong arity`);
  const operand = queryOperand(args[1], `${label} field`);
  if (operand.kind !== "field") fail(`${label} must select a bound field`);
  return {
    _tag: "IrQuerySelect",
    name: keywordLiteral(args[0], `${label} name`),
    binding: operand.binding,
    field: operand.field,
  };
}

function uiAttribute(node, label) {
  const name = localName(callName(node, label));
  if (name === "static-attr") {
    const args = callArguments(node, "static-attr", label);
    if (args.length !== 1) fail(`${label} wake/static-attr has wrong arity`);
    return { type: "static", value: stringLiteral(args[0], `${label} value`) };
  }
  if (name === "bind-attr") {
    const args = callArguments(node, "bind-attr", label);
    if (args.length !== 1) fail(`${label} wake/bind-attr has wrong arity`);
    return { type: "bind", prop: keywordLiteral(args[0], `${label} prop`) };
  }
  fail(`${label} uses unsupported Wake UI attribute '${name}'`);
}

function uiElement(node, label) {
  const args = callArguments(node, "element", label);
  if (args.length !== 3) fail(`${label} wake/element has wrong arity`);
  const attrs = Object.fromEntries(mapPairs(args[1], `${label} attributes`).map(({ key, val }) => {
    const attrName = keywordLiteral(key, `${label} attribute name`);
    return [attrName, uiAttribute(val, `${label} :${attrName}`)];
  }));
  return {
    _tag: "IrElement",
    tag: keywordLiteral(args[0], `${label} tag`),
    attrs,
    children: vectorItems(args[2], `${label} children`).map((child, index) =>
      uiElement(child, `${label} child ${index + 1}`)),
  };
}

function route(node, label) {
  const args = callArguments(node, "route", label);
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
  if (ast?.target !== "js") fail(`expected a beagle/js program, got '${ast?.target}'`);
  if (typeof ast.namespace !== "string" || !Array.isArray(ast.forms)) {
    fail("projection is missing namespace or forms");
  }

  const records = recordIndex(ast);
  const entityForms = declarations(ast, "EntitySpec");
  const entitySpecs = entityForms.map((form) => {
    const args = callArguments(form.value, "->EntitySpec", `entity '${form.name}'`);
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
  const entityByRecord = new Map(entitySpecs.map(({ name, recordName }) => [recordName, name]));

  const entities = entitySpecs.map((spec) => {
    const record = recordNamed(records, spec.recordName, `entity '${spec.name}'`);
    const attrs = record.fields.map((field) => {
      const decoded = wakeFieldType(
        field.ann,
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

  const stateForms = declarations(ast, "StateSpec");
  const defstates = stateForms.map((form) => {
    const args = callArguments(form.value, "->StateSpec", `state '${form.name}'`);
    if (args.length !== 4) fail(`state '${form.name}' has an invalid checked descriptor`);
    const enumName = stringLiteral(args[1], `state '${form.name}' enum`);
    const enumForm = ast.forms.find((candidate) =>
      candidate.node === "defenum" && candidate.name === enumName);
    if (enumForm === undefined) fail(`state '${form.name}' names missing enum '${enumName}'`);
    const transitions = transitionMap(args[3], `state '${form.name}' transitions`);
    if (Object.keys(transitions).some((state) => !enumForm.values.includes(state))) {
      fail(`state '${form.name}' transitions name a value outside enum '${enumName}'`);
    }
    return {
      _tag: "IrDefstate",
      name: enumName,
      transitions,
      initial: keywordLiteral(args[2], `state '${form.name}' initial`),
    };
  });

  const queryForms = declarations(ast, "QuerySpec");
  const queries = queryForms.map((form) => {
    const args = callArguments(form.value, "->QuerySpec", `query '${form.name}'`);
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
    return {
      _tag: "IrQuery",
      name: stringLiteral(args[0], `query '${form.name}' name`),
      capabilities: vectorItems(args[3], `query '${form.name}' capabilities`).map(
        (capability) => stringLiteral(capability, `query '${form.name}' capability`),
      ),
      params: (paramsRecord?.fields ?? []).map((field) => ({
        _tag: "IrQueryParam",
        name: field.name,
        type: wakeFieldType(field.ann, entityByRecord, `query '${form.name}' param '${field.name}'`).type,
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
        (predicate, index) => queryPredicate(predicate, `query '${form.name}' predicate ${index + 1}`),
      ),
      selection: vectorItems(args[5], `query '${form.name}' selection`).map(
        (selection, index) => querySelection(selection, `query '${form.name}' selection ${index + 1}`),
      ),
      result_kind: resultKind,
      page: resultKind === "page" ? {
        _tag: "IrQueryPage",
        default_limit: integerLiteral(args[7], `query '${form.name}' default limit`),
        max_limit: integerLiteral(args[8], `query '${form.name}' max limit`),
      } : null,
    };
  });

  const componentForms = declarations(ast, "ComponentSpec");
  const components = componentForms.map((form) => {
    const args = callArguments(form.value, "->ComponentSpec", `component '${form.name}'`);
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
        (element, index) => uiElement(element, `component '${form.name}' element ${index + 1}`),
      ),
    };
  });

  const viewForms = declarations(ast, "ViewSpec");
  const views = viewForms.map((form) => {
    const args = callArguments(form.value, "->ViewSpec", `view '${form.name}'`);
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

  const routerForm = declarations(ast, "RouterSpec");
  if (routerForm.length > 1) fail("only one wake/routes declaration is allowed");
  const router = routerForm.length === 0 ? null : (() => {
    const form = routerForm[0];
    const args = callArguments(form.value, "->RouterSpec", "routes");
    if (args.length !== 2) fail("routes has an invalid checked descriptor");
    return {
      _tag: "IrRouter",
      default_route: keywordLiteral(args[0], "routes default"),
      routes: vectorItems(args[1], "routes entries").map((entry, index) =>
        route(entry, `route ${index + 1}`)),
    };
  })();

  const applicationForm = oneDeclaration(ast, "ApplicationSpec");
  const applicationArgs = callArguments(applicationForm.value, "->ApplicationSpec", "application");
  if (applicationArgs.length !== 1) fail("application has an invalid checked descriptor");
  const backendForm = oneDeclaration(ast, "BackendSpec");
  const backendArgs = callArguments(backendForm.value, "->BackendSpec", "backend");
  if (backendArgs.length !== 1) fail("backend has an invalid checked descriptor");

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
      kind: keywordLiteral(backendArgs[0], "backend kind"),
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
