import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const compile = join(webRoot, "bin", "wake-compile");
const COMPILER_TEST_TIMEOUT_MS = 20_000;

function spawnSync(command, args, { cwd, env = process.env } = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: webRoot,
  });
  const diagnostics = [
    result.stdout,
    result.stderr,
  ].filter(Boolean).join("\n");
  assert.equal(result.status, 0, diagnostics);
}

function compileFram(source) {
  return spawnSync(compile, ["--fram", source, "-"], { cwd: webRoot });
}

async function compileAll(source, outputDir) {
  run(compile, ["--all", source, outputDir]);
  const appPath = join(outputDir, "app.js");
  const checked = await Bun.build({
    entrypoints: [appPath],
    target: "browser",
    write: false,
  });
  assert.equal(checked.success, true, checked.logs.join("\n"));
  return readFileSync(appPath, "utf8");
}

function storeBinding(generated, entity) {
  const escaped = JSON.stringify(entity).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return generated.match(
    new RegExp(`\\[${escaped}, \\{ store: ([A-Za-z_$][\\w$]*)`),
  )?.[1];
}

test("generated bindings are injective and related FRAM creates obey the entity contract", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-compiler-contracts-"));
  try {
    const generated = await compileAll(
      "tests/fixtures/compiler-contracts-list-detail.wake",
      outputDir,
    );
    const hyphenStore = storeBinding(generated, "blog-post");
    const underscoreStore = storeBinding(generated, "blog_post");
    assert.ok(hyphenStore);
    assert.ok(underscoreStore);
    assert.notEqual(hyphenStore, underscoreStore);
    assert.doesNotMatch(generated, /const blog-posts/);
    assert.match(generated, /\.by\("contact-ref", /);
    const relatedRenderer = generated.match(
      /function ([A-Za-z_$][\w$]*)\(\) \{\n  detailNodes\.[^\n]+List\.innerHTML/,
    )?.[1];
    assert.ok(relatedRenderer, "related tabs must define an encoded renderer");
    const rendererCalls = generated.match(
      new RegExp(`${relatedRenderer.replace(/\$/g, "\\$")}\\(\\);`, "g"),
    ) ?? [];
    assert.ok(rendererCalls.length >= 2, "tabs and store watchers must call the same renderer");
    assert.match(
      generated,
      /wakeFramAttachPublicationActions\("blog-post", entity, rowEntry,/,
    );
    assert.match(
      generated,
      /const wakeFramFieldMeta = Object\.assign\(Object\.create\(null\),/,
    );
    assert.match(
      generated,
      /const wakeFramPublications = Object\.assign\(Object\.create\(null\),/,
    );

    const relatedCreate = generated.match(
      /const values = Object\.create\(null\);\n([\s\S]*?)await ([A-Za-z_$][\w$]*)\.add\(values\);/,
    )?.[1];
    assert.ok(relatedCreate, "related Add must build an explicit FRAM payload");
    assert.match(relatedCreate, /values\["note-id"\]/);
    assert.match(relatedCreate, /values\["summary"\]/);
    assert.match(relatedCreate, /values\["contact-ref"\]/);
    assert.doesNotMatch(relatedCreate, /values\["status"\]/);
    assert.doesNotMatch(relatedCreate, /values\["content"\]/);
    assert.doesNotMatch(relatedCreate, /values\["created-at"\]/);
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("read-only single views compile and attach publication actions on add and load", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-single-publication-"));
  const sourcePath = join(outputDir, "single-publication.wake");
  writeFileSync(sourcePath, `(ns wake.single-publication)
(application :id "wake-test-single-publication")
(backend :fram)
(defstate PublishStatus
  [:draft -> :published :retired]
  [:published -> :retired]
  [:retired ->])
(entity page
  (slug : String :identity)
  (canonical-revision : Ref :to revision :write :command))
(entity revision
  (id : String :identity)
  (page-ref : Ref :to page :write :create)
  (status : PublishStatus :write :command))
(publication canonical
  :owner page :pointer canonical-revision
  :revision revision :owner-field page-ref :state-field status
  :draft :draft :published :published :retired :retired)
(component revision-row
  :props [id page-ref status]
  (div :class "row" (span :text id) (span :text status)))
(view revisions
  :entity revision
  :each revision-row
  :title "Revisions")
`);

  try {
    const generated = await compileAll(sourcePath, join(outputDir, "out"));
    assert.match(
      generated,
      /wakeFramAttachPublicationActions\("revision", evt\.entity, inst,/,
    );
    assert.match(
      generated,
      /wakeFramAttachPublicationActions\("revision", entity, inst,/,
    );
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("legacy related queries keep one coherent row variable", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-related-query-guard-"));
  const source = readFileSync(
    join(webRoot, "tests", "fixtures", "compiler-contracts-list-detail.wake"),
    "utf8",
  );
  try {
    for (const [name, query, expected] of [
      [
        "incoherent",
        "[:find ?n :where [?other :blog-note/contact-ref ?e]]",
        /:query :find row '\?n' must match :where row '\?other'/,
      ],
      [
        "aliased-roles",
        "[:find ?n :where [?n :blog-note/contact-ref ?n]]",
        /:query related row and owner must be distinct/,
      ],
    ]) {
      const sourcePath = join(temporary, `${name}.wake`);
      writeFileSync(sourcePath, source.replace(
        "[:find ?n :where [?n :blog-note/contact-ref ?e]]",
        query,
      ));
      const result = compileFram(sourcePath);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, expected);
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("legacy derived fields cannot hide unknown or derived dependencies", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-derived-graph-guard-"));
  try {
    const cases = [
      [
        "unknown",
        "  (label : Derived (str ghost))",
        /derived field 'page\.label' references unknown field 'ghost'/,
      ],
      [
        "derived",
        "  (label : Derived (str title))\n  (slug : Derived (str label))",
        /derived field 'page\.slug' cannot reference derived field 'label'/,
      ],
    ];
    for (const [name, derivedFields, expected] of cases) {
      const sourcePath = join(temporary, `${name}.wake`);
      writeFileSync(sourcePath, `(ns wake.tests.derived-graph-guard)
(application :id "wake-derived-graph-guard")
(backend :fram)
(entity page
  (id : String :identity)
  (title : String)
${derivedFields})
`);
      const result = compileFram(sourcePath);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, expected);
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("compiler rejects list-detail declarations it cannot all generate", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-list-detail-cardinality-"));
  const sourcePath = join(temporary, "two-list-details.wake");
  const source = readFileSync(
    join(webRoot, "tests", "fixtures", "compiler-contracts-list-detail.wake"),
    "utf8",
  );
  writeFileSync(sourcePath, `${source}
(list-detail blog-note
  :title "Blog notes"
  :columns [note-id summary]
  :search [note-id summary]
  :detail (tabs
    (tab "Overview" (fields [note-id summary]))))
`);
  try {
    const result = compileFram(sourcePath);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /program may declare at most one list detail/,
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("list-detail mode omits creation UI when no form is declared", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-list-without-form-"));
  const sourcePath = join(temporary, "read-only-list.wake");
  const source = readFileSync(
    join(webRoot, "tests", "fixtures", "compiler-contracts-list-detail.wake"),
    "utf8",
  ).replace(/\n\(form add-blog-post[\s\S]*\)\s*$/u, "\n");
  writeFileSync(sourcePath, source);
  try {
    const generated = await compileAll(sourcePath, join(temporary, "out"));
    assert.doesNotMatch(generated, /function handleSubmit/);
    assert.doesNotMatch(generated, /\.addEventListener\('submit'/);
    assert.doesNotMatch(generated, /undefined_val/);
    assert.match(generated, /Blog posts/);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("schema-only programs remain valid while browser generation needs a UI root", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-schema-only-"));
  const sourcePath = join(temporary, "schema-only.wake");
  writeFileSync(sourcePath, `(ns wake.tests.schema-only)
(application :id "wake-schema-only")
(backend :fram)
(entity page
  (id : String :identity)
  (title : String))
`);
  try {
    const fram = compileFram(sourcePath);
    assert.equal(fram.status, 0, `${fram.stdout}\n${fram.stderr}`);
    const browser = spawnSync(compile, [sourcePath, "-"], { cwd: webRoot });
    assert.notEqual(browser.status, 0);
    assert.match(
      `${browser.stdout}\n${browser.stderr}`,
      /browser generation requires one view or one list detail/,
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("compiler rejects ambiguous or mismatched UI root declarations", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-ui-root-topology-"));
  const base = readFileSync(
    join(webRoot, "tests", "fixtures", "compiler-contracts-list-detail.wake"),
    "utf8",
  );
  const form = base.match(/\n\(form add-blog-post[\s\S]*\)\s*$/u)?.[0];
  assert.ok(form, "fixture must contain one smart form");
  try {
    for (const [name, source, expected] of [
      [
        "multiple-forms",
        `${base}${form}`,
        /program may declare at most one list-detail form/,
      ],
      [
        "wrong-form-owner",
        base.replace(":entity blog-post", ":entity blog-note"),
        /targets entity 'blog-note' but the list detail owns 'blog-post'/,
      ],
      [
        "view-and-list",
        `${base}\n(component blog-row :props [id] (div :text id))\n(view blogs :entity blog-post :each blog-row :title "Blogs")\n`,
        /program cannot combine view and list-detail UI roots/,
      ],
    ]) {
      const sourcePath = join(temporary, `${name}.wake`);
      writeFileSync(sourcePath, source);
      const result = compileFram(sourcePath);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, expected);
    }
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, 45_000);
