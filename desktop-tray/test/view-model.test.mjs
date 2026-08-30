import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveTheme,
  getSetupIssues,
  isSetupComplete,
  normalizeTheme,
  serverPresentation,
  tunnelPresentation
} from "../ui/src/view-model.mjs";

const valid = {
  node: "node",
  mcpAppDir: "C:/runtime/server",
  workspace: "C:/work",
  mode: "safe",
  policy: "balanced",
  port: 8787,
  dashboardPort: 8790
};

test("setup completeness rejects a missing workspace", () => {
  assert.equal(isSetupComplete(valid), true);
  assert.deepEqual(getSetupIssues({ ...valid, workspace: "" }), ["workspace"]);
});

test("setup completeness rejects the tunnel-reserved dashboard port", () => {
  assert.deepEqual(getSetupIssues({ ...valid, dashboardPort: 8788 }), ["dashboardPort"]);
});

test("setup issues are stable and cover every runnable field", () => {
  assert.deepEqual(
    getSetupIssues({
      ...valid,
      node: "",
      mcpAppDir: "",
      workspace: "",
      mode: "turbo",
      policy: "open",
      port: 0,
      dashboardPort: 70000
    }),
    ["node", "mcpAppDir", "workspace", "mode", "policy", "port", "dashboardPort"]
  );
});

test("theme preference is normalized and resolved", () => {
  assert.equal(normalizeTheme("unknown"), "system");
  assert.equal(normalizeTheme(" DARK "), "dark");
  assert.equal(normalizeTheme(""), "system");
  assert.equal(effectiveTheme("system", true), "dark");
  assert.equal(effectiveTheme("system", false), "light");
  assert.equal(effectiveTheme("light", true), "light");
});

test("server presentation names online state without relying on color", () => {
  const result = serverPresentation({
    state: "online",
    version: "5.0.1",
    mode: "safe",
    policy: "balanced",
    permissionProfile: "default",
    roots: 1
  });
  assert.match(result.label, /ONLINE/);
  assert.match(result.detail, /safe.*balanced/);
  assert.equal(result.tone, "ok");
});

test("tunnel presentation names an unconfigured tunnel", () => {
  const result = tunnelPresentation({ state: "not_configured", reason: "" });
  assert.match(result.label, /NOT CONFIGURED/);
  assert.equal(result.tone, "neutral");
});
