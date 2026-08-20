# Local Coding Agent bootstrap for Windows.
# Checks prerequisites, clones the public repository, installs locked server
# dependencies, then opens the interactive safe setup.
$ErrorActionPreference = "Stop"

$Repository = "https://github.com/LongNgn204/local-coding-agent.git"
$DefaultDir = Join-Path $env:USERPROFILE "local-coding-agent"
$InstallDir = if ($env:LCA_INSTALL_DIR) { $env:LCA_INSTALL_DIR } else { $DefaultDir }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required: https://git-scm.com/download/win"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 18 or newer is required: https://nodejs.org"
}
$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 18) {
    throw "Node.js 18 or newer is required. Current version: $(node -v)"
}

if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Host "Cloning Local Coding Agent to $InstallDir" -ForegroundColor Cyan
    git clone --depth 1 $Repository $InstallDir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
} elseif (-not (Test-Path -LiteralPath (Join-Path $InstallDir ".git"))) {
    throw "Install path already exists and is not a git clone: $InstallDir"
} else {
    Write-Host "Using existing clone at $InstallDir" -ForegroundColor Cyan
}

Push-Location $InstallDir
try {
    node scripts/local-coding-agent.mjs install
    if ($LASTEXITCODE -ne 0) { throw "dependency installation failed" }
    node scripts/local-coding-agent.mjs setup
    if ($LASTEXITCODE -ne 0) { throw "interactive setup failed" }
    Write-Host "Setup saved. Start with: scripts\lca.cmd start --background" -ForegroundColor Green
} finally {
    Pop-Location
}
