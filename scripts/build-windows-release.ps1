param(
  [string]$OutputRoot = "build/windows",
  [string]$SandboxHelperPath = "",
  [switch]$SkipInstall,
  [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"

if (-not ($env:OS -eq "Windows_NT")) {
  throw "This script must be run on Windows."
}

$RepoRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot "build-windows-package.ps1") `
  -OutputRoot $OutputRoot `
  -SandboxHelperPath $SandboxHelperPath `
  -SkipInstall:$SkipInstall

if (-not $SkipInstaller) {
  & (Join-Path $PSScriptRoot "build-windows-installer.ps1") `
    -OutputRoot $OutputRoot `
    -SandboxHelperPath $SandboxHelperPath `
    -SkipPackage
}

Write-Host "Windows release artifacts are available under $(Join-Path $RepoRoot $OutputRoot)"
