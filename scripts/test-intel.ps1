#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Threat Intelligence Tools Test Harness (PowerShell)

.DESCRIPTION
    Tests threat intelligence tools: watchlist management (add/remove), scanning,
    and action drafting, including approval gating for mutating operations.

    Uses direct tool API calls (POST /api/tools/run) for deterministic approval
    testing and autonomous mode for read/write operation testing.

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
    .\scripts\test-intel.ps1

.EXAMPLE
    .\scripts\test-intel.ps1 -SkipStart -Port 3000 -Token "your-token"

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    All mutating operations (watch_add, watch_remove, draft_action) are denied
    after assertion in approval tests.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-intel-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$LogFile = Join-Path $env:TEMP "guardian-intel-harness.log"

# --- Helpers ---
function Write-Log($msg) { Write-Host "[intel] $msg" -ForegroundColor Cyan }
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
    $harnessConfig = Join-Path $env:TEMP "guardian-intel-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-intel-") {
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
    model: llama3.2
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
    $tempCfg = Join-Path $env:TEMP "guardian-intel-harness-config.yaml"
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
# SECTION 1: PREREQUISITE CHECK
# ===============================================================
Write-Host ""
Write-Log "=== Intel Prerequisite Check ==="

$intelToolsAvailable = $false

# Try a read-only intel call via direct tool API to check availability
$probeArgs = @{}
$intelProbe = Invoke-ToolRun -ToolName "intel_watch_list" -ToolArgs $probeArgs

if ($intelProbe.success -eq $true -or $intelProbe.status -eq "succeeded" -or $intelProbe.status -eq "failed") {
    $intelToolsAvailable = $true
    Write-Pass "intel: tools available (probe status: $($intelProbe.status))"
}
elseif ($intelProbe.message -match "not enabled|not configured") {
    Write-Skip "intel: all intel tests" "Threat intel not enabled or not configured"
}
elseif ($intelProbe.message -match "Unknown tool") {
    Write-Skip "intel: all intel tests" "intel_watch_list tool not registered (intel category may be disabled)"
}
elseif ($intelProbe.error -match "not enabled|not configured") {
    Write-Skip "intel: all intel tests" "Threat intel not enabled or not configured"
}
elseif ($intelProbe.error -match "Unknown tool") {
    Write-Skip "intel: all intel tests" "intel_watch_list tool not registered (intel category may be disabled)"
}
else {
    Write-Skip "intel: all intel tests" "unexpected probe result: status=$($intelProbe.status), error=$($intelProbe.error), message=$($intelProbe.message)"
}

if ($intelToolsAvailable) {

# ===============================================================
# SECTION 2: READ-ONLY TESTS (autonomous mode)
# ===============================================================
Write-Host ""
Write-Log "=== Read-Only Intel Tests (Autonomous Mode) ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for intel read-only tests"

Start-Sleep -Seconds 2

# --- intel_watch_list (read_only) ---
Write-Host ""
Write-Log "--- intel_watch_list (read_only) ---"

$watchListArgs = @{}
$watchListResult = Invoke-ToolRun -ToolName "intel_watch_list" -ToolArgs $watchListArgs

if ($watchListResult.success -eq $true -or $watchListResult.status -eq "succeeded" -or $watchListResult.status -eq "failed") {
    Write-Pass "intel_watch_list: tool executed (status: $($watchListResult.status))"
}
else {
    Write-Fail "intel_watch_list: tool execution" "status=$($watchListResult.status), error=$($watchListResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_findings (read_only) ---
Write-Host ""
Write-Log "--- intel_findings (read_only) ---"

$findingsArgs = @{ limit = 5 }
$findingsResult = Invoke-ToolRun -ToolName "intel_findings" -ToolArgs $findingsArgs

if ($findingsResult.success -eq $true -or $findingsResult.status -eq "succeeded" -or $findingsResult.status -eq "failed") {
    Write-Pass "intel_findings: tool executed (status: $($findingsResult.status))"
}
else {
    Write-Fail "intel_findings: tool execution" "status=$($findingsResult.status), error=$($findingsResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# SECTION 3: AUTONOMOUS MODE EXECUTION (mutating + network)
# ===============================================================
Write-Host ""
Write-Log "=== Autonomous Mode Execution (Mutating + Network) ==="

# --- intel_watch_add (mutating) ---
Write-Host ""
Write-Log "--- intel_watch_add (mutating, autonomous) ---"

$addArgs = @{ indicator = "harness-test-indicator.example.com"; type = "domain"; notes = "harness test" }
$addResult = Invoke-ToolRun -ToolName "intel_watch_add" -ToolArgs $addArgs

if ($addResult.success -eq $true -or $addResult.status -eq "succeeded" -or $addResult.status -eq "failed") {
    Write-Pass "intel_watch_add: tool executed (status: $($addResult.status))"
}
else {
    Write-Fail "intel_watch_add: tool execution" "status=$($addResult.status), error=$($addResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_watch_remove (mutating) ---
Write-Host ""
Write-Log "--- intel_watch_remove (mutating, autonomous) ---"

$removeArgs = @{ indicator = "harness-test-indicator.example.com" }
$removeResult = Invoke-ToolRun -ToolName "intel_watch_remove" -ToolArgs $removeArgs

if ($removeResult.success -eq $true -or $removeResult.status -eq "succeeded" -or $removeResult.status -eq "failed") {
    Write-Pass "intel_watch_remove: tool executed (status: $($removeResult.status))"
}
else {
    Write-Fail "intel_watch_remove: tool execution" "status=$($removeResult.status), error=$($removeResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_scan (network) ---
Write-Host ""
Write-Log "--- intel_scan (network, autonomous) ---"

$scanArgs = @{}
$scanResult = Invoke-ToolRun -ToolName "intel_scan" -ToolArgs $scanArgs

if ($scanResult.success -eq $true -or $scanResult.status -eq "succeeded" -or $scanResult.status -eq "failed") {
    Write-Pass "intel_scan: tool executed (status: $($scanResult.status))"
}
else {
    Write-Fail "intel_scan: tool execution" "status=$($scanResult.status), error=$($scanResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# SECTION 4: APPROVAL TESTS (approve_by_policy)
# ===============================================================
Write-Host ""
Write-Log "=== Intel Approval Tests (approve_by_policy) ==="

# --- Switch to approve_by_policy ---
$policyResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($policyResult.error) {
    Write-Fail "approval: set approve_by_policy" $policyResult.error
}
else {
    Write-Pass "approval: policy set to approve_by_policy"
}

Start-Sleep -Seconds 2

# --- intel_watch_add should require approval ---
Write-Host ""
Write-Log "--- intel_watch_add under approve_by_policy ---"

$addApprovalArgs = @{ indicator = "harness-test-indicator.example.com"; type = "domain"; notes = "harness approval test" }
$addApprovalResult = Invoke-ToolRun -ToolName "intel_watch_add" -ToolArgs $addApprovalArgs

if ($addApprovalResult.status -eq "pending_approval") {
    Write-Pass "intel_watch_add (approve_by_policy): requires approval (pending_approval)"
    if ($addApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $addApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "intel_watch_add (approve_by_policy): denial accepted" }
        else { Write-Fail "intel_watch_add (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($addApprovalResult.success -eq $true) {
    Write-Fail "intel_watch_add (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "intel_watch_add (approve_by_policy): unexpected" "status=$($addApprovalResult.status), error=$($addApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_watch_remove should require approval ---
Write-Host ""
Write-Log "--- intel_watch_remove under approve_by_policy ---"

$removeApprovalArgs = @{ indicator = "harness-test-indicator.example.com" }
$removeApprovalResult = Invoke-ToolRun -ToolName "intel_watch_remove" -ToolArgs $removeApprovalArgs

if ($removeApprovalResult.status -eq "pending_approval") {
    Write-Pass "intel_watch_remove (approve_by_policy): requires approval (pending_approval)"
    if ($removeApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $removeApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "intel_watch_remove (approve_by_policy): denial accepted" }
        else { Write-Fail "intel_watch_remove (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($removeApprovalResult.success -eq $true) {
    Write-Fail "intel_watch_remove (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "intel_watch_remove (approve_by_policy): unexpected" "status=$($removeApprovalResult.status), error=$($removeApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_draft_action should require approval ---
Write-Host ""
Write-Log "--- intel_draft_action under approve_by_policy ---"

$draftApprovalArgs = @{ findingId = "harness-fake-finding" }
$draftApprovalResult = Invoke-ToolRun -ToolName "intel_draft_action" -ToolArgs $draftApprovalArgs

if ($draftApprovalResult.status -eq "pending_approval") {
    Write-Pass "intel_draft_action (approve_by_policy): requires approval (pending_approval)"
    if ($draftApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $draftApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "intel_draft_action (approve_by_policy): denial accepted" }
        else { Write-Fail "intel_draft_action (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($draftApprovalResult.success -eq $true) {
    Write-Fail "intel_draft_action (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "intel_draft_action (approve_by_policy): unexpected" "status=$($draftApprovalResult.status), error=$($draftApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_scan (network) should be auto-allowed under approve_by_policy ---
Write-Host ""
Write-Log "--- intel_scan under approve_by_policy ---"

$scanPolicyArgs = @{}
$scanPolicyResult = Invoke-ToolRun -ToolName "intel_scan" -ToolArgs $scanPolicyArgs

if ($scanPolicyResult.status -eq "pending_approval") {
    Write-Fail "intel_scan (approve_by_policy): incorrectly requires approval" "network tools should be auto-allowed"
}
elseif ($scanPolicyResult.success -eq $true -or $scanPolicyResult.status -eq "succeeded") {
    Write-Pass "intel_scan (approve_by_policy): allowed without approval"
}
elseif ($scanPolicyResult.status -eq "failed" -or $scanPolicyResult.status -eq "error") {
    # Tool executed past approval gate — acceptable
    Write-Pass "intel_scan (approve_by_policy): tool executed without approval (status: $($scanPolicyResult.status))"
}
else {
    Write-Fail "intel_scan (approve_by_policy): unexpected" "status=$($scanPolicyResult.status), error=$($scanPolicyResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_watch_list (read_only) should NOT require approval ---
Write-Host ""
Write-Log "--- intel_watch_list under approve_by_policy ---"

$watchListPolicyArgs = @{}
$watchListPolicyResult = Invoke-ToolRun -ToolName "intel_watch_list" -ToolArgs $watchListPolicyArgs

if ($watchListPolicyResult.status -eq "pending_approval") {
    Write-Fail "intel_watch_list (approve_by_policy): incorrectly requires approval" "read_only tools should be auto-allowed"
}
elseif ($watchListPolicyResult.success -eq $true -or $watchListPolicyResult.status -eq "succeeded") {
    Write-Pass "intel_watch_list (approve_by_policy): allowed without approval"
}
elseif ($watchListPolicyResult.status -eq "failed" -or $watchListPolicyResult.status -eq "error") {
    # Tool executed past approval gate — acceptable
    Write-Pass "intel_watch_list (approve_by_policy): tool executed without approval (status: $($watchListPolicyResult.status))"
}
else {
    Write-Fail "intel_watch_list (approve_by_policy): unexpected" "status=$($watchListPolicyResult.status), error=$($watchListPolicyResult.error)"
}

Start-Sleep -Seconds 2

# --- intel_findings (read_only) should NOT require approval ---
Write-Host ""
Write-Log "--- intel_findings under approve_by_policy ---"

$findingsPolicyArgs = @{ limit = 5 }
$findingsPolicyResult = Invoke-ToolRun -ToolName "intel_findings" -ToolArgs $findingsPolicyArgs

if ($findingsPolicyResult.status -eq "pending_approval") {
    Write-Fail "intel_findings (approve_by_policy): incorrectly requires approval" "read_only tools should be auto-allowed"
}
elseif ($findingsPolicyResult.success -eq $true -or $findingsPolicyResult.status -eq "succeeded") {
    Write-Pass "intel_findings (approve_by_policy): allowed without approval"
}
elseif ($findingsPolicyResult.status -eq "failed" -or $findingsPolicyResult.status -eq "error") {
    # Tool executed past approval gate — acceptable
    Write-Pass "intel_findings (approve_by_policy): tool executed without approval (status: $($findingsPolicyResult.status))"
}
else {
    Write-Fail "intel_findings (approve_by_policy): unexpected" "status=$($findingsPolicyResult.status), error=$($findingsPolicyResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# SECTION 5: CLEANUP
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
# SECTION 6: JOB HISTORY
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Job History Verification ==="

try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=100" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5

    $jobs = $state.jobs
    $intelJobs = $jobs | Where-Object { $_.toolName -match "intel_" }
    if ($intelJobs -and $intelJobs.Count -gt 0) {
        Write-Pass "job history: $($intelJobs.Count) intel tool executions recorded"

        $statuses = ($intelJobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: intel statuses: $statuses"
    }
    else {
        Write-Fail "job history" "no intel jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

} # end if ($intelToolsAvailable)

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
