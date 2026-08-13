// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace LocalCodingAgentTray;

public sealed class MainForm : Form
{
    private const string HealthProbeUserAgent = "LocalCodingAgentTray/5.0.0";
    private const string HealthProbeHeader = "X-Local-Coding-Agent-Probe";
    private const string TunnelStatusUrl = "http://127.0.0.1:8788/api/status";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2.5) };

    private readonly AppConfig _cfg = AppConfig.Load();
    private readonly ProcessSupervisor _sup = new();
    private readonly System.Windows.Forms.Timer _healthTimer = new() { Interval = 3000 };
    private readonly NotifyIcon _tray;
    private bool _reallyExit;
    private bool _healthBusy;
    private bool _desiredRunning;
    private bool _starting;
    private bool _recovering;
    private int _recoveryFailures;
    private DateTime _nextRecoveryUtc = DateTime.MinValue;
    private CancellationTokenSource? _lifecycleCts;

    // Controls
    private TextBox _txtNode = null!;
    private TextBox _txtMcpDir = null!;
    private TextBox _txtTunnelExe = null!;
    private TextBox _txtProfileDir = null!;
    private TextBox _txtProfileName = null!;
    private TextBox _txtTunnelId = null!;
    private TextBox _txtOrgId = null!;
    private TextBox _txtWorkspace = null!;
    private TextBox _txtExtraRoots = null!;
    private TextBox _txtPermissionProfileFile = null!;
    private TextBox _txtPermissionProfileName = null!;
    private ComboBox _cmbMode = null!;
    private ComboBox _cmbPolicy = null!;
    private NumericUpDown _numPort = null!;
    private TextBox _txtAuth = null!;
    private TextBox _txtKey = null!;
    private Label _lblKeyState = null!;
    private CheckBox _chkOpenWeb = null!;
    private CheckBox _chkV5Preview = null!;
    private CheckBox _chkAllowSystemShutdown = null!;
    private Label _lblStatus = null!;
    private Label _lblConnectionHint = null!;
    private TextBox _txtLog = null!;
    private Button _btnStart = null!;
    private Button _btnStop = null!;
    private Button _btnReconnect = null!;

    public MainForm()
    {
        Text = "Local Coding Agent Tray v5.0.0";
        Width = 660;
        Height = 1000;
        StartPosition = FormStartPosition.CenterScreen;
        MinimizeBox = true;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;

        BuildUi();
        SyncFromConfig();

        _sup.OnLog += AppendLog;
        _healthTimer.Tick += async (_, _) => await PollHealthAsync();
        _healthTimer.Start();

        _tray = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Text = "Local Coding Agent",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu()
        };
        _tray.DoubleClick += (_, _) => ShowForm();

        FormClosing += OnFormClosing;
    }

    // ----------------------------------------------------------------- UI build
    private void BuildUi()
    {
        int y = 12;

        AddSection("Paths", ref y);
        _txtNode = AddRow("Node executable", ref y);
        _txtMcpDir = AddRow("MCP app folder", ref y, browse: BrowseFolder);
        _txtTunnelExe = AddRow("tunnel-client.exe", ref y, browse: BrowseFile);
        _txtProfileDir = AddRow("Tunnel profile dir", ref y, browse: BrowseFolder);
        _txtProfileName = AddRow("Tunnel profile name", ref y);

        AddSection("Agent", ref y);
        _txtWorkspace = AddRow("Legacy workspace", ref y, browse: BrowseFolder);
        _txtExtraRoots = AddRow("Legacy roots (;)", ref y);
        _txtPermissionProfileFile = AddRow("Profile store", ref y, browse: BrowseJsonFile);
        _txtPermissionProfileName = AddRow("Active profile", ref y);

        var btnPermissions = new Button
        {
            Text = "Manage authorized paths...",
            Left = 150,
            Top = y - 2,
            Width = 220,
            Height = 30
        };
        btnPermissions.Click += (_, _) => OpenPermissionProfiles();
        Controls.Add(btnPermissions);
        Controls.Add(new Label
        {
            Text = "Named multi-path profiles",
            Left = 380,
            Top = y + 5,
            Width = 250,
            ForeColor = System.Drawing.Color.DimGray
        });
        y += 38;

        // Mode + Port on one row
        AddLabel("Mode", y);
        _cmbMode = new ComboBox { Left = 150, Top = y - 3, Width = 120, DropDownStyle = ComboBoxStyle.DropDownList };
        _cmbMode.Items.AddRange(new object[] { "safe", "full" });
        Controls.Add(_cmbMode);
        var lblPort = new Label { Text = "Port", Left = 300, Top = y, Width = 40, TextAlign = ContentAlignment.MiddleLeft };
        Controls.Add(lblPort);
        _numPort = new NumericUpDown { Left = 345, Top = y - 3, Width = 90, Minimum = 1, Maximum = 65535 };
        Controls.Add(_numPort);
        y += 34;

        AddLabel("Policy", y);
        _cmbPolicy = new ComboBox { Left = 150, Top = y - 3, Width = 180, DropDownStyle = ComboBoxStyle.DropDownList };
        _cmbPolicy.Items.AddRange(new object[] { "strict", "balanced", "full" });
        Controls.Add(_cmbPolicy);
        y += 34;

        _txtAuth = AddRow("Auth token (opt)", ref y);

        AddSection("Tunnel", ref y);
        _txtTunnelId = AddRow("Tunnel ID", ref y);
        AddLabel("Organization ID", y);
        _txtOrgId = new TextBox { Left = 150, Top = y - 3, Width = 340 };
        Controls.Add(_txtOrgId);
        var btnSaveTunnel = new Button { Text = "Save tunnel", Left = 495, Top = y - 4, Width = 120 };
        btnSaveTunnel.Click += (_, _) => SaveTunnelSettings();
        Controls.Add(btnSaveTunnel);
        y += 30;

        AddLabel("Runtime API key", y);
        _txtKey = new TextBox { Left = 150, Top = y - 3, Width = 340, UseSystemPasswordChar = true };
        Controls.Add(_txtKey);
        var btnSaveKey = new Button { Text = "Save key", Left = 495, Top = y - 4, Width = 90 };
        btnSaveKey.Click += (_, _) => SaveKey();
        Controls.Add(btnSaveKey);
        y += 30;
        _lblKeyState = new Label { Left = 150, Top = y, Width = 480, ForeColor = System.Drawing.Color.DimGray };
        Controls.Add(_lblKeyState);
        y += 26;
        _chkOpenWeb = new CheckBox { Text = "Open tunnel web UI on start", Left = 150, Top = y, Width = 300 };
        Controls.Add(_chkOpenWeb);
        y += 28;
        _chkV5Preview = new CheckBox
        {
            Text = "Enable v5 features (official)",
            Left = 150,
            Top = y,
            Width = 360
        };
        Controls.Add(_chkV5Preview);
        y += 30;
        _chkAllowSystemShutdown = new CheckBox
        {
            Text = "Allow prompt-requested shutdown (immediate, no approval)",
            Left = 150,
            Top = y,
            Width = 445,
            ForeColor = System.Drawing.Color.DarkOrange
        };
        Controls.Add(_chkAllowSystemShutdown);
        y += 34;

        // Action buttons (row 1)
        _btnStart = new Button { Text = "Start", Left = 12, Top = y, Width = 100, Height = 32 };
        _btnStart.Click += async (_, _) => await StartAllAsync();
        Controls.Add(_btnStart);
        _btnStop = new Button { Text = "Stop", Left = 118, Top = y, Width = 100, Height = 32 };
        _btnStop.Click += (_, _) => StopAll();
        Controls.Add(_btnStop);
        _btnReconnect = new Button { Text = "Reconnect tunnel", Left = 224, Top = y, Width = 150, Height = 32 };
        _btnReconnect.Click += async (_, _) => await ReconnectTunnelAsync(userInitiated: true);
        Controls.Add(_btnReconnect);
        var btnDash = new Button { Text = "Open Dashboard", Left = 380, Top = y, Width = 140, Height = 32 };
        btnDash.Click += (_, _) => OpenDashboard();
        Controls.Add(btnDash);
        y += 38;

        // Action buttons (row 2)
        var btnSave = new Button { Text = "Save settings", Left = 12, Top = y, Width = 120, Height = 32 };
        btnSave.Click += (_, _) => { SyncToConfig(); _cfg.Save(); AppendLog("[ui] settings saved"); };
        Controls.Add(btnSave);
        var btnCopy = new Button { Text = "Copy local MCP URL", Left = 138, Top = y, Width = 155, Height = 32 };
        btnCopy.Click += (_, _) => CopyUrl();
        Controls.Add(btnCopy);
        var btnCopyTunnel = new Button { Text = "Copy Tunnel ID", Left = 299, Top = y, Width = 130, Height = 32 };
        btnCopyTunnel.Click += (_, _) => CopyTunnelId();
        Controls.Add(btnCopyTunnel);
        var btnFolder = new Button { Text = "Logs/Config", Left = 435, Top = y, Width = 120, Height = 32 };
        btnFolder.Click += (_, _) => OpenConfigFolder();
        Controls.Add(btnFolder);
        y += 44;

        _lblStatus = new Label
        {
            Left = 12,
            Top = y,
            Width = 620,
            Height = 24,
            Font = new System.Drawing.Font(Font, System.Drawing.FontStyle.Bold)
        };
        Controls.Add(_lblStatus);
        y += 24;
        _lblConnectionHint = new Label
        {
            Left = 12,
            Top = y,
            Width = 620,
            Height = 34,
            ForeColor = System.Drawing.Color.DimGray
        };
        Controls.Add(_lblConnectionHint);
        y += 36;

        _txtLog = new TextBox
        {
            Left = 12,
            Top = y,
            Width = 620,
            Height = Math.Max(120, ClientSize.Height - y - 12),
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = System.Drawing.Color.FromArgb(20, 24, 33),
            ForeColor = System.Drawing.Color.Gainsboro,
            Font = new System.Drawing.Font("Consolas", 8.5f)
        };
        Controls.Add(_txtLog);
    }

    private void AddSection(string title, ref int y)
    {
        var lbl = new Label
        {
            Text = title,
            Left = 12,
            Top = y,
            Width = 620,
            Font = new System.Drawing.Font(Font, System.Drawing.FontStyle.Bold),
            ForeColor = System.Drawing.Color.SteelBlue
        };
        Controls.Add(lbl);
        y += 24;
    }

    private void AddLabel(string text, int y, int width = 130)
    {
        Controls.Add(new Label { Text = text, Left = 12, Top = y, Width = width, TextAlign = ContentAlignment.MiddleLeft });
    }

    private TextBox AddRow(string label, ref int y, Action<TextBox>? browse = null)
    {
        AddLabel(label, y);
        var tb = new TextBox { Left = 150, Top = y - 3, Width = browse is null ? 480 : 360 };
        Controls.Add(tb);
        if (browse is not null)
        {
            var btn = new Button { Text = "Browse", Left = 520, Top = y - 4, Width = 114 };
            btn.Click += (_, _) => browse(tb);
            Controls.Add(btn);
        }
        y += 30;
        return tb;
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => ShowForm());
        menu.Items.Add("Open Dashboard", null, (_, _) => OpenDashboard());
        menu.Items.Add("Start", null, async (_, _) => await StartAllAsync());
        menu.Items.Add("Reconnect tunnel", null, async (_, _) => await ReconnectTunnelAsync(userInitiated: true));
        menu.Items.Add("Stop", null, (_, _) => StopAll());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => { _reallyExit = true; Close(); });
        return menu;
    }

    // ------------------------------------------------------------- config <-> UI
    private void SyncFromConfig()
    {
        _txtNode.Text = _cfg.NodePath;
        _txtMcpDir.Text = _cfg.McpAppDir;
        _txtTunnelExe.Text = _cfg.TunnelExe;
        _txtProfileDir.Text = _cfg.TunnelProfileDir;
        _txtProfileName.Text = _cfg.TunnelProfileName;
        _txtTunnelId.Text = _cfg.TunnelId;
        _txtOrgId.Text = _cfg.OrganizationId;
        _txtWorkspace.Text = _cfg.Workspace;
        _txtExtraRoots.Text = _cfg.ExtraRoots;
        _txtPermissionProfileFile.Text = _cfg.PermissionProfileFile;
        _txtPermissionProfileName.Text = _cfg.PermissionProfileName;
        _cmbMode.SelectedItem = _cfg.Mode == "safe" ? "safe" : "full";
        _cmbPolicy.SelectedItem = _cfg.Policy is "strict" or "full" ? _cfg.Policy : "balanced";
        _numPort.Value = Math.Clamp(_cfg.Port, 1, 65535);
        _txtAuth.Text = _cfg.AuthToken;
        _chkOpenWeb.Checked = _cfg.OpenWebUi;
        _chkV5Preview.Checked = _cfg.V5Preview;
        _chkAllowSystemShutdown.Checked = _cfg.AllowSystemShutdown;
        _lblKeyState.Text = _cfg.HasKey ? "Key is saved (encrypted)." : "No key saved yet.";
    }

    private void SyncToConfig()
    {
        _cfg.NodePath = _txtNode.Text.Trim();
        _cfg.McpAppDir = _txtMcpDir.Text.Trim();
        _cfg.TunnelExe = _txtTunnelExe.Text.Trim();
        _cfg.TunnelProfileDir = _txtProfileDir.Text.Trim();
        _cfg.TunnelProfileName = _txtProfileName.Text.Trim();
        _cfg.TunnelId = _txtTunnelId.Text.Trim();
        _cfg.OrganizationId = _txtOrgId.Text.Trim();
        _cfg.Workspace = _txtWorkspace.Text.Trim();
        _cfg.ExtraRoots = _txtExtraRoots.Text.Trim();
        _cfg.PermissionProfileFile = _txtPermissionProfileFile.Text.Trim();
        _cfg.PermissionProfileName = _txtPermissionProfileName.Text.Trim();
        _cfg.Mode = (_cmbMode.SelectedItem as string) ?? "full";
        _cfg.Policy = (_cmbPolicy.SelectedItem as string) ?? "balanced";
        _cfg.Port = (int)_numPort.Value;
        _cfg.AuthToken = _txtAuth.Text.Trim();
        _cfg.OpenWebUi = _chkOpenWeb.Checked;
        _cfg.V5Preview = _chkV5Preview.Checked;
        _cfg.AllowSystemShutdown = _chkAllowSystemShutdown.Checked;
    }

    // ----------------------------------------------------------------- actions
    private async Task StartAllAsync()
    {
        if (_starting) return;
        _starting = true;
        _desiredRunning = true;
        _recoveryFailures = 0;
        _nextRecoveryUtc = DateTime.MinValue;
        ResetLifecycleToken();
        var cancellationToken = _lifecycleCts!.Token;
        UpdateActionButtons();

        try
        {
            SyncToConfig();
            PreparePermissionProfile();
            _cfg.Save();

            if (!Directory.Exists(_cfg.Workspace))
                throw new DirectoryNotFoundException("Workspace folder does not exist:\n" + _cfg.Workspace);

            // Clear launcher/manual instances so this app owns the ports. Wait
            // asynchronously for sockets to close instead of freezing WinForms.
            var strays = ProcessSupervisor.KillStrayInstances(_cfg.ServerScript, AppendLog);
            if (strays > 0) await Task.Delay(700, cancellationToken);

            AppendLog("[startup] phase 1/3: starting MCP server");
            _sup.StartServer(_cfg);
            var serverHealth = await WaitForServerReadyAsync(TimeSpan.FromSeconds(25), cancellationToken);
            AppendLog($"[startup] phase 2/3: MCP health ready ({DescribeServerHealth(serverHealth)})");

            var key = _cfg.GetKey();
            if (string.IsNullOrEmpty(key))
            {
                AppendLog("[startup] server ready; no encrypted tunnel key is saved");
                MessageBox.Show(this,
                    "The MCP server is ready, but no tunnel key is saved. Enter the Runtime API key, click Save key, then use Reconnect tunnel.",
                    "Local Coding Agent", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            AppendLog("[startup] phase 3/3: starting tunnel after MCP health is ready");
            var tunnel = await StartTunnelWithRetryAsync(key, attempts: 3, cancellationToken);
            AppendLog($"[startup] READY: tunnel main channel connected ({RuntimeStatus.TunnelIdFingerprint(tunnel.ActiveTunnelId)})");
            _tray.ShowBalloonTip(1800, "Local Coding Agent",
                "Server and tunnel are connected.", ToolTipIcon.Info);
        }
        catch (OperationCanceledException) when (!_desiredRunning)
        {
            AppendLog("[startup] cancelled by Stop");
        }
        catch (Exception ex)
        {
            _desiredRunning = false;
            _sup.StopAll();
            AppendLog("[startup:error] " + ex.Message);
            MessageBox.Show(this, ex.Message, "Local Coding Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _starting = false;
            UpdateActionButtons();
            await PollHealthAsync();
        }
    }

    private void StopAll()
    {
        _desiredRunning = false;
        _lifecycleCts?.Cancel();
        _sup.StopAll();
        // Also stop instances started outside this app (launcher / manual).
        SyncToConfig();
        var n = ProcessSupervisor.KillStrayInstances(_cfg.ServerScript, AppendLog);
        AppendLog($"[ui] stopped (killed {n} external process(es))");
        UpdateActionButtons();
    }

    private async Task ReconnectTunnelAsync(bool userInitiated)
    {
        if (_starting || _recovering) return;
        _recovering = true;
        _desiredRunning = true;
        ResetLifecycleToken();
        var cancellationToken = _lifecycleCts!.Token;
        UpdateActionButtons();

        try
        {
            SyncToConfig();
            PreparePermissionProfile();
            _cfg.Save();
            var key = _cfg.GetKey();
            if (string.IsNullOrEmpty(key))
                throw new InvalidOperationException("No tunnel key is saved. Enter the Runtime API key and click Save key first.");

            if (!await IsServerReadyAsync(cancellationToken))
            {
                AppendLog("[recovery] MCP server is offline; running full startup");
                _recovering = false;
                await StartAllAsync();
                return;
            }

            AppendLog(userInitiated
                ? "[recovery] manual tunnel reconnect requested"
                : "[recovery] automatic tunnel reconnect started");
            var tunnel = await StartTunnelWithRetryAsync(key, attempts: userInitiated ? 3 : 1, cancellationToken);
            _recoveryFailures = 0;
            _nextRecoveryUtc = DateTime.MinValue;
            AppendLog($"[recovery] tunnel connected ({RuntimeStatus.TunnelIdFingerprint(tunnel.ActiveTunnelId)})");
        }
        catch (OperationCanceledException) when (!_desiredRunning)
        {
            AppendLog("[recovery] cancelled by Stop");
        }
        catch (Exception ex)
        {
            _recoveryFailures++;
            var delaySeconds = Math.Min(30, (int)Math.Pow(2, Math.Min(4, _recoveryFailures)));
            _nextRecoveryUtc = DateTime.UtcNow.AddSeconds(delaySeconds);
            AppendLog($"[recovery:error] {ex.Message}; next automatic attempt in {delaySeconds}s");
            if (userInitiated)
                MessageBox.Show(this, ex.Message, "Tunnel reconnect failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _recovering = false;
            UpdateActionButtons();
        }
    }

    private async Task<TunnelRuntimeStatus> StartTunnelWithRetryAsync(
        string key,
        int attempts,
        CancellationToken cancellationToken)
    {
        TunnelRuntimeStatus last = TunnelRuntimeStatus.Unreachable();
        for (var attempt = 1; attempt <= attempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _sup.StopTunnel();
            await WaitForTunnelAdminToStopAsync(cancellationToken);

            AppendLog($"[tunnel] launch attempt {attempt}/{attempts}");
            _sup.StartTunnel(_cfg, key);
            last = await WaitForTunnelReadyAsync(TimeSpan.FromSeconds(15), cancellationToken);
            if (last.Ready) return last;

            var failure = RuntimeStatus.FailureSummary(last);
            AppendLog($"[tunnel] attempt {attempt} did not become ready: {failure}");
            _sup.StopTunnel();
            if (attempt < attempts)
                await Task.Delay(TimeSpan.FromMilliseconds(600 * attempt), cancellationToken);
        }

        throw new InvalidOperationException(
            "Tunnel main channel did not become ready. " + RuntimeStatus.FailureSummary(last));
    }

    private async Task<TunnelRuntimeStatus> WaitForTunnelReadyAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        var last = TunnelRuntimeStatus.Unreachable();
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            last = await ProbeTunnelAsync(cancellationToken);
            if (last.Ready) return last;
            if (last.Reachable && (last.ProbeFailed || last.TunnelIdMismatch)) return last;
            await Task.Delay(350, cancellationToken);
        }
        return last;
    }

    private async Task WaitForTunnelAdminToStopAsync(CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var status = await ProbeTunnelAsync(cancellationToken);
            if (!status.Reachable) return;
            await Task.Delay(150, cancellationToken);
        }
    }

    private void SaveKey()
    {
        var plain = _txtKey.Text;
        if (string.IsNullOrWhiteSpace(plain))
        {
            MessageBox.Show(this, "Paste the tunnel key first.", "Local Coding Agent",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        _cfg.SetKey(plain);
        _cfg.Save();
        _txtKey.Clear();
        _lblKeyState.Text = "Key is saved (encrypted).";
        AppendLog("[ui] tunnel key saved (DPAPI, current user).");
    }

    private void SaveTunnelSettings()
    {
        try
        {
            SyncToConfig();
            _cfg.FillDefaults();
            _cfg.Save();
            _cfg.WriteTunnelProfile();
            AppendLog("[ui] tunnel settings saved: " + _cfg.TunnelProfilePath);
        }
        catch (Exception ex)
        {
            AppendLog("[error] save tunnel: " + ex.Message);
            MessageBox.Show(this, ex.Message, "Local Coding Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void CopyUrl()
    {
        SyncToConfig();
        Clipboard.SetText(_cfg.McpUrl);
        AppendLog("[ui] copied local MCP URL " + _cfg.McpUrl);
    }

    private void CopyTunnelId()
    {
        SyncToConfig();
        if (string.IsNullOrWhiteSpace(_cfg.TunnelId))
        {
            MessageBox.Show(this, "Tunnel ID is empty.", "Local Coding Agent",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Clipboard.SetText(_cfg.TunnelId);
        AppendLog("[ui] copied Tunnel ID " + RuntimeStatus.TunnelIdFingerprint(_cfg.TunnelId));
    }

    private void OpenConfigFolder()
    {
        Directory.CreateDirectory(AppConfig.ConfigDir);
        Process.Start(new ProcessStartInfo { FileName = AppConfig.ConfigDir, UseShellExecute = true });
    }

    private void OpenDashboard()
    {
        SyncToConfig();
        try
        {
            Process.Start(new ProcessStartInfo { FileName = _cfg.DashboardUrl, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppendLog("[error] open dashboard: " + ex.Message);
        }
    }

    private void OpenPermissionProfiles()
    {
        SyncToConfig();
        using var dialog = new PermissionProfileDialog(_cfg);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        SyncFromConfig();
        AppendLog($"[ui] permission profile selected: {_cfg.PermissionProfileName}");
    }

    private void PreparePermissionProfile()
    {
        if (string.IsNullOrWhiteSpace(_cfg.PermissionProfileFile)) return;

        var file = Path.GetFullPath(_cfg.PermissionProfileFile);
        var store = PermissionProfileStore.Load(file);
        store.Validate(file);
        var name = string.IsNullOrWhiteSpace(_cfg.PermissionProfileName)
            ? store.ActiveProfile
            : _cfg.PermissionProfileName;
        var profile = store.GetProfile(name);
        _cfg.PermissionProfileFile = file;
        _cfg.PermissionProfileName = name;
        _cfg.Workspace = profile.WorkingDirectory;
        _cfg.V5Preview = true;
        _txtWorkspace.Text = _cfg.Workspace;
        _txtPermissionProfileName.Text = name;
        _chkV5Preview.Checked = true;
        AppendLog($"[permissions] profile={name}, roots={profile.Roots.Count}, working={profile.WorkingDirectory}");
    }

    private static void BrowseFolder(TextBox tb)
    {
        using var dlg = new FolderBrowserDialog();
        if (Directory.Exists(tb.Text)) dlg.SelectedPath = tb.Text;
        if (dlg.ShowDialog() == DialogResult.OK) tb.Text = dlg.SelectedPath;
    }

    private static void BrowseFile(TextBox tb)
    {
        using var dlg = new OpenFileDialog { Filter = "Executable (*.exe)|*.exe|All files (*.*)|*.*" };
        if (File.Exists(tb.Text)) dlg.FileName = tb.Text;
        if (dlg.ShowDialog() == DialogResult.OK) tb.Text = dlg.FileName;
    }

    private static void BrowseJsonFile(TextBox tb)
    {
        using var dlg = new OpenFileDialog
        {
            Filter = "Permission profiles (*.json)|*.json|All files (*.*)|*.*",
            CheckFileExists = false
        };
        if (File.Exists(tb.Text)) dlg.FileName = tb.Text;
        else if (!string.IsNullOrWhiteSpace(tb.Text))
        {
            dlg.InitialDirectory = Path.GetDirectoryName(Path.GetFullPath(tb.Text));
            dlg.FileName = Path.GetFileName(tb.Text);
        }
        if (dlg.ShowDialog() == DialogResult.OK) tb.Text = dlg.FileName;
    }

    // --------------------------------------------------------- runtime probes
    private void ResetLifecycleToken()
    {
        _lifecycleCts?.Cancel();
        _lifecycleCts?.Dispose();
        _lifecycleCts = new CancellationTokenSource();
    }

    private void UpdateActionButtons()
    {
        if (!IsHandleCreated) return;
        _btnStart.Enabled = !_starting && !_recovering;
        _btnReconnect.Enabled = !_starting && !_recovering;
        _btnStop.Enabled = _starting || _recovering || _sup.NodeRunning || _sup.TunnelRunning || _desiredRunning;
    }

    private async Task<string> WaitForServerReadyAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        string? lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var json = await GetServerHealthJsonAsync(cancellationToken);
                if (json is not null) return json;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
            {
                lastError = ex.Message;
            }
            await Task.Delay(250, cancellationToken);
        }

        throw new TimeoutException(
            $"MCP server did not become healthy at {_cfg.HealthUrl} within {timeout.TotalSeconds:0}s"
            + (string.IsNullOrWhiteSpace(lastError) ? "." : $": {lastError}"));
    }

    private async Task<bool> IsServerReadyAsync(CancellationToken cancellationToken)
    {
        try { return await GetServerHealthJsonAsync(cancellationToken) is not null; }
        catch { return false; }
    }

    private async Task<string?> GetServerHealthJsonAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, _cfg.HealthUrl);
        request.Headers.TryAddWithoutValidation("User-Agent", HealthProbeUserAgent);
        request.Headers.TryAddWithoutValidation(HealthProbeHeader, "tray");
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode) return null;
        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty("status", out var status)
            && status.GetString()?.Equals("ok", StringComparison.OrdinalIgnoreCase) == true
            ? json
            : null;
    }

    private async Task<TunnelRuntimeStatus> ProbeTunnelAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await Http.GetAsync(TunnelStatusUrl, cancellationToken);
            if (!response.IsSuccessStatusCode)
                return TunnelRuntimeStatus.Unreachable($"admin endpoint returned HTTP {(int)response.StatusCode}");
            var json = await response.Content.ReadAsStringAsync(cancellationToken);
            return RuntimeStatus.ParseTunnelStatus(json, _cfg.TunnelId);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return TunnelRuntimeStatus.Unreachable(ex.Message);
        }
    }

    private static string DescribeServerHealth(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var version = root.TryGetProperty("version", out var release)
            ? release.GetString()
            : root.TryGetProperty("preview_version", out var legacy) ? legacy.GetString() : "unknown";
        var profile = root.TryGetProperty("permission_profile", out var p) ? p.GetString() : null;
        var rootCount = root.TryGetProperty("roots", out var roots) && roots.ValueKind == JsonValueKind.Array
            ? roots.GetArrayLength()
            : 0;
        return string.IsNullOrWhiteSpace(profile)
            ? $"v{version}"
            : $"v{version}, profile {profile}, {rootCount} path(s)";
    }

    // ----------------------------------------------------------------- health
    private async Task PollHealthAsync()
    {
        if (_healthBusy) return;
        _healthBusy = true;
        string status;
        string hint;
        Color statusColor;
        var shouldRecoverTunnel = false;
        try
        {
            var json = await GetServerHealthJsonAsync(CancellationToken.None)
                ?? throw new HttpRequestException("health endpoint is not ready");
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var ver = root.TryGetProperty("version", out var v) ? v.GetString() : "?";
            var mode = root.TryGetProperty("mode", out var m) ? m.GetString() : "?";
            var shownVersion = ver;
            var profile = root.TryGetProperty("permission_profile", out var p) ? p.GetString() : null;
            var rootCount = root.TryGetProperty("roots", out var r) && r.ValueKind == JsonValueKind.Array
                ? r.GetArrayLength()
                : 0;
            var shutdownEnabled = root.TryGetProperty("allow_system_shutdown", out var power)
                && power.ValueKind == JsonValueKind.True;
            var shutdownState = shutdownEnabled
                ? "Shutdown opt-in: ON (explicit prompts execute immediately; no approval)."
                : "Shutdown opt-in: OFF.";
            var permissionState = string.IsNullOrWhiteSpace(profile) ? mode : $"{profile}, {rootCount} path(s)";
            var tunnel = await ProbeTunnelAsync(CancellationToken.None);
            var fingerprint = RuntimeStatus.TunnelIdFingerprint(
                tunnel.ActiveTunnelId.Length > 0 ? tunnel.ActiveTunnelId : _cfg.TunnelId);
            if (tunnel.Ready)
            {
                status = $"Server: ONLINE v{shownVersion} ({permissionState})   Tunnel: CONNECTED {fingerprint}";
                hint = $"Ready. ChatGPT must use Tunnel ID {fingerprint}; a different suffix means a stale connector. {shutdownState}";
                statusColor = System.Drawing.Color.DarkGreen;
                _recoveryFailures = 0;
            }
            else if (_sup.TunnelRunning || tunnel.Reachable)
            {
                status = $"Server: ONLINE v{shownVersion} ({permissionState})   Tunnel: NOT READY {fingerprint}";
                hint = RuntimeStatus.FailureSummary(tunnel);
                statusColor = System.Drawing.Color.DarkRed;
            }
            else
            {
                status = $"Server: ONLINE v{shownVersion} ({permissionState})   Tunnel: STOPPED {fingerprint}";
                hint = string.IsNullOrWhiteSpace(_cfg.GetKey())
                    ? "Save the Runtime API key before connecting the tunnel."
                    : "Use Reconnect tunnel. MCP is already ready, so the startup race is avoided.";
                statusColor = System.Drawing.Color.DarkOrange;
            }

            shouldRecoverTunnel = _desiredRunning
                && !_starting
                && !_recovering
                && !tunnel.Ready
                && _cfg.HasKey
                && DateTime.UtcNow >= _nextRecoveryUtc;
        }
        catch
        {
            status = $"Server: OFFLINE   Tunnel process: {(_sup.TunnelRunning ? "running" : "stopped")}";
            hint = "Start the agent. The tray waits for MCP health before launching the tunnel.";
            statusColor = System.Drawing.Color.DarkRed;
        }
        finally
        {
            _healthBusy = false;
        }
        if (IsHandleCreated)
        {
            BeginInvoke((MethodInvoker)(() =>
            {
                _lblStatus.Text = status;
                _lblStatus.ForeColor = statusColor;
                _lblConnectionHint.Text = hint;
                UpdateActionButtons();
            }));
        }
        if (shouldRecoverTunnel)
            _ = ReconnectTunnelAsync(userInitiated: false);
    }

    // ----------------------------------------------------------------- helpers
    private void AppendLog(string line)
    {
        if (!IsHandleCreated) return;
        BeginInvoke((MethodInvoker)(() =>
        {
            if (_txtLog.TextLength > 60_000) _txtLog.Text = _txtLog.Text[^40_000..];
            _txtLog.AppendText($"{DateTime.Now:HH:mm:ss} {line}{Environment.NewLine}");
        }));
    }

    private void ShowForm()
    {
        Show();
        WindowState = FormWindowState.Normal;
        BringToFront();
        Activate();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // Closing the window minimizes to tray; real exit only via tray menu.
        if (!_reallyExit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            _tray.ShowBalloonTip(1500, "Local Coding Agent", "Still running in the tray.", ToolTipIcon.Info);
            return;
        }
        _healthTimer.Stop();
        _desiredRunning = false;
        _lifecycleCts?.Cancel();
        _lifecycleCts?.Dispose();
        _sup.StopAll();
        _tray.Visible = false;
        _tray.Dispose();
    }
}
