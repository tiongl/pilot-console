#!/usr/bin/env pwsh
# Pilot Console installer for Windows
# Usage: .\scripts\install.ps1  (from a local clone)
#   or:  pwsh -File path\to\install.ps1

$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:USERPROFILE ".pilot-console" "app"
$repoUrl = "https://github.com/tiongl/clippy.git"

Write-Host "`n=== Pilot Console Installer ===" -ForegroundColor Cyan

# Check prerequisites
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Error: git is required. Install it from https://git-scm.com" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Node.js is required. Install it from https://nodejs.org" -ForegroundColor Red
    exit 1
}

$nodeVersion = (node -v) -replace '^v',''
Write-Host "Using Node.js $nodeVersion" -ForegroundColor Gray

# Clone or update
if (Test-Path $installDir) {
    Write-Host "Updating existing installation..." -ForegroundColor Yellow
    Push-Location $installDir
    # Remove stale global link before updating
    npm unlink -g pilot-console 2>$null
    git pull --ff-only
    Pop-Location
} else {
    Write-Host "Cloning pilot-console..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path (Split-Path $installDir) | Out-Null
    git clone $repoUrl $installDir
}

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
Push-Location $installDir
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: npm install failed" -ForegroundColor Red
    Pop-Location
    exit 1
}

# Create global bin link
Write-Host "Linking 'pilot-console' command globally..." -ForegroundColor Yellow
npm link --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: npm link failed" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# Verify
$pilot-consolePath = (Get-Command pilot-console -ErrorAction SilentlyContinue).Source
if ($pilot-consolePath) {
    Write-Host "`nInstalled successfully!" -ForegroundColor Green
    Write-Host "  Command: pilot-console" -ForegroundColor Gray
    Write-Host "  Location: $installDir" -ForegroundColor Gray
    Write-Host "`nRun 'pilot-console' to start." -ForegroundColor Cyan
} else {
    Write-Host "`nWarning: 'pilot-console' command not found in PATH." -ForegroundColor Yellow
    Write-Host "You may need to restart your terminal." -ForegroundColor Yellow
}
