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
