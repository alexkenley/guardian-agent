param(
  [string]$OutputRoot = "build/windows",
  [string]$SandboxHelperPath = "",
  [switch]$BuildHelper,
  [switch]$RequireHelper,
  [switch]$AllowNoHelper,
  [switch]$SkipInstall,
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$env:NPM_CONFIG_PROGRESS = "false"

if (-not ($env:OS -eq "Windows_NT")) {
  throw "This script must be run on Windows."
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputRoot = Join-Path $RepoRoot $OutputRoot
$StageRoot = Join-Path $OutputRoot "app"
$BinDir = Join-Path $StageRoot "bin"
$ConfigDir = Join-Path $StageRoot "config"
$LogsDir = Join-Path $StageRoot "logs"
$WebDir = Join-Path $StageRoot "web"
$PoliciesDir = Join-Path $StageRoot "policies"
$PortableDir = Join-Path $OutputRoot "portable"
$packageJson = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$AppVersion = $packageJson.version
$PortableRootName = "GuardianAgent-windows-portable-$AppVersion"
$PortableRoot = Join-Path $PortableDir $PortableRootName
$PortableZip = Join-Path $PortableDir "$PortableRootName.zip"
$ResolvedSandboxHelperPath = ""
$enforceHelper = $RequireHelper -or (-not $AllowNoHelper)
if ($SandboxHelperPath) {
  $ResolvedSandboxHelperPath = (Resolve-Path $SandboxHelperPath -ErrorAction Stop).Path
}

function Stop-ProcessesUnderPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootPath
  )

  if (-not (Test-Path $RootPath)) {
    return
  }

  try {
    $resolvedRoot = (Resolve-Path $RootPath).Path
    $prefix = [System.IO.Path]::GetFullPath($resolvedRoot).TrimEnd('\') + '\'
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
    }
    foreach ($proc in $procs) {
      try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      } catch {
        # Best-effort only; cleanup retry below will report final failure if still locked.
      }
    }
  } catch {
    # Best-effort only.
  }
}

function Remove-PathWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [int]$Attempts = 8,
    [int]$DelayMs = 1000
  )

  if (-not (Test-Path $Path)) {
    return
  }

  $lastError = $null
  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      $lastError = $_
      if ($i -lt $Attempts) {
        Start-Sleep -Milliseconds $DelayMs
      }
    }
  }

  throw ("Failed to clean build output at '{0}'. A file is likely locked by a running process. " +
    "Close any running GuardianAgent portable windows (or stop related node.exe processes) and retry. Last error: {1}") -f $Path, $lastError.Exception.Message
}

function Copy-OptionalFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
  )

  if (-not (Test-Path $SourcePath)) {
    return $false
  }

  Copy-Item $SourcePath $DestinationPath -Force
  return $true
}

function Copy-OptionalDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
  )

  if (-not (Test-Path $SourcePath)) {
    return $false
  }

  Copy-Item -Recurse $SourcePath $DestinationPath -Force
  return $true
}

function Invoke-DependencyContractValidation {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  & node $ScriptPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

Push-Location $RepoRoot
try {
  if (Test-Path $OutputRoot) {
    Stop-ProcessesUnderPath -RootPath $OutputRoot
    Remove-PathWithRetry -Path $OutputRoot
  }

  $dependencyValidator = Join-Path $RepoRoot "scripts/validate-dependency-contract.mjs"
  if (-not (Test-Path $dependencyValidator)) {
    throw "Dependency contract validator was not found at $dependencyValidator."
  }

  Write-Host "Validating pinned dependency contract..." -ForegroundColor Cyan
  Invoke-DependencyContractValidation `
    -ScriptPath $dependencyValidator `
    -Arguments @("--repo-root", $RepoRoot) `
    -FailureMessage "Dependency contract validation failed for the repo root manifests."

  if (-not $SkipInstall) {
    Write-Host "Installing root dependencies..." -ForegroundColor Cyan
    npm ci
  }
  Write-Host "Building TypeScript..." -ForegroundColor Cyan
  npm run build

  New-Item -ItemType Directory -Force -Path $StageRoot, $BinDir, $ConfigDir, $LogsDir, $WebDir, $PoliciesDir, $PortableDir | Out-Null

  Copy-Item package.json, package-lock.json, README.md, LICENSE, INSTALLATION.md, USAGE.md, SECURITY.md, THIRD_PARTY_NOTICES.md -Destination $StageRoot
  Copy-OptionalFile -SourcePath (Join-Path $RepoRoot "SOUL.md") -DestinationPath $StageRoot | Out-Null
  Copy-Item -Recurse dist -Destination $StageRoot
  if (Test-Path (Join-Path $RepoRoot "web/public")) {
    Copy-Item -Recurse (Join-Path $RepoRoot "web/public") -Destination $WebDir
  } else {
    throw "Required web assets were not found at web/public."
  }

  # Copy skills into staged app
  if (Test-Path (Join-Path $RepoRoot "skills")) {
    Copy-Item -Recurse (Join-Path $RepoRoot "skills") -Destination $StageRoot
  }

  if (Test-Path (Join-Path $RepoRoot "policies")) {
    Copy-Item -Path (Join-Path $RepoRoot "policies\*") -Destination $PoliciesDir -Recurse -Force
  } else {
    throw "Required policy files were not found at policies/."
  }

  Write-Host "Installing production dependencies into staged app..." -ForegroundColor Cyan
  npm ci --omit=dev --ignore-scripts --prefix $StageRoot

  Write-Host "Validating staged package manifests..." -ForegroundColor Cyan
  Invoke-DependencyContractValidation `
    -ScriptPath $dependencyValidator `
    -Arguments @("--repo-root", $RepoRoot, "--stage-root", $StageRoot, "--require-stage") `
    -FailureMessage "Dependency contract validation failed for the staged Windows app manifests."

  # Ensure bundled CLI tools are available in staged app
  Write-Host "Ensuring bundled CLI tools..." -ForegroundColor Cyan
  Push-Location $StageRoot
  try {
    # No external CLI tools to ensure currently
  } finally {
    Pop-Location
  }

  $nodeExe = (Get-Command node.exe).Source
  if (-not $nodeExe) {
    throw "node.exe was not found on PATH."
  }
  Copy-Item $nodeExe (Join-Path $StageRoot "node.exe")

  $nodeRuntimeRoot = Split-Path -Parent $nodeExe
  $runtimeNodeModules = Join-Path $nodeRuntimeRoot "node_modules"
  foreach ($runtimeCli in @("npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1", "corepack", "corepack.cmd", "corepack.ps1")) {
    Copy-OptionalFile -SourcePath (Join-Path $nodeRuntimeRoot $runtimeCli) -DestinationPath $StageRoot | Out-Null
  }
  foreach ($runtimePackage in @("npm", "corepack")) {
    Copy-OptionalDirectory -SourcePath (Join-Path $runtimeNodeModules $runtimePackage) -DestinationPath (Join-Path $StageRoot "node_modules") | Out-Null
  }

  $launcher = @'
@echo off
setlocal
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"
if defined GUARDIAN_CONFIG_PATH (
  set CONFIG_PATH=%GUARDIAN_CONFIG_PATH%
) else (
  set CONFIG_PATH=%SCRIPT_DIR%config\portable-config.yaml
)
"%SCRIPT_DIR%node.exe" "%SCRIPT_DIR%dist\index.js" "%CONFIG_PATH%" %*
'@
  Set-Content -Path (Join-Path $StageRoot "guardianagent.cmd") -Value $launcher -Encoding ASCII

  $shouldBuildHelper = $BuildHelper -or (-not $SandboxHelperPath)
  if (-not $SandboxHelperPath -and $shouldBuildHelper) {
    Write-Host "Building Windows sandbox helper..." -ForegroundColor Cyan
    $helperBuilder = Join-Path $PSScriptRoot "build-windows-helper.ps1"
    if (-not (Test-Path $helperBuilder)) {
      throw "build-windows-helper.ps1 not found but helper build is required."
    }
    try {
      $helperOutputRoot = Join-Path $OutputRoot "helper"
      $SandboxHelperPath = (& $helperBuilder -OutputRoot $helperOutputRoot -Quiet).ToString().Trim()
    } catch {
      if ($enforceHelper) {
        throw
      }
      Write-Host "Helper build skipped: $($_.Exception.Message)" -ForegroundColor Yellow
      $SandboxHelperPath = ""
    }
  }

  $helperCopied = $false
  if ($ResolvedSandboxHelperPath) {
    Copy-Item $ResolvedSandboxHelperPath (Join-Path $BinDir "guardian-sandbox-win.exe")
    $helperCopied = $true
  }
  elseif ($SandboxHelperPath) {
    $resolvedHelper = Resolve-Path $SandboxHelperPath -ErrorAction Stop
    Copy-Item $resolvedHelper (Join-Path $BinDir "guardian-sandbox-win.exe")
    $helperCopied = $true
  }
  elseif ($enforceHelper) {
    throw "Sandbox helper is required but no helper binary was supplied or built."
  }

  $helperNote = if ($helperCopied) {
    "guardian-sandbox-win.exe was bundled into .\bin."
  } else {
    "Place guardian-sandbox-win.exe into .\bin to enable Windows strong sandbox mode."
  }
  Set-Content -Path (Join-Path $BinDir "README.txt") -Value $helperNote -Encoding ASCII

  $portableConfig = @'
assistant:
  tools:
    sandbox:
      enabled: true
      enforcementMode: strict
      windowsHelper:
        enabled: true
        command: ./bin/guardian-sandbox-win.exe
        timeoutMs: 5000
'@
  Set-Content -Path (Join-Path $ConfigDir "portable-config.yaml") -Value $portableConfig -Encoding ASCII
  Set-Content -Path (Join-Path $ConfigDir "windows-portable-isolation.example.yaml") -Value $portableConfig -Encoding ASCII

  if (-not $SkipZip) {
    if (Test-Path $PortableRoot) {
      Remove-Item -Recurse -Force $PortableRoot
    }
    New-Item -ItemType Directory -Force -Path $PortableRoot | Out-Null
    Copy-Item -Recurse (Join-Path $StageRoot "*") -Destination $PortableRoot

    if (Test-Path $PortableZip) {
      Remove-Item -Force $PortableZip
    }
    Write-Host "Creating portable zip (this can take a few minutes)..." -ForegroundColor Cyan
    try {
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $PortableRoot,
        $PortableZip,
        [System.IO.Compression.CompressionLevel]::Fastest,
        $false
      )
    } catch {
      Write-Host "ZipFile API failed; falling back to Compress-Archive." -ForegroundColor Yellow
      if (Test-Path $PortableZip) {
        Remove-Item -Force $PortableZip
      }
      Compress-Archive -Path (Join-Path $PortableRoot "*") -DestinationPath $PortableZip
    }
    Write-Host "Portable zip created at $PortableZip"
  }

  Write-Host "Windows package staged at $StageRoot"
}
finally {
  Pop-Location
}
