// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Text.Json;

namespace LocalCodingAgentTray;

/// <summary>
/// Parsed status from tunnel-client's local admin endpoint. Keeping parsing in
/// a UI-independent type makes startup/recovery decisions deterministic and
/// easy to smoke-test without launching WinForms.
/// </summary>
public sealed record TunnelRuntimeStatus(
    bool Reachable,
    bool ChannelEnabled,
    string ProbeStatus,
    string ProbeError,
    string Reason,
    string ActiveTunnelId,
    bool TunnelIdMismatch)
{
    public bool ProbeFailed =>
        ProbeStatus.Equals("failed", StringComparison.OrdinalIgnoreCase)
        || Reason.Contains("probe failed", StringComparison.OrdinalIgnoreCase)
        || ProbeError.Length > 0;

    public bool Ready => Reachable && ChannelEnabled && !ProbeFailed && !TunnelIdMismatch;

    public static TunnelRuntimeStatus Unreachable(string reason = "admin endpoint unavailable") =>
        new(false, false, "unreachable", "", reason, "", false);
}

public static class RuntimeStatus
{
    public static TunnelRuntimeStatus ParseTunnelStatus(string json, string? expectedTunnelId)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var activeTunnelId = ReadString(root, "control_plane_tunnel_id");
        var expected = expectedTunnelId?.Trim() ?? "";
        var mismatch = expected.Length > 0
            && activeTunnelId.Length > 0
            && !activeTunnelId.Equals(expected, StringComparison.Ordinal);

        if (!root.TryGetProperty("channels", out var channels)
            || channels.ValueKind != JsonValueKind.Array)
        {
            return new TunnelRuntimeStatus(
                true, false, "missing", "", "main channel is missing",
                activeTunnelId, mismatch);
        }

        foreach (var channel in channels.EnumerateArray())
        {
            if (!ReadString(channel, "name").Equals("main", StringComparison.OrdinalIgnoreCase))
                continue;

            var enabled = channel.TryGetProperty("enabled", out var enabledValue)
                && enabledValue.ValueKind == JsonValueKind.True;
            return new TunnelRuntimeStatus(
                true,
                enabled,
                ReadString(channel, "probe_status"),
                ReadString(channel, "probe_error"),
                ReadString(channel, "reason"),
                activeTunnelId,
                mismatch);
        }

        return new TunnelRuntimeStatus(
            true, false, "missing", "", "main channel is missing",
            activeTunnelId, mismatch);
    }

    public static string TunnelIdFingerprint(string? tunnelId)
    {
        var value = tunnelId?.Trim() ?? "";
        if (value.Length == 0) return "not configured";
        var suffixLength = Math.Min(8, value.Length);
        return "..." + value[^suffixLength..];
    }

    public static string FailureSummary(TunnelRuntimeStatus status)
    {
        if (status.TunnelIdMismatch)
            return "tunnel ID mismatch";
        if (status.ProbeError.Length > 0)
            return OneLine(status.ProbeError, 180);
        if (status.Reason.Length > 0)
            return OneLine(status.Reason, 180);
        if (status.ProbeStatus.Length > 0)
            return "probe " + status.ProbeStatus;
        return status.Reachable ? "main channel is not enabled" : "tunnel admin endpoint unavailable";
    }

    private static string ReadString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)) return "";
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : value.ToString();
    }

    private static string OneLine(string value, int maxLength)
    {
        var compact = string.Join(" ", value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return compact.Length <= maxLength ? compact : compact[..maxLength] + "...";
    }
}
