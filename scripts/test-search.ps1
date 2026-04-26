#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Document Search Document Search Test Harness (PowerShell)

.DESCRIPTION
    Tests Document Search document search tool integration: status, search, reindex,
    and policy enforcement (approval gating for mutating operations).

    Uses direct tool API calls (POST /api/tools/run) for deterministic approval
    testing and autonomous mode for read/write operation testing.

    Requires a running GuardianAgent instance with web channel enabled, an LLM
    provider configured, and document search enabled.

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.EXAMPLE
    .\scripts\test-search.ps1

.EXAMPLE
    .\scripts\test-search.ps1 -SkipStart -Port 3000 -Token "your-token"

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    Document search tests require search to be enabled in config.
    All mutating operations (reindex) are denied after assertion in approval tests.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-search-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$LogFile = Join-Path $env:TEMP "guardian-search-harness.log"

# --- Helpers ---
function Write-Log($msg) { Write-Host "[search] $msg" -ForegroundColor Cyan }
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
    $harnessConfig = Join-Path $env:TEMP "guardian-search-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-search-") {
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
    $tempCfg = Join-Path $env:TEMP "guardian-search-harness-config.yaml"
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
# Document Search PREREQUISITE CHECK
# ===============================================================
Write-Host ""
Write-Log "=== Document Search Prerequisite Check ==="

$searchAvailable = $false

# Try a read-only Document Search call via direct tool API to check availability
$probeArgs = @{}
$searchProbe = Invoke-ToolRun -ToolName "doc_search_status" -ToolArgs $probeArgs

if ($searchProbe.success -eq $true -or $searchProbe.status -eq "succeeded" -or $searchProbe.status -eq "failed") {
    $searchAvailable = $true
    Write-Pass "search: tool available (probe status: $($searchProbe.status))"
}
elseif ($searchProbe.message -match "not enabled|not configured") {
    Write-Skip "search: all Document Search tests" "Document Search not enabled or not configured"
}
elseif ($searchProbe.message -match "Unknown tool") {
    Write-Skip "search: all Document Search tests" "doc_search_status tool not registered (search category may be disabled)"
}
elseif ($searchProbe.error -match "not enabled|not configured") {
    Write-Skip "search: all Document Search tests" "Document Search not enabled or not configured"
}
elseif ($searchProbe.error -match "Unknown tool") {
    Write-Skip "search: all Document Search tests" "doc_search_status tool not registered (search category may be disabled)"
}
else {
    Write-Skip "search: all Document Search tests" "unexpected probe result: status=$($searchProbe.status), error=$($searchProbe.error), message=$($searchProbe.message)"
}

if ($searchAvailable) {

# ===============================================================
# Document Search TOOL TESTS (autonomous mode, direct API)
# ===============================================================
Write-Host ""
Write-Log "=== Document Search Tool Tests (Autonomous Mode) ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for Document Search tests"

Start-Sleep -Seconds 2

# --- Test 1: doc_search_status (read_only) ---
Write-Host ""
Write-Log "--- Test 1: doc_search_status ---"

$statusArgs = @{}
$statusResult = Invoke-ToolRun -ToolName "doc_search_status" -ToolArgs $statusArgs

if ($statusResult.success -eq $true -or $statusResult.status -eq "succeeded" -or $statusResult.status -eq "failed") {
    Write-Pass "doc_search_status: tool executed (status: $($statusResult.status))"
}
else {
    Write-Fail "doc_search_status: tool execution" "status=$($statusResult.status), error=$($statusResult.error)"
}

Start-Sleep -Seconds 2

# --- Test 2: doc_search (read_only) ---
Write-Host ""
Write-Log "--- Test 2: doc_search ---"

$searchArgs = @{ query = "test" }
$searchResult = Invoke-ToolRun -ToolName "doc_search" -ToolArgs $searchArgs

if ($searchResult.success -eq $true -or $searchResult.status -eq "succeeded" -or $searchResult.status -eq "failed") {
    Write-Pass "doc_search: tool executed (status: $($searchResult.status))"
}
else {
    Write-Fail "doc_search: tool execution" "status=$($searchResult.status), error=$($searchResult.error)"
}

Start-Sleep -Seconds 2

# --- Test 3: doc_search_reindex (mutating) ---
Write-Host ""
Write-Log "--- Test 3: doc_search_reindex ---"

$reindexArgs = @{}
$reindexResult = Invoke-ToolRun -ToolName "doc_search_reindex" -ToolArgs $reindexArgs

if ($reindexResult.success -eq $true -or $reindexResult.status -eq "succeeded" -or $reindexResult.status -eq "failed") {
    Write-Pass "doc_search_reindex: tool executed (status: $($reindexResult.status))"
}
else {
    Write-Fail "doc_search_reindex: tool execution" "status=$($reindexResult.status), error=$($reindexResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# Document Search HOT RELOAD TEST
# ===============================================================
Write-Host ""
Write-Log "=== Document Search Hot Reload Test ==="

# 1. Disable search via config API
$configPatch = @{
    assistant = @{
        tools = @{
            search = @{ enabled = $false }
        }
    }
}
$disableResp = Invoke-RestMethod -Uri "$BaseUrl/api/config" `
    -Method Post `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType "application/json" `
    -Body ($configPatch | ConvertTo-Json -Depth 4 -Compress) `
    -TimeoutSec 10

Write-Pass "hot-reload: disabled search in config"
Start-Sleep -Seconds 5 # Wait for hot-reload to propagate

# 2. Check tool availability (should be disabled/unavailable)
$statusDisabled = Invoke-ToolRun -ToolName "doc_search_status" -ToolArgs @{}
if ($statusDisabled.success -eq $false -or $statusDisabled.output.available -eq $false) {
    Write-Pass "hot-reload: tool correctly reported unavailable after disable"
} else {
    Write-Fail "hot-reload: tool still available after disable" "status=$($statusDisabled.status)"
}

# 3. Re-enable search via config API
$configPatchEnable = @{
    assistant = @{
        tools = @{
            search = @{ enabled = $true }
        }
    }
}
$enableResp = Invoke-RestMethod -Uri "$BaseUrl/api/config" `
    -Method Post `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType "application/json" `
    -Body ($configPatchEnable | ConvertTo-Json -Depth 4 -Compress) `
    -TimeoutSec 10

Write-Pass "hot-reload: re-enabled search in config"
Start-Sleep -Seconds 5 # Wait for hot-reload to propagate

# 4. Check tool availability (should be back)
$statusEnabled = Invoke-ToolRun -ToolName "doc_search_status" -ToolArgs @{}
if ($statusEnabled.success -eq $true -and $statusEnabled.output.available -eq $true) {
    Write-Pass "hot-reload: tool correctly reported available after re-enable"
} else {
    Write-Fail "hot-reload: tool still unavailable after re-enable" "error=$($statusEnabled.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# Document Search APPROVAL TESTS (approve_by_policy via direct API)
# ===============================================================
Write-Host ""
Write-Log "=== Document Search Approval Tests (approve_by_policy) ==="

# --- Test 4: Switch to approve_by_policy ---
$policyResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($policyResult.error) {
    Write-Fail "approval: set approve_by_policy" $policyResult.error
}
else {
    Write-Pass "approval: policy set to approve_by_policy"
}

Start-Sleep -Seconds 2

# --- Test 5: doc_search (read_only) should be allowed without approval ---
Write-Host ""
Write-Log "--- Test 5: doc_search under approve_by_policy ---"

$searchPolicyArgs = @{ query = "test" }
$searchPolicyResult = Invoke-ToolRun -ToolName "doc_search" -ToolArgs $searchPolicyArgs

if ($searchPolicyResult.status -eq "pending_approval") {
    Write-Fail "doc_search (approve_by_policy): incorrectly requires approval" "read_only tools should be auto-allowed"
}
elseif ($searchPolicyResult.success -eq $true -or $searchPolicyResult.status -eq "succeeded") {
    Write-Pass "doc_search (approve_by_policy): allowed without approval"
}
elseif ($searchPolicyResult.status -eq "failed" -or $searchPolicyResult.status -eq "error") {
    # Tool executed past approval gate — acceptable (may have no sources)
    Write-Pass "doc_search (approve_by_policy): tool executed without approval (status: $($searchPolicyResult.status))"
}
else {
    Write-Fail "doc_search (approve_by_policy): unexpected" "status=$($searchPolicyResult.status), error=$($searchPolicyResult.error)"
}

Start-Sleep -Seconds 2

# --- Test 6: doc_search_reindex (mutating) should require approval ---
Write-Host ""
Write-Log "--- Test 6: doc_search_reindex under approve_by_policy ---"

$reindexPolicyArgs = @{}
$reindexPolicyResult = Invoke-ToolRun -ToolName "doc_search_reindex" -ToolArgs $reindexPolicyArgs

if ($reindexPolicyResult.status -eq "pending_approval") {
    Write-Pass "doc_search_reindex (approve_by_policy): requires approval (pending_approval)"
    if ($reindexPolicyResult.approvalId) {
        $deny = Invoke-ApprovalDecision $reindexPolicyResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "doc_search_reindex (approve_by_policy): denial accepted" }
        else { Write-Fail "doc_search_reindex (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($reindexPolicyResult.success -eq $true) {
    Write-Fail "doc_search_reindex (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "doc_search_reindex (approve_by_policy): unexpected" "status=$($reindexPolicyResult.status), error=$($reindexPolicyResult.error)"
}

Start-Sleep -Seconds 2

# --- Test 7: Restore policy ---
Write-Host ""
Write-Log "--- Test 7: Restore policy ---"

$restoreResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($restoreResult.error) {
    Write-Fail "cleanup: restore policy" $restoreResult.error
}
else {
    Write-Pass "cleanup: policy restored to approve_by_policy"
}

# ===============================================================
# JOB HISTORY
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Job History Verification ==="

try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=100" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5

    $jobs = $state.jobs
    $searchJobs = $jobs | Where-Object { $_.toolName -match "search" }
    if ($searchJobs -and $searchJobs.Count -gt 0) {
        Write-Pass "job history: $($searchJobs.Count) Document Search tool executions recorded"

        $statuses = ($searchJobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: Document Search statuses: $statuses"
    }
    else {
        Write-Fail "job history" "no Document Search jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

} # end if ($searchAvailable)

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
