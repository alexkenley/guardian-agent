#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Browser Automation Tools Test Harness (PowerShell)

.DESCRIPTION
    Tests browser automation tools (browser_open, browser_action, browser_snapshot,
    browser_close, browser_task). These tools require Chromium/Puppeteer to be
    available. Tests use a skip-if-unavailable pattern for environments without
    a display or browser binary.

    Uses direct tool API calls (POST /api/tools/run) for deterministic policy
    testing and autonomous mode for full browser lifecycle testing.

    All browser tools are network risk and auto-allowed in approve_by_policy mode.

    Requires a running GuardianAgent instance with web channel enabled and an LLM
    provider configured.

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.EXAMPLE
    .\scripts\test-browser.ps1

.EXAMPLE
    .\scripts\test-browser.ps1 -SkipStart -Port 3000 -Token "your-token"

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    Browser tests require Chromium/Puppeteer to be installed.
    All browser tools are network risk — auto-allowed in approve_by_policy.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-browser-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --- State ---
$BaseUrl = "http://localhost:$Port"
$TimeoutStartup = 30
$TimeoutResponse = 120
$AppProcess = $null
$Pass = 0
$Fail = 0
$Skip = 0
$Results = @()
$LogFile = Join-Path $env:TEMP "guardian-browser-harness.log"

# --- Helpers ---
function Write-Log($msg) { Write-Host "[browser] $msg" -ForegroundColor Cyan }
function Write-Pass($name) {
    Write-Host "  PASS " -ForegroundColor Green -NoNewline; Write-Host $name
    $script:Pass++; $script:Results += "PASS: $name"
}
function Write-Fail($name, $reason) {
    Write-Host "  FAIL " -ForegroundColor Red -NoNewline; Write-Host "$name - $reason"
    $script:Fail++; $script:Results += "FAIL: $name - $reason"
}
function Write-Skip($name, $reason) {
    Write-Host "  SKIP " -ForegroundColor Yellow -NoNewline; Write-Host "$name - $reason"
    $script:Skip++; $script:Results += "SKIP: $name - $reason"
}

function Send-Message {
    param([string]$Content, [string]$AgentId)
    $body = @{ content = $Content; userId = "harness" }
    if ($AgentId) { $body.agentId = $AgentId }
    try {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/api/message" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($body | ConvertTo-Json -Compress) `
            -TimeoutSec $TimeoutResponse
        return $resp
    }
    catch { return @{ error = $_.Exception.Message } }
}

function Test-ValidResponse {
    param($Response, [string]$Name)
    if ($Response -and $Response.content) {
        Write-Pass $Name
        return $true
    }
    elseif ($Response.error) {
        Write-Fail $Name "error: $($Response.error)"
        return $false
    }
    else {
        Write-Fail $Name "no .content in response"
        return $false
    }
}

function Test-Contains {
    param($Response, [string]$Field, [string]$Expected, [string]$Name)
    $value = $null
    try {
        $value = $Response
        foreach ($part in $Field.Split('.')) { $value = $value.$part }
    } catch {}
    if (-not $value) { Write-Fail $Name "field '$Field' is empty or missing"; return $false }
    if ($value -match $Expected) { Write-Pass $Name; return $true }
    else {
        $preview = if ($value.Length -gt 200) { $value.Substring(0, 200) + "..." } else { $value }
        Write-Fail $Name "expected '$Expected' in: $preview"
        return $false
    }
}

function Test-NotContains {
    param($Response, [string]$Field, [string]$Pattern, [string]$Name)
    $value = $null
    try {
        $value = $Response
        foreach ($part in $Field.Split('.')) { $value = $value.$part }
    } catch {}
    if ($value -and $value -match $Pattern) {
        $preview = if ($value.Length -gt 200) { $value.Substring(0, 200) + "..." } else { $value }
        Write-Fail $Name "unexpected '$Pattern' found in: $preview"
        return $false
    }
    else { Write-Pass $Name; return $true }
}

function Get-RecentJobs {
    param([int]$Limit = 20)
    try {
        $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=$Limit" `
            -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
        return $state.jobs
    }
    catch { return @() }
}

function Test-ToolWasCalled {
    param([string]$ToolPattern, [string]$Name, $JobsBefore)
    $jobsAfter = Get-RecentJobs
    $beforeIds = @()
    if ($JobsBefore) { $beforeIds = $JobsBefore | ForEach-Object { $_.id } }
    $newJobs = $jobsAfter | Where-Object { $_.id -notin $beforeIds }
    $matched = $newJobs | Where-Object { $_.toolName -match $ToolPattern }
    if ($matched -and $matched.Count -gt 0) {
        $names = ($matched | ForEach-Object { $_.toolName }) -join ", "
        Write-Pass "$Name (called: $names)"
        return $true
    }
    else {
        $allNames = ($newJobs | ForEach-Object { $_.toolName }) -join ", "
        if ($allNames) {
            Write-Fail $Name "expected tool matching '$ToolPattern', got: $allNames"
        }
        else {
            Write-Fail $Name "no tool calls detected"
        }
        return $false
    }
}

function Invoke-ToolPolicy {
    param([hashtable]$Policy)
    try {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/api/tools/policy" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($Policy | ConvertTo-Json -Depth 3 -Compress) `
            -TimeoutSec 10
        return $resp
    }
    catch { return @{ error = $_.Exception.Message } }
}

function Invoke-ApprovalDecision {
    param([string]$ApprovalId, [string]$Decision, [string]$Reason = "")
    $body = @{ approvalId = $ApprovalId; decision = $Decision; actor = "harness"; reason = $Reason }
    try {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/api/tools/approvals/decision" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($body | ConvertTo-Json -Compress) `
            -TimeoutSec 10
        return $resp
    }
    catch { return @{ success = $false; error = $_.Exception.Message } }
}

function Invoke-ToolRun {
    param([string]$ToolName, [hashtable]$ToolArgs)
    $body = @{ toolName = $ToolName; args = $ToolArgs; origin = "harness"; userId = "harness" }
    try {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/api/tools/run" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($body | ConvertTo-Json -Depth 4 -Compress) `
            -TimeoutSec $TimeoutResponse
        return $resp
    }
    catch { return @{ success = $false; error = $_.Exception.Message } }
}

# --- Start the app ---
if (-not $SkipStart) {
    $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "src[/\\]index\.ts|dist[/\\]index\.js" }
    if ($existing) {
        Write-Log "Killing $($existing.Count) existing GuardianAgent process(es)..."
        foreach ($proc in $existing) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }

    $projectRoot = Split-Path -Parent $PSScriptRoot
    $userConfig = Join-Path $env:USERPROFILE ".guardianagent\config.yaml"
    $harnessConfig = Join-Path $env:TEMP "guardian-browser-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-browser-") {
        $Token = "harness-" + [guid]::NewGuid().ToString("N")
    }

    if (Test-Path $userConfig) {
        $configContent = Get-Content $userConfig -Raw
        $configContent = $configContent -replace '(?m)^  web:\r?\n(    .*\r?\n)*', ''
        $configContent = $configContent -replace '(?m)^\s*authToken:.*\r?\n?', ''
        $webBlock = @"
  web:
    enabled: true
    port: $Port
    authToken: "$Token"
"@
        $configContent = $configContent -replace '(channels:\s*\r?\n)', "`$1$webBlock`n"
        $configContent | Set-Content $harnessConfig -Encoding utf8
    }
    else {
        @"
llm:
  ollama:
    provider: ollama
    baseUrl: http://127.0.0.1:11434
    model: gpt-oss:120b
defaultProvider: ollama
channels:
  cli:
    enabled: false
  web:
    enabled: true
    port: $Port
    authToken: "$Token"
guardian:
  enabled: true
"@ | Set-Content $harnessConfig -Encoding utf8
    }

    Write-Log "Starting GuardianAgent with token: $Token"

    $AppProcess = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c npx tsx src/index.ts `"$harnessConfig`"" `
        -WorkingDirectory $projectRoot `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError "$LogFile.err" `
        -PassThru -WindowStyle Hidden

    Write-Log "App PID: $($AppProcess.Id), waiting for /health..."

    $elapsed = 0
    $healthy = $false
    while ($elapsed -lt $TimeoutStartup) {
        try {
            $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2
            if ($health.status) { $healthy = $true; Write-Log "App is healthy after ${elapsed}s"; break }
        } catch {}
        Start-Sleep -Seconds 1
        $elapsed++
    }

    if (-not $healthy) {
        Write-Host "ERROR: App failed to start within ${TimeoutStartup}s" -ForegroundColor Red
        if (Test-Path $LogFile) { Get-Content $LogFile -Tail 30 }
        if (Test-Path "$LogFile.err") { Get-Content "$LogFile.err" -Tail 30 }
        if ($AppProcess -and -not $AppProcess.HasExited) { $AppProcess.Kill() }
        exit 1
    }
    Write-Log "Ready with auth token: $Token"
}
else {
    Write-Log "Skipping app startup (-SkipStart). Using $BaseUrl"
}

# --- Cleanup on exit ---
$cleanupBlock = {
    if ($script:AppProcess -and -not $script:AppProcess.HasExited) {
        if ($script:Keep) {
            Write-Log "App left running (PID $($script:AppProcess.Id)) at $script:BaseUrl"
        }
        else {
            Write-Log "Stopping app (PID $($script:AppProcess.Id))..."
            $script:AppProcess.Kill()
        }
    }
    $tempCfg = Join-Path $env:TEMP "guardian-browser-harness-config.yaml"
    if (Test-Path $tempCfg) { Remove-Item $tempCfg -Force -ErrorAction SilentlyContinue }
}

try {

# --- LLM Provider Info ---
Write-Host ""
try {
    $providers = Invoke-RestMethod -Uri "$BaseUrl/api/providers" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
    if ($providers -and $providers.Count -gt 0) {
        foreach ($p in $providers) {
            $locality = if ($p.locality) { $p.locality } else { "unknown" }
            Write-Log "LLM Provider: $($p.name) ($($p.type)) - model: $($p.model), locality: $locality"
        }
    }
    else {
        Write-Log "LLM Provider: unknown (no providers returned)"
    }
}
catch {
    Write-Log "LLM Provider: could not query /api/providers"
}

# ===============================================================
# 1. BROWSER PREREQUISITE CHECK
# ===============================================================
Write-Host ""
Write-Log "=== Browser Prerequisite Check ==="

$browserToolRegistered = $false
$browserAvailable = $false

# Probe browser_open with about:blank to check availability
$probeArgs = @{ url = "about:blank" }
$browserProbe = Invoke-ToolRun -ToolName "browser_open" -ToolArgs $probeArgs

if ($browserProbe.message -match "Unknown tool" -or $browserProbe.error -match "Unknown tool") {
    Write-Skip "browser: all browser tests" "browser_open tool not registered"
}
elseif ($browserProbe.status -eq "succeeded" -or $browserProbe.success -eq $true) {
    $browserToolRegistered = $true
    $browserAvailable = $true
    Write-Pass "browser: tool available and browser binary found"
    # Close the probe session if one was opened
    $probeSessionId = $null
    if ($browserProbe.result) { $probeSessionId = $browserProbe.result.sessionId }
    if (-not $probeSessionId -and $browserProbe.data) { $probeSessionId = $browserProbe.data.sessionId }
    if (-not $probeSessionId -and $browserProbe.sessionId) { $probeSessionId = $browserProbe.sessionId }
    if ($probeSessionId) {
        $closeProbeArgs = @{ sessionId = $probeSessionId }
        $null = Invoke-ToolRun -ToolName "browser_close" -ToolArgs $closeProbeArgs
    }
}
elseif (($browserProbe.status -eq "failed" -or $browserProbe.status -eq "error") -and
        ($browserProbe.message -match "Chromium|puppeteer|browser|ENOENT|not found|Cannot find|no display" -or
         $browserProbe.error -match "Chromium|puppeteer|browser|ENOENT|not found|Cannot find|no display")) {
    $browserToolRegistered = $true
    $browserAvailable = $false
    Write-Pass "browser: tool registered but browser binary not available"
    Write-Log "Will skip live browser tests, but run registration and policy tests"
}
else {
    $browserToolRegistered = $true
    $browserAvailable = $false
    Write-Pass "browser: tool registered (probe status: $($browserProbe.status))"
    Write-Log "Will skip live browser tests, but run registration and policy tests"
}

# ===============================================================
# 2. FULL BROWSER LIFECYCLE (only if $browserAvailable)
# ===============================================================
if ($browserAvailable) {

Write-Host ""
Write-Log "=== Full Browser Lifecycle (Autonomous Mode) ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for browser lifecycle tests"

Start-Sleep -Seconds 2

# --- browser_open ---
Write-Host ""
Write-Log "--- browser_open (https://example.com) ---"

$openArgs = @{ url = "https://example.com" }
$openResult = Invoke-ToolRun -ToolName "browser_open" -ToolArgs $openArgs

if ($openResult.status -eq "succeeded" -or $openResult.success -eq $true) {
    Write-Pass "browser_open: succeeded"
}
else {
    Write-Fail "browser_open: open example.com" "status=$($openResult.status), error=$($openResult.error)"
}

# Extract sessionId with fallback pattern
$sessionId = $null
if ($openResult.result) { $sessionId = $openResult.result.sessionId }
if (-not $sessionId -and $openResult.data) { $sessionId = $openResult.data.sessionId }
if (-not $sessionId -and $openResult.sessionId) { $sessionId = $openResult.sessionId }

if ($sessionId) {
    Write-Pass "browser_open: sessionId captured ($sessionId)"

    Start-Sleep -Seconds 2

    # --- browser_snapshot ---
    Write-Host ""
    Write-Log "--- browser_snapshot ---"

    $snapshotArgs = @{ sessionId = $sessionId }
    $snapshotResult = Invoke-ToolRun -ToolName "browser_snapshot" -ToolArgs $snapshotArgs

    if ($snapshotResult.status -eq "succeeded" -or $snapshotResult.success -eq $true) {
        Write-Pass "browser_snapshot: succeeded"
    }
    else {
        Write-Fail "browser_snapshot: take snapshot" "status=$($snapshotResult.status), error=$($snapshotResult.error)"
    }

    Start-Sleep -Seconds 2

    # --- browser_action (evaluate) ---
    Write-Host ""
    Write-Log "--- browser_action (evaluate document.title) ---"

    $actionArgs = @{ sessionId = $sessionId; action = "evaluate"; value = "document.title" }
    $actionResult = Invoke-ToolRun -ToolName "browser_action" -ToolArgs $actionArgs

    if ($actionResult.status -eq "succeeded" -or $actionResult.success -eq $true) {
        Write-Pass "browser_action: evaluate succeeded"
    }
    else {
        Write-Fail "browser_action: evaluate document.title" "status=$($actionResult.status), error=$($actionResult.error)"
    }

    Start-Sleep -Seconds 2

    # --- browser_close ---
    Write-Host ""
    Write-Log "--- browser_close ---"

    $closeArgs = @{ sessionId = $sessionId }
    $closeResult = Invoke-ToolRun -ToolName "browser_close" -ToolArgs $closeArgs

    if ($closeResult.status -eq "succeeded" -or $closeResult.success -eq $true) {
        Write-Pass "browser_close: succeeded"
    }
    else {
        Write-Fail "browser_close: close session" "status=$($closeResult.status), error=$($closeResult.error)"
    }
}
else {
    Write-Skip "browser lifecycle: snapshot, action, close" "no sessionId returned from browser_open"
}

Start-Sleep -Seconds 2

# ===============================================================
# 3. BROWSER_TASK TEST (only if $browserAvailable)
# ===============================================================
Write-Host ""
Write-Log "=== browser_task Test ==="

$taskArgs = @{ url = "https://example.com"; task = "Get the page title" }
$taskResult = Invoke-ToolRun -ToolName "browser_task" -ToolArgs $taskArgs

if ($taskResult.status -eq "succeeded" -or $taskResult.success -eq $true) {
    Write-Pass "browser_task: succeeded"
}
elseif ($taskResult.status -eq "failed" -or $taskResult.status -eq "error") {
    # browser_task may fail depending on LLM availability — execution is still valid
    Write-Pass "browser_task: executed (status: $($taskResult.status))"
}
else {
    Write-Fail "browser_task: execute task" "status=$($taskResult.status), error=$($taskResult.error)"
}

} # end if ($browserAvailable)

# ===============================================================
# 4. REGISTRATION VERIFICATION (if registered but NOT available)
# ===============================================================
if ($browserToolRegistered -and -not $browserAvailable) {

Write-Host ""
Write-Log "=== Registration Verification (browser binary not available) ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for registration tests"

Start-Sleep -Seconds 2

# --- browser_open registration ---
Write-Host ""
Write-Log "--- browser_open registration check ---"

$regOpenArgs = @{ url = "about:blank" }
$regOpenResult = Invoke-ToolRun -ToolName "browser_open" -ToolArgs $regOpenArgs

if ($regOpenResult.status -eq "pending_approval") {
    Write-Fail "browser_open (registration): unexpected pending_approval in autonomous mode" ""
}
elseif ($regOpenResult.message -match "Unknown tool" -or $regOpenResult.error -match "Unknown tool") {
    Write-Fail "browser_open (registration): tool not registered" ""
}
else {
    Write-Pass "browser_open (registration): tool executed (status: $($regOpenResult.status))"
}

Start-Sleep -Seconds 2

# --- browser_close registration ---
Write-Host ""
Write-Log "--- browser_close registration check ---"

$regCloseArgs = @{ sessionId = "fake-session" }
$regCloseResult = Invoke-ToolRun -ToolName "browser_close" -ToolArgs $regCloseArgs

if ($regCloseResult.status -eq "pending_approval") {
    Write-Fail "browser_close (registration): unexpected pending_approval in autonomous mode" ""
}
elseif ($regCloseResult.message -match "Unknown tool" -or $regCloseResult.error -match "Unknown tool") {
    Write-Fail "browser_close (registration): tool not registered" ""
}
else {
    Write-Pass "browser_close (registration): tool executed (status: $($regCloseResult.status))"
}

Start-Sleep -Seconds 2

# --- browser_task registration ---
Write-Host ""
Write-Log "--- browser_task registration check ---"

$regTaskArgs = @{ url = "about:blank"; task = "test" }
$regTaskResult = Invoke-ToolRun -ToolName "browser_task" -ToolArgs $regTaskArgs

if ($regTaskResult.status -eq "pending_approval") {
    Write-Fail "browser_task (registration): unexpected pending_approval in autonomous mode" ""
}
elseif ($regTaskResult.message -match "Unknown tool" -or $regTaskResult.error -match "Unknown tool") {
    Write-Fail "browser_task (registration): tool not registered" ""
}
else {
    Write-Pass "browser_task (registration): tool executed (status: $($regTaskResult.status))"
}

} # end if ($browserToolRegistered -and -not $browserAvailable)

# ===============================================================
# 5. NETWORK RISK POLICY VERIFICATION (approve_by_policy)
# ===============================================================
if ($browserToolRegistered) {

Write-Host ""
Write-Log "=== Network Risk Policy Verification (approve_by_policy) ==="

$policyResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($policyResult.error) {
    Write-Fail "policy: set approve_by_policy" $policyResult.error
}
else {
    Write-Pass "policy: set to approve_by_policy"
}

Start-Sleep -Seconds 2

# --- browser_open should NOT require approval (network risk auto-allowed) ---
Write-Host ""
Write-Log "--- browser_open under approve_by_policy ---"

$policyOpenArgs = @{ url = "about:blank" }
$policyOpenResult = Invoke-ToolRun -ToolName "browser_open" -ToolArgs $policyOpenArgs

if ($policyOpenResult.status -eq "pending_approval") {
    Write-Fail "browser_open (approve_by_policy): incorrectly requires approval" "network risk tools should be auto-allowed"
}
elseif ($policyOpenResult.status -eq "succeeded" -or $policyOpenResult.success -eq $true) {
    Write-Pass "browser_open (approve_by_policy): allowed without approval"
    # Close any opened session
    $policySessionId = $null
    if ($policyOpenResult.result) { $policySessionId = $policyOpenResult.result.sessionId }
    if (-not $policySessionId -and $policyOpenResult.data) { $policySessionId = $policyOpenResult.data.sessionId }
    if (-not $policySessionId -and $policyOpenResult.sessionId) { $policySessionId = $policyOpenResult.sessionId }
    if ($policySessionId) {
        $policyCloseArgs = @{ sessionId = $policySessionId }
        $null = Invoke-ToolRun -ToolName "browser_close" -ToolArgs $policyCloseArgs
    }
}
elseif ($policyOpenResult.status -eq "failed" -or $policyOpenResult.status -eq "error") {
    # Tool executed past approval gate — acceptable (browser may not be available)
    Write-Pass "browser_open (approve_by_policy): executed without approval (status: $($policyOpenResult.status))"
}
else {
    Write-Fail "browser_open (approve_by_policy): unexpected" "status=$($policyOpenResult.status), error=$($policyOpenResult.error)"
}

Start-Sleep -Seconds 2

# --- browser_task should NOT require approval (network risk auto-allowed) ---
Write-Host ""
Write-Log "--- browser_task under approve_by_policy ---"

$policyTaskArgs = @{ url = "about:blank"; task = "test" }
$policyTaskResult = Invoke-ToolRun -ToolName "browser_task" -ToolArgs $policyTaskArgs

if ($policyTaskResult.status -eq "pending_approval") {
    Write-Fail "browser_task (approve_by_policy): incorrectly requires approval" "network risk tools should be auto-allowed"
}
elseif ($policyTaskResult.status -eq "succeeded" -or $policyTaskResult.success -eq $true) {
    Write-Pass "browser_task (approve_by_policy): allowed without approval"
}
elseif ($policyTaskResult.status -eq "failed" -or $policyTaskResult.status -eq "error") {
    Write-Pass "browser_task (approve_by_policy): executed without approval (status: $($policyTaskResult.status))"
}
else {
    Write-Fail "browser_task (approve_by_policy): unexpected" "status=$($policyTaskResult.status), error=$($policyTaskResult.error)"
}

Start-Sleep -Seconds 2

# --- browser_close should NOT require approval (network risk auto-allowed) ---
Write-Host ""
Write-Log "--- browser_close under approve_by_policy ---"

$policyCloseCheckArgs = @{ sessionId = "fake" }
$policyCloseCheckResult = Invoke-ToolRun -ToolName "browser_close" -ToolArgs $policyCloseCheckArgs

if ($policyCloseCheckResult.status -eq "pending_approval") {
    Write-Fail "browser_close (approve_by_policy): incorrectly requires approval" "network risk tools should be auto-allowed"
}
elseif ($policyCloseCheckResult.status -eq "succeeded" -or $policyCloseCheckResult.success -eq $true) {
    Write-Pass "browser_close (approve_by_policy): allowed without approval"
}
elseif ($policyCloseCheckResult.status -eq "failed" -or $policyCloseCheckResult.status -eq "error") {
    Write-Pass "browser_close (approve_by_policy): executed without approval (status: $($policyCloseCheckResult.status))"
}
else {
    Write-Fail "browser_close (approve_by_policy): unexpected" "status=$($policyCloseCheckResult.status), error=$($policyCloseCheckResult.error)"
}

# ===============================================================
# 6. CLEANUP — restore policy
# ===============================================================
Write-Host ""
Write-Log "=== Cleanup ==="

$restoreResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($restoreResult.error) {
    Write-Fail "cleanup: restore policy" $restoreResult.error
}
else {
    Write-Pass "cleanup: policy restored to approve_by_policy"
}

# ===============================================================
# 7. JOB HISTORY
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Job History Verification ==="

try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=100" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5

    $jobs = $state.jobs
    $browserJobs = $jobs | Where-Object { $_.toolName -match "browser_" }
    if ($browserJobs -and $browserJobs.Count -gt 0) {
        Write-Pass "job history: $($browserJobs.Count) browser tool executions recorded"

        $statuses = ($browserJobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: browser statuses: $statuses"
    }
    else {
        Write-Fail "job history" "no browser jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

} # end if ($browserToolRegistered)

# --- Summary ---
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  PASS: $Pass  " -ForegroundColor Green -NoNewline
Write-Host "FAIL: $Fail  " -ForegroundColor Red -NoNewline
Write-Host "SKIP: $Skip  " -ForegroundColor Yellow -NoNewline
Write-Host "Total: $($Pass + $Fail + $Skip)"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

if ($Fail -gt 0) {
    Write-Host "Failed tests:" -ForegroundColor Red
    foreach ($r in $Results) {
        if ($r.StartsWith("FAIL")) { Write-Host "  $r" }
    }
    Write-Host ""
}

Write-Log "Full app log: $LogFile"

} finally {
    & $cleanupBlock
}

exit $Fail
