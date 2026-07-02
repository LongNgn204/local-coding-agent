import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = 1;
const PROVIDERS = new Set(["openai", "anthropic"]);

export class DesktopCredentialStore {
  constructor({ file, safeStorage, now = () => Date.now() }) {
    if (!file) throw new Error("Credential store file is required.");
    this.file = file;
    this.safeStorage = safeStorage;
    this.now = now;
  }

  available() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.()) && safeBackend(this.safeStorage) !== "basic_text";
  }

  async status() {
    const data = await this.readData();
    return {
      available: this.available(),
      backend: safeBackend(this.safeStorage),
      providers: Object.fromEntries(Object.entries(data.providers || {}).map(([provider, entry]) => [
        provider,
        publicEntry(provider, entry)
      ]))
    };
  }

  async set(provider, value) {
    assertProvider(provider);
    this.assertAvailable();
    const secret = String(value || "").trim();
    if (!secret) throw new Error("Credential value is required.");
    if (secret.length > 20_000) throw new Error("Credential value is too large.");
    const data = await this.readData();
    const existing = data.providers?.[provider] || {};
    const encrypted = this.safeStorage.encryptString(secret);
    data.providers = {
      ...(data.providers || {}),
      [provider]: {
        ciphertext: Buffer.from(encrypted).toString("base64"),
        createdAt: existing.createdAt || new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString()
      }
    };
    await this.writeData(data);
    return publicEntry(provider, data.providers[provider]);
  }

  async get(provider) {
    assertProvider(provider);
    this.assertAvailable();
    const data = await this.readData();
    const entry = data.providers?.[provider];
    if (!entry) return "";
    return this.safeStorage.decryptString(Buffer.from(entry.ciphertext, "base64"));
  }

  async all() {
    this.assertAvailable();
    const data = await this.readData();
    const output = {};
    for (const provider of Object.keys(data.providers || {})) {
      assertProvider(provider);
      output[provider] = this.safeStorage.decryptString(Buffer.from(data.providers[provider].ciphertext, "base64"));
    }
    return output;
  }

  async delete(provider) {
    assertProvider(provider);
    const data = await this.readData();
    if (data.providers?.[provider]) delete data.providers[provider];
    await this.writeData(data);
    return { ok: true, provider };
  }

  async readData() {
    if (!existsSync(this.file)) return { version: VERSION, providers: {} };
    const parsed = JSON.parse(await readFile(this.file, "utf8"));
    if (parsed.version !== VERSION || !parsed.providers || typeof parsed.providers !== "object") {
      throw new Error("Unsupported desktop credential store format.");
    }
    return parsed;
  }

  async writeData(data) {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ version: VERSION, providers: data.providers || {} }, null, 2), { encoding: "utf8", mode: 0o600 });
    try { await chmod(this.file, 0o600); } catch {}
  }

  assertAvailable() {
    if (!this.available()) throw new Error("Operating-system credential encryption is unavailable.");
  }
}

function assertProvider(provider) {
  if (!PROVIDERS.has(String(provider || ""))) throw new Error("Unsupported credential provider.");
}

function publicEntry(provider, entry) {
  return {
    provider,
    configured: true,
    source: "os-safe-storage",
    readonly: false,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null
  };
}

function safeBackend(safeStorage) {
  try {
    return safeStorage?.getSelectedStorageBackend?.() || "os";
  } catch {
    return "os";
  }
}
