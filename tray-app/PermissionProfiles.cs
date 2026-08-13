// Local Coding Agent
// Copyright (c) 2026 Long Nguyen
// SPDX-License-Identifier: AGPL-3.0-or-later

using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LocalCodingAgentTray;

public sealed class PermissionProfileStore
{
    public static readonly string[] Presets = ["observe", "edit", "develop", "full_control"];

    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("active_profile")]
    public string ActiveProfile { get; set; } = "default";

    [JsonPropertyName("profiles")]
    public Dictionary<string, PermissionProfile> Profiles { get; set; } =
        new(StringComparer.OrdinalIgnoreCase);

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; set; }

    public static PermissionProfileStore Load(string file)
    {
        if (string.IsNullOrWhiteSpace(file))
            throw new InvalidOperationException("Permission profile file is empty.");
        if (!File.Exists(file))
            throw new FileNotFoundException("Permission profile file was not found.", file);

        var json = File.ReadAllText(file, Encoding.UTF8);
        var value = JsonSerializer.Deserialize<PermissionProfileStore>(json, JsonOptions())
            ?? throw new InvalidOperationException("Permission profile file is empty or invalid.");
        value.Profiles = new Dictionary<string, PermissionProfile>(
            value.Profiles ?? new Dictionary<string, PermissionProfile>(),
            StringComparer.OrdinalIgnoreCase);
        return value;
    }

    public static PermissionProfileStore Create(string? workspace, string? requestedName)
    {
        var name = NormalizeProfileName(requestedName);
        var store = new PermissionProfileStore { ActiveProfile = name };
        var fullWorkspace = string.IsNullOrWhiteSpace(workspace) ? "" : Path.GetFullPath(workspace);
        store.Profiles[name] = new PermissionProfile
        {
            Description = "Public preview multi-root profile",
            WorkingDirectory = fullWorkspace,
            Roots = string.IsNullOrWhiteSpace(fullWorkspace)
                ? []
                :
                [
                    new PermissionRoot
                    {
                        Label = "Primary workspace",
                        Path = fullWorkspace,
                        Preset = "develop"
                    }
                ]
        };
        return store;
    }

    public PermissionProfile GetProfile(string? requestedName)
    {
        var name = string.IsNullOrWhiteSpace(requestedName) ? ActiveProfile : requestedName.Trim();
        if (!Profiles.TryGetValue(name, out var profile))
            throw new InvalidOperationException($"Permission profile does not exist: {name}");
        return profile;
    }

    public void Save(string file)
    {
        Validate(file);
        var absolute = Path.GetFullPath(file);
        var directory = Path.GetDirectoryName(absolute)
            ?? throw new InvalidOperationException("Permission profile file needs a parent directory.");
        Directory.CreateDirectory(directory);

        var temp = Path.Combine(directory, $".{Path.GetFileName(absolute)}.{Guid.NewGuid():N}.tmp");
        try
        {
            var json = JsonSerializer.Serialize(this, JsonOptions(writeIndented: true));
            File.WriteAllText(temp, json + Environment.NewLine, new UTF8Encoding(false));
            File.Move(temp, absolute, true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    public void Validate(string file)
    {
        if (Profiles.Count == 0)
            throw new InvalidOperationException("Create at least one permission profile.");
        if (!Profiles.ContainsKey(ActiveProfile))
            throw new InvalidOperationException($"Active permission profile does not exist: {ActiveProfile}");

        var storePath = Path.GetFullPath(file);
        foreach (var (name, profile) in Profiles)
        {
            if (string.IsNullOrWhiteSpace(name))
                throw new InvalidOperationException("Permission profile names cannot be empty.");
            if (string.IsNullOrWhiteSpace(profile.WorkingDirectory))
                throw new InvalidOperationException($"Profile '{name}' needs a working directory.");
            if (!Directory.Exists(profile.WorkingDirectory))
                throw new DirectoryNotFoundException($"Working directory does not exist for profile '{name}': {profile.WorkingDirectory}");
            if (profile.Roots.Count == 0)
                throw new InvalidOperationException($"Profile '{name}' needs at least one authorized root.");

            profile.WorkingDirectory = Path.GetFullPath(profile.WorkingDirectory);
            var uniqueRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var root in profile.Roots)
            {
                if (string.IsNullOrWhiteSpace(root.Path))
                    throw new InvalidOperationException($"Profile '{name}' contains a root with no path.");
                root.Path = Path.GetFullPath(root.Path);
                if (!Directory.Exists(root.Path))
                    throw new DirectoryNotFoundException($"Authorized root does not exist: {root.Path}");
                if (!uniqueRoots.Add(root.Path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)))
                    throw new InvalidOperationException($"Profile '{name}' contains the same authorized root more than once: {root.Path}");
                if (!Presets.Contains(root.Preset, StringComparer.Ordinal))
                    throw new InvalidOperationException($"Unknown preset '{root.Preset}' for root: {root.Path}");
                if (PathInside(storePath, root.Path))
                    throw new InvalidOperationException(
                        $"The permission profile store must stay outside every authorized root: {storePath}");
            }

            if (!profile.Roots.Any(root => PathInside(profile.WorkingDirectory, root.Path)))
                throw new InvalidOperationException(
                    $"Working directory for profile '{name}' must be inside one of its authorized roots.");
        }
    }

    public static bool PathInside(string candidate, string root)
    {
        var fullCandidate = Path.GetFullPath(candidate)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var fullRoot = Path.GetFullPath(root)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(fullCandidate, fullRoot, StringComparison.OrdinalIgnoreCase)) return true;
        return fullCandidate.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || fullCandidate.StartsWith(fullRoot + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeProfileName(string? requestedName) =>
        string.IsNullOrWhiteSpace(requestedName) ? "default" : requestedName.Trim();

    private static JsonSerializerOptions JsonOptions(bool writeIndented = false) => new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = writeIndented,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}

public sealed class PermissionProfile
{
    [JsonPropertyName("description")]
    public string Description { get; set; } = "Public preview multi-root profile";

    [JsonPropertyName("working_directory")]
    public string WorkingDirectory { get; set; } = "";

    [JsonPropertyName("roots")]
    public List<PermissionRoot> Roots { get; set; } = [];

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; set; }
}

public sealed class PermissionRoot
{
    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("path")]
    public string Path { get; set; } = "";

    [JsonPropertyName("preset")]
    public string Preset { get; set; } = "develop";

    [JsonPropertyName("deny")]
    public List<string> Deny { get; set; } = [];

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; set; }
}
