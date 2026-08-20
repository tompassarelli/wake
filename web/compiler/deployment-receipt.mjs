import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "./canonical.mjs";

const OUTPUTS = Object.freeze({
  browserClient: "wake-client.js",
  browserJavaScript: "app.js",
  storePlan: "app.store.json",
});

function fail(message) {
  throw new TypeError(`wake deployment receipt: ${message}`);
}

function bytes(value, label) {
  const checked = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : null;
  if (checked === null || checked.byteLength === 0) {
    fail(`${label} must be nonempty exact bytes or text`);
  }
  return checked;
}

function canonicalManifest(value) {
  const exact = bytes(value, "application manifest");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(exact);
  } catch {
    fail("application manifest must be UTF-8");
  }
  return Object.freeze({
    bytes: exact,
    value: parseCanonicalDocument(text, "application manifest"),
  });
}

function assertManifestArtifact(manifest, name, path, exactBytes) {
  const descriptor = manifest?.artifacts?.[name];
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)
      || Object.keys(descriptor).length !== 2
      || descriptor.path !== path
      || descriptor.sha256 !== sha256Digest(exactBytes)) {
    fail(`application manifest ${name} does not describe the exact ${path} bytes`);
  }
}

/**
 * Binds the exact four compiler outputs without introducing a self-hash.
 * The returned canonical document is the fifth deployment artifact.
 */
export function generateDeploymentReceipt({
  browserClient,
  browserJavaScript,
  storePlan,
  manifest,
} = {}) {
  const artifacts = Object.freeze({
    browserClient: bytes(browserClient, OUTPUTS.browserClient),
    browserJavaScript: bytes(browserJavaScript, OUTPUTS.browserJavaScript),
    storePlan: bytes(storePlan, OUTPUTS.storePlan),
  });
  const manifestDocument = canonicalManifest(manifest);
  const manifestValue = manifestDocument.value;
  if (manifestValue === null || typeof manifestValue !== "object"
      || Array.isArray(manifestValue)
      || typeof manifestValue.applicationId !== "string"
      || manifestValue.applicationId.length === 0) {
    fail("application manifest has no applicationId");
  }

  for (const [name, path] of Object.entries(OUTPUTS)) {
    assertManifestArtifact(manifestValue, name, path, artifacts[name]);
  }

  return canonicalDocument({
    applicationId: manifestValue.applicationId,
    applicationManifestDigest: sha256Digest(manifestDocument.bytes),
    browserClientDigest: sha256Digest(artifacts.browserClient),
    browserJavaScriptDigest: sha256Digest(artifacts.browserJavaScript),
    storePlanDigest: sha256Digest(artifacts.storePlan),
    schemaVersion: 1,
  });
}
