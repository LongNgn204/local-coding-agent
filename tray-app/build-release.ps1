# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later

$ErrorActionPreference = "Stop"

# Official release packaging. Output stays ignored by Git and is intended for
# a GitHub Release asset after tests and secret checks pass.
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectFile = Join-Path $ProjectDir "LocalCodingAgentTray.csproj"
$ReleaseVersion = "5.0.0"
$ArtifactBaseName = "LocalCodingAgentTray-$ReleaseVersion-win-x64"
$OutputDir = Join-Path $ProjectDir "publish\$ReleaseVersion"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "The .NET 10 SDK is required to build the tray release."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "Publishing official tray release (win-x64, self-contained, single file)..."
dotnet publish $ProjectFile `
    -c Release `
    -r win-x64 `
    --self-contained true `
    /p:AssemblyName=$ArtifactBaseName `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:EnableCompressionInSingleFile=true `
    /p:DebugType=None `
    /p:DebugSymbols=false `
    -o $OutputDir
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$Executable = Join-Path $OutputDir ($ArtifactBaseName + ".exe")
if (-not (Test-Path -LiteralPath $Executable)) {
    throw "Expected tray executable was not created: $Executable"
}

$Hash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
$Manifest = [ordered]@{
    product = "Local Coding Agent Tray"
    version = $ReleaseVersion
    channel = "stable"
    runtime = "win-x64"
    self_contained = $true
    executable = [System.IO.Path]::GetFileName($Executable)
    sha256 = $Hash
    built_at_utc = [DateTime]::UtcNow.ToString("o")
}
$ManifestPath = Join-Path $OutputDir "build-manifest.json"
[System.IO.File]::WriteAllText(
    $ManifestPath,
    (($Manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Official tray release created:"
Write-Host $Executable
Write-Host ("SHA256: " + $Hash)
