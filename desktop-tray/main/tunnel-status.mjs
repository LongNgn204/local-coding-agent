// Local Coding Agent Tray — tunnel runtime status parsing.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mirrors tray-app/RuntimeStatus.cs: parses the tunnel-client admin endpoint
// JSON and decides whether the "main" MCP channel is really connected.

import { oneLine } from "./util.mjs";

export function parseTunnelStatus(json, expectedTunnelId) {
  const root = json && typeof json === "object" ? json : {};
  const activeTunnelId = String(root.control_plane_tunnel_id || "");
  const expected = String(expectedTunnelId || "").trim();
  const mismatch = expected.length > 0 && activeTunnelId.length > 0 && activeTunnelId !== expected;

  const channels = Array.isArray(root.channels) ? root.channels : null;
  if (!channels) {
    return missingChannel(activeTunnelId, mismatch);
  }
  const main = channels.find((ch) => String(ch.name || "").toLowerCase() === "main");
  if (!main) {
    return missingChannel(activeTunnelId, mismatch);
  }

  const probeStatus = String(main.probe_status || "");
  const probeError = String(main.probe_error || "");
  const reason = String(main.reason || "");
  const channelEnabled = main.enabled === true;
  const probeFailed =
    probeStatus.toLowerCase() === "failed" ||
    reason.toLowerCase().includes("probe failed") ||
    probeError.length > 0;

  return {
    reachable: true,
    channelEnabled,
    probeStatus,
    probeError,
    reason,
    activeTunnelId,
    tunnelIdMismatch: mismatch,
    probeFailed,
    ready: channelEnabled && !probeFailed && !mismatch
  };
}

function missingChannel(activeTunnelId, mismatch) {
  return {
    reachable: true,
    channelEnabled: false,
    probeStatus: "missing",
    probeError: "",
    reason: "main channel is missing",
    activeTunnelId,
    tunnelIdMismatch: mismatch,
    ready: false
  };
}

export function tunnelIdFingerprint(tunnelId) {
  const value = String(tunnelId || "").trim();
  if (!value) return "not configured";
  return `...${value.slice(-8)}`;
}

export function tunnelFailureSummary(status) {
  if (!status) return "tunnel admin endpoint unavailable";
  if (status.tunnelIdMismatch) return "tunnel ID mismatch";
  if (status.probeError) return oneLine(status.probeError);
  if (status.reason) return oneLine(status.reason);
  if (status.probeStatus) return `probe ${status.probeStatus}`;
  return status.reachable ? "main channel is not enabled" : "tunnel admin endpoint unavailable";
}