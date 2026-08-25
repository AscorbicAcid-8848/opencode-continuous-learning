#
# opencode-continuous-learning — installer (Windows PowerShell)
#
# This script is self-contained: it generates the plugin entry point and
# package.json at install time, copies src/ as a unit, installs runtime
# dependencies, and registers the TUI settings panel. No separate template
# files are needed.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 [-ConfigRoot <path>]
#
# ConfigRoot defaults to $env:USERPROFILE\.config\opencode
#

param(
    [string]$ConfigRoot = (Join-Path $env:USERPROFILE '.config\opencode')
)

$ErrorActionPreference = 'Stop'

$pluginId = 'continuous-learning'

# ── resolve paths ──────────────────────────────────────────────────────

$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedProjectRoot = (Resolve-Path -LiteralPath $projectRoot).Path
$resolvedConfigRoot = [System.IO.Path]::GetFullPath($ConfigRoot)

# safety: refuse to install outside an "opencode" config directory
$expectedSuffix = [System.IO.Path]::Combine('.config', 'opencode')
if (-not $resolvedConfigRoot.EndsWith($expectedSuffix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to install outside an OpenCode config directory: $resolvedConfigRoot"
}

$pluginDirectory    = Join-Path $resolvedConfigRoot 'plugins'
$moduleDirectory    = Join-Path $resolvedConfigRoot "$pluginId-plugin"
$commandDirectory   = Join-Path $resolvedConfigRoot 'commands'
$settingsDirectory  = Join-Path $resolvedConfigRoot $pluginId
$dataDirectory      = Join-Path $env:LOCALAPPDATA "opencode\$pluginId"
if (-not $dataDirectory) {
    $dataDirectory = Join-Path $env:USERPROFILE ".local\share\opencode\$pluginId"
}
$backupDirectory    = Join-Path $settingsDirectory ('install-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

# ── helpers ────────────────────────────────────────────────────────────

function Log([string]$Message) { Write-Output $Message }
function Warn([string]$Message) { Write-Warning $Message }
function Fail([string]$Message) { throw $Message }

function Get-RelativePath([string]$Base, [string]$Full) {
    if ($Full.StartsWith($Base, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Full.Substring($Base.Length).TrimStart('\', '/')
    }
    return (Split-Path -Leaf $Full)
}

function Backup-Existing([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $relative = Get-RelativePath $resolvedConfigRoot $Path
        $backup = Join-Path $backupDirectory $relative
        $backupParent = Split-Path -Parent $backup
        if (-not (Test-Path -LiteralPath $backupParent)) {
            New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
        }
        Copy-Item -LiteralPath $Path -Destination $backup -Recurse -Force
    }
}

function Copy-File([string]$Source, [string]$Destination) {
    Backup-Existing $Destination
    $destParent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $destParent)) {
        New-Item -ItemType Directory -Force -Path $destParent | Out-Null
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-Dir([string]$Source, [string]$Destination) {
    Backup-Existing $Destination
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -LiteralPath "$Source\*" -Destination $Destination -Recurse -Force
}

function Remove-Legacy([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $relative = Get-RelativePath $resolvedConfigRoot $Path
        $backup = Join-Path $backupDirectory $relative
        $backupParent = Split-Path -Parent $backup
        if (-not (Test-Path -LiteralPath $backupParent)) {
            New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
        }
        Copy-Item -LiteralPath $Path -Destination $backup -Recurse -Force
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

# ── pre-flight checks ─────────────────────────────────────────────────

$srcDirectory = Join-Path $resolvedProjectRoot 'src'
if (-not (Test-Path -LiteralPath $srcDirectory)) {
    Fail "Source directory not found: $srcDirectory"
}

foreach ($f in @('plugin.ts', 'tui.ts', 'shared.ts', 'config.ts', 'store.ts')) {
    $srcFile = Join-Path $srcDirectory $f
    if (-not (Test-Path -LiteralPath $srcFile)) {
        Fail "Missing required source file: src/$f"
    }
}

# ── create directories ────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $pluginDirectory, $moduleDirectory, $commandDirectory, $settingsDirectory, $dataDirectory | Out-Null

# ── copy runtime source ───────────────────────────────────────────────

Log "Copying source files to $moduleDirectory ..."
$destSrc = Join-Path $moduleDirectory 'src'
Copy-Dir $srcDirectory $destSrc

# ── generate plugin entry point ───────────────────────────────────────
#
# The entry lives in plugins/ (auto-scanned by OpenCode). It imports the
# server plugin from the sibling runtime directory and re-exports it.

$entryFile = Join-Path $pluginDirectory "$pluginId.ts"
Log "Generating plugin entry: $entryFile"
$entryContent = @"
// Auto-generated by scripts/install.ps1 -- do not edit manually.
// This file lives in <config>/plugins/ so OpenCode auto-discovers it.
// The runtime source is in the sibling <config>/continuous-learning-plugin/src/.
import plugin from "../continuous-learning-plugin/src/plugin.ts";
export default plugin;
"@
$utf8NoBom = (New-Object System.Text.UTF8Encoding $false)
[System.IO.File]::WriteAllText($entryFile, $entryContent, $utf8NoBom)

# ── generate package.json ─────────────────────────────────────────────

$pkgFile = Join-Path $moduleDirectory 'package.json'
Log "Generating package.json: $pkgFile"
$pkgContent = @"
{
  "name": "opencode-continuous-learning-local",
  "version": "0.5.0",
  "private": true,
  "type": "module",
  "engines": {
    "opencode": ">=1.18.15"
  },
  "dependencies": {
    "@honcho-ai/sdk": "2.2.0"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "1.18.15"
  },
  "peerDependenciesMeta": {
    "@opencode-ai/plugin": {
      "optional": false
    }
  },
  "exports": {
    ".": "./src/plugin.ts",
    "./tui": "./src/tui.ts"
  }
}
"@
[System.IO.File]::WriteAllText($pkgFile, $pkgContent, $utf8NoBom)

# ── copy commands ─────────────────────────────────────────────────────

Log "Installing slash commands ..."
Copy-File (Join-Path $resolvedProjectRoot 'commands\learn.md') (Join-Path $commandDirectory 'learn.md')
Copy-File (Join-Path $resolvedProjectRoot 'commands\learn-review.md') (Join-Path $commandDirectory 'learn-review.md')
Remove-Legacy (Join-Path $commandDirectory 'learning-mode.md')

# ── copy user manual ──────────────────────────────────────────────────

Copy-File (Join-Path $resolvedProjectRoot 'docs\用户手册.md') (Join-Path $settingsDirectory '用户手册.md')

# ── create default config (first install only) ────────────────────────

$settingsPath = Join-Path $settingsDirectory 'config.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
    Log "Creating default config: $settingsPath"
    Copy-Item -LiteralPath (Join-Path $resolvedProjectRoot 'config\default.json') -Destination $settingsPath
} else {
    Log "Config already exists, preserving: $settingsPath"
}

# ── check OpenCode plugin SDK ─────────────────────────────────────────

$pluginDependency = Join-Path $resolvedConfigRoot 'node_modules\@opencode-ai\plugin\package.json'
if (-not (Test-Path -LiteralPath $pluginDependency)) {
    Warn "@opencode-ai/plugin is not installed under $resolvedConfigRoot."
    Warn "The plugin will fail to load until OpenCode's own dependencies are present."
}

# ── install runtime dependencies ──────────────────────────────────────

Log "Installing runtime dependencies in $moduleDirectory ..."
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
Push-Location $moduleDirectory
try {
    if ($bunCommand) {
        & $bunCommand.Source install --production --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw "bun install failed with exit code $LASTEXITCODE." }
    }
    elseif ($npmCommand) {
        & $npmCommand.Source install --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
    }
    else {
        Warn 'bun/npm was not found; Honcho provider support was not installed.'
    }
}
finally {
    Pop-Location
}

# ── register TUI settings panel ───────────────────────────────────────

$opencodeCommand = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $opencodeCommand) {
    Fail "OpenCode executable was not found; unable to register the TUI settings panel. Install OpenCode first, then re-run this script."
}

# back up existing TUI configs before registration modifies them
foreach ($tuiConfigName in @('tui.json', 'tui.jsonc')) {
    $tuiConfigPath = Join-Path $resolvedConfigRoot $tuiConfigName
    if (Test-Path -LiteralPath $tuiConfigPath) {
        $tuiBackup = Join-Path $backupDirectory $tuiConfigName
        $tuiBackupParent = Split-Path -Parent $tuiBackup
        if (-not (Test-Path -LiteralPath $tuiBackupParent)) {
            New-Item -ItemType Directory -Force -Path $tuiBackupParent | Out-Null
        }
        Copy-Item -LiteralPath $tuiConfigPath -Destination $tuiBackup -Force
    }
}

Log "Registering TUI settings panel ..."
$previousXdgConfigHome = $env:XDG_CONFIG_HOME
try {
    $env:XDG_CONFIG_HOME = Split-Path -Parent $resolvedConfigRoot
    & $opencodeCommand.Source plugin $moduleDirectory --global --force
    if ($LASTEXITCODE -ne 0) {
        throw "OpenCode failed to register the TUI settings panel (exit code $LASTEXITCODE)."
    }
}
finally {
    $env:XDG_CONFIG_HOME = $previousXdgConfigHome
}

# ── summary ───────────────────────────────────────────────────────────

Log ''
Log '=== Installation complete ==='
Log "Plugin entry:  $entryFile"
Log "Runtime:       $destSrc"
Log "Commands:      $(Join-Path $commandDirectory 'learn.md'), $(Join-Path $commandDirectory 'learn-review.md')"
Log "Config:        $settingsPath"
Log "Data:          $dataDirectory"
Log "User manual:   $(Join-Path $settingsDirectory '用户手册.md')"
Log "Backups:       $backupDirectory"
Log ''
Log 'Restart OpenCode before using /learning-settings, /learning-pending,'
Log '/learning-journey, /learn, or /learn-review.'
