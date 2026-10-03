using LocalCodingAgentTray;

// This test executable doubles as a failing tunnel stub. No network request.
if (args.FirstOrDefault() == "run")
{
    Console.Error.WriteLine("configure tunnel-client: yaml: unmarshal errors:");
    Console.Error.WriteLine("line 7: cannot unmarshal !!seq into map[string]string");
    Console.Error.WriteLine(Environment.GetEnvironmentVariable("CONTROL_PLANE_API_KEY"));
    Console.Error.WriteLine(Environment.GetEnvironmentVariable("CONTROL_PLANE_TUNNEL_ID"));
    Environment.ExitCode = 2;
    return;
}

var temp = Path.Combine(Path.GetTempPath(), "lca-profile-test-" + Guid.NewGuid());
try
{
    var cfg = new AppConfig
    {
        TunnelProfileDir = temp,
        TunnelId = "tunnel_test",
        OrganizationId = "org_test",
        Port = 8811,
        OpenWebUi = false
    };
    cfg.SetKey("secret-test-key");
    cfg.WriteTunnelProfile();
    var yaml = File.ReadAllText(cfg.TunnelProfilePath);
    Assert(yaml.Contains("    OpenAI-Organization: \"org_test\""), "headers must be a YAML map, not a list");
    Assert(!yaml.Contains("- \"OpenAI-Organization:"), "v0.0.14 cannot parse sequence headers");
    Assert(yaml.Contains("http://127.0.0.1:8811/mcp"), "custom MCP port must be preserved");
    Assert(yaml.Contains("env:CONTROL_PLANE_API_KEY") && !yaml.Contains("secret-test-key"), "key must remain outside YAML");

    cfg.OrganizationId = "";
    cfg.TunnelId = "";
    cfg.FillDefaults();
    Assert(cfg.OrganizationId == "org_test" && cfg.TunnelId == "tunnel_test", "map profile must round-trip");

    // Migrate existing profiles produced by the previous tray without losing organization routing.
    File.WriteAllText(cfg.TunnelProfilePath, yaml.Replace("    OpenAI-Organization: \"org_test\"", "    - \"OpenAI-Organization: org_legacy\""));
    cfg.OrganizationId = "";
    cfg.FillDefaults();
    Assert(cfg.OrganizationId == "org_legacy", "legacy list profile must still load");
    cfg.WriteTunnelProfile();
    Assert(File.ReadAllText(cfg.TunnelProfilePath).Contains("    OpenAI-Organization: \"org_legacy\""), "legacy profile must rewrite as a map");

    cfg.OrganizationId = "";
    cfg.WriteTunnelProfile();
    Assert(!File.ReadAllText(cfg.TunnelProfilePath).Contains("extra_headers"), "empty organization must omit headers");

    cfg.TunnelExe = Environment.ProcessPath!;
    using var supervisor = new ProcessSupervisor();
    var logs = new System.Collections.Concurrent.ConcurrentQueue<string>();
    supervisor.OnLog += logs.Enqueue;
    supervisor.StartTunnel(cfg, "secret-test-key");
    var deadline = DateTime.UtcNow.AddSeconds(5);
    while (supervisor.TunnelRunning && DateTime.UtcNow < deadline) Thread.Sleep(25);
    Assert(!supervisor.TunnelRunning, "failing tunnel must exit promptly");
    var failure = supervisor.TunnelExitFailure();
    Assert(failure.Contains("code 2") && failure.Contains("cannot unmarshal !!seq"), "process error must retain original YAML cause and exit code");
    Assert(!failure.Contains("secret-test-key") && !failure.Contains(cfg.TunnelId), "error dialog must redact secrets and routing ID");
    Assert(!string.Join("\n", logs).Contains("secret-test-key"), "tunnel logs must redact the runtime key");
    Console.WriteLine("PASS tray tunnel profile smoke test");
}
finally
{
    if (Directory.Exists(temp)) Directory.Delete(temp, recursive: true);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
