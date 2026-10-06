// SPDX-License-Identifier: AGPL-3.0-or-later
namespace LocalCodingAgentTray;

public static class AppVersion
{
    public static string Current =>
        typeof(AppVersion).Assembly.GetName().Version?.ToString(3) ?? "unknown";
}
