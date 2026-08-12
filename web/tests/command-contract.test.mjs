import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { checkCommandGraph } from "../compiler/command-contract.mjs";

const wakeRoot = join(import.meta.dir, "..", "..");
const beagleRoot = process.env.BEAGLE_ROOT ?? join(homedir(), "code", "beagle", "main");

let buildDir;
let parseCommand;
let sexpr;

function compile(source, output) {
  const result = Bun.spawnSync(["beagle", "build", source, output], {
    env: { ...process.env, BEAGLE_JS_RUNTIME_PREFIX: "./beagle/" },
    stderr: "pipe",
    stdout: "pipe",
  });
  assert.equal(result.exitCode, 0, result.stderr.toString() || result.stdout.toString());
}

const field = (name, type, {
  cardinality = "single",
  identity = false,
  target = null,
  write = "create",
} = {}) => ({
  cardinality,
  derived: false,
  identity,
  name,
  target_entity: target,
  type,
  value_kind: target === null ? "literal" : "ref",
  write_policy: write,
});

const entryId = field("id", "String", { identity: true });
const versionId = field("id", "String", { identity: true });
const receiptId = field("id", "Digest", { identity: true });

const checked = {
  backend: { kind: "fram" },
  defstates: [{ name: "Lifecycle" }],
  entities: [
    {
      name: "entry",
      identity_field: entryId,
      fields: [
        entryId,
        field("current-version", "Ref", { target: "version", write: "command" }),
        field("links", "Ref", { cardinality: "multi", target: "entry" }),
      ],
    },
    {
      name: "version",
      identity_field: versionId,
      fields: [
        versionId,
        field("entry", "Ref", { target: "entry" }),
        field("previous", "Ref", { target: "version" }),
        field("state", "Lifecycle", { write: "command" }),
        field("author", "String", { write: "command" }),
        field("content", "String"),
        field("digest", "String"),
        field("created-at", "Instant"),
        field("application", "String"),
      ],
    },
    {
      name: "receipt",
      identity_field: receiptId,
      fields: [
        receiptId,
        field("actor", "String"),
        field("command", "String"),
        field("input-digest", "Digest"),
        field("created-at", "Instant"),
        field("result-entry", "Ref", { target: "entry" }),
        field("result-version", "Ref", { target: "version" }),
      ],
    },
  ],
  providers: [{
    name: "content-digest",
    input_type: {
      kind: "record",
      fields: [
        { name: "content", required: true, type: { kind: "string" } },
      ],
    },
    output_type: { kind: "string" },
  }],
  state_machines: [{
    entity: "version",
    field: "state",
    initial: "candidate",
    state_type: "Lifecycle",
    transitions: {
      candidate: ["released", "superseded"],
      released: ["superseded"],
      superseded: [],
    },
  }],
};

const source = `(command replace-release
  :capability [
    (release-own
      :guards [(guard version (input expected) author (actor id)
                 :when (non-null (input expected)))])
    release-any]
  :normalizer-version 1
  :input [(entry : (String :min 1 :bytes 200))
          (expected : (Nullable String))
          (links : (List String :max 8))
          (content : (String :min 1 :bytes 1024))]
  :inject [(version :generated-id String)
           (digest :provider content-digest String
             (record [content (input content)]))
           (payload :canonical-digest Digest
             (record [content (input content)]))]
  :steps [
    (assert (= (input entry) (input entry)))
    (require entry (input entry))
    (require-each entry (input links))
    (guard entry (input entry) links (input links))
    (guard entry (input entry) current-version (input expected))
    (create version (injected version)
      :fields [(entry (input entry))
               (previous (input expected) :omit-if-null)
               (state (literal :candidate))
               (author (actor id))
               (content (input content))
               (digest (injected digest))
               (created-at (receipt-time))
               (application (artifact-digest))])
    (update entry (input entry)
      :fields [(current-version (injected version)
                :allowed-current (input expected))])]
  :result [(entry : String (input entry))
           (version : String (injected version))]
  :receipt (receipt
    :entity receipt
    :identity id
    :actor actor
    :command command
    :input-digest input-digest
    :created-at created-at
    :result [(entry result-entry String)
             (version result-version String)]))`;

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "wake-command-contract-"));
  mkdirSync(join(buildDir, "beagle"));
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "core.js"),
    join(buildDir, "beagle", "core.js"),
  );
  copyFileSync(
    join(beagleRoot, "beagle-lib", "lib", "beagle", "hamt.js"),
    join(buildDir, "beagle", "hamt.js"),
  );
  compile(join(wakeRoot, "web", "compiler", "sexpr.bjs"), join(buildDir, "sexpr.mjs"));
  compile(join(wakeRoot, "web", "compiler", "command.bjs"), join(buildDir, "command.mjs"));
  await Bun.write(
    join(buildDir, "sexpr.mjs"),
    `${await Bun.file(join(buildDir, "sexpr.mjs")).text()}\nexport { parse_all };\n`,
  );
  await Bun.write(
    join(buildDir, "command.mjs"),
    `${await Bun.file(join(buildDir, "command.mjs")).text()}\nexport { parse_command };\n`,
  );
  sexpr = await import(join(buildDir, "sexpr.mjs"));
  ({ parse_command: parseCommand } = await import(join(buildDir, "command.mjs")));
});

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

test("command grammar parses a closed generic guarded transaction", () => {
  const [{ value: form }] = sexpr.parse_all(source);
  const parsed = parseCommand(form);
  assert.deepEqual(parsed.steps[1].identity, { kind: "input", name: "entry" });
  assert.deepEqual(parsed.input.map(field => [field.name, field.type]), [
    ["entry", { kind: "string", maxBytes: 200, minLength: 1 }],
    ["expected", { kind: "nullable", value: { kind: "string" } }],
    ["links", { kind: "list", items: { kind: "string" }, maxItems: 8 }],
    ["content", { kind: "string", maxBytes: 1024, minLength: 1 }],
  ]);
  const [command] = checkCommandGraph([parsed], checked, {
    exportedCapabilities: ["release-own", "release-any"],
  });

  assert.equal(command.name, "replace-release");
  assert.deepEqual(command.capabilities.map(choice => choice.capability), [
    "release-own",
    "release-any",
  ]);
  assert.equal(command.capabilities[0].guards[0].op, "guard");
  assert.deepEqual(command.input[0].type, {
    kind: "string",
    maxBytes: 200,
    minLength: 1,
  });
  assert.deepEqual(command.steps.map(step => step.op), [
    "assert",
    "require",
    "require-each",
    "guard",
    "guard",
    "create",
    "update",
  ]);
});

test("checker rejects undeclared capability, unguarded command update, and invalid state transition", () => {
  const [{ value: form }] = sexpr.parse_all(source);
  const command = parseCommand(form);
  assert.throws(
    () => checkCommandGraph([command], checked, { exportedCapabilities: ["release-own"] }),
    /undeclared capability 'release-any'/,
  );
  const unguarded = structuredClone(command);
  delete unguarded.steps.at(-1).fields[0].allowedCurrent;
  assert.throws(() => checkCommandGraph([unguarded], checked), /requires :allowed-current/);

  const invalidTransition = structuredClone(command);
  invalidTransition.steps.push({
    entity: "version",
    fields: [{
      allowedCurrent: { kind: "literal", type: "keyword", value: "superseded" },
      field: "state",
      value: { kind: "literal", type: "keyword", value: "released" },
    }],
    identity: { kind: "input", name: "expected" },
    op: "update",
    when: { kind: "non-null", value: { kind: "input", name: "expected" } },
  });
  assert.throws(() => checkCommandGraph([invalidTransition], checked), /is not declared/);
});

test("checker accepts an absence CAS for a single command-written field", () => {
  const [{ value: form }] = sexpr.parse_all(source);
  const command = parseCommand(form);
  const provenanceChecked = structuredClone(checked);
  provenanceChecked.entities
    .find(entity => entity.name === "version")
    .fields.push(field("published-at", "Instant", { write: "command" }));
  command.steps.push({
    entity: "version",
    fields: [{
      allowedCurrent: { kind: "literal", value: null },
      field: "published-at",
      value: { kind: "receipt-time" },
    }],
    identity: { kind: "input", name: "expected" },
    op: "update",
    when: { kind: "non-null", value: { kind: "input", name: "expected" } },
  });

  assert.doesNotThrow(() => checkCommandGraph([command], provenanceChecked));
});

test("checker normalizes configured keyword state names", () => {
  const [{ value: form }] = sexpr.parse_all(source);
  const command = parseCommand(form);
  const configured = structuredClone(checked);
  configured.state_machines[0].initial = ":candidate";
  configured.state_machines[0].transitions = {
    ":candidate": [":released", ":superseded"],
    ":released": [":superseded"],
    ":superseded": [],
  };

  assert.doesNotThrow(() => checkCommandGraph([command], configured));
});

test("checker enforces exact provider input and output contracts", () => {
  const [{ value: form }] = sexpr.parse_all(source);
  const command = parseCommand(form);
  const wrongInput = structuredClone(command);
  wrongInput.injections[1].input.fields[0].value = { kind: "input", name: "expected" };
  assert.throws(
    () => checkCommandGraph([wrongInput], checked),
    /provider 'digest' input has incompatible type/,
  );

  const wrongOutput = structuredClone(command);
  wrongOutput.injections[1].type = { kind: "digest" };
  assert.throws(
    () => checkCommandGraph([wrongOutput], checked),
    /provider 'digest' output has incompatible type/,
  );
});

test("checker accepts a literal integer for a bounded provider record field", () => {
  const [{ value: form }] = sexpr.parse_all(source);
  const command = parseCommand(form);
  const bounded = structuredClone(checked);
  bounded.providers[0].input_type.fields[0].type = {
    kind: "integer",
    maximum: 247,
    minimum: 1,
  };
  command.injections[1].input.fields[0].value = { kind: "literal", value: 5 };

  assert.doesNotThrow(() => checkCommandGraph([command], bounded));
});

test("parser rejects unknown command steps rather than accepting a no-op", () => {
  const [{ value: form }] = sexpr.parse_all(source.replace("(require entry", "(erase entry"));
  assert.throws(() => parseCommand(form), /unknown operation 'erase'/);
});
