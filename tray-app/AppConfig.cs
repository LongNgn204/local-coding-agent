// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LocalCodingAgentTray;

public class AppConfig
{
    public string NodePath { get; set; } = "node";
    public string McpAppDir { get; set; } = "";
    public string ServerScript { get; set; } = "server.mjs";
    public string TunnelExe { get; set; } = "";
    public string TunnelProfileName { get; set; } = "local-coding-agent";
    public string TunnelProfileDir { get; set; } = "";
    public string TunnelId { get; set; } = "";
    public string OrganizationId { get; set; } = "";
    public string Workspace { get; set; } = "";
    public string ExtraRoots { get; set; } = "";
    public string PermissionProfileFile { get; set; } = "";
    public string PermissionProfileName { get; set; } = "";
    public string Mode { get; set; } = "safe";
    public string Policy { get; set; } = "balanced";
    public int Port { get; set; } = 8787;
    public int DashboardPort { get; set; } = 8790;
    public string AuthToken { get; set; } = "";
    public bool OpenWebUi { get; set; } = true;

    /// <summary>Experimental public-preview features. Stable behavior remains
    /// available when this switch is disabled.</summary>
    public bool V5Preview { get; set; } = true;

    /// <summary>
    /// Explicit local opt-in for the dedicated schedule_system_shutdown tool.
    /// Once enabled, an explicit prompt can shut down immediately without a
    /// second dashboard approval. Raw power commands remain blocked.
    /// </summary>
    public bool AllowSystemShutdown { get; set; } = false;

    /// <summary>DPAPI-encrypted (CurrentUser) tunnel key, base64. Never stored in plain text.</summary>
    public string EncryptedKey { get; set; } = "";

    [JsonIgnore]
    public static string ConfigDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LocalCodingAgent");

    [JsonIgnore]
    public static string ConfigPath => Path.Combine(ConfigDir, "config.json");

    [JsonIgnore]
    public static string DefaultPermissionProfilePath =>
        Path.Combine(ConfigDir, "permission-profiles.json");

    [JsonIgnore]
    public bool HasKey => !string.IsNullOrEmpty(EncryptedKey);

    [JsonIgnore]
    public string McpUrl => $"http://127.0.0.1:{Port}/mcp";

    [JsonIgnore]
    public string HealthUrl => $"http://127.0.0.1:{Port}/healthz";

    [JsonIgnore]
    public string DashboardUrl => $"http://127.0.0.1:{DashboardPort}/ui";

    [JsonIgnore]
    public string TunnelProfilePath
    {
        get
        {
            var fileName = TunnelProfileName.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase)
                ? TunnelProfileName
                : TunnelProfileName + ".yaml";
            return Path.Combine(TunnelProfileDir, fileName);
        }
    }

    public static AppConfig Load()
    {
        AppConfig cfg;
        try
        {
            if (File.Exists(ConfigPath))
                cfg = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(ConfigPath)) ?? new AppConfig();
            else
                cfg = new AppConfig();
        }
        catch
        {
            cfg = new AppConfig();
        }
        cfg.FillDefaults();
        return cfg;
    }

    public void FillDefaults()
    {
        if (string.IsNullOrWhiteSpace(McpAppDir)) McpAppDir = Defaults.McpAppDir();
        if (string.IsNullOrWhiteSpace(TunnelExe)) TunnelExe = Defaults.TunnelExe();
        if (string.IsNullOrWhiteSpace(TunnelProfileDir)) TunnelProfileDir = Defaults.TunnelProfileDir();
        if (string.IsNullOrWhiteSpace(Workspace)) Workspace = Defaults.GuessWorkspace();
        if (Port <= 0) Port = 8787;
        if (DashboardPort <= 0) DashboardPort = 8790;
        // 8788 collides with the OpenAI tunnel-client's own health port; migrate off it.
        if (DashboardPort == 8788) DashboardPort = 8790;
        if (string.IsNullOrWhiteSpace(Mode)) Mode = "safe";
        if (Policy is not ("strict" or "balanced" or "full")) Policy = "balanced";
        if (string.IsNullOrWhiteSpace(ServerScript)) ServerScript = "server.mjs";
        if (string.IsNullOrWhiteSpace(NodePath)) NodePath = "node";
        if (string.IsNullOrWhiteSpace(TunnelProfileName)) TunnelProfileName = "local-coding-agent";
        if (string.IsNullOrWhiteSpace(TunnelId)) TunnelId = ReadProfileScalar("tunnel_id");
        if (string.IsNullOrWhiteSpace(OrganizationId)) OrganizationId = ReadProfileOrganizationId();
    }

    public void Save()
    {
        Directory.CreateDirectory(ConfigDir);
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(ConfigPath, json);
    }

    public void WriteTunnelProfile()
    {
        if (string.IsNullOrWhiteSpace(TunnelId))
            throw new InvalidOperationException("Tunnel ID is empty. Paste the tunnel_... ID from ChatGPT/OpenAI first.");

        Directory.CreateDirectory(TunnelProfileDir);
        var includeOrgHeader = !string.IsNullOrWhiteSpace(OrganizationId);
        var sb = new StringBuilder();
        sb.AppendLine("config_version: 1");
        sb.AppendLine("control_plane:");
        sb.AppendLine("  base_url: \"https://api.openai.com\"");
        sb.AppendLine($"  tunnel_id: \"{YamlEscape(TunnelId.Trim())}\"");
        sb.AppendLine("  api_key: \"env:CONTROL_PLANE_API_KEY\"");
        if (includeOrgHeader)
        {
            sb.AppendLine("  extra_headers:");
            sb.AppendLine($"    - \"OpenAI-Organization: {YamlEscape(OrganizationId.Trim())}\"");
        }
        sb.AppendLine("health:");
        sb.AppendLine("  listen_addr: \"127.0.0.1:8788\"");
        sb.AppendLine("admin_ui:");
        sb.AppendLine($"  open_browser: {OpenWebUi.ToString().ToLowerInvariant()}");
        sb.AppendLine("log:");
        sb.AppendLine("  level: info");
        sb.AppendLine("  format: json");
        sb.AppendLine("mcp:");
        sb.AppendLine("  server_urls:");
        sb.AppendLine("    - channel: main");
        sb.AppendLine($"      url: \"{YamlEscape(McpUrl)}\"");
        File.WriteAllText(TunnelProfilePath, sb.ToString(), new UTF8Encoding(false));
    }

    public void SetKey(string? plain)
    {
        if (string.IsNullOrEmpty(plain))
        {
            EncryptedKey = "";
            return;
        }
        var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
        EncryptedKey = Convert.ToBase64String(enc);
    }

    public string? GetKey()
    {
        if (string.IsNullOrEmpty(EncryptedKey)) return null;
        try
        {
            var bytes = ProtectedData.Unprotect(Convert.FromBase64String(EncryptedKey), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch
        {
            return null;
        }
    }

    private string ReadProfileScalar(string key)
    {
        try
        {
            if (!File.Exists(TunnelProfilePath)) return "";
            foreach (var raw in File.ReadLines(TunnelProfilePath))
            {
                var line = raw.Trim();
                if (!line.StartsWith(key + ":", StringComparison.Ordinal)) continue;
                return UnquoteYamlScalar(line[(key.Length + 1)..].Trim());
            }
        }
        catch
        {
            return "";
        }
        return "";
    }

    private string ReadProfileOrganizationId()
    {
        try
        {
            if (!File.Exists(TunnelProfilePath)) return "";
            foreach (var raw in File.ReadLines(TunnelProfilePath))
            {
                var line = raw.Trim();
                if (line.StartsWith("-", StringComparison.Ordinal)) line = line[1..].Trim();
                line = UnquoteYamlScalar(line);
                if (line.Contains("OpenAI-Organization:", StringComparison.OrdinalIgnoreCase))
                {
                    var marker = "OpenAI-Organization:";
                    var value = line[(line.IndexOf(marker, StringComparison.OrdinalIgnoreCase) + marker.Length)..].Trim();
                    if (value.StartsWith("env:", StringComparison.OrdinalIgnoreCase)) return "";
                    return value;
                }
            }
        }
        catch
        {
            return "";
        }
        return "";
    }

    private static string YamlEscape(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private static string UnquoteYamlScalar(string value)
    {
        value = value.Trim();
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            value = value[1..^1].Replace("\\\"", "\"").Replace("\\\\", "\\");
        return value;
    }
}
