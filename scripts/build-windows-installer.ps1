param(
  [string]$OutputRoot = "build/windows",
  [string]$SandboxHelperPath = "",
  [switch]$SkipPackage
)

$ErrorActionPreference = "Stop"

if (-not ($env:OS -eq "Windows_NT")) {
  throw "This script must be run on Windows."
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputRoot = Join-Path $RepoRoot $OutputRoot
$StageRoot = Join-Path $OutputRoot "app"
$InstallerScript = Join-Path $RepoRoot "packaging/windows/GuardianAgent.iss"

if (-not $SkipPackage -or -not (Test-Path $StageRoot)) {
  & (Join-Path $PSScriptRoot "build-windows-package.ps1") -OutputRoot $OutputRoot -SandboxHelperPath $SandboxHelperPath
}

$isccCandidates = @(
  $env:ISCC_PATH,
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $isccCandidates) {
  throw "Inno Setup compiler (ISCC.exe) was not found. Set ISCC_PATH or install Inno Setup 6."
}

$iscc = $isccCandidates[0]
$packageJson = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$appVersion = $packageJson.version

& $iscc "/DAppVersion=$appVersion" "/DSourceDir=$StageRoot" $InstallerScript

Write-Host "Windows installer created under $OutputRoot\installer"
