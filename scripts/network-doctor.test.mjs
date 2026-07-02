import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseTunnelLog, quickDiagnosis, summarizeTunnelLog } from "./network-doctor.mjs";

test("does not mistake proxyhealth or timestamp digits for proxy and HTTP 403 errors", () => {
  const log = [
    '{"time":"2026-07-02T10:54:43.4034387+07:00","msg":"OnStart hook executing","callee":"proxyhealth.startChecker"}',
    '{"time":"2026-07-02T10:54:43.4034387+07:00","msg":"poll failed; backing off","error":"read ECONNRESET"}'
  ].join("\n");

  const hints = diagnoseTunnelLog(log);
  assert.equal(hints.some((hint) => hint.includes("Proxy")), false);
  assert.equal(hints.some((hint) => hint.includes("Forbidden")), false);
  assert.equal(hints.some((hint) => hint.includes("reset/forcibly closed")), true);
});

test("recognizes a successful tunnel smoke test", () => {
  const log = [
    '{"msg":"mcp session initialized"}',
    '{"msg":"tunnel metadata fetched"}',
    '{"msg":"poll cycle complete","commands_polled":0}'
  ].join("\n");

  assert.deepEqual(summarizeTunnelLog(log), {
    smoke_status: "connected",
    mcp_initialized: true,
    control_plane_reachable: true,
    metadata_fetched: true,
    poll_succeeded: true,
    poll_failed: false
  });
});

test("explains Node CA mismatch without declaring a working tunnel blocked", () => {
  const tlsFailure = (host) => ({
    name: `tls:${host}:443`,
    ok: false,
    error: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    message: "unable to get local issuer certificate"
  });
  const diagnosis = quickDiagnosis({
    network: [tlsFailure("api.openai.com"), tlsFailure("chatgpt.com")],
    http: [{
      name: "http:GET:https://api.openai.com/v1/models",
      ok: false,
      error: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate"
    }],
    local: [{ name: "http:GET:http://127.0.0.1:8787/healthz", ok: true }],
    tunnel: { smoke_status: "connected", diagnosis_hints: [] }
  });

  assert.equal(diagnosis.some((hint) => hint.includes("different CA trust stores")), true);
  assert.equal(diagnosis.some((hint) => hint.startsWith("HTTPS request")), false);
  assert.equal(diagnosis.some((hint) => hint.startsWith("Tunnel smoke test connected")), true);
});
