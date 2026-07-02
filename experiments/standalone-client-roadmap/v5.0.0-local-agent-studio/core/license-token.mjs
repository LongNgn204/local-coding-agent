import { sign, verify } from "node:crypto";

const PRODUCT = "local-agent-studio";

export function createLicenseToken(claims, privateKeyPem) {
  if (!privateKeyPem) throw new Error("License signing private key is required.");
  const payload = normalizeLicenseClaims(claims);
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, payloadBytes, privateKeyPem).toString("base64url");
  return `${payloadBytes.toString("base64url")}.${signature}`;
}

export function verifyLicenseToken(token, publicKeyPem) {
  if (!publicKeyPem) throw new Error("License public key is required.");
  const parts = String(token || "").split(".");
  if (parts.length !== 2) throw new Error("Invalid license token format.");
  const payloadBytes = Buffer.from(parts[0], "base64url");
  const signature = Buffer.from(parts[1], "base64url");
  if (!verify(null, payloadBytes, publicKeyPem, signature)) throw new Error("License signature is invalid.");
  const claims = JSON.parse(payloadBytes.toString("utf8"));
  return normalizeLicenseClaims(claims);
}

export function normalizeLicenseClaims(claims = {}) {
  const output = {
    product: PRODUCT,
    licenseId: requiredString(claims.licenseId, "licenseId"),
    customerId: requiredString(claims.customerId, "customerId"),
    edition: requiredString(claims.edition, "edition"),
    issuedAt: validDate(claims.issuedAt || new Date().toISOString(), "issuedAt"),
    ...(claims.notBefore ? { notBefore: validDate(claims.notBefore, "notBefore") } : {}),
    ...(claims.expiresAt ? { expiresAt: validDate(claims.expiresAt, "expiresAt") } : {}),
    features: normalizeFeatures(claims.features)
  };
  for (const key of ["seats", "deviceLimit"]) {
    if (claims[key] == null || claims[key] === "") continue;
    const value = Number(claims[key]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`License ${key} must be a positive integer.`);
    output[key] = value;
  }
  if (claims.notes) output.notes = String(claims.notes).slice(0, 500);
  return output;
}

function requiredString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`License ${name} is required.`);
  if (text.length > 120) throw new Error(`License ${name} is too long.`);
  return text;
}

function validDate(value, name) {
  const text = String(value || "").trim();
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`License ${name} must be an ISO date/time.`);
  return new Date(time).toISOString();
}

function normalizeFeatures(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].sort();
}
