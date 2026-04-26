#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Automation Tools Test Harness (PowerShell)

.DESCRIPTION
    Tests workflow CRUD (upsert/delete/run) and scheduled task CRUD
    (create/update/delete) tools, including approval gating for all
    mutating operations.

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
    .\scripts\test-automation.ps1

.EXAMPLE
    .\scripts\test-automation.ps1 -SkipStart -Port 3000 -Token "your-token"

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    All mutating operations are denied after assertion in approval tests.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-auto-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$LogFile = Join-Path $env:TEMP "guardian-auto-harness.log"

# --- Helpers ---
function Write-Log($msg) { Write-Host "[auto] $msg" -ForegroundColor Cyan }
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
    $harnessConfig = Join-Path $env:TEMP "guardian-auto-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-auto-") {
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
    $tempCfg = Join-Path $env:TEMP "guardian-auto-harness-config.yaml"
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
Write-Log "=== Automation Prerequisite Check ==="

$autoToolsAvailable = $false

# Probe automation_list (read_only) to check if automation tools are registered
$probeArgs = @{}
$automationProbe = Invoke-ToolRun -ToolName "automation_list" -ToolArgs $probeArgs

if ($automationProbe.success -eq $true -or $automationProbe.status -eq "succeeded" -or $automationProbe.status -eq "failed") {
    $autoToolsAvailable = $true
    Write-Pass "automation: tools available (probe status: $($automationProbe.status))"
}
elseif ($automationProbe.message -match "Unknown tool") {
    Write-Skip "automation: all tests" "automation_list tool not registered (automation tools may be disabled)"
}
elseif ($automationProbe.error -match "Unknown tool") {
    Write-Skip "automation: all tests" "automation_list tool not registered (automation tools may be disabled)"
}
else {
    Write-Skip "automation: all tests" "unexpected probe result: status=$($automationProbe.status), error=$($automationProbe.error), message=$($automationProbe.message)"
}

if ($autoToolsAvailable) {

# ===============================================================
# SECTION 2: READ-ONLY TESTS (autonomous mode)
# ===============================================================
Write-Host ""
Write-Log "=== Read-Only Tests (Autonomous Mode) ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for read-only tests"

Start-Sleep -Seconds 2

# --- Test: automation_list (read_only) ---
Write-Host ""
Write-Log "--- Test: automation_list (read_only) ---"

$automationListArgs = @{}
$automationListResult = Invoke-ToolRun -ToolName "automation_list" -ToolArgs $automationListArgs

if ($automationListResult.status -eq "pending_approval") {
    Write-Fail "automation_list: read_only tool should not require approval" "got pending_approval"
}
elseif ($automationListResult.success -eq $true -or $automationListResult.status -eq "succeeded" -or $automationListResult.status -eq "failed") {
    Write-Pass "automation_list: executed without approval (status: $($automationListResult.status))"
}
else {
    Write-Fail "automation_list: unexpected" "status=$($automationListResult.status), error=$($automationListResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# SECTION 3: AUTONOMOUS MODE EXECUTION
# ===============================================================
Write-Host ""
Write-Log "=== Autonomous Mode Execution Tests ==="

# --- Test: automation_save workflow (mutating) ---
Write-Host ""
Write-Log "--- Test: automation_save workflow (autonomous) ---"

$workflowSaveArgs = @{ id = "harness-test-wf"; name = "Harness Test WF"; enabled = $true; kind = "workflow"; mode = "sequential"; steps = @(@{id="step-1";toolName="sys_info";args=@{}}) }
$workflowSaveResult = Invoke-ToolRun -ToolName "automation_save" -ToolArgs $workflowSaveArgs

if ($workflowSaveResult.status -eq "pending_approval") {
    Write-Fail "automation_save workflow (autonomous): should not require approval" "got pending_approval"
}
elseif ($workflowSaveResult.success -eq $true -or $workflowSaveResult.status -eq "succeeded" -or $workflowSaveResult.status -eq "failed") {
    Write-Pass "automation_save workflow (autonomous): executed (status: $($workflowSaveResult.status))"
}
else {
    Write-Fail "automation_save workflow (autonomous): unexpected" "status=$($workflowSaveResult.status), error=$($workflowSaveResult.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_save standalone task (mutating) ---
Write-Host ""
Write-Log "--- Test: automation_save standalone task (autonomous) ---"

$taskSaveArgs = @{
    id = "harness-test-task"
    name = "harness-test-task"
    enabled = $true
    kind = "standalone_task"
    task = @{ target = "sys_info"; args = @{} }
    schedule = @{ enabled = $true; cron = "0 0 31 2 *" }
}
$taskSaveResult = Invoke-ToolRun -ToolName "automation_save" -ToolArgs $taskSaveArgs

if ($taskSaveResult.status -eq "pending_approval") {
    Write-Fail "automation_save standalone task (autonomous): should not require approval" "got pending_approval"
}
elseif ($taskSaveResult.success -eq $true -or $taskSaveResult.status -eq "succeeded" -or $taskSaveResult.status -eq "failed") {
    Write-Pass "automation_save standalone task (autonomous): executed (status: $($taskSaveResult.status))"
}
else {
    Write-Fail "automation_save standalone task (autonomous): unexpected" "status=$($taskSaveResult.status), error=$($taskSaveResult.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_delete workflow (mutating) ---
Write-Host ""
Write-Log "--- Test: automation_delete workflow (autonomous) ---"

$wfDeleteArgs = @{ automationId = "harness-test-wf" }
$wfDeleteResult = Invoke-ToolRun -ToolName "automation_delete" -ToolArgs $wfDeleteArgs

if ($wfDeleteResult.status -eq "pending_approval") {
    Write-Fail "automation_delete workflow (autonomous): should not require approval" "got pending_approval"
}
elseif ($wfDeleteResult.success -eq $true -or $wfDeleteResult.status -eq "succeeded" -or $wfDeleteResult.status -eq "failed") {
    Write-Pass "automation_delete workflow (autonomous): executed (status: $($wfDeleteResult.status))"
}
else {
    Write-Fail "automation_delete workflow (autonomous): unexpected" "status=$($wfDeleteResult.status), error=$($wfDeleteResult.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_delete standalone task (mutating) ---
Write-Host ""
Write-Log "--- Test: automation_delete standalone task (autonomous) ---"

$taskDeleteArgs = @{ automationId = "harness-test-task" }
$taskDeleteResult = Invoke-ToolRun -ToolName "automation_delete" -ToolArgs $taskDeleteArgs

if ($taskDeleteResult.status -eq "pending_approval") {
    Write-Fail "automation_delete standalone task (autonomous): should not require approval" "got pending_approval"
}
elseif ($taskDeleteResult.success -eq $true -or $taskDeleteResult.status -eq "succeeded" -or $taskDeleteResult.status -eq "failed") {
    Write-Pass "automation_delete standalone task (autonomous): executed (status: $($taskDeleteResult.status))"
}
else {
    Write-Fail "automation_delete standalone task (autonomous): unexpected" "status=$($taskDeleteResult.status), error=$($taskDeleteResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# SECTION 4: APPROVAL TESTS (approve_by_policy)
# ===============================================================
Write-Host ""
Write-Log "=== Approval Tests (approve_by_policy) ==="

$policyResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($policyResult.error) {
    Write-Fail "approval: set approve_by_policy" $policyResult.error
}
else {
    Write-Pass "approval: policy set to approve_by_policy"
}

Start-Sleep -Seconds 2

# --- Test: automation_save workflow (mutating) should require approval ---
Write-Host ""
Write-Log "--- Test: automation_save workflow under approve_by_policy ---"

$wfUpsertApprovalArgs = @{ id = "harness-test-wf-2"; name = "Harness Test WF 2"; enabled = $true; kind = "workflow"; mode = "sequential"; steps = @(@{id="step-1";toolName="sys_info";args=@{}}) }
$wfUpsertApproval = Invoke-ToolRun -ToolName "automation_save" -ToolArgs $wfUpsertApprovalArgs

if ($wfUpsertApproval.status -eq "pending_approval") {
    Write-Pass "automation_save workflow (approve_by_policy): requires approval"
    if ($wfUpsertApproval.approvalId) {
        $deny = Invoke-ApprovalDecision $wfUpsertApproval.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "automation_save workflow (approve_by_policy): denial accepted" }
        else { Write-Fail "automation_save workflow (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($wfUpsertApproval.success -eq $true) {
    Write-Fail "automation_save workflow (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "automation_save workflow (approve_by_policy): unexpected" "status=$($wfUpsertApproval.status), error=$($wfUpsertApproval.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_delete (mutating) should require approval ---
Write-Host ""
Write-Log "--- Test: automation_delete under approve_by_policy ---"

$wfDeleteApprovalArgs = @{ automationId = "harness-test-wf" }
$wfDeleteApproval = Invoke-ToolRun -ToolName "automation_delete" -ToolArgs $wfDeleteApprovalArgs

if ($wfDeleteApproval.status -eq "pending_approval") {
    Write-Pass "automation_delete (approve_by_policy): requires approval"
    if ($wfDeleteApproval.approvalId) {
        $deny = Invoke-ApprovalDecision $wfDeleteApproval.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "automation_delete (approve_by_policy): denial accepted" }
        else { Write-Fail "automation_delete (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($wfDeleteApproval.success -eq $true) {
    Write-Fail "automation_delete (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "automation_delete (approve_by_policy): unexpected" "status=$($wfDeleteApproval.status), error=$($wfDeleteApproval.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_run (mutating) should require approval ---
Write-Host ""
Write-Log "--- Test: automation_run under approve_by_policy ---"

$wfRunApprovalArgs = @{ automationId = "harness-test-wf" }
$wfRunApproval = Invoke-ToolRun -ToolName "automation_run" -ToolArgs $wfRunApprovalArgs

if ($wfRunApproval.status -eq "pending_approval") {
    Write-Pass "automation_run (approve_by_policy): requires approval"
    if ($wfRunApproval.approvalId) {
        $deny = Invoke-ApprovalDecision $wfRunApproval.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "automation_run (approve_by_policy): denial accepted" }
        else { Write-Fail "automation_run (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($wfRunApproval.success -eq $true) {
    Write-Fail "automation_run (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "automation_run (approve_by_policy): unexpected" "status=$($wfRunApproval.status), error=$($wfRunApproval.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_save standalone task (mutating) should require approval ---
Write-Host ""
Write-Log "--- Test: automation_save standalone task under approve_by_policy ---"

$taskCreateApprovalArgs = @{
    id = "harness-test-task-2"
    name = "harness-test-task-2"
    enabled = $true
    kind = "standalone_task"
    task = @{ target = "sys_info"; args = @{} }
    schedule = @{ enabled = $true; cron = "0 0 31 2 *" }
}
$taskCreateApproval = Invoke-ToolRun -ToolName "automation_save" -ToolArgs $taskCreateApprovalArgs

if ($taskCreateApproval.status -eq "pending_approval") {
    Write-Pass "automation_save standalone task (approve_by_policy): requires approval"
    if ($taskCreateApproval.approvalId) {
        $deny = Invoke-ApprovalDecision $taskCreateApproval.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "automation_save standalone task (approve_by_policy): denial accepted" }
        else { Write-Fail "automation_save standalone task (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($taskCreateApproval.success -eq $true) {
    Write-Fail "automation_save standalone task (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "automation_save standalone task (approve_by_policy): unexpected" "status=$($taskCreateApproval.status), error=$($taskCreateApproval.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_set_enabled (mutating) should require approval ---
Write-Host ""
Write-Log "--- Test: automation_set_enabled under approve_by_policy ---"

$taskUpdateApprovalArgs = @{ automationId = "harness-test-wf"; enabled = $false }
$taskUpdateApproval = Invoke-ToolRun -ToolName "automation_set_enabled" -ToolArgs $taskUpdateApprovalArgs

if ($taskUpdateApproval.status -eq "pending_approval") {
    Write-Pass "automation_set_enabled (approve_by_policy): requires approval"
    if ($taskUpdateApproval.approvalId) {
        $deny = Invoke-ApprovalDecision $taskUpdateApproval.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "automation_set_enabled (approve_by_policy): denial accepted" }
        else { Write-Fail "automation_set_enabled (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($taskUpdateApproval.success -eq $true) {
    Write-Fail "automation_set_enabled (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "automation_set_enabled (approve_by_policy): unexpected" "status=$($taskUpdateApproval.status), error=$($taskUpdateApproval.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_delete standalone task (mutating) should require approval ---
Write-Host ""
Write-Log "--- Test: automation_delete standalone task under approve_by_policy ---"

$taskDeleteApprovalArgs = @{ automationId = "harness-test-task" }
$taskDeleteApproval = Invoke-ToolRun -ToolName "automation_delete" -ToolArgs $taskDeleteApprovalArgs

if ($taskDeleteApproval.status -eq "pending_approval") {
    Write-Pass "automation_delete standalone task (approve_by_policy): requires approval"
    if ($taskDeleteApproval.approvalId) {
        $deny = Invoke-ApprovalDecision $taskDeleteApproval.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "automation_delete standalone task (approve_by_policy): denial accepted" }
        else { Write-Fail "automation_delete standalone task (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($taskDeleteApproval.success -eq $true) {
    Write-Fail "automation_delete standalone task (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "automation_delete standalone task (approve_by_policy): unexpected" "status=$($taskDeleteApproval.status), error=$($taskDeleteApproval.error)"
}

Start-Sleep -Seconds 2

# --- Test: automation_list (read_only) should NOT require approval ---
Write-Host ""
Write-Log "--- Test: automation_list under approve_by_policy ---"

$taskListApprovalArgs = @{}
$taskListApproval = Invoke-ToolRun -ToolName "automation_list" -ToolArgs $taskListApprovalArgs

if ($taskListApproval.status -eq "pending_approval") {
    Write-Fail "automation_list (approve_by_policy): incorrectly requires approval" "read_only tools should be auto-allowed"
}
elseif ($taskListApproval.success -eq $true -or $taskListApproval.status -eq "succeeded") {
    Write-Pass "automation_list (approve_by_policy): allowed without approval"
}
elseif ($taskListApproval.status -eq "failed" -or $taskListApproval.status -eq "error") {
    # Tool executed past approval gate -- acceptable
    Write-Pass "automation_list (approve_by_policy): tool executed without approval (status: $($taskListApproval.status))"
}
else {
    Write-Fail "automation_list (approve_by_policy): unexpected" "status=$($taskListApproval.status), error=$($taskListApproval.error)"
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
    $autoJobs = $jobs | Where-Object { $_.toolName -match "automation_save|automation_set_enabled|automation_run|automation_delete|automation_list" }
    if ($autoJobs -and $autoJobs.Count -gt 0) {
        Write-Pass "job history: $($autoJobs.Count) automation tool executions recorded"

        $statuses = ($autoJobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: automation statuses: $statuses"
    }
    else {
        Write-Fail "job history" "no automation jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

} # end if ($autoToolsAvailable)

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
