#!/usr/bin/env pwsh
# GCClippy installer for Windows
# Usage: irm https://raw.githubusercontent.com/tionglee_microsoft/gcclippy/main/scripts/install.ps1 | iex
#   or:  .\scripts\install.ps1

$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:USERPROFILE ".gcclippy" "app"
$repoUrl = "https://github.com/tionglee_microsoft/gcclippy.git"

Write-Host "`n=== GCClippy Installer ===" -ForegroundColor Cyan

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
    git pull --ff-only
    Pop-Location
} else {
    Write-Host "Cloning gcclippy..." -ForegroundColor Yellow
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
Write-Host "Linking 'clippy' command globally..." -ForegroundColor Yellow
npm link --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: npm link failed" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# Verify
$clippyPath = (Get-Command clippy -ErrorAction SilentlyContinue).Source
if ($clippyPath) {
    Write-Host "`nInstalled successfully!" -ForegroundColor Green
    Write-Host "  Command: clippy" -ForegroundColor Gray
    Write-Host "  Location: $installDir" -ForegroundColor Gray
    Write-Host "`nRun 'clippy' to start." -ForegroundColor Cyan
} else {
    Write-Host "`nWarning: 'clippy' command not found in PATH." -ForegroundColor Yellow
    Write-Host "You may need to restart your terminal." -ForegroundColor Yellow
}
