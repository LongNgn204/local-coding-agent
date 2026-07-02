import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LicenseService } from "../core/license-service.mjs";
import { normalizeLicenseClaims, verifyLicenseToken } from "../core/license-token.mjs";
import { generateLicenseKeypair } from "../scripts/generate-license-keypair.mjs";
import { issueLicenseToken } from "../scripts/generate-license-token.mjs";

test("license issuer creates admin-signed tokens accepted by stable app verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-license-issuer-"));
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
  const privateKeyFile = join(dir, "license-private-key.pem");
  writeFileSync(privateKeyFile, privateKeyPem, { encoding: "utf8", mode: 0o600 });
  try {
    const issued = issueLicenseToken({
      privateKeyFile,
      licenseId: "lic_customer_a",
      customerId: "customer_a",
      edition: "team",
      issuedAt: "2026-07-02T00:00:00Z",
      expiresAt: "2027-07-02T00:00:00Z",
      features: ["agent", "updates", "agent"],
      seats: "5",
      deviceLimit: "3"
    });
    assert.equal(issued.publicKeyPem, publicKeyPem);
    assert.equal(issued.claims.product, "local-agent-studio");
    assert.deepEqual(issued.claims.features, ["agent", "updates"]);
    assert.equal(issued.claims.seats, 5);

    const service = new LicenseService({
      storageDir: dir,
      manifest: { releaseStage: "stable" },
      publicKeyPem,
      now: () => Date.parse("2026-08-01T00:00:00Z")
    });
    const activated = service.activate(issued.token, { persist: false });
    assert.equal(activated.allowed, true);
    assert.equal(activated.claims.licenseId, "lic_customer_a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("license keygen writes a non-overwriting Ed25519 keypair usable by issuer", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-license-keygen-"));
  try {
    const generated = generateLicenseKeypair({ outDir: dir });
    assert.equal(existsSync(generated.privateKeyFile), true);
    assert.equal(existsSync(generated.publicKeyFile), true);
    assert.throws(() => generateLicenseKeypair({ outDir: dir }), /Refusing to overwrite/);

    const issued = issueLicenseToken({
      privateKeyFile: generated.privateKeyFile,
      publicKeyFile: generated.publicKeyFile,
      licenseId: "lic_keygen",
      customerId: "customer_keygen",
      edition: "pro",
      features: ["agent"]
    });
    assert.equal(issued.claims.licenseId, "lic_keygen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("license claim normalization rejects invalid dates and counts", () => {
  assert.throws(() => normalizeLicenseClaims({
    licenseId: "lic_bad",
    customerId: "customer_bad",
    edition: "pro",
    issuedAt: "not-a-date"
  }), /issuedAt/);
  assert.throws(() => normalizeLicenseClaims({
    licenseId: "lic_bad",
    customerId: "customer_bad",
    edition: "pro",
    seats: "0"
  }), /seats/);
});

test("license token verifier rejects a mismatched public key", () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-license-mismatch-"));
  const keys = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const privateKeyFile = join(dir, "license-private-key.pem");
  writeFileSync(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  try {
    const issued = issueLicenseToken({
      privateKeyFile,
      licenseId: "lic_mismatch",
      customerId: "customer_mismatch",
      edition: "pro"
    });
    assert.throws(
      () => verifyLicenseToken(issued.token, other.publicKey.export({ type: "spki", format: "pem" })),
      /signature/i
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
