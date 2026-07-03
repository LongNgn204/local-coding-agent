const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const READ_ROUTES = new Set(["/metrics", "/api/tree", "/api/file", "/api/diff", "/api/approvals"]);
const APPROVAL_ACTION = /^\/api\/approvals\/[A-Za-z0-9_.-]{1,160}\/(?:approve|deny)$/;

export function buildDashboardRequestUrl(baseUrl, requestPath, { method = "GET" } = {}) {
  const base = parseUrl(baseUrl, "Dashboard URL");
  const hostname = base.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("Dashboard proxy requires a loopback HTTP endpoint.");
  }
  if (base.username || base.password || base.search || base.hash || (base.pathname && base.pathname !== "/")) {
    throw new Error("Dashboard proxy base URL must contain only a loopback origin.");
  }

  const rawPath = String(requestPath || "");
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\")) {
    throw new Error("Dashboard proxy path must be an absolute local route.");
  }
  const target = parseUrl(rawPath, "Dashboard route", base);
  if (target.origin !== base.origin || target.hash) throw new Error("Dashboard proxy route escaped the local origin.");

  const normalizedMethod = String(method || "GET").toUpperCase();
  const allowed = normalizedMethod === "GET"
    ? READ_ROUTES.has(target.pathname)
    : normalizedMethod === "POST" && APPROVAL_ACTION.test(target.pathname) && !target.search;
  if (!allowed) throw new Error(`Dashboard proxy route is not allowlisted: ${normalizedMethod} ${target.pathname}`);
  return target.href;
}

function parseUrl(value, label, base) {
  try {
    return new URL(value, base);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}
