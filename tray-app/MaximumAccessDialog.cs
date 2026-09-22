// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace LocalCodingAgentTray;

public sealed class MaximumAccessDialog : Form
{
    public const string ConfirmationPhrase = "ENABLE FULL ACCESS";

    public MaximumAccessDialog(IEnumerable<string> roots, string workingDirectory)
    {
        Text = "Confirm maximum machine access";
        Width = 680;
        Height = 500;
        MinimumSize = new Size(620, 460);
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.Sizable;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        BackColor = UiTheme.Canvas;
        ForeColor = UiTheme.Text;
        Font = new Font("Segoe UI", 9.25f);

        var rootList = roots.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        BuildUi(rootList, workingDirectory);
    }

    private void BuildUi(IReadOnlyList<string> roots, string workingDirectory)
    {
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 6,
            Padding = new Padding(26, 22, 26, 20),
            BackColor = UiTheme.Canvas
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        layout.Controls.Add(new Label
        {
            Text = "Maximum access removes the normal safety boundary",
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 15f),
            ForeColor = UiTheme.Danger,
            Margin = new Padding(0, 0, 0, 10)
        }, 0, 0);

        layout.Controls.Add(new Label
        {
            Text = "This enables full command mode, bypasses local approval prompts, authorizes every ready drive root, and allows commands that are normally blocked as catastrophic. Commands run with your Windows account and may delete files, change the system, or damage disks.",
            AutoSize = true,
            MaximumSize = new Size(600, 0),
            ForeColor = UiTheme.Text,
            Margin = new Padding(0, 0, 0, 14)
        }, 0, 1);

        var rootsBox = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = UiTheme.Surface,
            ForeColor = UiTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Cascadia Mono", 9f),
            Text = "Working directory:" + Environment.NewLine + workingDirectory + Environment.NewLine + Environment.NewLine
                 + "Authorized drive roots:" + Environment.NewLine + string.Join(Environment.NewLine, roots),
            Margin = new Padding(0, 0, 0, 14)
        };
        layout.Controls.Add(rootsBox, 0, 2);

        layout.Controls.Add(new Label
        {
            Text = $"Type {ConfirmationPhrase} to continue:",
            AutoSize = true,
            Font = new Font("Segoe UI Semibold", 9.25f),
            Margin = new Padding(0, 0, 0, 5)
        }, 0, 3);

        var input = new TextBox
        {
            Dock = DockStyle.Top,
            Height = 36,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 10f),
            CharacterCasing = CharacterCasing.Upper,
            Margin = new Padding(0, 0, 0, 16)
        };
        layout.Controls.Add(input, 0, 4);

        var actions = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Margin = Padding.Empty
        };
        var confirm = UiTheme.Button("Enable maximum access", ButtonKind.Danger, 188);
        confirm.BackColor = UiTheme.Danger;
        confirm.ForeColor = Color.White;
        confirm.FlatAppearance.BorderColor = UiTheme.Danger;
        confirm.Enabled = false;
        confirm.DialogResult = DialogResult.OK;
        var cancel = UiTheme.Button("Cancel", ButtonKind.Secondary, 104);
        cancel.DialogResult = DialogResult.Cancel;
        actions.Controls.Add(confirm);
        actions.Controls.Add(cancel);
        layout.Controls.Add(actions, 0, 5);

        input.TextChanged += (_, _) =>
            confirm.Enabled = input.Text.Trim().Equals(ConfirmationPhrase, StringComparison.Ordinal);

        Controls.Add(layout);
        AcceptButton = confirm;
        CancelButton = cancel;
    }
}
