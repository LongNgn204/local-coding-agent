// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace LocalCodingAgentTray;

public sealed class PermissionProfileDialog : Form
{
    private readonly AppConfig _config;
    private readonly TextBox _file = new();
    private readonly ComboBox _profiles = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly TextBox _workingDirectory = new();
    private readonly DataGridView _roots = new();
    private readonly Label _summary = new();
    private PermissionProfileStore _store;
    private string _loadedProfile = "";
    private bool _binding;

    public PermissionProfileDialog(AppConfig config)
    {
        _config = config;
        _store = LoadOrCreateStore();

        Text = "Private multi-path permission profiles";
        Width = 980;
        Height = 660;
        MinimizeBox = false;
        MaximizeBox = false;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        ShowInTaskbar = false;

        BuildUi();
        BindProfiles(string.IsNullOrWhiteSpace(_config.PermissionProfileName)
            ? _store.ActiveProfile
            : _config.PermissionProfileName);
    }

    private PermissionProfileStore LoadOrCreateStore()
    {
        var path = string.IsNullOrWhiteSpace(_config.PermissionProfileFile)
            ? AppConfig.DefaultPermissionProfilePath
            : Path.GetFullPath(_config.PermissionProfileFile);
        return File.Exists(path)
            ? PermissionProfileStore.Load(path)
            : PermissionProfileStore.Create(_config.Workspace, _config.PermissionProfileName);
    }

    private void BuildUi()
    {
        Controls.Add(new Label { Text = "Profile store", Left = 16, Top = 19, Width = 110 });
        _file.Left = 130;
        _file.Top = 16;
        _file.Width = 690;
        _file.Text = string.IsNullOrWhiteSpace(_config.PermissionProfileFile)
            ? AppConfig.DefaultPermissionProfilePath
            : Path.GetFullPath(_config.PermissionProfileFile);
        Controls.Add(_file);

        var browseFile = new Button { Text = "Browse", Left = 830, Top = 14, Width = 120 };
        browseFile.Click += (_, _) => BrowseStore();
        Controls.Add(browseFile);

        Controls.Add(new Label { Text = "Active profile", Left = 16, Top = 58, Width = 110 });
        _profiles.Left = 130;
        _profiles.Top = 54;
        _profiles.Width = 350;
        _profiles.SelectedIndexChanged += (_, _) => SwitchProfile();
        Controls.Add(_profiles);

        var addProfile = new Button { Text = "New profile", Left = 490, Top = 52, Width = 130 };
        addProfile.Click += (_, _) => AddProfile();
        Controls.Add(addProfile);
        var deleteProfile = new Button { Text = "Delete profile", Left = 628, Top = 52, Width = 130 };
        deleteProfile.Click += (_, _) => DeleteProfile();
        Controls.Add(deleteProfile);

        Controls.Add(new Label { Text = "Working path", Left = 16, Top = 96, Width = 110 });
        _workingDirectory.Left = 130;
        _workingDirectory.Top = 92;
        _workingDirectory.Width = 690;
        Controls.Add(_workingDirectory);
        var browseWorking = new Button { Text = "Browse", Left = 830, Top = 90, Width = 120 };
        browseWorking.Click += (_, _) => BrowseFolderInto(_workingDirectory);
        Controls.Add(browseWorking);

        var help = new Label
        {
            Left = 16,
            Top = 130,
            Width = 934,
            Height = 42,
            ForeColor = System.Drawing.Color.DimGray,
            Text = "observe = read only   |   edit = file changes, no commands   |   develop = file changes + safe commands\n" +
                   "full_control = full commands inside this root. Deny globs always win (separate patterns with semicolons)."
        };
        Controls.Add(help);

        ConfigureRootsGrid();
        Controls.Add(_roots);

        var addRoot = new Button { Text = "+ Add path", Left = 16, Top = 500, Width = 120 };
        addRoot.Click += (_, _) => AddRoot();
        Controls.Add(addRoot);
        var changeRoot = new Button { Text = "Change path", Left = 144, Top = 500, Width = 130 };
        changeRoot.Click += (_, _) => ChangeSelectedRoot();
        Controls.Add(changeRoot);
        var removeRoot = new Button { Text = "Remove path", Left = 282, Top = 500, Width = 130 };
        removeRoot.Click += (_, _) => RemoveSelectedRoots();
        Controls.Add(removeRoot);

        _summary.Left = 16;
        _summary.Top = 540;
        _summary.Width = 650;
        _summary.Height = 50;
        _summary.ForeColor = System.Drawing.Color.SteelBlue;
        Controls.Add(_summary);

        var cancel = new Button { Text = "Cancel", Left = 688, Top = 548, Width = 120, Height = 36, DialogResult = DialogResult.Cancel };
        Controls.Add(cancel);
        var save = new Button { Text = "Save & use", Left = 818, Top = 548, Width = 132, Height = 36 };
        save.Click += (_, _) => SaveAndUse();
        Controls.Add(save);

        AcceptButton = save;
        CancelButton = cancel;
    }

    private void ConfigureRootsGrid()
    {
        _roots.Left = 16;
        _roots.Top = 178;
        _roots.Width = 934;
        _roots.Height = 310;
        _roots.AllowUserToAddRows = false;
        _roots.AllowUserToDeleteRows = true;
        _roots.AllowUserToResizeRows = false;
        _roots.MultiSelect = true;
        _roots.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        _roots.RowHeadersVisible = false;
        _roots.AutoGenerateColumns = false;
        _roots.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Label", Name = "label", Width = 165 });
        _roots.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Authorized path", Name = "path", Width = 390 });
        _roots.Columns.Add(new DataGridViewComboBoxColumn
        {
            HeaderText = "Rights",
            Name = "preset",
            Width = 130,
            DataSource = PermissionProfileStore.Presets.ToArray()
        });
        _roots.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Deny globs", Name = "deny", Width = 220 });
        _roots.RowsRemoved += (_, _) => UpdateSummary();
        _roots.RowsAdded += (_, _) => UpdateSummary();
    }

    private void BindProfiles(string preferred)
    {
        _binding = true;
        _profiles.Items.Clear();
        foreach (var name in _store.Profiles.Keys.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
            _profiles.Items.Add(name);
        _profiles.SelectedItem = _store.Profiles.ContainsKey(preferred) ? preferred : _store.ActiveProfile;
        if (_profiles.SelectedIndex < 0 && _profiles.Items.Count > 0) _profiles.SelectedIndex = 0;
        _binding = false;
        LoadSelectedProfile();
    }

    private void SwitchProfile()
    {
        if (_binding) return;
        SaveEditorToLoadedProfile();
        LoadSelectedProfile();
    }

    private void LoadSelectedProfile()
    {
        if (_profiles.SelectedItem is not string name || !_store.Profiles.TryGetValue(name, out var profile)) return;
        _loadedProfile = name;
        _workingDirectory.Text = profile.WorkingDirectory;
        _roots.Rows.Clear();
        foreach (var root in profile.Roots)
            _roots.Rows.Add(root.Label, root.Path, root.Preset, string.Join("; ", root.Deny));
        UpdateSummary();
    }

    private void SaveEditorToLoadedProfile()
    {
        if (string.IsNullOrWhiteSpace(_loadedProfile) || !_store.Profiles.TryGetValue(_loadedProfile, out var profile)) return;
        _roots.EndEdit();
        profile.WorkingDirectory = _workingDirectory.Text.Trim();
        profile.Roots = _roots.Rows.Cast<DataGridViewRow>().Select(row => new PermissionRoot
        {
            Label = Convert.ToString(row.Cells["label"].Value)?.Trim() ?? "",
            Path = Convert.ToString(row.Cells["path"].Value)?.Trim() ?? "",
            Preset = Convert.ToString(row.Cells["preset"].Value)?.Trim() ?? "develop",
            Deny = SplitDeny(Convert.ToString(row.Cells["deny"].Value))
        }).ToList();
    }

    private static List<string> SplitDeny(string? value) =>
        (value ?? "").Split([';', '\r', '\n'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Distinct(StringComparer.Ordinal)
            .ToList();

    private void AddProfile()
    {
        SaveEditorToLoadedProfile();
        var name = PromptForName();
        if (string.IsNullOrWhiteSpace(name)) return;
        name = name.Trim();
        if (_store.Profiles.ContainsKey(name))
        {
            MessageBox.Show(this, "That profile name already exists.", "Permission profiles", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var seed = Directory.Exists(_workingDirectory.Text) ? Path.GetFullPath(_workingDirectory.Text) : "";
        _store.Profiles[name] = new PermissionProfile
        {
            WorkingDirectory = seed,
            Roots = string.IsNullOrWhiteSpace(seed)
                ? []
                : [new PermissionRoot { Label = "Primary workspace", Path = seed, Preset = "develop" }]
        };
        BindProfiles(name);
    }

    private void DeleteProfile()
    {
        if (_profiles.SelectedItem is not string name) return;
        if (_store.Profiles.Count <= 1)
        {
            MessageBox.Show(this, "At least one profile is required.", "Permission profiles", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        if (MessageBox.Show(this, $"Delete profile '{name}'?", "Permission profiles",
                MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        _store.Profiles.Remove(name);
        _store.ActiveProfile = _store.Profiles.Keys.First();
        BindProfiles(_store.ActiveProfile);
    }

    private void AddRoot()
    {
        using var dialog = new FolderBrowserDialog { Description = "Choose a folder to authorize" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var path = Path.GetFullPath(dialog.SelectedPath);
        if (_roots.Rows.Cast<DataGridViewRow>().Any(row =>
                string.Equals(Convert.ToString(row.Cells["path"].Value), path, StringComparison.OrdinalIgnoreCase)))
            return;
        _roots.Rows.Add(new DirectoryInfo(path).Name, path, "develop", "");
        if (string.IsNullOrWhiteSpace(_workingDirectory.Text)) _workingDirectory.Text = path;
        UpdateSummary();
    }

    private void ChangeSelectedRoot()
    {
        if (_roots.CurrentRow is not DataGridViewRow row) return;
        using var dialog = new FolderBrowserDialog { Description = "Choose the replacement authorized folder" };
        var current = Convert.ToString(row.Cells["path"].Value);
        if (Directory.Exists(current)) dialog.SelectedPath = current;
        if (dialog.ShowDialog(this) == DialogResult.OK)
            row.Cells["path"].Value = Path.GetFullPath(dialog.SelectedPath);
    }

    private void RemoveSelectedRoots()
    {
        foreach (var row in _roots.SelectedRows.Cast<DataGridViewRow>().OrderByDescending(row => row.Index))
            _roots.Rows.RemoveAt(row.Index);
        UpdateSummary();
    }

    private void BrowseStore()
    {
        using var dialog = new OpenFileDialog
        {
            Filter = "Permission profiles (*.json)|*.json|All files (*.*)|*.*",
            CheckFileExists = false,
            FileName = _file.Text
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        SaveEditorToLoadedProfile();
        _file.Text = Path.GetFullPath(dialog.FileName);
        try
        {
            _store = File.Exists(_file.Text)
                ? PermissionProfileStore.Load(_file.Text)
                : PermissionProfileStore.Create(_config.Workspace, _config.PermissionProfileName);
            BindProfiles(_store.ActiveProfile);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Permission profiles", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void SaveAndUse()
    {
        try
        {
            SaveEditorToLoadedProfile();
            if (_profiles.SelectedItem is not string selected) throw new InvalidOperationException("Select a profile.");
            _store.ActiveProfile = selected;
            var path = Path.GetFullPath(_file.Text.Trim());
            _store.Save(path);
            var active = _store.GetProfile(selected);

            _config.PermissionProfileFile = path;
            _config.PermissionProfileName = selected;
            _config.Workspace = active.WorkingDirectory;
            _config.V5Preview = true;
            _config.Save();
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Cannot save permission profiles", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void UpdateSummary()
    {
        var rows = _roots.Rows.Cast<DataGridViewRow>().ToList();
        var writeRoots = rows.Count(row =>
            Convert.ToString(row.Cells["preset"].Value) is "edit" or "develop" or "full_control");
        var commandRoots = rows.Count(row =>
            Convert.ToString(row.Cells["preset"].Value) is "develop" or "full_control");
        _summary.Text = $"{rows.Count} authorized path(s) · {writeRoots} writable · {commandRoots} command-enabled\n" +
                        "The profile file stays local and is not packaged into the tray executable.";
    }

    private static void BrowseFolderInto(TextBox target)
    {
        using var dialog = new FolderBrowserDialog();
        if (Directory.Exists(target.Text)) dialog.SelectedPath = target.Text;
        if (dialog.ShowDialog() == DialogResult.OK) target.Text = Path.GetFullPath(dialog.SelectedPath);
    }

    private string? PromptForName()
    {
        using var prompt = new Form
        {
            Text = "New permission profile",
            Width = 430,
            Height = 160,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MinimizeBox = false,
            MaximizeBox = false,
            ShowInTaskbar = false
        };
        var input = new TextBox { Left = 18, Top = 20, Width = 380 };
        var ok = new Button { Text = "Create", Left = 218, Top = 60, Width = 86, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Cancel", Left = 312, Top = 60, Width = 86, DialogResult = DialogResult.Cancel };
        prompt.Controls.Add(input);
        prompt.Controls.Add(ok);
        prompt.Controls.Add(cancel);
        prompt.AcceptButton = ok;
        prompt.CancelButton = cancel;
        return prompt.ShowDialog(this) == DialogResult.OK ? input.Text : null;
    }
}
