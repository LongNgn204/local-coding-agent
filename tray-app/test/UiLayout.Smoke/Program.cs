// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using LocalCodingAgentTray;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        ApplicationConfiguration.Initialize();
        using var form = new MainForm
        {
            ShowInTaskbar = false,
            Opacity = 0
        };

        form.Show();
        Application.DoEvents();
        form.PerformLayout();

        Assert(form.FormBorderStyle == FormBorderStyle.Sizable, "main window must be resizable");
        Assert(form.MinimumSize.Width >= 900 && form.MinimumSize.Height >= 600,
            "main window minimum size is too small for the settings layout");

        var controls = Descendants(form).ToList();
        var tabs = controls.OfType<TabControl>().SingleOrDefault();
        Assert(tabs is not null, "main navigation tabs are missing");
        Assert(tabs!.TabPages.Count == 4, "main navigation must contain four pages");
        Assert(tabs.TabPages.Cast<TabPage>().Select(page => page.Text)
                .SequenceEqual(["Overview", "Setup", "Advanced", "Activity"]),
            "main navigation pages are out of order");

        var buttonTexts = controls.OfType<Button>().Select(button => button.Text).ToHashSet();
        foreach (var required in new[]
                 {
                     "Start agent", "Stop", "Reconnect tunnel", "Open dashboard",
                     "Enable maximum access", "Restore safe defaults"
                 })
            Assert(buttonTexts.Contains(required), $"required action button is missing: {required}");

        var labels = controls.OfType<Label>().Select(label => label.Text).ToHashSet();
        Assert(labels.Contains("Dashboard port"), "dashboard port setting is missing");
        Assert(controls.OfType<TextBox>().Any(textBox => textBox.UseSystemPasswordChar),
            "secret fields must be masked by default");
        Assert(tabs.Width > 700 && tabs.Height > 480, "tab content area did not receive the main layout space");

        var systemRoot = Path.GetPathRoot(Environment.SystemDirectory)
            ?? throw new InvalidOperationException("Windows system root is unavailable");
        using var confirmation = new MaximumAccessDialog([systemRoot], systemRoot)
        {
            ShowInTaskbar = false,
            Opacity = 0
        };
        confirmation.Show();
        Application.DoEvents();
        var confirmationControls = Descendants(confirmation).ToList();
        var confirmationInput = confirmationControls.OfType<TextBox>().Single(textBox => !textBox.ReadOnly);
        var confirmButton = confirmationControls.OfType<Button>()
            .Single(button => button.Text == "Enable maximum access");
        Assert(!confirmButton.Enabled, "maximum access confirmation must start disabled");
        confirmationInput.Text = MaximumAccessDialog.ConfirmationPhrase;
        Application.DoEvents();
        Assert(confirmButton.Enabled, "typed confirmation phrase must enable maximum access");
        confirmation.Hide();

        form.Hide();
        Console.WriteLine("PASS modern WinForms layout smoke test");
        return 0;
    }

    private static IEnumerable<Control> Descendants(Control root)
    {
        foreach (Control child in root.Controls)
        {
            yield return child;
            foreach (var nested in Descendants(child)) yield return nested;
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
