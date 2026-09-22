// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Drawing.Drawing2D;

namespace LocalCodingAgentTray;

internal enum ButtonKind
{
    Primary,
    Secondary,
    Danger,
    Ghost
}

internal static class UiTheme
{
    public static readonly Color Canvas = Color.FromArgb(244, 247, 251);
    public static readonly Color Surface = Color.White;
    public static readonly Color Border = Color.FromArgb(220, 226, 235);
    public static readonly Color Text = Color.FromArgb(27, 35, 50);
    public static readonly Color Muted = Color.FromArgb(99, 110, 128);
    public static readonly Color Primary = Color.FromArgb(37, 99, 235);
    public static readonly Color PrimaryHover = Color.FromArgb(29, 78, 216);
    public static readonly Color SoftBlue = Color.FromArgb(238, 244, 255);
    public static readonly Color Danger = Color.FromArgb(190, 45, 52);
    public static readonly Color DangerHover = Color.FromArgb(160, 35, 42);
    public static readonly Color LogBackground = Color.FromArgb(18, 24, 38);

    public static Button Button(string text, ButtonKind kind = ButtonKind.Secondary, int width = 132)
    {
        var button = new Button
        {
            Text = text,
            Width = width,
            Height = 38,
            AutoSize = false,
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            Font = new Font("Segoe UI Semibold", 9.25f),
            Margin = new Padding(0, 0, 10, 0),
            UseVisualStyleBackColor = false
        };
        button.FlatAppearance.BorderSize = 1;

        switch (kind)
        {
            case ButtonKind.Primary:
                button.BackColor = Primary;
                button.ForeColor = Color.White;
                button.FlatAppearance.BorderColor = Primary;
                button.FlatAppearance.MouseOverBackColor = PrimaryHover;
                break;
            case ButtonKind.Danger:
                button.BackColor = Color.White;
                button.ForeColor = Danger;
                button.FlatAppearance.BorderColor = Color.FromArgb(232, 180, 183);
                button.FlatAppearance.MouseOverBackColor = Color.FromArgb(255, 242, 243);
                break;
            case ButtonKind.Ghost:
                button.BackColor = Surface;
                button.ForeColor = Primary;
                button.FlatAppearance.BorderColor = Surface;
                button.FlatAppearance.MouseOverBackColor = SoftBlue;
                break;
            default:
                button.BackColor = Surface;
                button.ForeColor = Text;
                button.FlatAppearance.BorderColor = Border;
                button.FlatAppearance.MouseOverBackColor = Color.FromArgb(247, 249, 252);
                break;
        }

        return button;
    }

    public static void StyleTextBox(TextBox textBox, bool secret = false)
    {
        textBox.AutoSize = false;
        textBox.Height = 36;
        textBox.BorderStyle = BorderStyle.FixedSingle;
        textBox.BackColor = Surface;
        textBox.ForeColor = Text;
        textBox.Font = new Font("Segoe UI", 9.5f);
        textBox.UseSystemPasswordChar = secret;
        textBox.Margin = new Padding(0, 4, 10, 5);
        textBox.Dock = DockStyle.Fill;
    }

    public static void StyleComboBox(ComboBox comboBox)
    {
        comboBox.FlatStyle = FlatStyle.Flat;
        comboBox.BackColor = Surface;
        comboBox.ForeColor = Text;
        comboBox.Font = new Font("Segoe UI", 9.5f);
        comboBox.Margin = new Padding(0, 4, 10, 5);
        comboBox.Dock = DockStyle.Fill;
    }

    public static void StyleNumeric(NumericUpDown numeric)
    {
        numeric.BorderStyle = BorderStyle.FixedSingle;
        numeric.BackColor = Surface;
        numeric.ForeColor = Text;
        numeric.Font = new Font("Segoe UI", 9.5f);
        numeric.Margin = new Padding(0, 4, 10, 5);
        numeric.Dock = DockStyle.Fill;
        numeric.Height = 36;
    }

    public static void StyleCheckBox(CheckBox checkBox, bool warning = false)
    {
        checkBox.AutoSize = true;
        checkBox.ForeColor = warning ? Color.FromArgb(170, 92, 12) : Text;
        checkBox.Font = new Font("Segoe UI", 9.25f);
        checkBox.Margin = new Padding(0, 8, 0, 8);
    }
}

internal sealed class ModernCard : Panel
{
    public ModernCard()
    {
        BackColor = UiTheme.Surface;
        Padding = new Padding(22);
        Margin = new Padding(0, 0, 0, 16);
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Dock = DockStyle.Top;
        SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(UiTheme.Border);
        var rect = ClientRectangle;
        rect.Width -= 1;
        rect.Height -= 1;
        e.Graphics.DrawRectangle(pen, rect);
    }
}

internal sealed class ModernTabControl : TabControl
{
    public ModernTabControl()
    {
        DrawMode = TabDrawMode.OwnerDrawFixed;
        SizeMode = TabSizeMode.Fixed;
        ItemSize = new Size(154, 42);
        Font = new Font("Segoe UI Semibold", 9.5f);
        Padding = new Point(18, 5);
        SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
    }

    protected override void OnDrawItem(DrawItemEventArgs e)
    {
        var selected = SelectedIndex == e.Index;
        var bounds = e.Bounds;
        using var background = new SolidBrush(selected ? UiTheme.Surface : UiTheme.Canvas);
        e.Graphics.FillRectangle(background, bounds);

        if (selected)
        {
            using var accent = new SolidBrush(UiTheme.Primary);
            e.Graphics.FillRectangle(accent, bounds.Left + 14, bounds.Bottom - 3, bounds.Width - 28, 3);
        }

        var color = selected ? UiTheme.Primary : UiTheme.Muted;
        TextRenderer.DrawText(
            e.Graphics,
            TabPages[e.Index].Text,
            Font,
            bounds,
            color,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}
