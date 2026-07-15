// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace LocalCodingAgentTray;

public sealed class MainForm : Form
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    private readonly AppConfig _cfg = AppConfig.Load();
    private readonly ProcessSupervisor _sup = new();
    private readonly System.Windows.Forms.Timer _healthTimer = new() { Interval = 3000 };
    private readonly NotifyIcon _tray;
    private bool _reallyExit;
    private bool _healthBusy;

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
    private ComboBox _cmbMode = null!;
    private ComboBox _cmbPolicy = null!;
    private NumericUpDown _numPort = null!;
    private TextBox _txtAuth = null!;
    private TextBox _txtKey = null!;
    private Label _lblKeyState = null!;
    private CheckBox _chkOpenWeb = null!;
    private Label _lblStatus = null!;
    private TextBox _txtLog = null!;
    private Button _btnStart = null!;
    private Button _btnStop = null!;

    public MainForm()
    {
        Text = "Local Coding Agent";
        Width = 660;
        Height = 863;
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
        _txtWorkspace = AddRow("Workspace (root)", ref y, browse: BrowseFolder);
        _txtExtraRoots = AddRow("Extra roots (;)", ref y);

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

        // Action buttons (row 1)
        _btnStart = new Button { Text = "Start", Left = 12, Top = y, Width = 100, Height = 32 };
        _btnStart.Click += (_, _) => StartAll();
        Controls.Add(_btnStart);
        _btnStop = new Button { Text = "Stop", Left = 118, Top = y, Width = 100, Height = 32 };
        _btnStop.Click += (_, _) => StopAll();
        Controls.Add(_btnStop);
        var btnCopy = new Button { Text = "Copy MCP URL", Left = 224, Top = y, Width = 130, Height = 32 };
        btnCopy.Click += (_, _) => CopyUrl();
        Controls.Add(btnCopy);
        var btnDash = new Button { Text = "Open Dashboard", Left = 360, Top = y, Width = 140, Height = 32 };
        btnDash.Click += (_, _) => OpenDashboard();
        Controls.Add(btnDash);
        y += 38;

        // Action buttons (row 2)
        var btnSave = new Button { Text = "Save settings", Left = 12, Top = y, Width = 130, Height = 32 };
        btnSave.Click += (_, _) => { SyncToConfig(); _cfg.Save(); AppendLog("[ui] settings saved"); };
        Controls.Add(btnSave);
        var btnFolder = new Button { Text = "Logs/Config", Left = 148, Top = y, Width = 130, Height = 32 };
        btnFolder.Click += (_, _) => OpenConfigFolder();
        Controls.Add(btnFolder);
        y += 44;

        _lblStatus = new Label { Left = 12, Top = y, Width = 620, Font = new System.Drawing.Font(Font, System.Drawing.FontStyle.Bold) };
        Controls.Add(_lblStatus);
        y += 26;

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
        menu.Items.Add("Start", null, (_, _) => StartAll());
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
        _cmbMode.SelectedItem = _cfg.Mode == "safe" ? "safe" : "full";
        _cmbPolicy.SelectedItem = _cfg.Policy is "strict" or "full" ? _cfg.Policy : "balanced";
        _numPort.Value = Math.Clamp(_cfg.Port, 1, 65535);
        _txtAuth.Text = _cfg.AuthToken;
        _chkOpenWeb.Checked = _cfg.OpenWebUi;
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
        _cfg.Mode = (_cmbMode.SelectedItem as string) ?? "full";
        _cfg.Policy = (_cmbPolicy.SelectedItem as string) ?? "balanced";
        _cfg.Port = (int)_numPort.Value;
        _cfg.AuthToken = _txtAuth.Text.Trim();
        _cfg.OpenWebUi = _chkOpenWeb.Checked;
    }

    // ----------------------------------------------------------------- actions
    private void StartAll()
    {
        try
        {
            SyncToConfig();
            _cfg.Save();

            if (!Directory.Exists(_cfg.Workspace))
            {
                MessageBox.Show(this, "Workspace folder does not exist:\n" + _cfg.Workspace,
                    "Local Coding Agent", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            // Clear any stray instances (launcher/manual) so this app owns the
            // processes and ports are free, then start fresh.
            var strays = ProcessSupervisor.KillStrayInstances(_cfg.ServerScript, AppendLog);
            if (strays > 0) System.Threading.Thread.Sleep(700); // let ports free up

            _sup.StartServer(_cfg);

            var key = _cfg.GetKey();
            if (string.IsNullOrEmpty(key))
            {
                AppendLog("[ui] server started; no tunnel key saved, tunnel NOT started.");
                MessageBox.Show(this, "Server started. Enter and save the tunnel key, then Start again to launch the tunnel.",
                    "Local Coding Agent", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                _sup.StartTunnel(_cfg, key);
            }
        }
        catch (Exception ex)
        {
            AppendLog("[error] " + ex.Message);
            MessageBox.Show(this, ex.Message, "Local Coding Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void StopAll()
    {
        _sup.StopAll();
        // Also stop instances started outside this app (launcher / manual).
        SyncToConfig();
        var n = ProcessSupervisor.KillStrayInstances(_cfg.ServerScript, AppendLog);
        AppendLog($"[ui] stopped (killed {n} external process(es))");
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
        AppendLog("[ui] copied " + _cfg.McpUrl);
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

    // ----------------------------------------------------------------- health
    private async Task PollHealthAsync()
    {
        if (_healthBusy) return;
        _healthBusy = true;
        string status;
        try
        {
            var json = await Http.GetStringAsync(_cfg.HealthUrl);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var ver = root.TryGetProperty("version", out var v) ? v.GetString() : "?";
            var mode = root.TryGetProperty("mode", out var m) ? m.GetString() : "?";
            status = $"● Server: ONLINE v{ver} ({mode})   Tunnel: {(_sup.TunnelRunning ? "running" : "stopped")}";
        }
        catch
        {
            status = $"○ Server: offline   Tunnel: {(_sup.TunnelRunning ? "running" : "stopped")}";
        }
        finally
        {
            _healthBusy = false;
        }
        if (IsHandleCreated)
            BeginInvoke((MethodInvoker)(() => _lblStatus.Text = status));
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
        _sup.StopAll();
        _tray.Visible = false;
        _tray.Dispose();
    }
}
