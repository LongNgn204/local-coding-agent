import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopCredentialStore } from "../desktop/credential-store.mjs";

test("desktop credential store persists only OS-encrypted ciphertext", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-os-credentials-"));
  const file = join(dir, "credentials.json");
  const safeStorage = fakeSafeStorage();
  try {
    const store = new DesktopCredentialStore({ file, safeStorage, now: () => Date.parse("2026-07-02T00:00:00Z") });
    const secret = "sk-os-secret-never-plaintext";
    const metadata = await store.set("openai", secret);
    assert.equal(metadata.source, "os-safe-storage");
    assert.equal(await store.get("openai"), secret);
    assert.equal((await store.all()).openai, secret);
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes(secret), false);
    assert.match(raw, /ciphertext/);
    const status = await store.status();
    assert.equal(status.available, true);
    assert.equal(status.providers.openai.configured, true);
    await store.delete("openai");
    assert.equal(await store.get("openai"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop credential store fails closed when OS encryption is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-os-credentials-off-"));
  try {
    const store = new DesktopCredentialStore({
      file: join(dir, "credentials.json"),
      safeStorage: { isEncryptionAvailable: () => false }
    });
    await assert.rejects(() => store.set("openai", "secret"), /unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop credential store rejects Electron basic_text fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lca-os-credentials-basic-"));
  try {
    const store = new DesktopCredentialStore({
      file: join(dir, "credentials.json"),
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text"
      }
    });
    assert.equal(store.available(), false);
    await assert.rejects(() => store.set("openai", "secret"), /unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-os-keychain",
    encryptString: (value) => Buffer.from(`protected:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => Buffer.from(value.toString().slice("protected:".length), "base64").toString("utf8")
  };
}
