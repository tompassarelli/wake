import { afterEach, describe, expect, test } from "bun:test";
import { parseCanonicalDocument, sha256Digest } from "../compiler/canonical.mjs";
import { packPlugin } from "../compiler/plugin-package.mjs";

const webRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const fixtureRoot = `${webRoot}/tests/fixtures/composition-plugin`;
const scratchRoots = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    const result = Bun.spawnSync(["rm", "-rf", root], { stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
});

async function fixture(source) {
  const root = `/tmp/wake-composition-${crypto.randomUUID()}`;
  const artifactRoot = `${root}/artifacts`;
  const create = Bun.spawnSync(["mkdir", "-p", artifactRoot], {
    stderr: "pipe",
    stdout: "pipe",
  }, 30_000);
  if (create.exitCode !== 0) throw new Error(create.stderr.toString());
  await Bun.write(`${root}/app.bjs`, source);
  const packed = await packPlugin(fixtureRoot);
  await Bun.write(`${artifactRoot}/composition-plugin.wakepkg.json`, packed.bytes);
  const commit = Bun.spawnSync(["git", "-C", webRoot, "rev-parse", "HEAD"])
    .stdout.toString().trim();
  await Bun.write(`${root}/wake.lock`, `${JSON.stringify({
    pluginAbiVersion: 1,
    plugins: [{
      artifact: "artifacts/composition-plugin.wakepkg.json",
      digest: packed.digest,
      packageId: "wake-composition-plugin",
      source: { commit, kind: "git" },
      version: "0.1.0",
    }],
    schemaVersion: 1,
  })}\n`);
  scratchRoots.push(root);
  return root;
}

function runCompile(root) {
  return Bun.spawnSync([
    `${webRoot}/bin/wake-compile`,
    "--all",
    `${root}/app.bjs`,
    `${root}/out`,
  ], { cwd: webRoot, stderr: "pipe", stdout: "pipe" });
}

async function runGeneratedRoute(root) {
  await Bun.write(`${root}/execute-route.mjs`, `
class FakeClassList {
  constructor() { this.values = new Set(); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : force;
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.classList = new FakeClassList();
    this.dataset = Object.create(null);
    this.listeners = Object.create(null);
    this.style = Object.create(null);
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  focus() {}
  remove() {}
  replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
  setAttribute(name, value) { this[name] = value; }
  get childElementCount() { return this.children.length; }
}
const appRoot = new FakeElement("root");
globalThis.document = {
  body: new FakeElement("body"),
  documentElement: new FakeElement("html"),
  createElement: tag => new FakeElement(tag),
  getElementById: () => appRoot,
  querySelector: () => null,
};
globalThis.window = { WAKE_MOUNT_ID: "app", addEventListener() {} };
globalThis.location = { hash: "", pathname: "/releases/release-1" };
globalThis.history = { pushState(_state, _title, path) { location.pathname = path; } };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.setTimeout = () => 1;
globalThis.clearTimeout = () => {};
const calls = [];
globalThis.fetch = async (_path, options) => {
  const body = JSON.parse(options.body);
  calls.push(body);
  return new Response(JSON.stringify({
    row: { id: "release-1", state: "stable" },
    servedVersion: "7",
  }), { headers: { "Content-Type": "application/json" } });
};
await import("./out/app.js");
for (let index = 0; index < 20; index += 1) await Promise.resolve();
function containsClass(element, name) {
  return element.className === name
    || element.children.some(child => containsClass(child, name));
}
if (!containsClass(appRoot, "application-release-card")) {
  throw new Error("mounted route did not render its checked component");
}
process.stdout.write(JSON.stringify(calls));
`);
  return Bun.spawnSync(["bun", `${root}/execute-route.mjs`], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
}

const application = `#lang beagle/js
(ns wake.fixtures.composition
  (:require [wake.core :as wake]))

(wake/defentity-ref actor "actor" "actor")

(wake/define-entity-model
  actor
  Actor
  "actor"
  [[id "actor/id" "id" String
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->IdentityWrite nil)
    "wake-composition-fixture/field/actor/id"
    true]]
  []
  "wake-composition-fixture/entity/actor")

(wake/defcomponent-model
  application-release-card
  "application-release-card"
  [(wake/->ComponentPropertySpec
     :current-id
     (wake/->StringValueType nil nil nil))
   (wake/->ComponentPropertySpec
     :current-state
     (wake/->StringValueType nil nil nil))]
  [(wake/->Element
     :div
     {:class (wake/->StaticAttr "application-release-card")}
     [(wake/->Element :h2 {:text (wake/->BindAttr :current-id)} [])
      (wake/->Element :p {:text (wake/->BindAttr :current-state)} [])])])

(wake/defplugin-use release-plugin "release-plugin")

(wake/defplugin-bindings
  plugin-bindings
  [] [] [] [] [] [] [] [] [] [])

(wake/bind-provider
  release-summary-provider
  release-plugin-ref
  "release-summary"
  "release-summary"
  "release-summary-provider")

(wake/extend-entity-fields
  release-fields-extension
  release-plugin-ref
  "release-fields"
  "release-fields"
  [[channel
    "release-fields/channel"
    "channel"
    (wake/->StringField nil)
    (wake/->SingleField nil)
    (wake/->CreateWrite nil)
    "wake-composition-fixture/field/release/channel"
    true]
   [owner
    "release-fields/owner"
    "owner"
    (wake/->RefField (wake/->DeclaredEntityTarget actor-ref))
    (wake/->SingleField nil)
    (wake/->CreateWrite nil)
    "wake-composition-fixture/field/release/owner"
    true]])

(wake/fill-component-slot
  release-card-fill
  release-plugin-ref
  "release-card"
  "release-card"
  application-release-card-ref)

(wake/mount-route-slot
  release-detail-mount
  release-plugin-ref
  "release-detail"
  "release-detail"
  "/releases/:release-id")

(wake/use-plugin
  release-plugin
  "wake-composition-plugin"
  "0.1.0"
  [(wake/->SchemaContribution nil)
   (wake/->QueryContribution nil)
   (wake/->CapabilityContribution nil)
   (wake/->UiContribution nil)
   (wake/->RouteContribution nil)]
  plugin-bindings
  [release-summary-provider]
  [release-fields-extension]
  [release-card-fill]
  [release-detail-mount])

(wake/application-root
  application
  "wake-composition-fixture"
  (wake/->FramAuthority "fram")
  [(wake/->StorageSpec actor-ref "wake-composition-fixture/entity/actor")]
  [(wake/->IdentitySpec actor-ref actor-id-ref)]
  [release-plugin-composition]
  (wake/->MountedDefaultRoute release-detail-mount-ref)
  nil
  []
  []
  [])
`;

describe("W3 checked application composition", () => {
  test("materializes provider, extension, fill, and parameterized mount once", async () => {
    const root = await fixture(application);
    const result = runCompile(root);
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const plan = JSON.parse(await Bun.file(`${root}/out/app.fram.json`).text());
    const release = plan.entities.find(entity => entity.name === "release-plugin.release");
    expect(release).toBeDefined();
    expect(release.fields.find(field => field.name === "channel")).toMatchObject({
      cardinality: "single",
      storageId: "wake-composition-fixture/field/release/channel",
      type: "String",
      write: "create",
    });
    expect(release.fields.find(field => field.name === "owner")).toMatchObject({
      storageId: "wake-composition-fixture/field/release/owner",
      targetEntity: "actor",
      type: "Ref",
      valueKind: "ref",
      write: "create",
    });
    const releaseQuery = plan.queries.find(query => (
      query.name === "release-plugin.release-by-id"
    ));
    expect(releaseQuery.capabilities).toEqual([
      "wake-composition-plugin/cap/read-release",
    ]);
    expect(releaseQuery.select.slice(2)).toEqual([
      {
        binding: "item",
        cardinality: "single",
        entity: "release-plugin.release",
        field: "channel",
        name: "channel",
        type: "String",
        valueKind: "literal",
      },
      {
        binding: "item",
        cardinality: "single",
        entity: "release-plugin.release",
        field: "owner",
        name: "owner",
        targetEntity: "actor",
        type: "Ref",
        valueKind: "ref",
      },
    ]);
    expect(releaseQuery.dependencies).toContainEqual({
      entity: "release-plugin.release",
      field: "channel",
    });
    expect(releaseQuery.dependencies).toContainEqual({
      entity: "release-plugin.release",
      field: "owner",
    });
    expect(plan.composition.providers).toHaveLength(1);
    expect(plan.composition.providers[0]).toMatchObject({
      name: "release-summary-provider",
      package_id: "wake-composition-plugin",
      port_name: "release-summary",
    });
    expect(plan.composition.extensions[0]).toMatchObject({
      kind: "entity-fields",
      package_id: "wake-composition-plugin",
      port: "release-plugin.release-fields",
      target: "release-plugin.release",
    });
    expect(plan.composition.fills[0]).toMatchObject({
      component: "application-release-card",
      target_component: "release-plugin.release-card",
    });
    expect(plan.composition.mounts[0]).toMatchObject({
      parameters: ["release-id"],
      path: "/releases/:release-id",
      target_route: "release-plugin.release-detail",
    });
    expect(plan.routes).toEqual([{
      inputParameters: ["release-id"],
      parameters: ["release-id"],
      path: "/releases/:release-id",
      queries: [{ name: "release-plugin.release-by-id", prefix: "current" }],
      requiredProps: ["current-id", "current-state"],
      view: "release-plugin.release-detail",
    }]);

    const manifestText = await Bun.file(`${root}/out/app.wake.manifest.json`).text();
    const manifest = parseCanonicalDocument(manifestText, "fixture manifest");
    const clientText = await Bun.file(`${root}/out/wake-client.js`).text();
    expect(manifest.artifacts.browserClient).toEqual({
      path: "wake-client.js",
      sha256: sha256Digest(clientText),
    });
    const deploymentText = await Bun.file(`${root}/out/app.wake.deployment.json`).text();
    const deployment = parseCanonicalDocument(deploymentText, "fixture deployment receipt");
    expect(deployment).toEqual({
      applicationId: manifest.applicationId,
      applicationManifestDigest: sha256Digest(manifestText),
      browserClientDigest: sha256Digest(clientText),
      browserJavaScriptDigest: sha256Digest(await Bun.file(`${root}/out/app.js`).text()),
      framPlanDigest: sha256Digest(await Bun.file(`${root}/out/app.fram.json`).text()),
      schemaVersion: 1,
    });
    expect(manifest.digests.operationSurface).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(manifest.digests.storageProjection).not.toBe(sha256Digest(JSON.stringify({
      applicationId: "not-the-real-canonical-document",
    })));
    const javascript = await Bun.file(`${root}/out/app.js`).text();
    expect(javascript).toContain("application-release-card");
    expect(javascript).toContain('className = "application-release-card"');
    expect(javascript).not.toContain('className = "release-card"');
    expect(javascript).toContain("wakeMatchRoute(location.pathname)");
    expect(javascript).toContain("query: descriptor.name");
    expect(javascript).toContain("history.pushState");
    const built = await Bun.build({
      entrypoints: [`${root}/out/app.js`, `${root}/out/wake-client.js`],
      target: "browser",
      write: false,
    });
    expect(built.success, built.logs.join("\n")).toBe(true);
    const executed = await runGeneratedRoute(root);
    expect(executed.exitCode, executed.stderr.toString()).toBe(0);
    expect(JSON.parse(executed.stdout.toString())).toContainEqual(expect.objectContaining({
      input: { "release-id": "release-1" },
      op: "execute",
      query: "release-plugin.release-by-id",
    }));
    expect(clientText).not.toContain("document.");
    expect(clientText).not.toContain("init();");
    expect(clientText).not.toContain("fetch(");
    expect(clientText).not.toContain("/api/wake/");
    const client = await import(`${root}/out/wake-client.js`);
    expect(client.semanticFingerprint).toBe(manifest.checkedApplication.fingerprint);
    expect(client.queryDescriptor("release-plugin.release-by-id")).toMatchObject({
      capabilities: ["wake-composition-plugin/cap/read-release"],
      input: [{ name: "release-id", required: true, value: { kind: "string" } }],
      result: { kind: "optional" },
    });
    expect(client.normalizeQueryInput(
      "release-plugin.release-by-id",
      { "release-id": "release-1" },
    )).toEqual({ "release-id": "release-1" });
  }, 60_000);

  test("rejects undeclared ports, duplicate route patterns, and missing extension targets", async () => {
    for (const [change, expected] of [
      [
        source => source.replace("release-plugin.release-summary", "release-plugin.unknown-provider"),
        "unexported provider port 'unknown-provider'",
      ],
      [
        source => `${source}(mount release-plugin.release-detail :path "/releases/:other-id")\n`,
        "route slot 'release-plugin.release-detail' is mounted twice",
      ],
      [
        source => source.replace("release-plugin.release-fields", "release-plugin.unknown-fields"),
        "unknown extension port 'unknown-fields'",
      ],
    ]) {
      const root = await fixture(change(application));
      const result = runCompile(root);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(expected);
    }
  }, 60_000);

  test("rejects missing storage identity and incompatible component fills", async () => {
    const withoutStorage = application.replace(
      '    :storage-id "wake-composition-fixture/field/release/channel"\n',
      "",
    );
    let root = await fixture(withoutStorage);
    let result = runCompile(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("requires :storage-id");

    const incompatible = application
      .replace(":props [current-id current-state]", ":props [current-id]");
    root = await fixture(incompatible);
    result = runCompile(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("lacks required props: current-state");
  }, 30_000);
});
