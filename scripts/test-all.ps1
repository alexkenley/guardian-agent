#Requires -Version 5.1
<#
.SYNOPSIS
    Run all GuardianAgent integration test harness scripts in sequence.

.DESCRIPTION
    Starts the app once, then chains every test-*.ps1 harness script using
    -SkipStart so they all share the same running instance. The app is
    started by the first script (test-approvals.ps1) and kept alive with
    -Keep. After all scripts finish, the app process is stopped.

    Scripts are ordered so deterministic (direct API) tests run first,
    followed by LLM-path tests which are slower and non-deterministic.

    Exit code = total failures across all scripts.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.PARAMETER SkipStart
    Skip app startup — assume it is already running.

.PARAMETER Keep
    Keep the app running after all tests finish.

.PARAMETER Only
    Comma-separated list of script basenames to run (e.g. "approvals,network").
    Omit to run all scripts.

.EXAMPLE
    .\scripts\test-all.ps1

.EXAMPLE
    .\scripts\test-all.ps1 -SkipStart -Port 3000 -Token "your-token"

.EXAMPLE
    .\scripts\test-all.ps1 -Only "approvals,automation,network"
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "harness-all-$(Get-Date -Format 'yyyyMMddHHmmss')" } ),
    [string]$Only = ""
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot

# ─── Ordered script list ──────────────────────────────────────
# First entry starts the app (no -SkipStart); the rest use -SkipStart.
# Deterministic (direct API) tests first, then LLM-path tests.
$AllScripts = @(
    # Deterministic / direct API
    "test-approvals"          # approval UX, policy transitions, edge cases
    "test-automation"         # workflow/task CRUD + approval gating
    "test-network"            # network diagnostic tools
    "test-browser"            # browser automation tools
    "test-intel"              # threat intel tools
    "test-contacts"           # contacts, campaigns, email gating
    "test-qmd"               # QMD document search
    "test-gws"               # Google Workspace tools
    "test-security-api"       # security framework controls

    # LLM-path (slower, non-deterministic)
    "test-harness"            # core LLM chat path
    "test-tools"              # LLM tool discovery across categories
    "test-security-content"   # prompt injection, secret/PII scanning
    "test-automations-llm"    # LLM automation creation
    "test-memory-save"        # memory tool selection diagnostic
)

# ─── Filter if -Only specified ────────────────────────────────
if ($Only.Trim()) {
    $filter = $Only.Split(",") | ForEach-Object { $_.Trim().ToLower() }
    # Normalize: allow "approvals" or "test-approvals"
    $filter = $filter | ForEach-Object {
        if ($_ -match "^test-") { $_ } else { "test-$_" }
    }
    $AllScripts = $AllScripts | Where-Object { $filter -contains $_.ToLower() }
    if ($AllScripts.Count -eq 0) {
        Write-Host "ERROR: No scripts matched -Only filter: $Only" -ForegroundColor Red
        Write-Host "Available: $($AllScripts -join ', ')"
        exit 1
    }
}

# ─── State ────────────────────────────────────────────────────
$TotalFail = 0
$ScriptResults = @()
$StartTime = Get-Date

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  GuardianAgent Integration Test Suite" -ForegroundColor Cyan
Write-Host "  Scripts: $($AllScripts.Count)  Port: $Port" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# ─── Run each script ─────────────────────────────────────────
$isFirst = $true
foreach ($scriptName in $AllScripts) {
    $scriptPath = Join-Path $ScriptDir "$scriptName.ps1"

    if (-not (Test-Path $scriptPath)) {
        Write-Host "  SKIP $scriptName — file not found" -ForegroundColor Yellow
        $ScriptResults += @{ Name = $scriptName; Pass = 0; Fail = 0; Skip = 1; Status = "NOT FOUND" }
        $TotalSkip++
        continue
    }

    Write-Host ""
    Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host "  Running: $scriptName" -ForegroundColor Cyan
    Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""

    # Build arguments as hashtable for proper splatting
    $scriptArgs = @{
        Port  = $Port
        Token = $Token
    }

    if ($isFirst -and -not $SkipStart) {
        # First script starts the app and keeps it alive for subsequent scripts
        $scriptArgs.Keep = $true
        $isFirst = $false
    } else {
        # All subsequent scripts connect to the already-running app
        $scriptArgs.SkipStart = $true
    }

    # Run the script and capture exit code
    $scriptStart = Get-Date
    try {
        & $scriptPath @scriptArgs
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Host "  ERROR: $scriptName threw an exception: $_" -ForegroundColor Red
        $exitCode = 999
    }
    $elapsed = [math]::Round(((Get-Date) - $scriptStart).TotalSeconds, 1)

    # Parse results from output (scripts print "PASS: N  FAIL: N  SKIP: N")
    # We use the exit code as the failure count
    $failures = if ($exitCode) { $exitCode } else { 0 }
    $status = if ($failures -eq 0) { "PASSED" } else { "FAILED ($failures)" }

    $ScriptResults += @{
        Name = $scriptName
        Fail = $failures
        Status = $status
        Duration = "${elapsed}s"
    }

    $TotalFail += $failures

    if ($failures -gt 0) {
        Write-Host ""
        Write-Host "  >> ${scriptName}: $failures failure(s) in ${elapsed}s" -ForegroundColor Red
    } else {
        Write-Host ""
        Write-Host "  >> ${scriptName}: PASSED in ${elapsed}s" -ForegroundColor Green
    }

    # Brief pause between scripts to let state settle
    Start-Sleep -Seconds 2
}

# ─── Stop the app ────────────────────────────────────────────
if (-not $Keep -and -not $SkipStart) {
    Write-Host ""
    Write-Host "[test-all] Stopping app..." -ForegroundColor Cyan
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "src[/\\]index\.ts|dist[/\\]index\.js" }
    foreach ($proc in $procs) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# ─── Summary ──────────────────────────────────────────────────
$totalElapsed = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Test Suite Summary" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$maxName = ($ScriptResults | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
if ($maxName -lt 20) { $maxName = 20 }

foreach ($r in $ScriptResults) {
    $namepad = $r.Name.PadRight($maxName)
    $color = if ($r.Status -eq "PASSED") { "Green" }
             elseif ($r.Status -eq "NOT FOUND") { "Yellow" }
             else { "Red" }
    Write-Host "  $namepad  " -NoNewline
    Write-Host "$($r.Status)" -ForegroundColor $color -NoNewline
    if ($r.Duration) { Write-Host "  ($($r.Duration))" -ForegroundColor DarkGray -NoNewline }
    Write-Host ""
}

Write-Host ""
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
$failColor = if ($TotalFail -eq 0) { "Green" } else { "Red" }
Write-Host "  Total failures: " -NoNewline
Write-Host "$TotalFail" -ForegroundColor $failColor -NoNewline
Write-Host "  |  Scripts: $($AllScripts.Count)  |  Duration: ${totalElapsed}s"
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

exit $TotalFail
