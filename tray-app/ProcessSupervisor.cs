// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Diagnostics;
using System.Management;

namespace LocalCodingAgentTray;

/// <summary>
/// Owns the two child processes: the Node MCP server and the OpenAI tunnel
/// client. Streams their output via OnLog and tears them down on Stop/exit.
/// </summary>
public sealed class ProcessSupervisor : IDisposable
{
    private Process? _node;
    private Process? _tunnel;

    public event Action<string>? OnLog;

    public bool NodeRunning => _node is { HasExited: false };
    public bool TunnelRunning => _tunnel is { HasExited: false };

    private void Log(string line) => OnLog?.Invoke(line);

    public void StartServer(AppConfig cfg)
    {
        // Restart with the latest config if already running (so changing the
        // workspace/path and pressing Start applies immediately).
        if (NodeRunning)
        {
            StopServer();
            System.Threading.Thread.Sleep(400);
        }
        else if (_node is not null)
        {
            _node.Dispose();
            _node = null;
        }

        if (!File.Exists(Path.Combine(cfg.McpAppDir, cfg.ServerScript)))
            throw new FileNotFoundException($"server script not found: {Path.Combine(cfg.McpAppDir, cfg.ServerScript)}");

        var psi = new ProcessStartInfo
        {
            FileName = cfg.NodePath,
            WorkingDirectory = cfg.McpAppDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add(cfg.ServerScript);
        psi.Environment["PORT"] = cfg.Port.ToString();
        psi.Environment["DASHBOARD_PORT"] = cfg.DashboardPort.ToString();
        psi.Environment["AGENT_HOST"] = "127.0.0.1";
        psi.Environment["AGENT_WORKSPACE"] = cfg.Workspace;
        psi.Environment["AGENT_MODE"] = cfg.Mode;
        psi.Environment["AGENT_POLICY"] = cfg.Policy;
        psi.Environment["AGENT_EXTRA_ROOTS"] = cfg.ExtraRoots;
        psi.Environment["AGENT_PERMISSION_PROFILE_FILE"] = cfg.PermissionProfileFile;
        psi.Environment["AGENT_PERMISSION_PROFILE_NAME"] = cfg.PermissionProfileName;
        psi.Environment["MCP_AUTH_TOKEN"] = cfg.AuthToken;
        // Legacy environment name retained for compatibility. v5 is official
        // and enabled by default; users may disable it for v4 compatibility.
        psi.Environment["AGENT_V5_PREVIEW"] = cfg.V5Preview ? "1" : "0";
        psi.Environment["AGENT_ALLOW_SYSTEM_SHUTDOWN"] = cfg.AllowSystemShutdown ? "1" : "0";

        _node = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _node.OutputDataReceived += (_, e) => { if (e.Data is not null) Log("[server] " + e.Data); };
        _node.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log("[server] " + e.Data); };
        _node.Exited += (_, _) => Log("[server] process exited");
        _node.Start();
        _node.BeginOutputReadLine();
        _node.BeginErrorReadLine();
        var permissionState = string.IsNullOrWhiteSpace(cfg.PermissionProfileName)
            ? $"legacy mode={cfg.Mode}"
            : $"profile={cfg.PermissionProfileName}";
        Log($"[supervisor] started node {cfg.ServerScript} (PORT={cfg.Port}, {permissionState})");
    }

    public void StartTunnel(AppConfig cfg, string key)
    {
        if (TunnelRunning) return;
        if (_tunnel is not null)
        {
            _tunnel.Dispose();
            _tunnel = null;
        }
        if (!File.Exists(cfg.TunnelExe))
            throw new FileNotFoundException($"tunnel-client.exe not found: {cfg.TunnelExe}");
        if (string.IsNullOrEmpty(key))
            throw new InvalidOperationException("Tunnel key is empty. Enter and save the key first.");
        if (string.IsNullOrWhiteSpace(cfg.TunnelId))
            throw new InvalidOperationException("Tunnel ID is empty. Paste the tunnel_... ID first.");

        cfg.WriteTunnelProfile();

        var psi = new ProcessStartInfo
        {
            FileName = cfg.TunnelExe,
            WorkingDirectory = Path.GetDirectoryName(cfg.TunnelExe) ?? Environment.CurrentDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("--profile");
        psi.ArgumentList.Add(cfg.TunnelProfileName);
        psi.ArgumentList.Add("--profile-dir");
        psi.ArgumentList.Add(cfg.TunnelProfileDir);
        psi.ArgumentList.Add("--control-plane.tunnel-id");
        psi.ArgumentList.Add(cfg.TunnelId);
        if (cfg.OpenWebUi) psi.ArgumentList.Add("--open-web-ui");
        psi.Environment["CONTROL_PLANE_API_KEY"] = key;
        psi.Environment["CONTROL_PLANE_TUNNEL_ID"] = cfg.TunnelId;
        if (!string.IsNullOrWhiteSpace(cfg.AuthToken))
        {
            // The MCP server enforces Bearer auth when MCP_AUTH_TOKEN is set.
            // Pass the header to the tunnel without putting the token in args.
            psi.Environment["MCP_AUTH_HEADER"] = "Bearer " + cfg.AuthToken;
            psi.Environment["MCP_EXTRA_HEADERS"] = "Authorization: env:MCP_AUTH_HEADER";
        }

        _tunnel = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _tunnel.OutputDataReceived += (_, e) => { if (e.Data is not null) Log("[tunnel] " + e.Data); };
        _tunnel.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log("[tunnel] " + e.Data); };
        _tunnel.Exited += (_, _) => Log("[tunnel] process exited");
        _tunnel.Start();
        _tunnel.BeginOutputReadLine();
        _tunnel.BeginErrorReadLine();
        Log("[supervisor] started tunnel-client");
    }

    public void StopTunnel()
    {
        TryKill(ref _tunnel, "tunnel");
    }

    public void StopServer()
    {
        TryKill(ref _node, "server");
    }

    public void StopAll()
    {
        StopTunnel();
        StopServer();
    }

    private void TryKill(ref Process? p, string label)
    {
        try
        {
            if (p is { HasExited: false })
            {
                p.Kill(entireProcessTree: true);
                p.WaitForExit(3000);
                Log($"[supervisor] stopped {label}");
            }
        }
        catch (Exception ex)
        {
            Log($"[supervisor] failed to stop {label}: {ex.Message}");
        }
        finally
        {
            p?.Dispose();
            p = null;
        }
    }

    public void Dispose() => StopAll();

    /// <summary>
    /// Kill any MCP server / tunnel processes running on this machine, even ones
    /// this app did not start (e.g. launched by the PowerShell launcher). This is
    /// what makes the Stop button authoritative.
    /// </summary>
    public static int KillStrayInstances(string serverScript, Action<string>? log = null)
    {
        int killed = 0;

        // node processes whose command line references the server script.
        foreach (var p in FindServerNodeProcesses(serverScript))
        {
            try
            {
                p.Kill(entireProcessTree: true);
                p.WaitForExit(3000);
                killed++;
                log?.Invoke($"[supervisor] killed stray node PID {p.Id}");
            }
            catch (Exception ex) { log?.Invoke($"[supervisor] could not kill node {p.Id}: {ex.Message}"); }
            finally { p.Dispose(); }
        }

        // tunnel-client.exe (only our tunnel uses this name).
        foreach (var p in Process.GetProcessesByName("tunnel-client"))
        {
            try
            {
                p.Kill(entireProcessTree: true);
                p.WaitForExit(3000);
                killed++;
                log?.Invoke($"[supervisor] killed tunnel PID {p.Id}");
            }
            catch (Exception ex) { log?.Invoke($"[supervisor] could not kill tunnel {p.Id}: {ex.Message}"); }
            finally { p.Dispose(); }
        }

        return killed;
    }

    private static List<Process> FindServerNodeProcesses(string serverScript)
    {
        var result = new List<Process>();
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'");
            foreach (ManagementBaseObject mo in searcher.Get())
            {
                var cmd = mo["CommandLine"] as string ?? "";
                if (cmd.Contains(serverScript, StringComparison.OrdinalIgnoreCase))
                {
                    var pid = Convert.ToInt32(mo["ProcessId"]);
                    try { result.Add(Process.GetProcessById(pid)); } catch { /* gone already */ }
                }
            }
        }
        catch { /* WMI unavailable -> nothing to do */ }
        return result;
    }
}
