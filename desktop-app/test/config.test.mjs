import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigStore } from "../main/config.mjs";

test("ConfigStore migrates a workspace into a private permission profile", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "lca-studio-config-"));
  const workspace = path.join(base, "workspace");
  const configDir = path.join(base, "private-config");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));

  const config = new ConfigStore(configDir);
  config.set({ workspace, mode: "safe" });
  const store = config.getPermissionStore();
  assert.equal(store.active_profile, "default");
  assert.equal(store.profiles.default.working_directory, workspace);
  assert.equal(store.profiles.default.roots[0].preset, "develop");
  const saved = config.setPermissionStore(store);
  assert.equal(saved.file, path.join(configDir, "permission-profiles.json"));
  assert.equal(config.get().activePermissionProfile, "default");
});

test("ConfigStore rejects a profile store located inside an authorized root", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-studio-unsafe-config-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = new ConfigStore(path.join(workspace, "app-config"));
  assert.throws(() => config.setPermissionStore({
    version: 1,
    active_profile: "default",
    profiles: {
      default: {
        name: "default",
        working_directory: workspace,
        roots: [{ label: "Workspace", path: workspace, preset: "develop" }]
      }
    }
  }), /outside every authorized root/i);
});

