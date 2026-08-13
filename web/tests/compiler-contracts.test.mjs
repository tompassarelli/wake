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

const singlePublicationProgram = `#lang beagle/js
(ns wake.single-publication
  (:require [wake.core :as wake]))

(wake/defstate-model
  publish-status
  "PublishStatus"
  "PublishStatus"
  [[draft "PublishStatus/draft" "draft" :draft]
   [published "PublishStatus/published" "published" :published]
   [retired "PublishStatus/retired" "retired" :retired]]
  draft
  [[draft [published retired]]
   [published [retired]]
   [retired []]])

(wake/defentity-ref page "page" "page")
(wake/defentity-ref revision "revision" "revision")

(wake/define-entity-model
  page
  Page
  "page"
  [[slug "page/slug" "slug" String
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->IdentityWrite nil)
    "wake-test-single-publication/field/page/slug"
    true]
   [canonical-revision "page/canonical-revision" "canonical-revision" String
    (wake/->RefField (wake/->DeclaredEntityTarget revision-ref))
    (wake/->SingleField nil)
    (wake/->CommandFieldWrite nil)
    "wake-test-single-publication/field/page/canonical-revision"
    false]]
  []
  "wake-test-single-publication/entity/page")

(wake/define-entity-model
  revision
  Revision
  "revision"
  [[id "revision/id" "id" String
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->IdentityWrite nil)
    "wake-test-single-publication/field/revision/id"
    true]
   [page-ref "revision/page-ref" "page-ref" String
    (wake/->RefField (wake/->DeclaredEntityTarget page-ref))
    (wake/->SingleField nil)
    (wake/->CreateWrite nil)
    "wake-test-single-publication/field/revision/page-ref"
    true]
   [status "revision/status" "status" Keyword
    (wake/->StateField publish-status-ref)
    (wake/->SingleField nil)
    (wake/->CommandFieldWrite nil)
    "wake-test-single-publication/field/revision/status"
    true]]
  []
  "wake-test-single-publication/entity/revision")

(wake/defpublication
  canonical
  "canonical"
  "canonical"
  page-ref
  page-canonical-revision-ref
  revision-ref
  revision-page-ref-ref
  revision-status-ref
  publish-status-draft-ref
  publish-status-published-ref
  publish-status-retired-ref)

(wake/defcomponent-model
  revision-row
  "revision-row"
  [(wake/->ComponentPropertySpec :id (wake/->StringValueType nil nil nil))
   (wake/->ComponentPropertySpec
     :page-ref
     (wake/->EntityReferenceValueType page-ref))
   (wake/->ComponentPropertySpec
     :status
     (wake/->StateValueType publish-status-ref))]
  [(wake/->Element
     :div
     {:class (wake/->StaticAttr "row")}
     [(wake/->Element :span {:text (wake/->BindAttr :id)} [])
      (wake/->Element :span {:text (wake/->BindAttr :status)} [])])])

(wake/defview-model
  revisions
  "revisions"
  "revisions"
  revision-ref
  revision-row-ref
  "Revisions"
  nil
  nil)

(wake/application-root
  application
  "wake-test-single-publication"
  (wake/->FramAuthority "fram")
  [(wake/->StorageSpec page-ref "wake-test-single-publication/entity/page")
   (wake/->StorageSpec revision-ref "wake-test-single-publication/entity/revision")]
  [(wake/->IdentitySpec page-ref page-slug-ref)
   (wake/->IdentitySpec revision-ref revision-id-ref)]
  []
  nil
  nil
  [canonical-ref]
  []
  [])
`;

const schemaOnlyProgram = `#lang beagle/js
(ns wake.tests.schema-only
  (:require [wake.core :as wake]))

(wake/defentity-ref page "page" "page")

(wake/define-entity-model
  page
  Page
  "page"
  [[id "page/id" "id" String
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->IdentityWrite nil)
    "wake-schema-only/field/page/id"
    true]
   [title "page/title" "title" String
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->SetWrite nil)
    "wake-schema-only/field/page/title"
    true]]
  []
  "wake-schema-only/entity/page")

(wake/application-root
  application
  "wake-schema-only"
  (wake/->FramAuthority "fram")
  [(wake/->StorageSpec page-ref "wake-schema-only/entity/page")]
  [(wake/->IdentitySpec page-ref page-id-ref)]
  []
  nil
  nil
  []
  []
  [])
`;

test("generated bindings are injective and related FRAM creates obey the entity contract", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "wake-compiler-contracts-"));
  try {
    const generated = await compileAll(
      "tests/fixtures/compiler-contracts-list-detail.bjs",
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
  const sourcePath = join(outputDir, "single-publication.bjs");
  writeFileSync(sourcePath, singlePublicationProgram);

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

test("compiler rejects list-detail declarations it cannot all generate", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-list-detail-cardinality-"));
  const sourcePath = join(temporary, "two-list-details.bjs");
  const source = readFileSync(
    join(webRoot, "tests", "fixtures", "compiler-contracts-list-detail.bjs"),
    "utf8",
  )
    .replace(
      /\n\(wake\/defform[\s\S]*?\(wake\/->ClearFormSuccess nil\)\)\n/u,
      "\n",
    )
    .replace("  [add-blog-post-ref]\n", "  []\n");
  const secondListDetail = `(wake/deflist-detail
  blog-note-detail
  "blog-note"
  "blog-note"
  blog-note-ref
  "Blog notes"
  [blog-note-note-id-ref blog-note-summary-ref]
  [blog-note-note-id-ref blog-note-summary-ref]
  [(wake/->FieldsDetailTab
     "Overview"
     [blog-note-note-id-ref blog-note-summary-ref])])

`;
  writeFileSync(sourcePath, source
    .replace("(wake/application-root", `${secondListDetail}(wake/application-root`)
    .replace(
      "[blog-post-detail-ref])",
      "[blog-post-detail-ref blog-note-detail-ref])",
    ));
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
  const sourcePath = join(temporary, "read-only-list.bjs");
  const source = readFileSync(
    join(webRoot, "tests", "fixtures", "compiler-contracts-list-detail.bjs"),
    "utf8",
  )
    .replace(
      /\n\(wake\/defform[\s\S]*?\(wake\/->ClearFormSuccess nil\)\)\n/u,
      "\n",
    )
    .replace("  [add-blog-post-ref]\n", "  []\n");
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

test("schema-only FRAM programs remain valid", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-schema-only-fram-"));
  const sourcePath = join(temporary, "schema-only.bjs");
  writeFileSync(sourcePath, schemaOnlyProgram);
  try {
    const fram = compileFram(sourcePath);
    assert.equal(fram.status, 0, `${fram.stdout}\n${fram.stderr}`);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}, COMPILER_TEST_TIMEOUT_MS);

test("browser generation rejects schema-only programs without a UI root", () => {
  const temporary = mkdtempSync(join(tmpdir(), "wake-schema-only-browser-"));
  const sourcePath = join(temporary, "schema-only.bjs");
  writeFileSync(sourcePath, schemaOnlyProgram);
  try {
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

const uiRootTopologyCases = (() => {
  const base = readFileSync(
    join(webRoot, "tests", "fixtures", "compiler-contracts-list-detail.bjs"),
    "utf8",
  );
  const form = base.match(
    /\n\(wake\/defform[\s\S]*?\(wake\/->ClearFormSuccess nil\)\)\n/u,
  )?.[0];
  assert.ok(form, "fixture must contain one smart form");
  const secondForm = form
    .replaceAll("add-blog-post", "add-blog-post-again");
  const view = `(wake/defcomponent-model
  blog-row
  "blog-row"
  [(wake/->ComponentPropertySpec :id (wake/->StringValueType nil nil nil))]
  [(wake/->Element :div {:text (wake/->BindAttr :id)} [])])

(wake/defview-model
  blogs
  "blogs"
  "blogs"
  blog-post-ref
  blog-row-ref
  "Blogs"
  nil
  nil)

`;
  return [
    [
      "multiple forms",
      base
        .replace("(wake/application-root", `${secondForm}(wake/application-root`)
        .replace(
          "  [add-blog-post-ref]\n",
          "  [add-blog-post-ref add-blog-post-again-ref]\n",
        ),
      /program may declare at most one list-detail form/,
    ],
    [
      "a mismatched form owner",
      base.replace(
        `(wake/defform
  add-blog-post
  "add-blog-post"
  "add-blog-post"
  blog-post-ref`,
        `(wake/defform
  add-blog-post
  "add-blog-post"
  "add-blog-post"
  blog-note-ref`,
      ),
      /targets entity 'blog-note' but the list detail owns 'blog-post'/,
    ],
    [
      "combined view and list roots",
      base.replace("(wake/application-root", `${view}(wake/application-root`),
      /program cannot combine view and list-detail UI roots/,
    ],
  ];
})();

for (const [name, source, expected] of uiRootTopologyCases) {
  test(`compiler rejects ${name}`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "wake-ui-root-topology-"));
    const sourcePath = join(temporary, "application.bjs");
    writeFileSync(sourcePath, source);
    try {
      const result = compileFram(sourcePath);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, expected);
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  }, COMPILER_TEST_TIMEOUT_MS);
}
