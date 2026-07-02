import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectReleaseReadiness } from "../scripts/release-doctor.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("release doctor allows the current preview build with explicit warnings", () => {
  const result = inspectReleaseReadiness({ root: ROOT, target: "preview", platform: "win32" });
  assert.equal(result.ok, true);
  assert.equal(result.releaseStage, "preview");
  assert.equal(result.findings.length, 0);
  assert.ok(result.warnings.some((item) => item.includes("Preview release doctor")));
  assert.ok(result.warnings.some((item) => item.includes("No packaged artifact")));
});

test("release doctor fails closed for stable without release credentials and signed artifacts", () => {
  const result = inspectReleaseReadiness({
    root: ROOT,
    target: "stable",
    platform: "win32",
    artifact: "dist/missing.exe"
  });
  assert.equal(result.ok, false);
  const text = JSON.stringify(result.findings);
  assert.match(text, /releaseStage=stable/);
  assert.match(text, /license-public-key\.pem/);
  assert.match(text, /release-public-key\.pem/);
  assert.match(text, /update-public-key\.pem/);
  assert.match(text, /Stable builds require a release-signed integrity manifest|Integrity manifest/);
  assert.match(text, /Packaged artifact does not exist/);
  assert.match(text, /Windows signature policy/);
});
