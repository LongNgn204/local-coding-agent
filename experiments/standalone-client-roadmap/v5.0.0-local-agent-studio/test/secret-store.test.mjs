import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretStore } from "../core/secret-store.mjs";

test("secret store encrypts provider keys and returns metadata only", async () => {
  const oldOpenAi = process.env.OPENAI_API_KEY;
  const oldAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const storage = mkdtempSync(join(tmpdir(), "lca-studio-secrets-"));
  try {
    const store = new SecretStore(storage);
    const secret = "sk-test-secret-value-123";
    const saved = await store.set("openai", secret, { label: "Test OpenAI" });
    assert.equal(saved.configured, true);
    assert.equal(saved.source, "vault");
    assert.equal(saved.label, "Test OpenAI");
    assert.equal(await store.get("openai"), secret);

    const statusText = JSON.stringify(await store.status());
    assert.equal(statusText.includes(secret), false);

    const vaultText = readFileSync(join(storage, "secrets", "vault.json"), "utf8");
    assert.equal(vaultText.includes(secret), false);
    assert.match(vaultText, /AES-256-GCM/);

    await store.delete("openai");
    assert.equal(await store.get("openai"), "");
  } finally {
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAi;
    if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldAnthropic;
    rmSync(storage, { recursive: true, force: true });
  }
});

test("environment provider keys remain readonly and override the vault", async () => {
  const oldOpenAi = process.env.OPENAI_API_KEY;
  const storage = mkdtempSync(join(tmpdir(), "lca-studio-secrets-env-"));
  try {
    const store = new SecretStore(storage);
    await store.set("openai", "vault-value", { label: "Vault" });
    process.env.OPENAI_API_KEY = "env-value";
    assert.equal(await store.get("openai"), "env-value");
    assert.deepEqual(await store.providerStatus("openai"), {
      configured: true,
      source: "env",
      provider: "openai",
      readonly: true
    });
  } finally {
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAi;
    rmSync(storage, { recursive: true, force: true });
  }
});

test("runtime desktop secrets override the preview vault without being persisted", async () => {
  const oldOpenAi = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const storage = mkdtempSync(join(tmpdir(), "lca-studio-runtime-secret-"));
  try {
    const store = new SecretStore(storage);
    await store.set("openai", "vault-value");
    const status = store.setRuntime("openai", "desktop-value", { label: "OS credential" });
    assert.equal(status.source, "os-safe-storage");
    assert.equal(await store.get("openai"), "desktop-value");
    assert.equal((await store.providerStatus("openai")).source, "os-safe-storage");
    const vaultText = readFileSync(join(storage, "secrets", "vault.json"), "utf8");
    assert.equal(vaultText.includes("desktop-value"), false);
    store.deleteRuntime("openai");
    assert.equal(await store.get("openai"), "vault-value");
  } finally {
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAi;
    rmSync(storage, { recursive: true, force: true });
  }
});
