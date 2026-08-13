using LocalCodingAgentTray;

var scratch = Path.Combine(Path.GetTempPath(), "lca-tray-permissions-smoke-" + Guid.NewGuid().ToString("N"));
var rootsParent = Path.Combine(scratch, "authorized");
var primary = Path.Combine(rootsParent, "primary");
var docs = Path.Combine(rootsParent, "docs");
var operatorState = Path.Combine(scratch, "operator-state");
var storeFile = Path.Combine(operatorState, "permission-profiles.json");

try
{
    Directory.CreateDirectory(primary);
    Directory.CreateDirectory(docs);
    Directory.CreateDirectory(operatorState);

    var store = PermissionProfileStore.Create(primary, "private-dev");
    store.Profiles["private-dev"].Roots.Add(new PermissionRoot
    {
        Label = "Reference docs",
        Path = docs,
        Preset = "observe",
        Deny = ["**/.env", "**/secrets/**"]
    });
    store.Save(storeFile);

    var loaded = PermissionProfileStore.Load(storeFile);
    loaded.Validate(storeFile);
    var profile = loaded.GetProfile("private-dev");
    Assert(profile.Roots.Count == 2, "expected two roots");
    Assert(profile.Roots[1].Preset == "observe", "preset was not preserved");
    Assert(profile.Roots[1].Deny.SequenceEqual(["**/.env", "**/secrets/**"]), "deny globs were not preserved");
    Assert(PermissionProfileStore.PathInside(Path.Combine(primary, "src"), primary), "child path should be inside root");
    Assert(!PermissionProfileStore.PathInside(primary + "-sibling", primary), "sibling-prefix path must stay outside root");

    profile.Roots.Add(new PermissionRoot { Label = "Duplicate", Path = primary, Preset = "develop" });
    var rejectedDuplicate = false;
    try
    {
        loaded.Validate(storeFile);
    }
    catch (InvalidOperationException)
    {
        rejectedDuplicate = true;
    }
    Assert(rejectedDuplicate, "duplicate roots must be rejected");
    profile.Roots.RemoveAt(profile.Roots.Count - 1);

    var rejectedInsideRoot = false;
    try
    {
        loaded.Validate(Path.Combine(primary, "permission-profiles.json"));
    }
    catch (InvalidOperationException)
    {
        rejectedInsideRoot = true;
    }
    Assert(rejectedInsideRoot, "profile store inside an authorized root must be rejected");

    Console.WriteLine("PASS permission profile store smoke test");
}
finally
{
    if (Directory.Exists(scratch)) Directory.Delete(scratch, recursive: true);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
