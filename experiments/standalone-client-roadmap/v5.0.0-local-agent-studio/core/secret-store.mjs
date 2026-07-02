import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";

const VERSION = 1;
const ALLOWED_PROVIDERS = new Set(["openai", "anthropic"]);

export class SecretStore {
  constructor(storageDir) {
    this.dir = join(storageDir, "secrets");
    this.keyFile = join(this.dir, "master.key");
    this.vaultFile = join(this.dir, "vault.json");
    this.masterKey = null;
    this.runtimeSecrets = new Map();
    this.runtimeMetadata = new Map();
  }

  async status() {
    const vault = await this.readVault();
    return Object.fromEntries(Object.entries(vault.providers || {}).map(([provider, entry]) => [
      provider,
      publicEntry(entry)
    ]));
  }

  async has(provider) {
    return Boolean(await this.get(provider));
  }

  async get(provider) {
    assertProvider(provider);
    const env = envSecret(provider);
    if (env) return env;
    if (this.runtimeSecrets.has(provider)) return this.runtimeSecrets.get(provider);
    const vault = await this.readVault();
    const entry = vault.providers?.[provider];
    if (!entry) return "";
    return this.decrypt(entry);
  }

  async set(provider, value, metadata = {}) {
    assertProvider(provider);
    const secret = String(value || "").trim();
    if (!secret) throw new Error("Secret value is required.");
    if (secret.length > 20_000) throw new Error("Secret value is too large.");
    await this.ensureReady();
    const vault = await this.readVault();
    const existing = vault.providers?.[provider] || {};
    vault.providers = {
      ...(vault.providers || {}),
      [provider]: {
        ...this.encrypt(secret),
        provider,
        label: safeLabel(metadata.label || provider),
        source: "vault",
        updatedAt: new Date().toISOString(),
        createdAt: existing.createdAt || new Date().toISOString()
      }
    };
    await this.writeVault(vault);
    return publicEntry(vault.providers[provider]);
  }

  async delete(provider) {
    assertProvider(provider);
    const vault = await this.readVault();
    if (vault.providers?.[provider]) delete vault.providers[provider];
    await this.writeVault(vault);
    return { ok: true };
  }

  setRuntime(provider, value, metadata = {}) {
    assertProvider(provider);
    const secret = String(value || "").trim();
    if (!secret) throw new Error("Runtime secret value is required.");
    if (secret.length > 20_000) throw new Error("Runtime secret value is too large.");
    this.runtimeSecrets.set(provider, secret);
    const entry = {
      provider,
      configured: true,
      source: "os-safe-storage",
      readonly: false,
      label: safeLabel(metadata.label || provider),
      updatedAt: new Date().toISOString()
    };
    this.runtimeMetadata.set(provider, entry);
    return { ...entry };
  }

  deleteRuntime(provider) {
    assertProvider(provider);
    this.runtimeSecrets.delete(provider);
    this.runtimeMetadata.delete(provider);
    return { ok: true, provider };
  }

  async providerStatus(provider) {
    assertProvider(provider);
    const env = envSecret(provider);
    if (env) return { configured: true, source: "env", provider, readonly: true };
    if (this.runtimeMetadata.has(provider)) return { ...this.runtimeMetadata.get(provider) };
    const status = await this.status();
    return status[provider] || { configured: false, source: "none", provider, readonly: false };
  }

  async readVault() {
    await this.ensureReady();
    if (!existsSync(this.vaultFile)) return { version: VERSION, providers: {} };
    const parsed = JSON.parse(await readFile(this.vaultFile, "utf8"));
    if (parsed.version !== VERSION || !parsed.providers || typeof parsed.providers !== "object") {
      throw new Error("Unsupported secret vault format.");
    }
    return parsed;
  }

  async writeVault(vault) {
    await this.ensureReady();
    await writeFile(this.vaultFile, JSON.stringify({ version: VERSION, providers: vault.providers || {} }, null, 2), "utf8");
    await chmodPrivate(this.vaultFile);
  }

  async ensureReady() {
    await mkdir(this.dir, { recursive: true });
    await chmodPrivateDir(this.dir);
    if (!this.masterKey) this.masterKey = await this.loadOrCreateKey();
  }

  async loadOrCreateKey() {
    if (existsSync(this.keyFile)) {
      const raw = (await readFile(this.keyFile, "utf8")).trim();
      const key = Buffer.from(raw, "base64");
      if (key.length !== 32) throw new Error("Invalid secret vault master key.");
      return key;
    }
    const key = randomBytes(32);
    await writeFile(this.keyFile, key.toString("base64"), "utf8");
    await chmodPrivate(this.keyFile);
    return key;
  }

  encrypt(secret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      alg: "AES-256-GCM",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  decrypt(entry) {
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  }
}

export function envSecret(provider) {
  if (provider === "openai") return process.env.OPENAI_API_KEY || "";
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  return "";
}

export function assertProvider(provider) {
  if (!ALLOWED_PROVIDERS.has(String(provider || ""))) {
    throw new Error("Unsupported secret provider.");
  }
}

function publicEntry(entry) {
  return {
    provider: entry.provider,
    configured: true,
    source: entry.source || "vault",
    readonly: entry.source === "env",
    label: entry.label || entry.provider,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null
  };
}

function safeLabel(value) {
  return String(value || "").replace(/[^\w .:@/-]+/g, "").slice(0, 80) || "provider key";
}

async function chmodPrivate(path) {
  try {
    await chmod(path, 0o600);
  } catch {}
}

async function chmodPrivateDir(path) {
  try {
    await chmod(path, 0o700);
  } catch {}
}
