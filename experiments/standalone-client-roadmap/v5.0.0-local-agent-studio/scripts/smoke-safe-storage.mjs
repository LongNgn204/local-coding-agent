#!/usr/bin/env electron
import { app, safeStorage } from "electron";

app.whenReady().then(() => {
  const backend = getBackend();
  const available = safeStorage.isEncryptionAvailable() && backend !== "basic_text";
  if (!available) {
    console.error(JSON.stringify({ ok: false, available, backend, error: "Secure OS credential backend is unavailable." }, null, 2));
    app.exit(2);
    return;
  }
  const probe = `lca-safe-storage-${Date.now()}`;
  const encrypted = safeStorage.encryptString(probe);
  const decrypted = safeStorage.decryptString(encrypted);
  const ok = decrypted === probe && !encrypted.toString("utf8").includes(probe);
  console.log(JSON.stringify({
    ok,
    available,
    backend,
    ciphertextBytes: encrypted.length,
    plaintextRoundTrip: decrypted === probe,
    plaintextAbsentFromCiphertext: !encrypted.toString("utf8").includes(probe)
  }, null, 2));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  app.exit(1);
});

function getBackend() {
  try {
    return safeStorage.getSelectedStorageBackend?.() || process.platform;
  } catch {
    return process.platform;
  }
}
