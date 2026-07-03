import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardRequestUrl } from "../core/dashboard-proxy.mjs";

test("dashboard proxy allows only loopback read routes and exact approval actions", () => {
  assert.equal(
    buildDashboardRequestUrl("http://127.0.0.1:8790", "/api/tree?path=src&depth=3"),
    "http://127.0.0.1:8790/api/tree?path=src&depth=3"
  );
  assert.equal(
    buildDashboardRequestUrl("http://[::1]:8790", "/api/approvals/request-1/approve", { method: "POST" }),
    "http://[::1]:8790/api/approvals/request-1/approve"
  );
});

test("dashboard proxy rejects remote origins, credentials, and non-allowlisted routes", () => {
  assert.throws(() => buildDashboardRequestUrl("https://example.com", "/api/tree"), /loopback HTTP/);
  assert.throws(() => buildDashboardRequestUrl("http://user:pass@127.0.0.1:8790", "/api/tree"), /only a loopback origin/);
  assert.throws(() => buildDashboardRequestUrl("http://127.0.0.1:8790/base", "/api/tree"), /only a loopback origin/);
  assert.throws(() => buildDashboardRequestUrl("http://127.0.0.1:8790", "//example.com/api/tree"), /absolute local route/);
  assert.throws(() => buildDashboardRequestUrl("http://127.0.0.1:8790", "/api/health"), /not allowlisted/);
  assert.throws(() => buildDashboardRequestUrl("http://127.0.0.1:8790", "/api/approvals/../approve", { method: "POST" }), /not allowlisted/);
  assert.throws(() => buildDashboardRequestUrl("http://127.0.0.1:8790", "/api/approvals/id/approve?next=evil", { method: "POST" }), /not allowlisted/);
});
