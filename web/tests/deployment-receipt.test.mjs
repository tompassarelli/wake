import { describe, expect, test } from "bun:test";
import {
  canonicalDocument,
  parseCanonicalDocument,
  sha256Digest,
} from "../compiler/canonical.mjs";
import { generateDeploymentReceipt } from "../compiler/deployment-receipt.mjs";

function fixture() {
  const browserClient = "export const client = true;\n";
  const browserJavaScript = "export const app = true;\n";
  const storePlan = canonicalDocument({ backend: "store", schemaVersion: 2 });
  const manifest = canonicalDocument({
    applicationId: "example-application",
    artifacts: {
      browserClient: {
        path: "wake-client.js",
        sha256: sha256Digest(browserClient),
      },
      browserJavaScript: {
        path: "app.js",
        sha256: sha256Digest(browserJavaScript),
      },
      storePlan: {
        path: "app.store.json",
        sha256: sha256Digest(storePlan),
      },
    },
  });
  return { browserClient, browserJavaScript, storePlan, manifest };
}

describe("deployment artifact receipt", () => {
  test("publishes a closed versioned receipt schema", async () => {
    const schema = await Bun.file(
      `${import.meta.dir}/../contracts/app-wake-deployment-v1.schema.json`,
    ).json();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "applicationId",
      "applicationManifestDigest",
      "browserClientDigest",
      "browserJavaScriptDigest",
      "storePlanDigest",
      "schemaVersion",
    ]);
  });

  test("canonically binds every emitted compiler artifact", () => {
    const input = fixture();
    const first = generateDeploymentReceipt(input);
    const second = generateDeploymentReceipt(input);
    expect(first).toBe(second);
    expect(first).toBe(canonicalDocument(JSON.parse(first)));
    expect(parseCanonicalDocument(first)).toEqual({
      applicationId: "example-application",
      applicationManifestDigest: sha256Digest(input.manifest),
      browserClientDigest: sha256Digest(input.browserClient),
      browserJavaScriptDigest: sha256Digest(input.browserJavaScript),
      storePlanDigest: sha256Digest(input.storePlan),
      schemaVersion: 1,
    });
  });

  test("rejects bytes that disagree with the manifest", () => {
    const input = fixture();
    expect(() => generateDeploymentReceipt({
      ...input,
      browserClient: `${input.browserClient}// tampered\n`,
    })).toThrow("manifest browserClient does not describe the exact wake-client.js bytes");
  });

  test("rejects a noncanonical manifest", () => {
    const input = fixture();
    expect(() => generateDeploymentReceipt({
      ...input,
      manifest: JSON.stringify(JSON.parse(input.manifest)),
    })).toThrow("application manifest is not canonical JSON");
  });
});
