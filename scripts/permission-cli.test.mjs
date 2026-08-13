import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "local-coding-agent.mjs");

test("permissions CLI manages a private named multi-root store", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "lca-permission-cli-"));
  const workspace = path.join(base, "workspace");
  const extra = path.join(base, "extra");
  const configPath = path.join(base, "config", "cli-config.json");
  await Promise.all([workspace, extra].map((dir) => mkdir(dir, { recursive: true })));
  t.after(() => rm(base, { recursive: true, force: true }));

  function run(args) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: path.dirname(HERE),
      env: { ...process.env, LCA_CONFIG_PATH: configPath },
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  }

  const initialized = run(["permissions", "init", "--workspace", workspace, "--name", "default", "--preset", "develop"]);
  assert.equal(initialized.active_profile, "default");
  assert.ok(initialized.file.startsWith(path.dirname(configPath)));
  assert.equal(initialized.file.startsWith(workspace), false);

  const added = run(["permissions", "add-root", "default", extra, "edit", "--deny", ".env,secrets/**"]);
  assert.equal(added.root.preset, "edit");
  assert.deepEqual(added.root.deny, [".env", "secrets/**"]);

  run(["permissions", "create", "review", "--workspace", workspace, "--preset", "observe"]);
  const selected = run(["permissions", "use", "review"]);
  assert.equal(selected.active_profile, "review");
  assert.equal(selected.restart_required, true);

  const listed = run(["permissions", "list"]);
  assert.equal(listed.profiles.length, 2);
  assert.equal(listed.active_profile, "review");

  const store = JSON.parse(await readFile(initialized.file, "utf8"));
  assert.equal(store.active_profile, "review");
  assert.equal(store.profiles.default.roots.length, 2);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.permissionProfileFile, initialized.file);
  assert.equal(config.permissionProfileName, "review");
});
