# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later

$ErrorActionPreference = "Stop"

# Public preview packaging. Output stays ignored by Git and is intended for a
# GitHub Release asset after tests and secret checks pass.
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectFile = Join-Path $ProjectDir "LocalCodingAgentTray.csproj"
$PreviewVersion = "5.0.0-preview.12"
$ArtifactBaseName = "LocalCodingAgentTray-$PreviewVersion-win-x64"
$OutputDir = Join-Path $ProjectDir "publish\$PreviewVersion-public"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "The .NET 10 SDK is required to build the tray preview."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "Publishing public tray preview (win-x64, self-contained, single file)..."
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
    product = "Local Coding Agent Preview Tray"
    version = $PreviewVersion
    channel = "public-preview"
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

Write-Host "Public tray preview created:"
Write-Host $Executable
Write-Host ("SHA256: " + $Hash)
