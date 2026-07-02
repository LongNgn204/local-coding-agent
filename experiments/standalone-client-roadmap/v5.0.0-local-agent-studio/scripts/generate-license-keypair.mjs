#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export function generateLicenseKeypair(options = {}) {
  const outDir = resolve(options.outDir || process.cwd());
  const privateKeyFile = resolve(options.privateKeyFile || join(outDir, "license-private-key.pem"));
  const publicKeyFile = resolve(options.publicKeyFile || join(outDir, "license-public-key.pem"));
  if (!options.force) {
    for (const file of [privateKeyFile, publicKeyFile]) {
      if (existsSync(file)) throw new Error(`Refusing to overwrite existing key file: ${file}`);
    }
  }
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
  mkdirSync(dirname(privateKeyFile), { recursive: true });
  mkdirSync(dirname(publicKeyFile), { recursive: true });
  writeFileSync(privateKeyFile, privateKeyPem, { encoding: "utf8", mode: 0o600 });
  writeFileSync(publicKeyFile, publicKeyPem, { encoding: "utf8", mode: 0o644 });
  return { privateKeyFile, publicKeyFile, publicKeyPem };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    const result = generateLicenseKeypair(options);
    console.log(JSON.stringify({
      ok: true,
      privateKeyFile: result.privateKeyFile,
      publicKeyFile: result.publicKeyFile,
      next: [
        "Keep the private key offline or in KMS/HSM.",
        "Copy only license-public-key.pem into Stable builds.",
        "Use npm run license:issue with LCA_LICENSE_SIGNING_PRIVATE_KEY_FILE pointing to the private key."
      ]
    }, null, 2));
  } catch (error) {
    console.error(`ERROR: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

function usage() {
  console.log(`Local Agent Studio license key generator

Usage:
  npm run license:keygen -- --out-dir C:\\secure\\local-agent-studio-license

Options:
  --out-dir <dir>             Directory for license-private-key.pem and license-public-key.pem
  --private-key-file <path>   Exact private key output path
  --public-key-file <path>    Exact public key output path
  --force                     Overwrite existing key files
`);
}

function parseArgs(values) {
  const parsed = {};
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
      case "--out-dir":
        parsed.outDir = resolve(next());
        break;
      case "--private-key-file":
        parsed.privateKeyFile = resolve(next());
        break;
      case "--public-key-file":
        parsed.publicKeyFile = resolve(next());
        break;
      case "--force":
        parsed.force = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
