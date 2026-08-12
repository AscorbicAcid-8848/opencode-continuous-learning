param(
    [string]$ConfigRoot = (Join-Path $env:USERPROFILE '.config\opencode')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedProjectRoot = (Resolve-Path -LiteralPath $projectRoot).Path
$resolvedConfigRoot = [System.IO.Path]::GetFullPath($ConfigRoot)

if (-not $resolvedConfigRoot.EndsWith([System.IO.Path]::Combine('.config', 'opencode'))) {
    throw "Refusing to install outside an OpenCode config directory: $resolvedConfigRoot"
}

$pluginDirectory = Join-Path $resolvedConfigRoot 'plugins'
$moduleDirectory = Join-Path $resolvedConfigRoot 'continuous-learning-plugin'
$commandDirectory = Join-Path $resolvedConfigRoot 'commands'
$settingsDirectory = Join-Path $resolvedConfigRoot 'continuous-learning'
$backupDirectory = Join-Path $settingsDirectory ('install-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

New-Item -ItemType Directory -Force -Path $pluginDirectory, $moduleDirectory, $commandDirectory, $settingsDirectory | Out-Null

$copies = @(
    @((Join-Path $resolvedProjectRoot 'install\continuous-learning.ts'), (Join-Path $pluginDirectory 'continuous-learning.ts')),
    @((Join-Path $resolvedProjectRoot 'src\plugin.ts'), (Join-Path $moduleDirectory 'plugin.ts')),
    @((Join-Path $resolvedProjectRoot 'src\core.ts'), (Join-Path $moduleDirectory 'core.ts')),
    @((Join-Path $resolvedProjectRoot 'src\tui.ts'), (Join-Path $moduleDirectory 'tui.ts')),
    @((Join-Path $resolvedProjectRoot 'install\plugin-package.json'), (Join-Path $moduleDirectory 'package.json')),
    @((Join-Path $resolvedProjectRoot 'commands\learn.md'), (Join-Path $commandDirectory 'learn.md')),
    @((Join-Path $resolvedProjectRoot 'commands\learn-review.md'), (Join-Path $commandDirectory 'learn-review.md')),
    @((Join-Path $resolvedProjectRoot 'docs\用户手册.md'), (Join-Path $settingsDirectory '用户手册.md'))
)

foreach ($copy in $copies) {
    $source = $copy[0]
    $destination = $copy[1]
    if (Test-Path -LiteralPath $destination) {
        $relative = [System.IO.Path]::GetRelativePath($resolvedConfigRoot, $destination)
        $backup = Join-Path $backupDirectory $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

$legacyModeCommand = Join-Path $commandDirectory 'learning-mode.md'
if (Test-Path -LiteralPath $legacyModeCommand) {
    $legacyRelative = [System.IO.Path]::GetRelativePath($resolvedConfigRoot, $legacyModeCommand)
    $legacyBackup = Join-Path $backupDirectory $legacyRelative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $legacyBackup) | Out-Null
    Copy-Item -LiteralPath $legacyModeCommand -Destination $legacyBackup -Force
    Remove-Item -LiteralPath $legacyModeCommand -Force
}

$settingsPath = Join-Path $settingsDirectory 'config.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
    Copy-Item -LiteralPath (Join-Path $resolvedProjectRoot 'config\default.json') -Destination $settingsPath
}

$pluginDependency = Join-Path $resolvedConfigRoot 'node_modules\@opencode-ai\plugin\package.json'
if (-not (Test-Path -LiteralPath $pluginDependency)) {
    Write-Warning '@opencode-ai/plugin is not installed under the OpenCode config directory.'
}

$opencodeCommand = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $opencodeCommand) {
    throw 'OpenCode executable was not found; unable to register the TUI settings panel.'
}

foreach ($tuiConfigName in @('tui.json', 'tui.jsonc')) {
    $tuiConfigPath = Join-Path $resolvedConfigRoot $tuiConfigName
    if (Test-Path -LiteralPath $tuiConfigPath) {
        $tuiConfigBackup = Join-Path $backupDirectory $tuiConfigName
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $tuiConfigBackup) | Out-Null
        Copy-Item -LiteralPath $tuiConfigPath -Destination $tuiConfigBackup -Force
    }
}

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

Write-Output "Installed plugin entry: $(Join-Path $pluginDirectory 'continuous-learning.ts')"
Write-Output 'Installed settings panel: /learning-settings (also available in the command palette)'
Write-Output "Installed commands: $(Join-Path $commandDirectory 'learn.md'), $(Join-Path $commandDirectory 'learn-review.md')"
Write-Output "Settings: $settingsPath"
Write-Output "User manual: $(Join-Path $settingsDirectory '用户手册.md')"
Write-Output 'Restart OpenCode before using /learning-settings, /learn, or /learn-review.'
