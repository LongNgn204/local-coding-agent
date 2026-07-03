#!/usr/bin/env node
// Shared runtime for standalone Local Agent Studio experiments.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateAgentTool, normalizeAgentToolPolicy, publicToolPolicyModes } from "./core/agent-tool-policy.mjs";
import { compactContext } from "./core/context-compactor.mjs";
import { buildDashboardRequestUrl } from "./core/dashboard-proxy.mjs";
import { IntegrityService, loadReleasePublicKey } from "./core/integrity-service.mjs";
import { LicenseService, loadLicensePublicKey } from "./core/license-service.mjs";
import { PatchReviewService } from "./core/patch-review-service.mjs";
import { PermissionBroker, PermissionDeniedError } from "./core/permission-broker.mjs";
import { PlatformSignatureVerifier } from "./core/platform-signature.mjs";
import { redactForSupport } from "./core/redaction.mjs";
import { createStudioSecurity } from "./core/security.mjs";
import { SecretStore, assertProvider } from "./core/secret-store.mjs";
import { ThreadStore } from "./core/thread-store.mjs";
import { isAbortError, TurnManager } from "./core/turn-manager.mjs";
import { UpdateService, loadUpdatePublicKey } from "./core/update-service.mjs";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const UI_DIST_DIR = join(APP_DIR, "dist", "ui");
const DEFAULT_MCP_URL = process.env.MCP_ENDPOINT || "http://127.0.0.1:8787/mcp";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DEFAULT_PROVIDER = process.env.LCA_MODEL_PROVIDER || "openai";
const MAX_TOOL_LOOPS = Number(process.env.LCA_STUDIO_MAX_TOOL_LOOPS || 8);
const MCP_CONNECT_TIMEOUT_VALUE = Number(process.env.LCA_MCP_CONNECT_TIMEOUT_MS || 12_000);
const MCP_CONNECT_TIMEOUT_MS = Number.isFinite(MCP_CONNECT_TIMEOUT_VALUE)
  ? Math.max(1_000, Math.min(MCP_CONNECT_TIMEOUT_VALUE, 60_000))
  : 12_000;
let mcpSdkPromise = null;

export function startStudio(manifest, options = {}) {
  const host = options.host || process.env.LCA_STUDIO_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.LCA_STUDIO_PORT || manifest.defaultPort || 5177);
  const storageDir = options.storageDir || getStorageDir(manifest.version);
  const security = createStudioSecurity({ host, port });
  const threadStore = new ThreadStore(join(storageDir, "studio.db"));
  const turnManager = new TurnManager();
  const secretStore = new SecretStore(storageDir);
  const permissionBroker = new PermissionBroker({ strict: process.env.LCA_PERMISSION_BROKER !== "off" });
  const patchReviewService = new PatchReviewService();
  const updateService = new UpdateService({
    storageDir,
    manifest,
    publicKeyPem: loadUpdatePublicKey(APP_DIR),
    signatureVerifier: new PlatformSignatureVerifier()
  });
  const licenseService = new LicenseService({
    storageDir,
    manifest,
    publicKeyPem: loadLicensePublicKey(APP_DIR)
  });
  const integrityService = new IntegrityService({
    appDir: APP_DIR,
    manifest,
    publicKeyPem: loadReleasePublicKey(APP_DIR)
  });
  const state = {
    manifest,
    storageDir,
    repoRoot: Object.hasOwn(options, "repoRoot") ? options.repoRoot : findRepoRoot(options.cwd || process.cwd()),
    mcpEndpoint: process.env.MCP_ENDPOINT || manifest.defaultMcpEndpoint || DEFAULT_MCP_URL,
    dashboardUrl: process.env.LCA_DASHBOARD_URL || "http://127.0.0.1:8790",
    client: null,
    tools: [],
    events: [],
    activeProfile: null,
    serverProcess: null,
    serverLogs: [],
    security,
    threadStore,
    turnManager,
    secretStore,
    permissionBroker,
    patchReviewService,
    updateService,
    licenseService,
    integrityService,
    desktopBridgeToken: options.desktopBridgeToken || process.env.LCA_DESKTOP_BRIDGE_TOKEN || "",
    nodeRuntime: options.nodeRuntime || {
      executable: process.execPath,
      source: process.versions.electron ? "electron-embedded" : "direct",
      version: process.versions.node
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (url.pathname.startsWith("/api/")) {
      applyHeaders(res, security.apiHeaders());
      const publicRoute = url.pathname === "/api/health";
      const requireJson = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "GET");
      const authorization = security.authorize(req, { publicRoute, requireJson });
      if (!authorization.ok) return sendJson(res, authorization.status, { error: authorization.error });
      return handleApi(req, res, url, state);
    }
    const authorization = security.authorize(req, { publicRoute: true });
    if (!authorization.ok) return sendJson(res, authorization.status, { error: authorization.error });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (existsSync(join(UI_DIST_DIR, "index.html"))) {
        return serveUiIndex(res, security);
      }
      return sendText(res, 200, renderHtml(manifest, security), "text/html; charset=utf-8", security.htmlHeaders());
    }
    if (url.pathname.startsWith("/assets/")) {
      return serveUiAsset(res, url.pathname);
    }
    return sendJson(res, 404, { error: "Not found" });
  });

  let threadStoreClosed = false;
  const closeThreadStore = () => {
    if (threadStoreClosed) return;
    threadStoreClosed = true;
    try { threadStore.close(); } catch {}
  };
  const ready = new Promise((resolveReady, rejectReady) => {
    const onError = (error) => {
      closeThreadStore();
      rejectReady(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      console.log(`${manifest.productName} ${manifest.version} listening on http://${host}:${port}`);
      console.log(`MCP endpoint default: ${state.mcpEndpoint}`);
      console.log(`Local data: ${storageDir}`);
      resolveReady();
    });
  });
  server.on("close", () => {
    closeThreadStore();
  });
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      turnManager.close();
      if (state.serverProcess) await stopManagedServer(state).catch(() => {});
      if (state.client) {
        await state.client.close().catch(() => {});
        state.client = null;
        state.tools = [];
      }
      if (!server.listening) {
        closeThreadStore();
        return;
      }
      await new Promise((resolveClose) => {
        const forceTimer = setTimeout(() => server.closeAllConnections?.(), 5_000);
        forceTimer.unref?.();
        server.close(() => {
          clearTimeout(forceTimer);
          resolveClose();
        });
        server.closeIdleConnections?.();
      });
    })();
    return closePromise;
  };
  return { server, state, ready, close };
}

async function handleApi(req, res, url, state) {
  try {
    if (url.pathname === "/api/health") {
      return sendJson(res, 200, await enrichedHealthPayload(state));
    }
    if (url.pathname === "/api/providers") {
      return sendJson(res, 200, await providersPayload(state));
    }
    if (url.pathname === "/api/model-presets") {
      return sendJson(res, 200, { presets: modelPresets(state.manifest) });
    }
    if (url.pathname === "/api/permissions") {
      return sendJson(res, 200, {
        summary: state.permissionBroker.summary(),
        audit: state.permissionBroker.publicAudit(url.searchParams.get("limit") || 100)
      });
    }
    if (url.pathname === "/api/release-update/status") {
      return sendJson(res, 200, state.updateService.status());
    }
    if (url.pathname === "/api/release-update/verify" && req.method === "POST") {
      const body = await readJson(req);
      state.permissionBroker.require("release-update:verify", body, { route: url.pathname, method: req.method });
      return sendJson(res, 200, state.updateService.verifyEnvelope(body.envelope, { persist: body.persist !== false }));
    }
    if (url.pathname === "/api/release-update/stage" && req.method === "POST") {
      const body = await readJson(req);
      state.permissionBroker.require("release-update:stage", body, { route: url.pathname, method: req.method });
      return sendJson(res, 200, await state.updateService.stageArtifact(body.envelope, {
        platform: body.platform || process.platform,
        arch: body.arch || process.arch
      }));
    }
    const desktopSecretMatch = url.pathname.match(/^\/api\/desktop-secrets\/([^/]+)$/);
    if (desktopSecretMatch) {
      if (!authorizeDesktopBridge(req, state)) return sendJson(res, 403, { error: "Desktop secret bridge authorization failed." });
      const provider = decodeURIComponent(desktopSecretMatch[1]);
      assertProvider(provider);
      const body = await readJson(req);
      if (req.method === "POST") {
        state.permissionBroker.require("provider-key:set", body, { route: url.pathname, method: req.method, target: provider });
        return sendJson(res, 200, state.secretStore.setRuntime(provider, body.value, { label: body.label }));
      }
      if (req.method === "DELETE") {
        state.permissionBroker.require("provider-key:delete", body, { route: url.pathname, method: req.method, target: provider });
        return sendJson(res, 200, state.secretStore.deleteRuntime(provider));
      }
    }
    if (url.pathname === "/api/desktop-license") {
      if (!authorizeDesktopBridge(req, state)) return sendJson(res, 403, { error: "Desktop license bridge authorization failed." });
      const body = await readJson(req);
      if (req.method === "POST") {
        state.permissionBroker.require("license:activate", body, { route: url.pathname, method: req.method });
        return sendJson(res, 200, state.licenseService.activateRuntime(body.token, { removeLegacy: true }));
      }
      if (req.method === "DELETE") {
        state.permissionBroker.require("license:delete", body, { route: url.pathname, method: req.method });
        return sendJson(res, 200, state.licenseService.clearRuntime({ removeLegacy: true }));
      }
    }
    if (url.pathname === "/api/secrets") {
      return sendJson(res, 200, {
        providers: {
          openai: await state.secretStore.providerStatus("openai"),
          anthropic: await state.secretStore.providerStatus("anthropic")
        }
      });
    }
    const secretMatch = url.pathname.match(/^\/api\/secrets\/([^/]+)$/);
    if (secretMatch) {
      const provider = decodeURIComponent(secretMatch[1]);
      assertProvider(provider);
      if (req.method === "GET") return sendJson(res, 200, await state.secretStore.providerStatus(provider));
      if (req.method === "POST") {
        const body = await readJson(req);
        state.permissionBroker.require("provider-key:set", body, { route: url.pathname, method: req.method, target: provider });
        return sendJson(res, 200, await state.secretStore.set(provider, body.value, { label: body.label }));
      }
      if (req.method === "DELETE") {
        const body = await readJson(req);
        state.permissionBroker.require("provider-key:delete", body, { route: url.pathname, method: req.method, target: provider });
        return sendJson(res, 200, await state.secretStore.delete(provider));
      }
    }
    if (url.pathname === "/api/license") {
      if (req.method === "DELETE") {
        const body = await readJson(req);
        state.permissionBroker.require("license:delete", body, { route: url.pathname, method: req.method });
        return sendJson(res, 200, state.licenseService.clearRuntime({ removeLegacy: true }));
      }
      return sendJson(res, 200, state.licenseService.status());
    }
    if (url.pathname === "/api/license/activate" && req.method === "POST") {
      const body = await readJson(req);
      state.permissionBroker.require("license:activate", body, { route: url.pathname, method: req.method });
      return sendJson(res, 200, state.licenseService.activate(body.token));
    }
    if (url.pathname === "/api/turns" && req.method === "POST") {
      const body = await readJson(req);
      const readiness = agentReadiness(state);
      if (!readiness.ok) return sendJson(res, readiness.status, readiness.body);
      return sendJson(res, 202, startAgentTurn(state, body));
    }
    const turnEventsMatch = url.pathname.match(/^\/api\/turns\/([^/]+)\/events$/);
    if (turnEventsMatch && req.method === "GET") {
      const turnId = decodeURIComponent(turnEventsMatch[1]);
      return streamTurnEvents(req, res, url, state, turnId);
    }
    const turnCancelMatch = url.pathname.match(/^\/api\/turns\/([^/]+)\/cancel$/);
    if (turnCancelMatch && req.method === "POST") {
      const turnId = decodeURIComponent(turnCancelMatch[1]);
      const body = await readJson(req);
      state.permissionBroker.require("turn:cancel", body, { route: url.pathname, method: req.method, target: turnId });
      return sendJson(res, 200, { turn: state.turnManager.requestCancel(turnId) });
    }
    const turnMatch = url.pathname.match(/^\/api\/turns\/([^/]+)$/);
    if (turnMatch && req.method === "GET") {
      const turnId = decodeURIComponent(turnMatch[1]);
      const turn = state.turnManager.get(turnId);
      if (!turn) return sendJson(res, 404, { error: "Turn not found." });
      return sendJson(res, 200, {
        turn,
        events: state.turnManager.getEvents(turnId, { after: url.searchParams.get("after") || 0 })
      });
    }
    const activeTurnMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/active-turn$/);
    if (activeTurnMatch && req.method === "GET") {
      const threadId = decodeURIComponent(activeTurnMatch[1]);
      state.threadStore.requireThread(threadId);
      return sendJson(res, 200, { turn: state.turnManager.getActiveByThread(threadId) });
    }
    if (url.pathname === "/api/threads") {
      if (req.method === "GET") {
        return sendJson(res, 200, { threads: state.threadStore.listThreads({ limit: url.searchParams.get("limit") }) });
      }
      if (req.method === "POST") {
        return sendJson(res, 201, { thread: state.threadStore.createThread(await readJson(req)) });
      }
    }
    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (threadMatch) {
      const id = decodeURIComponent(threadMatch[1]);
      if (req.method === "GET") {
        const thread = state.threadStore.requireThread(id);
        return sendJson(res, 200, {
          thread,
          items: state.threadStore.listItems(id, { limit: url.searchParams.get("limit") || 100 })
        });
      }
      if (req.method === "DELETE") {
        return sendJson(res, 200, { thread: state.threadStore.archiveThread(id) });
      }
    }
    if (url.pathname === "/api/connect" && req.method === "POST") {
      const body = await readJson(req);
      await connectMcp(state, body.endpoint || state.mcpEndpoint);
      return sendJson(res, 200, {
        ok: true,
        endpoint: state.mcpEndpoint,
        tools: publicTools(state.tools)
      });
    }
    if (url.pathname === "/api/tools") {
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      return sendJson(res, 200, {
        endpoint: state.mcpEndpoint,
        tools: publicTools(state.tools, true)
      });
    }
    if (url.pathname === "/api/patches/preview" && req.method === "POST") {
      const body = await readJson(req);
      state.permissionBroker.require("patch:preview", body, { route: url.pathname, method: req.method });
      const draft = state.patchReviewService.validateDraft(body.diff);
      const readiness = agentReadiness(state);
      if (!readiness.ok) return sendJson(res, readiness.status, readiness.body);
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      const [previewCall, validationCall] = await Promise.all([
        callMcpTool(state, "preview_patch", { diff: draft.text }),
        callMcpTool(state, "validate_patch", { diff: draft.text })
      ]);
      const preview = requireMcpToolPayload(previewCall, "preview_patch");
      const validation = requireMcpToolPayload(validationCall, "validate_patch");
      const review = state.patchReviewService.create({ diff: draft.text, preview, validation });
      return sendJson(res, 201, { ok: review.status === "ready", review });
    }
    if (url.pathname === "/api/patches/undo" && req.method === "POST") {
      const body = await readJson(req);
      state.permissionBroker.require("patch:undo", body, { route: url.pathname, method: req.method });
      const readiness = agentReadiness(state);
      if (!readiness.ok) return sendJson(res, readiness.status, readiness.body);
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      const call = await callMcpTool(state, "undo_last_patch", {});
      const result = requireMcpToolPayload(call, "undo_last_patch");
      if (result?.ok !== true) {
        const error = new Error("undo_last_patch did not confirm a successful restore.");
        error.status = 409;
        throw error;
      }
      return sendJson(res, 200, { ok: true, result });
    }
    const patchApplyMatch = url.pathname.match(/^\/api\/patches\/([^/]+)\/apply$/);
    if (patchApplyMatch && req.method === "POST") {
      const reviewId = decodeURIComponent(patchApplyMatch[1]);
      const body = await readJson(req);
      state.permissionBroker.require("patch:apply", body, { route: url.pathname, method: req.method, target: reviewId });
      const readiness = agentReadiness(state);
      if (!readiness.ok) return sendJson(res, readiness.status, readiness.body);
      const pending = state.patchReviewService.beginApply(reviewId);
      try {
        if (!state.client) await connectMcp(state, state.mcpEndpoint);
        const call = await callMcpTool(state, "apply_patch", { diff: pending.diff });
        const result = parseMcpToolPayload(call.result);
        const applied = call.ok && result?.ok === true;
        const error = !call.ok
          ? toolResultText(call.result) || "apply_patch failed"
          : applied ? null : "apply_patch did not confirm success.";
        const review = state.patchReviewService.finishApply(reviewId, { ok: applied, result, error });
        if (review.status !== "applied") return sendJson(res, 409, { error: error || "Patch was not applied.", review, result });
        return sendJson(res, 200, { ok: true, review, result });
      } catch (error) {
        state.patchReviewService.finishApply(reviewId, { ok: false, error: error?.message || String(error) });
        throw error;
      }
    }
    const patchReviewMatch = url.pathname.match(/^\/api\/patches\/([^/]+)$/);
    if (patchReviewMatch && req.method === "GET") {
      const review = state.patchReviewService.get(decodeURIComponent(patchReviewMatch[1]));
      if (!review) return sendJson(res, 404, { error: "Patch review not found." });
      return sendJson(res, 200, { review });
    }
    if (url.pathname === "/api/call-tool" && req.method === "POST") {
      const body = await readJson(req);
      state.permissionBroker.require("tool:call", body, { route: url.pathname, method: req.method, target: body.name });
      const preliminary = evaluateAgentTool({ name: body.name }, "read-only");
      if (!preliminary.allowed) {
        const error = new Error(`Manual tool calls are read-only. Use a dedicated reviewed workflow for ${body.name || "this tool"}.`);
        error.status = 403;
        throw error;
      }
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      const tool = state.tools.find((entry) => entry.name === body.name || sanitizeToolName(entry.name) === body.name);
      if (!tool) {
        const error = new Error(`MCP tool is not available: ${body.name || "(missing name)"}`);
        error.status = 404;
        throw error;
      }
      const decision = evaluateAgentTool(tool, "read-only");
      if (!decision.allowed) {
        const error = new Error(`MCP metadata marks ${tool.name} as mutating or destructive.`);
        error.status = 403;
        throw error;
      }
      const result = await callMcpTool(state, tool.name, body.arguments || {});
      return sendJson(res, 200, result);
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readJson(req);
      const readiness = agentReadiness(state);
      if (!readiness.ok) return sendJson(res, readiness.status, readiness.body);
      const started = startAgentTurn(state, body);
      const settled = await state.turnManager.wait(started.turnId);
      if (settled.status === "completed") return sendJson(res, 200, settled.result);
      const error = new Error(settled.error || `Turn ${settled.status}.`);
      error.status = settled.status === "cancelled" ? 409 : 500;
      throw error;
    }
    if (url.pathname === "/api/events") {
      return sendJson(res, 200, { events: state.events.slice(-150) });
    }
    if (url.pathname === "/api/profiles") {
      assertFeature(state.manifest, "profiles");
      if (req.method === "GET") return sendJson(res, 200, await readProfiles(state));
      if (req.method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, await saveProfile(state, body));
      }
      if (req.method === "DELETE") {
        return sendJson(res, 200, await deleteProfile(state, url.searchParams.get("id")));
      }
    }
    if (url.pathname === "/api/profiles/activate" && req.method === "POST") {
      assertFeature(state.manifest, "profiles");
      return sendJson(res, 200, await activateProfile(state, await readJson(req)));
    }
    if (url.pathname === "/api/profiles/export") {
      assertFeature(state.manifest, "profiles");
      return sendJson(res, 200, await exportProfiles(state));
    }
    if (url.pathname === "/api/skills") {
      assertFeature(state.manifest, "skills");
      if (!state.client) await connectMcp(state, state.mcpEndpoint);
      const name = url.searchParams.get("name");
      const result = await callMcpTool(state, name ? "read_skill" : "list_skills", name ? { name } : {});
      return sendJson(res, 200, result);
    }
    if (url.pathname === "/api/skills/validate" && req.method === "POST") {
      assertFeature(state.manifest, "skills");
      return sendJson(res, 200, await validateSkills(state));
    }
    if (url.pathname === "/api/server/status") {
      assertFeature(state.manifest, "serverSupervisor");
      return sendJson(res, 200, await serverStatus(state));
    }
    if (url.pathname === "/api/server/start" && req.method === "POST") {
      assertFeature(state.manifest, "serverSupervisor");
      const body = await readJson(req);
      state.permissionBroker.require("mcp-server:start", body, { route: url.pathname, method: req.method });
      return sendJson(res, 200, await startManagedServer(state, body));
    }
    if (url.pathname === "/api/server/stop" && req.method === "POST") {
      assertFeature(state.manifest, "serverSupervisor");
      const body = await readJson(req);
      state.permissionBroker.require("mcp-server:stop", body, { route: url.pathname, method: req.method });
      return sendJson(res, 200, await stopManagedServer(state));
    }
    if (url.pathname === "/api/dashboard/metrics") {
      assertFeature(state.manifest, "dashboard");
      return sendJson(res, 200, await dashboardJson(state, "/metrics"));
    }
    if (url.pathname === "/api/dashboard/tree") {
      assertFeature(state.manifest, "fileViewer");
      return sendJson(res, 200, await dashboardJson(state, `/api/tree${url.search}`));
    }
    if (url.pathname === "/api/dashboard/file") {
      assertFeature(state.manifest, "fileViewer");
      return sendJson(res, 200, await dashboardJson(state, `/api/file${url.search}`));
    }
    if (url.pathname === "/api/dashboard/diff") {
      assertFeature(state.manifest, "fileViewer");
      return sendJson(res, 200, await dashboardJson(state, `/api/diff${url.search}`));
    }
    if (url.pathname === "/api/approvals") {
      assertFeature(state.manifest, "approvals");
      return sendJson(res, 200, await dashboardJson(state, "/api/approvals"));
    }
    if (url.pathname.startsWith("/api/approvals/") && req.method === "POST") {
      assertFeature(state.manifest, "approvals");
      const body = await readJson(req);
      state.permissionBroker.require("approval:mutate", body, { route: url.pathname, method: req.method });
      const suffix = url.pathname.slice("/api".length);
      return sendJson(res, 200, await dashboardJson(state, `/api${suffix}`, { method: "POST" }));
    }
    if (url.pathname === "/api/update" && req.method === "POST") {
      assertFeature(state.manifest, "customerUpdateFlow");
      const body = await readJson(req);
      state.permissionBroker.require("customer-update:run", body, { route: url.pathname, method: req.method });
      return sendJson(res, 200, await runCustomerUpdate(state, body));
    }
    if (url.pathname === "/api/support-bundle" && req.method === "POST") {
      assertFeature(state.manifest, "supportBundle");
      const body = await readJson(req);
      state.permissionBroker.require("support-bundle:export", body, { route: url.pathname, method: req.method });
      return sendJson(res, 200, await writeSupportBundle(state));
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return sendJson(res, error.status, { error: error.message, action: error.action, risk: error.risk });
    }
    const status = Number(error?.status || 500);
    return sendJson(res, status >= 400 && status <= 599 ? status : 500, { error: error?.message || String(error) });
  }
}

function agentReadiness(state) {
  const license = state.licenseService.status();
  if (!license.allowed) return { ok: false, status: 402, body: { error: license.reason, license } };
  const integrity = state.integrityService.status();
  if (!integrity.allowed) return { ok: false, status: 503, body: { error: integrity.reason, integrity } };
  return { ok: true };
}

function startAgentTurn(state, body) {
  const message = String(body.message || "").trim();
  if (!message) throw new Error("message is required");
  if (message.length > 200_000) {
    const error = new Error("message is too large");
    error.status = 413;
    throw error;
  }
  const provider = String(body.provider || DEFAULT_PROVIDER);
  if (!["openai", "anthropic", "ollama"].includes(provider)) throw new Error("Unsupported model provider.");
  const model = String(body.model || DEFAULT_MODEL).trim().slice(0, 160);
  const toolPolicy = normalizeAgentToolPolicy(body.toolPolicy);
  if (toolPolicy === "workspace") {
    state.permissionBroker.require("agent-turn:workspace", body, { route: "/api/turns", method: "POST", target: model });
  } else if (toolPolicy === "full") {
    state.permissionBroker.require("agent-turn:full", body, { route: "/api/turns", method: "POST", target: model });
  }
  const thread = body.threadId
    ? state.threadStore.requireThread(body.threadId)
    : state.threadStore.createThread({
      title: message,
      provider,
      model,
      workspace: state.activeProfile?.workspace || ""
    });
  const active = state.turnManager.getActiveByThread(thread.id);
  if (active) {
    const error = new Error(`Thread already has an active turn: ${active.id}`);
    error.status = 409;
    throw error;
  }
  const turn = state.threadStore.startTurn(thread.id, { provider, model, toolPolicy });
  state.threadStore.appendItem(thread.id, { turnId: turn.id, role: "user", content: message });
  state.turnManager.create({ id: turn.id, threadId: thread.id, provider, model, toolPolicy });
  state.turnManager.emit(turn.id, "turn.started", {
    turnId: turn.id,
    threadId: thread.id,
    provider,
    model,
    toolPolicy
  });
  queueMicrotask(() => {
    void executeAgentTurn(state, { turn, thread, message, provider, model, toolPolicy });
  });
  return { turnId: turn.id, threadId: thread.id, status: "running", toolPolicy };
}

async function executeAgentTurn(state, request) {
  const { turn, thread, message, provider, model, toolPolicy } = request;
  const signal = state.turnManager.signal(turn.id);
  try {
    const currentThread = state.threadStore.requireThread(thread.id);
    const messages = state.threadStore.messagesAfter(thread.id, currentThread.summarySeq, 1_000);
    const context = compactContext({ thread: currentThread, messages });
    if (context.summarySeq > currentThread.summarySeq) {
      state.threadStore.setSummary(thread.id, context.summary, { throughSeq: context.summarySeq });
    }
    state.turnManager.emit(turn.id, "context.ready", context.stats);
    const emit = (type, data = {}) => {
      const safeData = redactForSupport(data);
      if (type === "tool.completed" && data.event) {
        const event = data.event;
        state.threadStore.appendItem(thread.id, {
          turnId: turn.id,
          type: "tool",
          content: event.result || "",
          metadata: {
            tool: event.tool,
            args: redactForSupport(event.args),
            isError: event.isError,
            blocked: Boolean(event.blocked),
            policy: event.policy || null,
            level: event.level || null,
            ms: event.ms
          }
        });
      }
      state.turnManager.emit(turn.id, type, safeData);
    };
    const result = await chatWithTools(state, {
      message,
      model,
      provider,
      history: context.history,
      contextSummary: context.summary,
      toolPolicy,
      signal,
      emit
    });
    const publicResult = {
      provider: result.provider,
      text: result.text || "",
      timeline: result.timeline || [],
      threadId: thread.id,
      turnId: turn.id,
      context: context.stats,
      toolPolicy
    };
    state.threadStore.appendItem(thread.id, { turnId: turn.id, role: "assistant", content: publicResult.text });
    state.threadStore.finishTurn(turn.id);
    state.turnManager.complete(turn.id, publicResult, {
      eventResult: {
        provider: publicResult.provider,
        text: publicResult.text,
        threadId: thread.id,
        turnId: turn.id,
        context: context.stats,
        toolPolicy
      }
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      const reason = signal.reason?.message || "Turn cancelled.";
      state.threadStore.finishTurn(turn.id, { status: "cancelled", error: reason });
      state.turnManager.cancelled(turn.id, reason);
      return;
    }
    const messageText = error?.message || String(error);
    state.threadStore.finishTurn(turn.id, { status: "failed", error: messageText });
    state.turnManager.fail(turn.id, error);
  }
}

function streamTurnEvents(req, res, url, state, turnId) {
  const turn = state.turnManager.get(turnId);
  if (!turn) return sendJson(res, 404, { error: "Turn not found." });
  const after = Math.max(0, Number(url.searchParams.get("after") || 0));
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();
  let closed = false;
  let unsubscribe = () => {};
  let heartbeat = null;
  const closeStream = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  const send = (event) => {
    if (closed || res.writableEnded) return;
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
      queueMicrotask(closeStream);
    }
  };
  unsubscribe = state.turnManager.subscribe(turnId, send, { after });
  if (["completed", "failed", "cancelled"].includes(turn.status) && turn.lastSeq <= after) {
    queueMicrotask(closeStream);
  }
  heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref?.();
  req.once("close", closeStream);
  req.once("aborted", closeStream);
  const latest = state.turnManager.get(turnId);
  if (["completed", "failed", "cancelled"].includes(latest.status) && after >= latest.lastSeq) {
    queueMicrotask(closeStream);
  }
}

function healthPayload(state) {
  return {
    ok: true,
    product: state.manifest.productName,
    version: state.manifest.version,
    channel: state.manifest.channel,
    default_port: state.manifest.defaultPort,
    mcp_endpoint: state.mcpEndpoint,
    connected: Boolean(state.client),
    tools: state.tools.length,
    features: state.manifest.features || [],
    providers: [],
    active_profile: state.activeProfile,
    repo_root: state.repoRoot,
    managed_server_pid: state.serverProcess?.pid || null,
    active_turns: state.turnManager.listActive(),
    agent_tool_policies: publicToolPolicyModes(),
    patch_review: state.patchReviewService.summary(),
    node_runtime: {
      executable: state.nodeRuntime.executable,
      source: state.nodeRuntime.source,
      version: state.nodeRuntime.version
    },
    security: {
      loopback_only: true,
      session_token_required: true,
      origin_guard: true,
      desktop_secret_bridge: Boolean(state.desktopBridgeToken),
      permission_broker: state.permissionBroker.summary()
    },
    license: publicLicenseStatus(state.licenseService.status()),
    integrity: state.integrityService.status(),
    updates: state.updateService.status(),
    openai_key_present: false,
    anthropic_key_present: false,
    ollama_url: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
  };
}

async function enrichedHealthPayload(state) {
  const payload = healthPayload(state);
  const providers = await providersPayload(state);
  payload.providers = providers.providers;
  payload.openai_key_present = Boolean(providers.providers.find((provider) => provider.id === "openai")?.ready);
  payload.anthropic_key_present = Boolean(providers.providers.find((provider) => provider.id === "anthropic")?.ready);
  return payload;
}

async function providersPayload(state) {
  const manifest = state.manifest;
  const enabled = new Set(manifest.providers || ["openai"]);
  const openai = await state.secretStore.providerStatus("openai");
  const anthropic = await state.secretStore.providerStatus("anthropic");
  const providers = [
    { id: "openai", name: "OpenAI Responses API", enabled: enabled.has("openai"), ready: Boolean(openai.configured), source: openai.source, readonly: openai.readonly },
    { id: "anthropic", name: "Anthropic Messages API", enabled: enabled.has("anthropic"), ready: Boolean(anthropic.configured), source: anthropic.source, readonly: anthropic.readonly },
    { id: "ollama", name: "Ollama/local HTTP", enabled: enabled.has("ollama"), ready: true }
  ];
  return { providers };
}

function modelPresets(manifest) {
  const providers = new Set(manifest.providers || ["openai"]);
  return [
    ...(providers.has("openai") ? [
      { id: "fast", provider: "openai", model: "gpt-4.1-mini", label: "Fast" },
      { id: "balanced", provider: "openai", model: "gpt-4.1", label: "Balanced" }
    ] : []),
    ...(providers.has("anthropic") ? [
      { id: "deep-review", provider: "anthropic", model: "claude-3-5-sonnet-latest", label: "Deep review" }
    ] : []),
    ...(providers.has("ollama") ? [
      { id: "local-only", provider: "ollama", model: "qwen2.5-coder:7b", label: "Local only" }
    ] : [])
  ];
}

async function connectMcp(state, endpoint) {
  validateMcpEndpoint(endpoint);
  if (state.client) await state.client.close().catch(() => {});
  state.client = null;
  state.tools = [];
  const { Client, StreamableHTTPClientTransport } = await loadMcpSdk();
  const client = new Client({ name: "local-agent-studio", version: state.manifest.version });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
    const listed = await client.listTools(undefined, { timeout: MCP_CONNECT_TIMEOUT_MS });
    state.client = client;
    state.mcpEndpoint = endpoint;
    state.tools = listed.tools || [];
    return state;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function loadMcpSdk() {
  if (!mcpSdkPromise) {
    mcpSdkPromise = (async () => {
      const requireFromVersion = createRequire(join(process.cwd(), "package.json"));
      const clientPath = requireFromVersion.resolve("@modelcontextprotocol/sdk/client/index.js");
      const transportPath = requireFromVersion.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const clientModule = await import(pathToFileURL(clientPath).href);
      const transportModule = await import(pathToFileURL(transportPath).href);
      return {
        Client: clientModule.Client,
        StreamableHTTPClientTransport: transportModule.StreamableHTTPClientTransport
      };
    })();
  }
  return mcpSdkPromise;
}

async function callMcpTool(state, name, args, options = {}) {
  const started = Date.now();
  const { signal = null, onProgress = null } = options;
  let result;
  try {
    throwIfAborted(signal);
    const requestOptions = {
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onprogress: onProgress, resetTimeoutOnProgress: true, timeout: 120_000 } : {})
    };
    result = await state.client.callTool({ name, arguments: args || {} }, undefined, requestOptions);
  } catch (error) {
    if (isAbortError(error)) throw error;
    result = { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
  }
  const event = {
    at: new Date().toISOString(),
    tool: name,
    args: args || {},
    isError: Boolean(result.isError),
    ms: Date.now() - started,
    result: toolResultText(result).slice(0, 50_000)
  };
  state.events.push(event);
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
  return { ok: !result.isError, ms: event.ms, result, event };
}

async function callAgentMcpTool(state, name, args, options = {}) {
  const { toolPolicy = "read-only", signal = null, emit = () => {} } = options;
  throwIfAborted(signal);
  const tool = state.tools.find((item) => item.name === name || sanitizeToolName(item.name) === name);
  const actualName = tool?.name || name;
  const decision = evaluateAgentTool(tool || { name: actualName }, toolPolicy);
  const safeArgs = redactForSupport(args || {});
  if (!decision.allowed) {
    const event = {
      at: new Date().toISOString(),
      tool: actualName,
      args: safeArgs,
      isError: true,
      blocked: true,
      policy: decision.mode,
      level: decision.level,
      ms: 0,
      result: `Tool blocked by ${decision.mode} policy. ${decision.reason}`
    };
    state.events.push(event);
    if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
    emit("tool.blocked", { event, reason: decision.reason });
    emit("tool.completed", { event });
    return {
      ok: false,
      ms: 0,
      result: { isError: true, content: [{ type: "text", text: event.result }] },
      event
    };
  }
  emit("tool.started", { tool: actualName, args: safeArgs, policy: decision.mode, level: decision.level });
  const result = await callMcpTool(state, actualName, args, {
    signal,
    onProgress: (progress) => emit("tool.progress", { tool: actualName, progress: redactForSupport(progress || {}) })
  });
  result.event.args = safeArgs;
  result.event.policy = decision.mode;
  result.event.level = decision.level;
  emit("tool.completed", { event: result.event });
  return result;
}

async function chatWithTools(state, request) {
  if (!state.client) await connectMcp(state, state.mcpEndpoint);
  if (request.provider === "anthropic") return chatAnthropic(state, request);
  if (request.provider === "ollama") return chatOllama(state, request);
  return chatOpenAI(state, request);
}

async function chatOpenAI(state, { message, model, history, contextSummary = "", toolPolicy = "read-only", signal = null, emit = () => {} }) {
  const apiKey = await state.secretStore.get("openai");
  if (!apiKey) throw new Error("OpenAI API key is not configured. Add it in Provider Keys or set OPENAI_API_KEY.");
  const timeline = [];
  const input = [
    { role: "system", content: systemPrompt(state.manifest, { contextSummary, toolPolicy }) },
    ...providerMessages(history || [{ role: "user", content: message }])
  ];
  let response = null;
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    throwIfAborted(signal);
    response = await httpJson("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input,
        tools: state.tools.map(openAiTool),
        tool_choice: "auto"
      })
    }, { signal });
    const calls = (response.output || []).filter((item) => item.type === "function_call");
    if (!calls.length) return { provider: "openai", text: extractOpenAiText(response), timeline, raw: response };
    input.push(...response.output);
    for (const call of calls) {
      throwIfAborted(signal);
      const args = parseJsonObject(call.arguments);
      const result = await callAgentMcpTool(state, originalToolName(state, call.name), args, { toolPolicy, signal, emit });
      timeline.push(result.event);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result.event.result });
    }
  }
  return { provider: "openai", text: extractOpenAiText(response) || "Stopped after max tool loops.", timeline, raw: response };
}

async function chatAnthropic(state, { message, model, history, contextSummary = "", toolPolicy = "read-only", signal = null, emit = () => {} }) {
  const apiKey = await state.secretStore.get("anthropic");
  if (!apiKey) throw new Error("Anthropic API key is not configured. Add it in Provider Keys or set ANTHROPIC_API_KEY.");
  const timeline = [];
  const messages = providerMessages(history || [{ role: "user", content: message }]);
  let response = null;
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    throwIfAborted(signal);
    response = await httpJson("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model || "claude-3-5-sonnet-latest",
        max_tokens: 4096,
        system: systemPrompt(state.manifest, { contextSummary, toolPolicy }),
        messages,
        tools: state.tools.map(anthropicTool)
      })
    }, { signal });
    const uses = (response.content || []).filter((item) => item.type === "tool_use");
    if (!uses.length) return { provider: "anthropic", text: anthropicText(response), timeline, raw: response };
    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];
    for (const use of uses) {
      throwIfAborted(signal);
      const result = await callAgentMcpTool(state, use.name, use.input || {}, { toolPolicy, signal, emit });
      timeline.push(result.event);
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: result.event.result, is_error: !result.ok });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return { provider: "anthropic", text: anthropicText(response) || "Stopped after max tool loops.", timeline, raw: response };
}

async function chatOllama(state, { message, model, history, contextSummary = "", toolPolicy = "read-only", signal = null, emit = () => {} }) {
  const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const timeline = [];
  const messages = [
    { role: "system", content: systemPrompt(state.manifest, { contextSummary, toolPolicy }) },
    ...providerMessages(history || [{ role: "user", content: message }])
  ];
  let response = null;
  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    throwIfAborted(signal);
    response = await httpJson(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model || "qwen2.5-coder:7b",
        stream: false,
        messages,
        tools: state.tools.map(ollamaTool)
      })
    }, { signal });
    const msg = response.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) return { provider: "ollama", text: msg.content || "", timeline, raw: response };
    messages.push(msg);
    for (const call of calls) {
      throwIfAborted(signal);
      const fn = call.function || {};
      const result = await callAgentMcpTool(state, fn.name, parseJsonObject(fn.arguments), { toolPolicy, signal, emit });
      timeline.push(result.event);
      messages.push({ role: "tool", content: result.event.result, name: fn.name });
    }
  }
  return { provider: "ollama", text: response?.message?.content || "Stopped after max tool loops.", timeline, raw: response };
}

async function readProfiles(state) {
  const file = join(state.storageDir, "profiles.json");
  if (!existsSync(file)) return { profiles: [] };
  return JSON.parse(await readFile(file, "utf8"));
}

async function saveProfile(state, body) {
  const data = await readProfiles(state);
  const current = (data.profiles || []).find((item) => item.id === body.id);
  const profile = {
    id: body.id || safeId(body.name || "profile"),
    name: body.name || current?.name || "Profile",
    endpoint: body.endpoint || state.mcpEndpoint,
    provider: body.provider || DEFAULT_PROVIDER,
    model: body.model || DEFAULT_MODEL,
    workspace: body.workspace || current?.workspace || state.repoRoot || process.cwd(),
    extraRoots: Array.isArray(body.extraRoots) ? body.extraRoots : current?.extraRoots || [],
    mode: body.mode || current?.mode || "safe",
    policy: body.policy || current?.policy || "balanced",
    port: Number(body.port || current?.port || 8787),
    dashboardPort: Number(body.dashboardPort || current?.dashboardPort || 8790),
    tunnelId: body.tunnelId || current?.tunnelId || "",
    organizationId: body.organizationId || current?.organizationId || "",
    updatedAt: new Date().toISOString()
  };
  data.profiles = (data.profiles || []).filter((item) => item.id !== profile.id);
  data.profiles.push(profile);
  await mkdir(state.storageDir, { recursive: true });
  await writeFile(join(state.storageDir, "profiles.json"), JSON.stringify(data, null, 2), "utf8");
  return { ok: true, profile, profiles: data.profiles };
}

async function deleteProfile(state, id) {
  if (!id) throw new Error("profile id is required");
  const data = await readProfiles(state);
  const before = (data.profiles || []).length;
  data.profiles = (data.profiles || []).filter((item) => item.id !== id);
  await mkdir(state.storageDir, { recursive: true });
  await writeFile(join(state.storageDir, "profiles.json"), JSON.stringify(data, null, 2), "utf8");
  if (state.activeProfile?.id === id) state.activeProfile = null;
  return { ok: true, deleted: before !== data.profiles.length, profiles: data.profiles };
}

async function activateProfile(state, body) {
  const data = await readProfiles(state);
  const profile = (data.profiles || []).find((item) => item.id === body.id);
  if (!profile) throw new Error(`Profile not found: ${body.id || ""}`);
  state.activeProfile = profile;
  state.mcpEndpoint = profile.endpoint || `http://127.0.0.1:${profile.port || 8787}/mcp`;
  state.dashboardUrl = `http://127.0.0.1:${profile.dashboardPort || 8790}`;
  if (state.client) {
    await state.client.close().catch(() => {});
    state.client = null;
    state.tools = [];
  }
  return { ok: true, profile, endpoint: state.mcpEndpoint, dashboardUrl: state.dashboardUrl };
}

async function exportProfiles(state) {
  const data = await readProfiles(state);
  return {
    exportedAt: new Date().toISOString(),
    profiles: (data.profiles || []).map((profile) => ({
      ...profile,
      tunnelId: profile.tunnelId ? "[configured]" : "",
      organizationId: profile.organizationId ? "[configured]" : ""
    }))
  };
}

async function serverStatus(state) {
  const port = state.activeProfile?.port || Number(new URL(state.mcpEndpoint).port || 8787);
  let health = null;
  try {
    health = await httpJson(`http://127.0.0.1:${port}/healthz`, {}, { retries: 0 });
  } catch {
    health = null;
  }
  return {
    ok: true,
    running: health?.status === "ok",
    managed: Boolean(state.serverProcess && !state.serverProcess.killed),
    pid: health?.pid || state.serverProcess?.pid || null,
    health,
    logs: state.serverLogs.slice(-100)
  };
}

async function startManagedServer(state, body) {
  if (!state.repoRoot) throw new Error("Could not locate the Local Coding Agent repo root.");
  const profile = state.activeProfile || {};
  const port = Number(body.port || profile.port || 8787);
  const dashboardPort = Number(body.dashboardPort || profile.dashboardPort || 8790);
  assertPort(port, "MCP");
  assertPort(dashboardPort, "dashboard");
  const workspace = resolve(body.workspace || profile.workspace || state.repoRoot);
  state.mcpEndpoint = `http://127.0.0.1:${port}/mcp`;
  state.dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
  const existing = await serverStatus(state);
  if (existing.running) return { ...existing, endpoint: state.mcpEndpoint, dashboardUrl: state.dashboardUrl, alreadyRunning: true };
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: join(state.repoRoot, "server"),
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_WORKSPACE: workspace,
      AGENT_EXTRA_ROOTS_JSON: JSON.stringify(body.extraRoots || profile.extraRoots || []),
      AGENT_MODE: body.mode || profile.mode || "safe",
      AGENT_POLICY: body.policy || profile.policy || "balanced",
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {})
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  state.serverProcess = child;
  state.serverLogs = [];
  child.stdout.on("data", (chunk) => appendServerLog(state, chunk));
  child.stderr.on("data", (chunk) => appendServerLog(state, chunk, "ERR"));
  child.on("exit", (code, signal) => {
    state.serverLogs.push(`${new Date().toISOString()} EXIT code=${code} signal=${signal || ""}`);
    state.serverProcess = null;
  });
  for (let i = 0; i < 40; i++) {
    const status = await serverStatus(state);
    if (status.running) return { ...status, endpoint: state.mcpEndpoint, dashboardUrl: state.dashboardUrl, workspace };
    await sleep(250);
  }
  throw new Error(`Managed MCP server did not become healthy on port ${port}`);
}

async function stopManagedServer(state) {
  const child = state.serverProcess;
  if (!child) return { ok: true, stopped: false, reason: "No server process was started by this Studio instance." };
  if (process.platform === "win32") {
    await runChild("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], process.cwd());
  } else {
    child.kill("SIGTERM");
  }
  state.serverProcess = null;
  if (state.client) {
    await state.client.close().catch(() => {});
    state.client = null;
    state.tools = [];
  }
  return { ok: true, stopped: true };
}

function appendServerLog(state, chunk, prefix = "OUT") {
  for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
    state.serverLogs.push(`${new Date().toISOString()} ${prefix} ${line}`);
  }
  if (state.serverLogs.length > 500) state.serverLogs.splice(0, state.serverLogs.length - 500);
}

async function dashboardJson(state, path, options = {}) {
  const url = buildDashboardRequestUrl(state.dashboardUrl, path, { method: options.method || "GET" });
  return httpJson(url, options, { retries: 0 });
}

async function validateSkills(state) {
  if (!state.repoRoot) throw new Error("Could not locate repo root.");
  const result = await runChild(process.execPath, [join(state.repoRoot, "scripts", "validate-skills.mjs")], state.repoRoot);
  return { ok: result.code === 0, ...result };
}

async function runCustomerUpdate(state, body) {
  if (!state.repoRoot) throw new Error("Could not locate repo root.");
  if (body.confirm !== "update") throw new Error('Set confirm="update" to run the guarded customer update flow.');
  const args = [join(state.repoRoot, "scripts", "local-coding-agent.mjs"), "update"];
  if (body.force === true) args.push("--force");
  const result = await runChild(process.execPath, args, state.repoRoot, 15 * 60_000);
  return { ok: result.code === 0, ...result };
}

async function writeSupportBundle(state) {
  await mkdir(join(state.storageDir, "support-bundles"), { recursive: true });
  const stamp = Date.now();
  const bundleDir = join(state.storageDir, "support-bundles");
  const file = join(bundleDir, `support-${stamp}.json`);
  const networkDoctorPath = join(bundleDir, `network-doctor-${stamp}.txt`);
  const status = (state.manifest.features || []).includes("serverSupervisor") ? await serverStatus(state) : null;
  let metrics = null;
  let approvals = null;
  try { metrics = await dashboardJson(state, "/metrics"); } catch {}
  try { approvals = await dashboardJson(state, "/api/approvals"); } catch {}
  let doctor = null;
  if (state.client && state.tools.some((tool) => tool.name === "workspace_doctor")) {
    doctor = await callMcpTool(state, "workspace_doctor", {});
  }
  let networkDoctor = null;
  if (state.repoRoot) {
    const mcpUrl = state.mcpEndpoint;
    const healthUrl = mcpUrl.replace(/\/mcp(?:\?.*)?$/, "/healthz");
    const result = await runChild(process.execPath, [
      join(state.repoRoot, "scripts", "network-doctor.mjs"),
      "--out", networkDoctorPath,
      "--mcp-url", mcpUrl,
      "--health-url", healthUrl,
      "--dashboard-url", `${state.dashboardUrl.replace(/\/+$/, "")}/ui`,
      "--no-tunnel-smoke"
    ], state.repoRoot, 90_000);
    networkDoctor = {
      ok: result.code === 0,
      path: networkDoctorPath,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
  const report = {
    createdAt: new Date().toISOString(),
    health: await enrichedHealthPayload(state),
    server: redactForSupport(status),
    metrics: redactForSupport(metrics),
    approvals: redactForSupport(approvals),
    workspaceDoctor: redactForSupport(doctor),
    networkDoctor: redactForSupport(networkDoctor),
    agentSessions: redactForSupport(agentSessionDiagnostics(state)),
    events: state.events.slice(-50).map((event) => ({
      at: event.at,
      tool: event.tool,
      isError: event.isError,
      ms: event.ms
    })),
    permissions: state.permissionBroker.publicAudit(100),
    updates: redactForSupport(state.updateService.status()),
    tools: publicTools(state.tools),
    redaction: "Sensitive keys, credentials, private keys, authorization values, and secret-like strings are recursively redacted."
  };
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  return { ok: true, path: file, report };
}

function agentSessionDiagnostics(state) {
  const threads = state.threadStore.listThreads({ limit: 10, includeArchived: true });
  return {
    activeTurns: state.turnManager.listActive(),
    threads: threads.map((thread) => {
      const turns = state.threadStore.listTurns(thread.id, { limit: 10 });
      const items = state.threadStore.listItems(thread.id, { limit: 80 });
      return {
        id: thread.id,
        title: thread.title,
        status: thread.status,
        provider: thread.provider,
        model: thread.model,
        workspace: thread.workspace,
        summarySeq: thread.summarySeq,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        turns,
        recentItems: items.map((item) => ({
          seq: item.seq,
          turnId: item.turnId,
          type: item.type,
          role: item.role,
          createdAt: item.createdAt,
          contentPreview: supportPreview(item.content, item.type === "tool" ? 2_000 : 360),
          metadata: item.type === "tool" ? {
            tool: item.metadata?.tool,
            isError: Boolean(item.metadata?.isError),
            blocked: Boolean(item.metadata?.blocked),
            policy: item.metadata?.policy || null,
            level: item.metadata?.level || null,
            ms: item.metadata?.ms ?? null
          } : undefined
        }))
      };
    })
  };
}

function assertFeature(manifest, name) {
  if (!(manifest.features || []).includes(name)) throw new Error(`Feature not enabled in ${manifest.version}: ${name}`);
}

async function httpJson(url, options = {}, config = {}) {
  const retries = Number(config.retries ?? 2);
  const signal = options.signal || config.signal || null;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      throwIfAborted(signal);
      const res = await fetch(url, { ...options, ...(signal ? { signal } : {}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data?.error?.message || data?.error || `${res.status} ${res.statusText}`);
        error.status = res.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      const retryable = !error?.status || error.status === 429 || error.status >= 500;
      if (attempt >= retries || !retryable) break;
      await sleep(300 * (2 ** attempt), signal);
    }
  }
  throw lastError;
}

function openAiTool(tool) {
  return {
    type: "function",
    name: sanitizeToolName(tool.name),
    description: tool.description || tool.title || `Call MCP tool ${tool.name}`,
    parameters: normalizeSchema(tool.inputSchema)
  };
}

function anthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description || tool.title || `Call MCP tool ${tool.name}`,
    input_schema: normalizeSchema(tool.inputSchema)
  };
}

function ollamaTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.title || `Call MCP tool ${tool.name}`,
      parameters: normalizeSchema(tool.inputSchema)
    }
  };
}

function publicTools(tools, schema = false) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || tool.title || "",
    ...(schema ? { inputSchema: tool.inputSchema || {} } : {})
  }));
}

function systemPrompt(manifest, options = {}) {
  const { contextSummary = "", toolPolicy = "read-only" } = options;
  const policyText = {
    "read-only": "This turn is read-only: inspect, search, summarize, and plan. Mutating, command, network, and unknown tools are blocked.",
    workspace: "This turn may edit workspace files with approved file-edit tools. Commands, destructive actions, network-like actions, and unknown tools are blocked.",
    full: "This turn is in full tool mode by explicit user choice. Prefer safe MCP tools first, explain risky actions, and keep every action scoped to the user's request."
  }[toolPolicy] || "This turn uses the default read-only tool policy.";
  return `You are ${manifest.productName} ${manifest.version}, a standalone local AI coding assistant connected to a Local Coding Agent MCP server.

Rules:
- First inspect the workspace with workspace_info or workspace_snapshot when the task needs repo context.
- Prefer MCP file/search/git tools over shell commands.
- Use read_many for multiple files and run_commands for independent checks.
- Keep edits scoped to the user request.
- Explain risky actions before mutating files or running commands.
- After changing code, run the most relevant checks available.
- If a tool call is denied by policy, explain what approval or safer alternative is needed.

Current tool policy:
${policyText}${contextSummary ? `\n\nConversation summary before the recent window:\n${contextSummary}` : ""}`;
}

function extractOpenAiText(response) {
  if (typeof response?.output_text === "string" && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response?.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" || content.type === "text") parts.push(content.text || "");
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

function anthropicText(response) {
  return (response?.content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n").trim();
}

function toolResultText(result) {
  return result?.content?.map((part) => part.text || JSON.stringify(part)).join("\n") || "";
}

function parseMcpToolPayload(result) {
  const text = toolResultText(result).trim();
  if (!text) return { ok: !result?.isError };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: !result?.isError, text };
  }
}

function requireMcpToolPayload(call, label) {
  const text = toolResultText(call?.result).trim();
  if (!call?.ok) throw new Error(`${label} failed: ${text || "MCP tool error"}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned an invalid JSON payload.`);
  }
}

function originalToolName(state, sanitized) {
  const hit = state.tools.find((tool) => sanitizeToolName(tool.name) === sanitized);
  return hit?.name || sanitized;
}

function sanitizeToolName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const out = JSON.parse(JSON.stringify(schema));
  if (!out.type) out.type = "object";
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function providerMessages(history) {
  return (history || [])
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .map((item) => ({ role: item.role, content: String(item.content || "") }));
}

function validateMcpEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error("MCP endpoint must be a valid URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP endpoint must use HTTP or HTTPS.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!loopback && process.env.LCA_ALLOW_REMOTE_MCP !== "1") {
    throw new Error("Remote MCP endpoints are disabled. Set LCA_ALLOW_REMOTE_MCP=1 only for a trusted endpoint.");
  }
}

function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${label} port: ${value}`);
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function authorizeDesktopBridge(req, state) {
  const expected = Buffer.from(String(state.desktopBridgeToken || ""));
  const suppliedHeader = req.headers?.["x-lca-desktop-token"];
  const supplied = Buffer.from(String(Array.isArray(suppliedHeader) ? suppliedHeader[0] || "" : suppliedHeader || ""));
  return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2_000_000) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, body) {
  sendText(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function sendText(res, status, body, type, headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

async function serveUiIndex(res, security) {
  const html = await readFile(join(UI_DIST_DIR, "index.html"), "utf8");
  const body = html.replace("%LCA_STUDIO_TOKEN%", escapeHtml(security.token));
  sendText(res, 200, body, "text/html; charset=utf-8", security.staticHtmlHeaders());
}

async function serveUiAsset(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "Invalid asset path" });
  }
  const root = resolve(UI_DIST_DIR);
  const filePath = resolve(root, `.${decoded}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    return sendJson(res, 403, { error: "Invalid asset path" });
  }
  if (!existsSync(filePath)) return sendJson(res, 404, { error: "Asset not found" });
  const body = await readFile(filePath);
  sendText(res, 200, body, mimeType(filePath), { "cache-control": "public, max-age=31536000, immutable" });
}

function mimeType(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function applyHeaders(res, headers) {
  for (const [name, value] of Object.entries(headers || {})) res.setHeader(name, value);
}

function getStorageDir(version) {
  const base = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || process.env.HOME || APP_DIR;
  return join(base, "LocalAgentStudio", version);
}

function findRepoRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "server", "server.mjs")) &&
        existsSync(join(current, "scripts", "local-coding-agent.mjs"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function runChild(fileName, args, cwd, timeoutMs = 5 * 60_000) {
  return new Promise((resolveRun) => {
    const child = spawn(fileName, args, {
      cwd,
      env: {
        ...process.env,
        ...(fileName === process.execPath && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {})
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = appendBoundedOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBoundedOutput(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

function sleep(ms, signal = null) {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) return rejectSleep(signal.reason || abortError("Operation cancelled."));
    const timer = setTimeout(resolveSleep, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectSleep(signal.reason || abortError("Operation cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || abortError("Operation cancelled.");
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function appendBoundedOutput(current, chunk, limit = 2_000_000) {
  if (current.length >= limit) return current;
  const next = current + String(chunk);
  return next.length <= limit ? next : `${next.slice(0, limit)}\n[OUTPUT TRUNCATED]`;
}

function supportPreview(value, limit = 360) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[SUPPORT PREVIEW TRUNCATED]`;
}

function publicLicenseStatus(status) {
  return {
    allowed: Boolean(status?.allowed),
    mode: status?.mode || "unknown",
    edition: status?.edition || null,
    source: status?.source || null,
    reason: status?.reason || ""
  };
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "profile";
}

function renderHtml(manifest, security) {
  const features = new Set(manifest.features || []);
  const providers = manifest.providers || ["openai"];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(manifest.productName)} ${escapeHtml(manifest.version)}</title>
  <style nonce="${security.nonce}">
    :root{color-scheme:dark;--bg:#0b0f14;--panel:#111821;--panel2:#0f151d;--text:#e5edf7;--muted:#8ea0b8;--line:#223044;--accent:#28d7bd;--warn:#f7b955;--bad:#ff6b6b}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line);background:#0d131b}h1{font-size:18px;margin:0}h2{font-size:14px;margin:14px 0 8px;color:#b9c8dc}main{display:grid;grid-template-columns:330px minmax(0,1fr)430px;min-height:calc(100vh - 58px)}section{border-right:1px solid var(--line);padding:14px;min-width:0}section:last-child{border-right:0}label{display:block;color:var(--muted);font-size:12px;margin:10px 0 6px}input,textarea,select{width:100%;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:9px 10px;font:inherit}textarea{min-height:128px;resize:vertical}button{background:var(--accent);color:#04110f;border:0;border-radius:6px;padding:9px 12px;font-weight:700;cursor:pointer;margin-top:10px}button.secondary{background:#1b2532;color:var(--text);border:1px solid var(--line)}.row{display:flex;gap:8px;align-items:center}.row>*{flex:1}.pill{display:inline-flex;gap:6px;color:var(--muted);border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:5px 9px;font-size:12px}.ok{color:var(--accent)}.bad{color:var(--bad)}.muted{color:var(--muted)}.box,.msg,.tool{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:9px}.tools,.timeline{display:flex;flex-direction:column;gap:8px;overflow:auto}.tools{max-height:calc(100vh - 360px)}.timeline{max-height:calc(100vh - 116px)}.chat{display:flex;flex-direction:column;gap:10px;height:calc(100vh - 86px)}.messages{flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-right:4px}.msg{white-space:pre-wrap}.msg.user{border-color:#2c6a7a}.msg.agent{border-color:#246b5e}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;color:#c9d7e8;font-size:12px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:12px;color:#c9d7e8;border:1px solid var(--line);border-radius:999px;padding:4px 8px;background:#172131}@media(max-width:980px){main{grid-template-columns:1fr}section{border-right:0;border-bottom:1px solid var(--line)}.chat{height:auto;min-height:520px}}
  </style>
</head>
<body>
  <header><h1>${escapeHtml(manifest.productName)} <span class="muted">${escapeHtml(manifest.version)}</span></h1><span class="pill" id="health">checking...</span></header>
  <main>
    <section>
      <h2>Connection</h2>
      ${features.has("serverSupervisor") ? `<div class="row"><button id="startServer">Start MCP</button><button class="secondary" id="stopServer">Stop MCP</button><button class="secondary" id="serverStatus">Status</button></div>` : ""}
      <label>MCP endpoint</label><input id="endpoint" value="${escapeHtml(manifest.defaultMcpEndpoint || DEFAULT_MCP_URL)}" />
      <button id="connect">Connect MCP</button> <button class="secondary" id="refresh">Refresh Tools</button>
      <div class="box"><b>Status</b><div id="status" class="muted">Not connected yet.</div></div>
      <h2>Features</h2><div class="chips">${(manifest.features || []).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>
      <h2>Threads</h2><button class="secondary" id="newThread">New</button> <button class="secondary" id="loadThreads">Refresh</button><div id="threads" class="box muted">No threads loaded.</div>
      ${features.has("profiles") ? `<h2>Profiles</h2><button class="secondary" id="saveProfile">Save</button> <button class="secondary" id="loadProfiles">Manage</button> <button class="secondary" id="exportProfiles">Export</button><div id="profiles" class="box muted">No profiles loaded.</div>` : ""}
      ${features.has("skills") ? `<h2>Skills</h2><button class="secondary" id="skills">List</button> <button class="secondary" id="readSkill">Read</button> <button class="secondary" id="validateSkills">Validate</button>` : ""}
      ${features.has("dashboard") ? `<h2>Operations</h2><button class="secondary" id="metrics">Metrics</button> <button class="secondary" id="approvals">Approvals</button>` : ""}
      ${features.has("fileViewer") ? `<button class="secondary" id="readFile">Read File</button> <button class="secondary" id="diff">Git Diff</button>` : ""}
      ${features.has("supportBundle") ? `<h2>Support</h2><button class="secondary" id="support">Export Support Bundle</button>` : ""}
      ${features.has("customerUpdateFlow") ? `<h2>Update</h2><button class="secondary" id="update">Run Guarded Update</button>` : ""}
      ${features.has("signedUpdates") ? `<h2>Release Updates</h2><button class="secondary" id="updateStatus">Status</button> <button class="secondary" id="verifyUpdate">Verify Manifest</button> <button class="secondary" id="stageUpdate">Stage Artifact</button>` : ""}
      <h2>Provider Keys</h2><button class="secondary" id="saveOpenAiKey">Save OpenAI</button> <button class="secondary" id="saveAnthropicKey">Save Anthropic</button> <button class="secondary" id="providerKeys">Status</button>
      <h2>License</h2><button class="secondary" id="license">Status / Activate</button>
      <h2>Tools</h2><div class="tools" id="tools"></div>
    </section>
    <section>
      <div class="chat">
        <div class="row">
          <div><label>Provider</label><select id="provider">${providers.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("")}</select></div>
          <div><label>Model</label><input id="model" value="${escapeHtml(manifest.defaultModel || DEFAULT_MODEL)}" /></div>
        </div>
        ${features.has("modelRouter") ? `<div><label>Preset</label><select id="preset"><option value="">Custom</option></select></div>` : ""}
        <div class="messages" id="messages"></div>
        <div><label>Ask the agent</label><textarea id="prompt" placeholder="Example: Call workspace_info, then summarize this workspace."></textarea><button id="send">Send</button></div>
      </div>
    </section>
    <section><h2>Tool Timeline</h2><div class="timeline" id="timeline"></div></section>
  </main>
  <script nonce="${security.nonce}">
    const STUDIO_TOKEN=${JSON.stringify(security.token)};
    const $=(id)=>document.getElementById(id); const state={tools:[],threadId:null};
    const intent=(action)=>({action,confirm:action});
    async function api(path,options={}){const res=await fetch(path,{...options,headers:{"content-type":"application/json","x-lca-studio-token":STUDIO_TOKEN,...(options.headers||{})}});const data=await res.json();if(!res.ok)throw new Error(data.error||res.statusText);return data}
    function addMessage(kind,text){const div=document.createElement("div");div.className="msg "+kind;div.textContent=text;$("messages").appendChild(div);$("messages").scrollTop=$("messages").scrollHeight;return div}
    function escapeHtml(text){return String(text).replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[ch]))}
    function renderTools(){ $("tools").innerHTML=""; for(const tool of state.tools){const div=document.createElement("div");div.className="tool";div.innerHTML="<b>"+escapeHtml(tool.name)+"</b><span class='muted'>"+escapeHtml(tool.description||"")+"</span>";const btn=document.createElement("button");btn.className="secondary";btn.textContent="Call";btn.onclick=async()=>{const raw=prompt("JSON arguments for "+tool.name,"{}");if(raw===null)return;try{const args=JSON.parse(raw);const data=await api("/api/call-tool",{method:"POST",body:JSON.stringify({name:tool.name,arguments:args,intent:intent("tool:call")})});addTimeline(data.event||{tool:tool.name,args,isError:!data.ok,ms:data.ms,result:JSON.stringify(data.result,null,2)})}catch(err){addTimeline({tool:tool.name,args:{},isError:true,ms:0,result:err.message})}};div.appendChild(btn);$("tools").appendChild(div)}}
    function addTimeline(event){const div=document.createElement("div");div.className="box";const status=event.isError?"<span class='bad'>error</span>":"<span class='ok'>ok</span>";div.innerHTML="<b>"+escapeHtml(event.tool)+"</b> "+status+" <span class='muted'>"+(event.ms||0)+"ms</span><pre>"+escapeHtml(JSON.stringify(event.args||{},null,2))+"</pre><pre>"+escapeHtml(String(event.result||"").slice(0,4000))+"</pre>";$("timeline").prepend(div)}
    async function health(){try{const data=await api("/api/health");$("health").innerHTML=data.license?.allowed?(data.openai_key_present||data.anthropic_key_present?"<span class='ok'>ready</span>":"<span class='bad'>model setup needed</span>"):"<span class='bad'>license required</span>";if($("preset")){const p=await api("/api/model-presets");for(const item of p.presets||[]){const opt=document.createElement("option");opt.value=item.id;opt.textContent=item.label+" - "+item.provider+"/"+item.model;opt.dataset.provider=item.provider;opt.dataset.model=item.model;$("preset").appendChild(opt)}$("preset").onchange=()=>{const opt=$("preset").selectedOptions[0];if(opt&&opt.dataset.provider){$("provider").value=opt.dataset.provider;$("model").value=opt.dataset.model}}}await loadThreads()}catch{$("health").innerHTML="<span class='bad'>offline</span>"}}
    async function connect(){ $("status").textContent="Connecting..."; const data=await api("/api/connect",{method:"POST",body:JSON.stringify({endpoint:$("endpoint").value.trim()})}); state.tools=data.tools||[]; $("status").textContent="Connected to "+data.endpoint+". "+state.tools.length+" tools."; renderTools()}
    async function refreshTools(){const data=await api("/api/tools");state.tools=data.tools||[];$("status").textContent="Connected to "+data.endpoint+". "+state.tools.length+" tools.";renderTools()}
    async function send(){const message=$("prompt").value.trim();if(!message)return;$("prompt").value="";addMessage("user",message);const last=addMessage("agent","Thinking...");try{const data=await api("/api/chat",{method:"POST",body:JSON.stringify({threadId:state.threadId,message,provider:$("provider").value,model:$("model").value.trim()})});state.threadId=data.threadId;last.textContent=data.text||"(no text)";for(const event of data.timeline||[])addTimeline(event);await loadThreads()}catch(err){last.textContent="Error: "+err.message}}
    async function loadThreads(){const data=await api("/api/threads?limit=50");const box=$("threads");box.textContent="";for(const thread of data.threads||[]){const btn=document.createElement("button");btn.className="secondary";btn.textContent=(thread.id===state.threadId?"* ":"")+thread.title;btn.title=thread.provider+"/"+thread.model;btn.onclick=()=>openThread(thread.id);box.appendChild(btn)}if(!(data.threads||[]).length)box.textContent="No threads."}
    async function openThread(id){const data=await api("/api/threads/"+encodeURIComponent(id)+"?limit=100");state.threadId=id;$("messages").textContent="";$("timeline").textContent="";for(const item of data.items||[]){if(item.type==="message")addMessage(item.role==="user"?"user":"agent",item.content);else if(item.type==="tool")addTimeline({tool:item.metadata?.tool,args:item.metadata?.args,isError:item.metadata?.isError,ms:item.metadata?.ms,result:item.content})}await loadThreads()}
    function newThread(){state.threadId=null;$("messages").textContent="";$("timeline").textContent="";$("status").textContent="New thread ready.";loadThreads()}
    async function saveProfile(){const name=prompt("Profile name","Default");if(!name)return;const workspace=prompt("Workspace path","")||"";const data=await api("/api/profiles",{method:"POST",body:JSON.stringify({name,workspace,endpoint:$("endpoint").value.trim(),provider:$("provider").value,model:$("model").value.trim(),mode:"safe",policy:"balanced"})});renderProfileList(data.profiles)}
    function renderProfileList(profiles){$("profiles").textContent=(profiles||[]).map(p=>p.id+" | "+p.name+" | "+p.provider+"/"+p.model+" | "+p.workspace).join("\\n")||"No profiles."}
    async function manageProfiles(){const data=await api("/api/profiles");renderProfileList(data.profiles);const action=prompt("Enter profile id to activate, or delete:<id>","");if(!action)return;if(action.startsWith("delete:")){const deleted=await api("/api/profiles?id="+encodeURIComponent(action.slice(7)),{method:"DELETE"});renderProfileList(deleted.profiles);return}const active=await api("/api/profiles/activate",{method:"POST",body:JSON.stringify({id:action})});$("endpoint").value=active.endpoint;$("provider").value=active.profile.provider;$("model").value=active.profile.model;$("status").textContent="Activated profile "+active.profile.name}
    async function exportProfiles(){const data=await api("/api/profiles/export");addMessage("agent","Redacted profiles:\\n"+JSON.stringify(data,null,2))}
    async function listSkills(){const data=await api("/api/skills");addTimeline({tool:"list_skills",args:{},isError:!data.ok,ms:data.ms,result:JSON.stringify(data.result,null,2)})}
    async function readSkill(){const name=prompt("Skill name","");if(!name)return;const data=await api("/api/skills?name="+encodeURIComponent(name));addTimeline({tool:"read_skill",args:{name},isError:!data.ok,ms:data.ms,result:JSON.stringify(data.result,null,2)})}
    async function validateSkills(){const data=await api("/api/skills/validate",{method:"POST",body:"{}"});addMessage("agent","Skill validation "+(data.ok?"passed":"failed")+":\\n"+data.stdout+"\\n"+data.stderr)}
    async function showMetrics(){const data=await api("/api/dashboard/metrics");addMessage("agent","Dashboard metrics:\\n"+JSON.stringify(data,null,2))}
    async function manageApprovals(){const data=await api("/api/approvals");addMessage("agent","Pending approvals:\\n"+JSON.stringify(data.pending||[],null,2));const action=prompt("Optional action: approve:<id> or deny:<id>","");if(!action)return;const parts=action.split(":");if(parts.length===2)await api("/api/approvals/"+encodeURIComponent(parts[1])+"/"+encodeURIComponent(parts[0]),{method:"POST",body:JSON.stringify({intent:intent("approval:mutate")})})}
    async function readWorkspaceFile(){const path=prompt("Workspace-relative file path","README.md");if(!path)return;const data=await api("/api/dashboard/file?path="+encodeURIComponent(path));addMessage("agent",data.path+"\\n\\n"+data.content)}
    async function showDiff(){const data=await api("/api/dashboard/diff");addMessage("agent","Git diff:\\n"+(data.diff||data.error||"(empty)"))}
    async function startServer(){const workspace=prompt("Workspace path for MCP server","");const data=await api("/api/server/start",{method:"POST",body:JSON.stringify({workspace:workspace||undefined,mode:"safe",policy:"balanced",intent:intent("mcp-server:start")})});$("endpoint").value=data.endpoint;$("status").textContent="MCP server running at "+data.endpoint}
    async function stopServer(){const data=await api("/api/server/stop",{method:"POST",body:JSON.stringify({intent:intent("mcp-server:stop")})});$("status").textContent=data.stopped?"Managed MCP server stopped.":data.reason}
    async function serverStatus(){const data=await api("/api/server/status");addMessage("agent","Server status:\\n"+JSON.stringify(data,null,2))}
    async function supportBundle(){const data=await api("/api/support-bundle",{method:"POST",body:JSON.stringify({intent:intent("support-bundle:export")})});addMessage("agent","Support bundle written:\\n"+data.path)}
    async function runUpdate(){if(prompt('Type "update" to run guarded repository update','')!=="update")return;const data=await api("/api/update",{method:"POST",body:JSON.stringify({confirm:"update",intent:intent("customer-update:run")})});addMessage("agent","Update "+(data.ok?"completed":"failed")+":\\n"+data.stdout+"\\n"+data.stderr)}
    async function releaseUpdateStatus(){const data=await api("/api/release-update/status");addMessage("agent","Release update status:\\n"+JSON.stringify(data,null,2))}
    async function verifyReleaseUpdate(){const raw=prompt("Paste signed update manifest JSON","");if(!raw)return;const envelope=JSON.parse(raw);const data=await api("/api/release-update/verify",{method:"POST",body:JSON.stringify({envelope,intent:intent("release-update:verify")})});addMessage("agent","Release update verified:\\n"+JSON.stringify(data,null,2))}
    async function stageReleaseUpdate(){const raw=prompt("Paste signed update manifest JSON to download and stage","");if(!raw||!confirm("Download and verify this artifact? It will not be executed."))return;const envelope=JSON.parse(raw);const data=await api("/api/release-update/stage",{method:"POST",body:JSON.stringify({envelope,intent:intent("release-update:stage")})});addMessage("agent","Release update staged:\\n"+JSON.stringify(data,null,2))}
    async function saveProviderKey(provider){const value=prompt(provider+" API key","");if(!value)return;const data=await api("/api/secrets/"+encodeURIComponent(provider),{method:"POST",body:JSON.stringify({value,label:provider+" key",intent:intent("provider-key:set")})});addMessage("agent",provider+" key saved: "+JSON.stringify(data))}
    async function providerKeyStatus(){const data=await api("/api/secrets");addMessage("agent","Provider keys:\\n"+JSON.stringify(data,null,2))}
    async function license(){const status=await api("/api/license");if(status.allowed&&status.mode==="experimental"){addMessage("agent","License: Preview mode. Commercial key is not required yet.");return}const token=prompt(status.reason+"\nPaste the admin-provided signed license token, or Cancel:","");if(!token)return;const activated=await api("/api/license/activate",{method:"POST",body:JSON.stringify({token,intent:intent("license:activate")})});addMessage("agent","License activated: "+activated.edition)}
    $("connect").onclick=()=>connect().catch(err=>$("status").textContent=err.message);$("refresh").onclick=()=>refreshTools().catch(err=>$("status").textContent=err.message);$("send").onclick=send;$("prompt").addEventListener("keydown",(event)=>{if(event.ctrlKey&&event.key==="Enter")send()});
    if($("saveProfile"))$("saveProfile").onclick=saveProfile;if($("loadProfiles"))$("loadProfiles").onclick=manageProfiles;if($("exportProfiles"))$("exportProfiles").onclick=exportProfiles;
    if($("skills"))$("skills").onclick=listSkills;if($("readSkill"))$("readSkill").onclick=readSkill;if($("validateSkills"))$("validateSkills").onclick=validateSkills;
    if($("metrics"))$("metrics").onclick=showMetrics;if($("approvals"))$("approvals").onclick=manageApprovals;if($("readFile"))$("readFile").onclick=readWorkspaceFile;if($("diff"))$("diff").onclick=showDiff;
    if($("startServer"))$("startServer").onclick=startServer;if($("stopServer"))$("stopServer").onclick=stopServer;if($("serverStatus"))$("serverStatus").onclick=serverStatus;
    if($("support"))$("support").onclick=supportBundle;if($("update"))$("update").onclick=runUpdate;
    if($("updateStatus"))$("updateStatus").onclick=releaseUpdateStatus;if($("verifyUpdate"))$("verifyUpdate").onclick=verifyReleaseUpdate;if($("stageUpdate"))$("stageUpdate").onclick=stageReleaseUpdate;
    $("saveOpenAiKey").onclick=()=>saveProviderKey("openai");$("saveAnthropicKey").onclick=()=>saveProviderKey("anthropic");$("providerKeys").onclick=providerKeyStatus;
    $("newThread").onclick=newThread;$("loadThreads").onclick=loadThreads;$("license").onclick=license;health();
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
