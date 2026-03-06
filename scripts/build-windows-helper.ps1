param(
  [string]$OutputRoot = "build/windows/helper",
  [switch]$SkipCargoClean,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

if (-not ($env:OS -eq "Windows_NT")) {
  throw "This script must be run on Windows."
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $RepoRoot "native/windows-helper/Cargo.toml"
if (-not (Test-Path $ManifestPath)) {
  throw "Windows helper source not found at native/windows-helper/Cargo.toml"
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
  throw "cargo was not found on PATH. Install Rust toolchain first."
}

$OutputRootPath = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
  $OutputRoot
} else {
  Join-Path $RepoRoot $OutputRoot
}
$OutputBin = Join-Path $OutputRootPath "bin"
if (Test-Path $OutputRootPath) {
  Remove-Item -Recurse -Force $OutputRootPath
}
New-Item -ItemType Directory -Force -Path $OutputRootPath, $OutputBin | Out-Null

if (-not $Quiet) {
  Write-Host "Building guardian-sandbox-win helper..." -ForegroundColor Cyan
}

Push-Location $RepoRoot
try {
  if (-not $SkipCargoClean) {
    cargo clean --manifest-path $ManifestPath
  }
  cargo build --manifest-path $ManifestPath --release
}
finally {
  Pop-Location
}

$BuiltExe = Join-Path $RepoRoot "native/windows-helper/target/release/guardian-sandbox-win.exe"
if (-not (Test-Path $BuiltExe)) {
  throw "Expected helper binary was not produced: $BuiltExe"
}

$DestExe = Join-Path $OutputBin "guardian-sandbox-win.exe"
Copy-Item $BuiltExe $DestExe -Force
Copy-Item $BuiltExe (Join-Path $OutputRootPath "guardian-sandbox-win.exe") -Force

if (-not $Quiet) {
  Write-Host "Helper built at $DestExe" -ForegroundColor Green
}

Write-Output $DestExe
