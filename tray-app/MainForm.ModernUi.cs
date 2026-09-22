// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace LocalCodingAgentTray;

public sealed partial class MainForm
{
    private NumericUpDown _numDashboardPort = null!;
    private Label _lblStatusDot = null!;
    private Label _lblWorkspaceSummary = null!;
    private Label _lblModeSummary = null!;
    private Label _lblTunnelSummary = null!;
    private Label _lblMaximumAccessState = null!;

    private void BuildModernUi()
    {
        SuspendLayout();
        BackColor = UiTheme.Canvas;
        ForeColor = UiTheme.Text;
        Font = new Font("Segoe UI", 9.25f);
        Padding = Padding.Empty;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = UiTheme.Canvas,
            ColumnCount = 1,
            RowCount = 2,
            Margin = Padding.Empty,
            Padding = Padding.Empty
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 92));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.Controls.Add(BuildHeader(), 0, 0);

        var body = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = UiTheme.Canvas,
            Padding = new Padding(24, 14, 24, 22),
            Margin = Padding.Empty
        };
        var tabs = new ModernTabControl { Dock = DockStyle.Fill, Margin = Padding.Empty };
        tabs.TabPages.Add(BuildOverviewPage());
        tabs.TabPages.Add(BuildSetupPage());
        tabs.TabPages.Add(BuildAdvancedPage());
        tabs.TabPages.Add(BuildActivityPage());
        body.Controls.Add(tabs);
        root.Controls.Add(body, 0, 1);

        Controls.Add(root);
        ResumeLayout(true);
    }

    private Control BuildHeader()
    {
        var header = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = UiTheme.Surface,
            Margin = Padding.Empty,
            Padding = new Padding(28, 17, 28, 14)
        };

        var title = new Label
        {
            Text = "Local Coding Agent",
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 18f),
            ForeColor = UiTheme.Text,
            Location = new Point(28, 16)
        };
        var subtitle = new Label
        {
            Text = "Secure workspace supervisor  •  v5.0.1",
            AutoSize = true,
            Font = new Font("Segoe UI", 9.5f),
            ForeColor = UiTheme.Muted,
            Location = new Point(30, 54)
        };
        header.Controls.Add(title);
        header.Controls.Add(subtitle);

        var statusPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Right,
            Width = 570,
            ColumnCount = 2,
            RowCount = 2,
            BackColor = UiTheme.Surface,
            Margin = Padding.Empty,
            Padding = new Padding(0, 7, 0, 0)
        };
        statusPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 26));
        statusPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        statusPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));

        _lblStatusDot = new Label
        {
            Text = "●",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.DarkOrange,
            Font = new Font("Segoe UI", 12f)
        };
        _lblStatus = new Label
        {
            Text = "Checking local services...",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            AutoEllipsis = true,
            Font = new Font("Segoe UI Semibold", 9.5f),
            ForeColor = UiTheme.Text
        };
        var statusCaption = new Label
        {
            Text = "Status refreshes automatically every 3 seconds",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = UiTheme.Muted,
            Font = new Font("Segoe UI", 8.75f)
        };
        statusPanel.Controls.Add(_lblStatusDot, 0, 0);
        statusPanel.Controls.Add(_lblStatus, 1, 0);
        statusPanel.Controls.Add(statusCaption, 1, 1);
        header.Controls.Add(statusPanel);
        return header;
    }

    private TabPage BuildOverviewPage()
    {
        var page = CreatePage("Overview");
        var stack = CreateScrollableStack(page);

        _lblConnectionHint = new Label
        {
            Text = "Start the agent to make the local MCP endpoint available.",
            AutoSize = true,
            MaximumSize = new Size(920, 0),
            ForeColor = UiTheme.Muted,
            Font = new Font("Segoe UI", 10f),
            Margin = new Padding(0, 6, 0, 14)
        };

        var summary = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ColumnCount = 3,
            RowCount = 1,
            Margin = Padding.Empty
        };
        summary.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
        summary.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 27));
        summary.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 27));
        _lblWorkspaceSummary = AddSummaryBlock(summary, 0, "WORKSPACE");
        _lblModeSummary = AddSummaryBlock(summary, 1, "SAFETY");
        _lblTunnelSummary = AddSummaryBlock(summary, 2, "TUNNEL");

        var statusContent = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ColumnCount = 1,
            RowCount = 2,
            Margin = Padding.Empty
        };
        statusContent.Controls.Add(_lblConnectionHint, 0, 0);
        statusContent.Controls.Add(summary, 0, 1);
        stack.Controls.Add(CreateCard("System status", "Live state of the local server, permissions and secure tunnel.", statusContent));

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            Margin = Padding.Empty,
            Padding = new Padding(0, 4, 0, 0)
        };
        _btnStart = UiTheme.Button("Start agent", ButtonKind.Primary, 138);
        _btnStart.Click += async (_, _) => await StartAllAsync();
        _btnStop = UiTheme.Button("Stop", ButtonKind.Danger, 108);
        _btnStop.Click += (_, _) => StopAll();
        _btnReconnect = UiTheme.Button("Reconnect tunnel", ButtonKind.Secondary, 164);
        _btnReconnect.Click += async (_, _) => await ReconnectTunnelAsync(userInitiated: true);
        var dashboard = UiTheme.Button("Open dashboard", ButtonKind.Secondary, 154);
        dashboard.Click += (_, _) => OpenDashboard();
        actions.Controls.AddRange([_btnStart, _btnStop, _btnReconnect, dashboard]);
        stack.Controls.Add(CreateCard("Quick actions", "Start locally first; the tunnel connects only when a Runtime API key is saved.", actions));

        var safety = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(920, 0),
            Text = "Recommended defaults: safe mode + balanced policy. The agent can work normally while risky actions still require local approval. Only authorize folders you trust.",
            ForeColor = Color.FromArgb(89, 67, 20),
            BackColor = Color.FromArgb(255, 249, 226),
            Padding = new Padding(14),
            Margin = Padding.Empty,
            Font = new Font("Segoe UI", 9.25f)
        };
        stack.Controls.Add(CreateCard("Safety", "A quick reminder before exposing a workspace to an AI agent.", safety));
        return page;
    }

    private TabPage BuildSetupPage()
    {
        var page = CreatePage("Setup");
        var stack = CreateScrollableStack(page);

        var workspaceGrid = CreateFormGrid();
        _txtWorkspace = CreateTextBox();
        AddFormRow(workspaceGrid, "Workspace", _txtWorkspace, BrowseButton(_txtWorkspace, BrowseFolder),
            "Primary folder the agent may read and change.");
        _txtExtraRoots = CreateTextBox();
        AddFormRow(workspaceGrid, "Extra roots", _txtExtraRoots, null,
            "Optional legacy roots separated with semicolons. Named permission profiles are safer for multiple folders.");
        _cmbMode = CreateComboBox("safe", "full");
        AddFormRow(workspaceGrid, "Command mode", _cmbMode, null,
            "Use safe unless this machine is isolated and you understand the command boundary.");
        _cmbPolicy = CreateComboBox("strict", "balanced", "full");
        AddFormRow(workspaceGrid, "Approval policy", _cmbPolicy, null,
            "Balanced allows normal development and asks locally before risky actions.");

        var permissionActions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.LeftToRight,
            Margin = new Padding(0, 8, 0, 0)
        };
        var managePermissions = UiTheme.Button("Manage authorized paths", ButtonKind.Secondary, 206);
        managePermissions.Click += (_, _) => OpenPermissionProfiles();
        permissionActions.Controls.Add(managePermissions);
        var permissionRow = workspaceGrid.RowCount++;
        workspaceGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        workspaceGrid.Controls.Add(permissionActions, 1, permissionRow);
        workspaceGrid.SetColumnSpan(permissionActions, 2);
        stack.Controls.Add(CreateCard("Workspace access", "Choose what the agent can access and how much autonomy it has.", workspaceGrid));

        var tunnelGrid = CreateFormGrid();
        _txtTunnelId = CreateTextBox();
        var saveTunnel = UiTheme.Button("Save tunnel", ButtonKind.Secondary, 126);
        saveTunnel.Click += (_, _) => SaveTunnelSettings();
        AddFormRow(tunnelGrid, "Tunnel ID", _txtTunnelId, saveTunnel,
            "Use the tunnel_... identifier created in ChatGPT/OpenAI.");
        _txtOrgId = CreateTextBox();
        AddFormRow(tunnelGrid, "Organization ID", _txtOrgId, null,
            "Optional. Required only when the tunnel belongs to a specific organization.");
        _txtKey = CreateTextBox(secret: true);
        var keyButtons = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = Padding.Empty
        };
        var showKey = UiTheme.Button("Show", ButtonKind.Ghost, 58);
        showKey.Click += (_, _) =>
        {
            _txtKey.UseSystemPasswordChar = !_txtKey.UseSystemPasswordChar;
            showKey.Text = _txtKey.UseSystemPasswordChar ? "Show" : "Hide";
        };
        var saveKey = UiTheme.Button("Save key", ButtonKind.Primary, 92);
        saveKey.Click += (_, _) => SaveKey();
        keyButtons.Controls.Add(showKey);
        keyButtons.Controls.Add(saveKey);
        AddFormRow(tunnelGrid, "Runtime API key", _txtKey, keyButtons,
            "Encrypted with Windows DPAPI for the current Windows user.");
        _lblKeyState = new Label
        {
            AutoSize = true,
            ForeColor = UiTheme.Muted,
            Margin = new Padding(0, 2, 0, 8)
        };
        var keyStateRow = tunnelGrid.RowCount++;
        tunnelGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        tunnelGrid.Controls.Add(_lblKeyState, 1, keyStateRow);
        tunnelGrid.SetColumnSpan(_lblKeyState, 2);
        _chkOpenWeb = new CheckBox { Text = "Open the tunnel web UI when it starts" };
        UiTheme.StyleCheckBox(_chkOpenWeb);
        var openWebRow = tunnelGrid.RowCount++;
        tunnelGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        tunnelGrid.Controls.Add(_chkOpenWeb, 1, openWebRow);
        tunnelGrid.SetColumnSpan(_chkOpenWeb, 2);
        stack.Controls.Add(CreateCard("ChatGPT tunnel", "Optional for local-only use; required when ChatGPT Web connects to this machine.", tunnelGrid));

        var saveSettings = UiTheme.Button("Save all settings", ButtonKind.Primary, 160);
        saveSettings.Click += (_, _) =>
        {
            SyncToConfig();
            _cfg.Save();
            RefreshUiSummary();
            AppendLog("[ui] settings saved");
        };
        var saveFlow = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.RightToLeft,
            Margin = Padding.Empty
        };
        saveFlow.Controls.Add(saveSettings);
        stack.Controls.Add(CreateCard("Apply changes", "Starting the agent also saves and applies the current configuration.", saveFlow));
        return page;
    }

    private TabPage BuildAdvancedPage()
    {
        var page = CreatePage("Advanced");
        var stack = CreateScrollableStack(page);

        var runtimeGrid = CreateFormGrid();
        _txtNode = CreateTextBox();
        AddFormRow(runtimeGrid, "Node executable", _txtNode);
        _txtMcpDir = CreateTextBox();
        AddFormRow(runtimeGrid, "MCP app folder", _txtMcpDir, BrowseButton(_txtMcpDir, BrowseFolder));
        _txtTunnelExe = CreateTextBox();
        AddFormRow(runtimeGrid, "tunnel-client.exe", _txtTunnelExe, BrowseButton(_txtTunnelExe, BrowseFile));
        _txtProfileDir = CreateTextBox();
        AddFormRow(runtimeGrid, "Tunnel profile folder", _txtProfileDir, BrowseButton(_txtProfileDir, BrowseFolder));
        _txtProfileName = CreateTextBox();
        AddFormRow(runtimeGrid, "Tunnel profile name", _txtProfileName);
        stack.Controls.Add(CreateCard("Runtime paths", "Defaults are detected from the repository. Change them only for a custom installation.", runtimeGrid));

        var profileGrid = CreateFormGrid();
        _txtPermissionProfileFile = CreateTextBox();
        AddFormRow(profileGrid, "Permission store", _txtPermissionProfileFile,
            BrowseButton(_txtPermissionProfileFile, BrowseJsonFile));
        _txtPermissionProfileName = CreateTextBox();
        AddFormRow(profileGrid, "Active profile", _txtPermissionProfileName);
        stack.Controls.Add(CreateCard("Permission profile", "Named profiles keep multi-folder access explicit and reusable.", profileGrid));

        var networkGrid = CreateFormGrid();
        _numPort = CreatePortControl();
        AddFormRow(networkGrid, "MCP port", _numPort);
        _numDashboardPort = CreatePortControl();
        AddFormRow(networkGrid, "Dashboard port", _numDashboardPort, null,
            "Do not use 8788; it is reserved by tunnel-client.");
        _txtAuth = CreateTextBox(secret: true);
        var showAuth = UiTheme.Button("Show", ButtonKind.Ghost, 76);
        showAuth.Click += (_, _) =>
        {
            _txtAuth.UseSystemPasswordChar = !_txtAuth.UseSystemPasswordChar;
            showAuth.Text = _txtAuth.UseSystemPasswordChar ? "Show" : "Hide";
        };
        AddFormRow(networkGrid, "MCP auth token", _txtAuth, showAuth,
            "Optional defense in depth. The value is passed to the local MCP server.");
        _chkV5Preview = new CheckBox { Text = "Enable official v5 features" };
        UiTheme.StyleCheckBox(_chkV5Preview);
        var v5Row = networkGrid.RowCount++;
        networkGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        networkGrid.Controls.Add(_chkV5Preview, 1, v5Row);
        networkGrid.SetColumnSpan(_chkV5Preview, 2);
        _chkAllowSystemShutdown = new CheckBox
        {
            Text = "Allow explicit prompt-requested Windows shutdown without a second dashboard approval"
        };
        UiTheme.StyleCheckBox(_chkAllowSystemShutdown, warning: true);
        var shutdownRow = networkGrid.RowCount++;
        networkGrid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        networkGrid.Controls.Add(_chkAllowSystemShutdown, 1, shutdownRow);
        networkGrid.SetColumnSpan(_chkAllowSystemShutdown, 2);
        stack.Controls.Add(CreateCard("Network and safety", "Local endpoints, authentication and optional power integration.", networkGrid));

        var maximumAccessLayout = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ColumnCount = 1,
            RowCount = 3,
            Margin = Padding.Empty,
            BackColor = UiTheme.Surface
        };
        maximumAccessLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        _lblMaximumAccessState = new Label
        {
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 9.5f),
            ForeColor = UiTheme.Muted,
            Margin = new Padding(0, 0, 0, 10)
        };
        maximumAccessLayout.Controls.Add(_lblMaximumAccessState, 0, 0);
        maximumAccessLayout.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(900, 0),
            Text = "Maximum access sets full command mode, full policy, full_control on every ready drive root, and enables commands normally blocked as catastrophic. Use only on a trusted, recoverable machine.",
            ForeColor = UiTheme.Danger,
            Margin = new Padding(0, 0, 0, 14)
        }, 0, 1);
        var maximumActions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            Margin = Padding.Empty
        };
        var enableMaximum = UiTheme.Button("Enable maximum access", ButtonKind.Danger, 196);
        enableMaximum.Click += (_, _) => EnableMaximumAccess();
        var restoreSafe = UiTheme.Button("Restore safe defaults", ButtonKind.Secondary, 174);
        restoreSafe.Click += (_, _) => RestoreSafeDefaults();
        maximumActions.Controls.Add(enableMaximum);
        maximumActions.Controls.Add(restoreSafe);
        maximumAccessLayout.Controls.Add(maximumActions, 0, 2);
        stack.Controls.Add(CreateCard("Maximum machine access", "Explicit all-root mode for fully trusted local use.", maximumAccessLayout));
        return page;
    }

    private void EnableMaximumAccess()
    {
        try
        {
            SyncToConfig();
            var roots = ReadyDriveRoots();
            if (roots.Count == 0)
                throw new InvalidOperationException("No ready drive roots were found.");

            var requestedWorkspace = _txtWorkspace.Text.Trim();
            var workingDirectory = Directory.Exists(requestedWorkspace)
                ? Path.GetFullPath(requestedWorkspace)
                : roots[0];

            using var confirmation = new MaximumAccessDialog(roots, workingDirectory);
            if (confirmation.ShowDialog(this) != DialogResult.OK) return;

            _cmbMode.SelectedItem = "full";
            _cmbPolicy.SelectedItem = "full";
            _txtWorkspace.Text = workingDirectory;
            _txtExtraRoots.Text = string.Join(";", roots.Where(root =>
                !Path.GetFullPath(root).Equals(workingDirectory, StringComparison.OrdinalIgnoreCase)));
            _txtPermissionProfileFile.Clear();
            _txtPermissionProfileName.Clear();
            _chkV5Preview.Checked = true;
            _chkAllowSystemShutdown.Checked = true;

            SyncToConfig();
            _cfg.AllowDangerousCommands = true;
            _cfg.PermissionProfileFile = "";
            _cfg.PermissionProfileName = "";
            _cfg.Save();
            RefreshUiSummary();
            UpdateMaximumAccessState();
            AppendLog($"[security] MAXIMUM ACCESS enabled for {roots.Count} drive root(s); restart agent to apply");

            MessageBox.Show(this,
                "Maximum access has been saved. Click Start agent to restart with full command, full policy, all-root file access, and dangerous-command opt-in.",
                "Maximum access enabled", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            AppendLog("[security:error] " + ex.Message);
            MessageBox.Show(this, ex.Message, "Cannot enable maximum access",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void RestoreSafeDefaults()
    {
        _cmbMode.SelectedItem = "safe";
        _cmbPolicy.SelectedItem = "balanced";
        _txtExtraRoots.Clear();
        _chkAllowSystemShutdown.Checked = false;
        SyncToConfig();
        _cfg.AllowDangerousCommands = false;
        _cfg.Save();
        StopAll();
        _cfg.Save();
        RefreshUiSummary();
        UpdateMaximumAccessState();
        AppendLog("[security] safe defaults restored; running agent stopped");
        MessageBox.Show(this,
            "Safe mode and balanced policy have been restored. Extra all-root access and dangerous commands are disabled, and the running agent has been stopped. Click Start agent when you are ready.",
            "Safe defaults restored", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private static List<string> ReadyDriveRoots()
    {
        var roots = new List<string>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady || drive.DriveType == DriveType.CDRom) continue;
                var root = Path.GetFullPath(drive.RootDirectory.FullName);
                if (Directory.Exists(root)) roots.Add(root);
            }
            catch
            {
                // A drive can disappear between enumeration and inspection.
            }
        }
        return roots.Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(root => root, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private TabPage BuildActivityPage()
    {
        var page = CreatePage("Activity");
        page.Padding = new Padding(22);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = UiTheme.Canvas,
            Margin = Padding.Empty,
            Padding = Padding.Empty
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var tools = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = Padding.Empty,
            BackColor = UiTheme.Canvas
        };
        var copyUrl = UiTheme.Button("Copy MCP URL", ButtonKind.Secondary, 132);
        copyUrl.Click += (_, _) => CopyUrl();
        var copyTunnel = UiTheme.Button("Copy Tunnel ID", ButtonKind.Secondary, 142);
        copyTunnel.Click += (_, _) => CopyTunnelId();
        var openFolder = UiTheme.Button("Logs / config", ButtonKind.Secondary, 132);
        openFolder.Click += (_, _) => OpenConfigFolder();
        var clear = UiTheme.Button("Clear view", ButtonKind.Ghost, 104);
        clear.Click += (_, _) => _txtLog.Clear();
        tools.Controls.AddRange([copyUrl, copyTunnel, openFolder, clear]);
        layout.Controls.Add(tools, 0, 0);

        var logCard = new ModernCard { Dock = DockStyle.Fill, AutoSize = false, Padding = new Padding(1) };
        _txtLog = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            BorderStyle = BorderStyle.None,
            BackColor = UiTheme.LogBackground,
            ForeColor = Color.FromArgb(218, 225, 238),
            Font = new Font("Cascadia Mono", 9f),
            Margin = Padding.Empty
        };
        logCard.Controls.Add(_txtLog);
        layout.Controls.Add(logCard, 0, 1);
        page.Controls.Add(layout);
        return page;
    }

    private static TabPage CreatePage(string title) => new(title)
    {
        BackColor = UiTheme.Canvas,
        ForeColor = UiTheme.Text,
        UseVisualStyleBackColor = false
    };

    private static TableLayoutPanel CreateScrollableStack(Control page)
    {
        var scrollHost = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = UiTheme.Canvas,
            Padding = new Padding(22)
        };
        var stack = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 0,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            BackColor = UiTheme.Canvas
        };
        stack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        scrollHost.Controls.Add(stack);
        page.Controls.Add(scrollHost);
        return stack;
    }

    private static ModernCard CreateCard(string title, string subtitle, Control content)
    {
        var card = new ModernCard();
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 3,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            BackColor = UiTheme.Surface
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(new Label
        {
            Text = title,
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 12f),
            ForeColor = UiTheme.Text,
            Margin = new Padding(0, 0, 0, 3)
        }, 0, 0);
        layout.Controls.Add(new Label
        {
            Text = subtitle,
            AutoSize = true,
            MaximumSize = new Size(940, 0),
            Font = new Font("Segoe UI", 9f),
            ForeColor = UiTheme.Muted,
            Margin = new Padding(0, 0, 0, 14)
        }, 0, 1);
        content.Dock = DockStyle.Top;
        layout.Controls.Add(content, 0, 2);
        card.Controls.Add(layout);
        return card;
    }

    private static TableLayoutPanel CreateFormGrid()
    {
        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            RowCount = 0,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            BackColor = UiTheme.Surface
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 176));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 170));
        return grid;
    }

    private static void AddFormRow(
        TableLayoutPanel grid,
        string label,
        Control field,
        Control? action = null,
        string? helper = null)
    {
        var row = grid.RowCount++;
        grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        grid.Controls.Add(new Label
        {
            Text = label,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = UiTheme.Text,
            Font = new Font("Segoe UI Semibold", 9.25f),
            Margin = new Padding(0, 5, 12, 5)
        }, 0, row);
        grid.Controls.Add(field, 1, row);
        if (action is not null)
        {
            action.Anchor = AnchorStyles.Left;
            action.Margin = new Padding(0, 3, 0, 4);
            grid.Controls.Add(action, 2, row);
        }

        if (string.IsNullOrWhiteSpace(helper)) return;
        var helperRow = grid.RowCount++;
        grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var helperLabel = new Label
        {
            Text = helper,
            AutoSize = true,
            MaximumSize = new Size(680, 0),
            ForeColor = UiTheme.Muted,
            Font = new Font("Segoe UI", 8.4f),
            Margin = new Padding(0, 0, 0, 8)
        };
        grid.Controls.Add(helperLabel, 1, helperRow);
        grid.SetColumnSpan(helperLabel, 2);
    }

    private static TextBox CreateTextBox(bool secret = false)
    {
        var textBox = new TextBox();
        UiTheme.StyleTextBox(textBox, secret);
        return textBox;
    }

    private static ComboBox CreateComboBox(params string[] items)
    {
        var combo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        combo.Items.AddRange(items.Cast<object>().ToArray());
        UiTheme.StyleComboBox(combo);
        return combo;
    }

    private static NumericUpDown CreatePortControl()
    {
        var numeric = new NumericUpDown { Minimum = 1, Maximum = 65535 };
        UiTheme.StyleNumeric(numeric);
        return numeric;
    }

    private static Button BrowseButton(TextBox target, Action<TextBox> browse)
    {
        var button = UiTheme.Button("Browse...", ButtonKind.Secondary, 112);
        button.Click += (_, _) => browse(target);
        return button;
    }

    private static Label AddSummaryBlock(TableLayoutPanel parent, int column, string caption)
    {
        var panel = new TableLayoutPanel
        {
            Height = 72,
            Dock = DockStyle.Fill,
            BackColor = UiTheme.SoftBlue,
            Margin = new Padding(column == 0 ? 0 : 6, 0, column == 2 ? 0 : 6, 0),
            Padding = new Padding(12, 7, 12, 7),
            ColumnCount = 1,
            RowCount = 2
        };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 20));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        panel.Controls.Add(new Label
        {
            Text = caption,
            Dock = DockStyle.Fill,
            ForeColor = UiTheme.Primary,
            Font = new Font("Segoe UI Semibold", 8f)
        }, 0, 0);
        var value = new Label
        {
            Text = "Not configured",
            Dock = DockStyle.Fill,
            AutoEllipsis = true,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = UiTheme.Text,
            Font = new Font("Segoe UI Semibold", 9.5f)
        };
        panel.Controls.Add(value, 0, 1);
        parent.Controls.Add(panel, column, 0);
        return value;
    }

    private void RefreshUiSummary()
    {
        if (_lblWorkspaceSummary is null || _lblWorkspaceSummary.IsDisposed) return;
        var workspace = _txtWorkspace?.Text.Trim() ?? _cfg.Workspace;
        _lblWorkspaceSummary.Text = string.IsNullOrWhiteSpace(workspace)
            ? "Not configured"
            : CompactPath(workspace, 48);
        var mode = (_cmbMode?.SelectedItem as string) ?? _cfg.Mode;
        var policy = (_cmbPolicy?.SelectedItem as string) ?? _cfg.Policy;
        _lblModeSummary.Text = _cfg.AllowDangerousCommands && mode == "full" && policy == "full"
            ? "MAXIMUM / all roots"
            : $"{mode} / {policy}";
        var tunnelId = _txtTunnelId?.Text.Trim() ?? _cfg.TunnelId;
        _lblTunnelSummary.Text = RuntimeStatus.TunnelIdFingerprint(tunnelId);
    }

    private void UpdateMaximumAccessState()
    {
        if (_lblMaximumAccessState is null || _lblMaximumAccessState.IsDisposed) return;
        var enabled = _cfg.AllowDangerousCommands
            && _cfg.Mode == "full"
            && _cfg.Policy == "full"
            && string.IsNullOrWhiteSpace(_cfg.PermissionProfileFile);
        _lblMaximumAccessState.Text = enabled
            ? "MAXIMUM ACCESS IS ENABLED — restart the agent after changing this setting."
            : "Standard safeguards are active.";
        _lblMaximumAccessState.ForeColor = enabled ? UiTheme.Danger : Color.DarkGreen;
    }

    private static string CompactPath(string value, int limit)
    {
        if (value.Length <= limit) return value;
        var root = Path.GetPathRoot(value) ?? "";
        var tail = Path.GetFileName(value.TrimEnd(Path.DirectorySeparatorChar));
        return $"{root}...{Path.DirectorySeparatorChar}{tail}";
    }
}
