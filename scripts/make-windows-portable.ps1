param(
  [string]$SandboxHelperPath = "",
  [switch]$SkipInstall,
  [switch]$RequireHelper,
  [switch]$AllowNoHelper
)

$ErrorActionPreference = "Stop"

if (-not ($env:OS -eq "Windows_NT")) {
  throw "This script must be run on Windows."
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputRoot = Join-Path $RepoRoot "build/windows"

function Find-SandboxHelper {
  param(
    [string]$ExplicitPath,
    [string]$RepoRoot
  )

  $explicitOrEnv = $ExplicitPath
  if (-not $explicitOrEnv -and $env:GUARDIAN_SANDBOX_HELPER) {
    $explicitOrEnv = $env:GUARDIAN_SANDBOX_HELPER
  }

  if ($explicitOrEnv) {
    $resolved = Resolve-Path $explicitOrEnv -ErrorAction Stop
    return $resolved.Path
  }

  $candidates = @(
    (Join-Path $RepoRoot "bin/guardian-sandbox-win.exe"),
    (Join-Path $RepoRoot "native/windows-helper/target/release/guardian-sandbox-win.exe"),
    (Join-Path $RepoRoot "guardian-sandbox-win.exe")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  $helperCmd = Get-Command "guardian-sandbox-win.exe" -ErrorAction SilentlyContinue
  if ($helperCmd -and $helperCmd.Source) {
    return $helperCmd.Source
  }

  return $null
}

$helper = Find-SandboxHelper -ExplicitPath $SandboxHelperPath -RepoRoot $RepoRoot
if ($helper) {
  $helper = "$helper".Trim()
}
$enforceHelper = $RequireHelper -or (-not $AllowNoHelper)

Write-Host ""
Write-Host "GuardianAgent Windows Portable Builder" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"
if ($helper) {
  Write-Host "Sandbox helper: using existing binary at $helper" -ForegroundColor Green
} else {
  if ($enforceHelper) {
    Write-Host "Sandbox helper: not pre-specified; packaging will build/resolve it and fail if unavailable." -ForegroundColor Cyan
  } else {
    Write-Host "Sandbox helper: not pre-specified; packaging will attempt to build/resolve it in this clean run." -ForegroundColor Cyan
  }
}
Write-Host ""

$packageArgs = @{
  OutputRoot = "build/windows"
  SkipInstall = $SkipInstall
  RequireHelper = $enforceHelper
  BuildHelper = $true
}
if ($AllowNoHelper) {
  $packageArgs["AllowNoHelper"] = $true
}
if ($helper) {
  $packageArgs["SandboxHelperPath"] = $helper
}

& (Join-Path $PSScriptRoot "build-windows-package.ps1") @packageArgs

$packageJson = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$appVersion = $packageJson.version
$zipPath = Join-Path $OutputRoot "portable/GuardianAgent-windows-portable-$appVersion.zip"

Write-Host ""
if (Test-Path $zipPath) {
  Write-Host "Portable build complete:" -ForegroundColor Green
  Write-Host "  $zipPath"
  Write-Host ""
  Write-Host "After extracting, run:" -ForegroundColor Cyan
  Write-Host "  .\guardianagent.cmd"
} else {
  throw "Portable build did not produce the expected zip: $zipPath"
}
