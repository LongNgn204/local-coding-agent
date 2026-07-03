import assert from "node:assert/strict";
import test from "node:test";
import { buildPrivilegedRequest, privilegedActionNames } from "../desktop/privileged-actions.mjs";

test("desktop privileged action mapping injects intent and never accepts arbitrary routes", () => {
  const request = buildPrivilegedRequest({
    action: "providerKey:set",
    payload: { provider: "openai", value: "sk-test", path: "/api/health" }
  });
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/secrets/openai");
  assert.equal(request.body.intent.action, "provider-key:set");
  assert.equal(request.body.intent.confirm, "provider-key:set");
  assert.equal(request.body.path, undefined);

  assert.throws(() => buildPrivilegedRequest({ action: "anything", payload: { path: "/api/update" } }), /Unknown privileged/);
  assert.throws(() => buildPrivilegedRequest({ action: "providerKey:set", payload: { provider: "../openai", value: "x" } }), /Unsupported provider/);

  const patch = buildPrivilegedRequest({ action: "patch:preview", payload: { diff: "--- a/a\n+++ b/a\n@@\n-a\n+b\n" } });
  assert.equal(patch.path, "/api/patches/preview");
  assert.equal(patch.body.intent.action, "patch:preview");
  assert.equal(Object.hasOwn(patch.body, "reviewId"), false);
  assert.throws(() => buildPrivilegedRequest({ action: "patch:apply", payload: { reviewId: "../escape" } }), /Invalid patch review id/);
});

test("desktop privileged action mapping is a small explicit allowlist", () => {
  assert.deepEqual(privilegedActionNames().sort(), [
    "approval:mutate",
    "customerUpdate:run",
    "license:activate",
    "license:delete",
    "mcpServer:start",
    "mcpServer:stop",
    "patch:apply",
    "patch:preview",
    "patch:undo",
    "providerKey:delete",
    "providerKey:set",
    "releaseUpdate:verify",
    "releaseUpdate:stage",
    "supportBundle:export",
    "tool:call"
  ].sort());
});
