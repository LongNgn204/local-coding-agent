using LocalCodingAgentTray;

const string expectedId = "tunnel_111111111111111111111111feedbeef";

var ready = RuntimeStatus.ParseTunnelStatus(
    $$"""
    {
      "control_plane_tunnel_id": "{{expectedId}}",
      "channels": [
        {
          "name": "main",
          "enabled": true,
          "server_kind": "external",
          "transport_kind": "http-streamable",
          "probe_status": "succeeded",
          "probe_error": "",
          "reason": ""
        }
      ]
    }
    """,
    expectedId);
Assert(ready.Ready, "enabled main channel with matching ID should be ready");
Assert(!ready.ProbeFailed, "successful channel must not be marked failed");

var raceFailure = RuntimeStatus.ParseTunnelStatus(
    $$"""
    {
      "control_plane_tunnel_id": "{{expectedId}}",
      "channels": [
        {
          "name": "main",
          "enabled": false,
          "probe_status": "failed",
          "probe_error": "dial tcp 127.0.0.1:8798: connectex: actively refused",
          "reason": "initial mcp probe failed"
        }
      ]
    }
    """,
    expectedId);
Assert(!raceFailure.Ready, "failed initial MCP probe must not be ready");
Assert(raceFailure.ProbeFailed, "startup race must be recognized as a failed probe");
Assert(RuntimeStatus.FailureSummary(raceFailure).Contains("127.0.0.1:8798"),
    "failure summary should retain the actionable local target");

var staleId = RuntimeStatus.ParseTunnelStatus(
    """
    {
      "control_plane_tunnel_id": "tunnel_old",
      "channels": [{ "name": "main", "enabled": true, "probe_status": "succeeded" }]
    }
    """,
    expectedId);
Assert(staleId.TunnelIdMismatch, "different active and configured IDs must be detected");
Assert(!staleId.Ready, "ID mismatch must block ready state");

var missingMain = RuntimeStatus.ParseTunnelStatus(
    $$"""{ "control_plane_tunnel_id": "{{expectedId}}", "channels": [] }""",
    expectedId);
Assert(!missingMain.Ready && missingMain.Reason.Contains("missing"),
    "missing main channel should have an actionable status");

Assert(RuntimeStatus.TunnelIdFingerprint(expectedId) == "...feedbeef",
    "fingerprint must expose only the final eight characters");
Assert(RuntimeStatus.TunnelIdFingerprint("") == "not configured",
    "empty tunnel ID should be explicit");

Console.WriteLine("PASS tray runtime status smoke test");

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
