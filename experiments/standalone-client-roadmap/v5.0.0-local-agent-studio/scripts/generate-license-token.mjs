#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLicenseToken, normalizeLicenseClaims, verifyLicenseToken } from "../core/license-token.mjs";

const SIGNING_KEY_ENV = "LCA_LICENSE_SIGNING_PRIVATE_KEY_FILE";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export function issueLicenseToken(options = {}, env = process.env) {
  const claims = normalizeLicenseClaims({
    licenseId: options.licenseId,
    customerId: options.customerId,
    edition: options.edition || "pro",
    issuedAt: options.issuedAt,
    notBefore: options.notBefore,
    expiresAt: options.expiresAt,
    features: options.features || [],
    seats: options.seats,
    deviceLimit: options.deviceLimit,
    notes: options.notes
  });
  const privateKeyFile = options.privateKeyFile || env[SIGNING_KEY_ENV];
  if (!privateKeyFile) throw new Error(`Set ${SIGNING_KEY_ENV} or pass --private-key-file.`);
  if (!existsSync(privateKeyFile)) throw new Error(`License signing private key file not found: ${privateKeyFile}`);
  const privateKeyPem = readFileSync(privateKeyFile, "utf8");
  const token = createLicenseToken(claims, privateKeyPem);
  const publicKeyPem = options.publicKeyFile
    ? readFileSync(options.publicKeyFile, "utf8")
    : createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" });
  const verifiedClaims = verifyLicenseToken(token, publicKeyPem);
  return { token, claims: verifiedClaims, publicKeyPem };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    const result = issueLicenseToken(options);
    const output = {
      token: result.token,
      claims: result.claims,
      publicKeyPem: options.showPublicKey ? result.publicKeyPem : "[hidden; write this to license-public-key.pem for Stable builds]"
    };
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (options.out) {
      writeFileSync(options.out, text, { encoding: "utf8", mode: 0o600 });
      console.log(`License token written to: ${resolve(options.out)}`);
    } else {
      process.stdout.write(text);
    }
  } catch (error) {
    console.error(`ERROR: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

function usage() {
  console.log(`Local Agent Studio license issuer

Usage:
  npm run license:issue -- --license-id lic_001 --customer-id customer_001 --edition pro --expires-at 2027-01-01T00:00:00Z

Required:
  --license-id <id>           Unique license id
  --customer-id <id>          Customer/account id
  ${SIGNING_KEY_ENV}          Ed25519 private key PEM file, or --private-key-file

Options:
  --edition <name>            Edition name (default: pro)
  --feature <name>            Feature flag; repeatable or comma-separated
  --seats <n>                 Seat count
  --device-limit <n>          Device limit
  --not-before <iso>          License activation start
  --expires-at <iso>          License expiry
  --issued-at <iso>           Issue timestamp (default: now)
  --notes <text>              Short admin note
  --private-key-file <path>   Signing key file for this run
  --public-key-file <path>    Public key used to self-verify output
  --show-public-key           Include derived public key in JSON output
  --out <file>                Write JSON output to a file
`);
}

function parseArgs(values) {
  const parsed = { features: [] };
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      if (index + 1 >= values.length) throw new Error(`Missing value for ${arg}`);
      return values[++index];
    };
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--license-id":
        parsed.licenseId = next();
        break;
      case "--customer-id":
        parsed.customerId = next();
        break;
      case "--edition":
        parsed.edition = next();
        break;
      case "--feature":
        parsed.features.push(...next().split(","));
        break;
      case "--seats":
        parsed.seats = next();
        break;
      case "--device-limit":
        parsed.deviceLimit = next();
        break;
      case "--not-before":
        parsed.notBefore = next();
        break;
      case "--expires-at":
        parsed.expiresAt = next();
        break;
      case "--issued-at":
        parsed.issuedAt = next();
        break;
      case "--notes":
        parsed.notes = next();
        break;
      case "--private-key-file":
        parsed.privateKeyFile = resolve(next());
        break;
      case "--public-key-file":
        parsed.publicKeyFile = resolve(next());
        break;
      case "--show-public-key":
        parsed.showPublicKey = true;
        break;
      case "--out":
        parsed.out = resolve(next());
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
