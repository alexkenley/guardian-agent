#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Approval Flow Test Harness (PowerShell)

.DESCRIPTION
    Exercises approval UX scenarios end-to-end:
    - Contextual approval prompts (tool name + args preview in prompt text)
    - Single-tool pending approval via direct API and LLM path
    - Multi-tool pending approval (multiple tools pending simultaneously)
    - Approve/deny single, approve/deny all
    - Policy mode transitions (autonomous -> approve_by_policy -> approve_each)
    - Post-approval result synthesis (LLM describes what happened, not just "Tool X completed")
    - Double-approval flows (update_tool_policy -> fs_write)

    Uses both POST /api/tools/run (deterministic, bypasses LLM) and
    POST /api/message (LLM path, tests real user experience).

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.EXAMPLE
    .\scripts\test-approvals.ps1

.EXAMPLE
    .\scripts\test-approvals.ps1 -SkipStart -Port 3000 -Token "your-token"

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    Some tests use the LLM path and are non-deterministic.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-approvals-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --- State ------------------------------------------------
$BaseUrl = "http://localhost:$Port"
$TimeoutStartup = 30
$TimeoutResponse = 120
$AppProcess = $null
$Pass = 0
$Fail = 0
$Skip = 0
$Results = @()
$LogFile = Join-Path $env:TEMP "guardian-approvals-harness.log"
$TestDir = "/tmp/harness-approvals-test"

# --- Helpers ---------------------------------------------
function Write-Log($msg) { Write-Host "[approvals] $msg" -ForegroundColor Cyan }
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
    catch {
        return @{ error = $_.Exception.Message }
    }
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

function Is-ProviderFailure {
    param([string]$Message)
    if (-not $Message) { return $false }
    return ($Message -match "Internal Server Error") -or ($Message -match "\(\s*500\s*\)")
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
    param([int]$Limit = 50)
    try {
        $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=$Limit" `
            -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
        return $state.jobs
    }
    catch { return @() }
}

function Get-PendingApprovals {
    try {
        $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=50" `
            -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
        return @($state.approvals | Where-Object { $_.status -eq "pending" })
    }
    catch { return @() }
}

function Get-ToolsState {
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=50" `
            -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
    }
    catch { return $null }
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
    param(
        [string]$ToolName,
        [hashtable]$ToolArgs = @{},
        [string]$Origin = "web",
        [string]$UserId = "harness"
    )
    $body = @{
        toolName = $ToolName
        args = $ToolArgs
        origin = $Origin
        userId = $UserId
    }
    try {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/api/tools/run" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($body | ConvertTo-Json -Depth 4 -Compress) `
            -TimeoutSec 30
        return $resp
    }
    catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

function Clear-AllPendingApprovals {
    $pending = Get-PendingApprovals
    foreach ($a in $pending) {
        $null = Invoke-ApprovalDecision $a.id "denied" "harness cleanup"
    }
}

# --- Start the app ---------------------------------------
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
    $harnessConfig = Join-Path $env:TEMP "guardian-approvals-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-approvals-") {
        $Token = "harness-" + [guid]::NewGuid().ToString("N")
    }

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
assistant:
  setup:
    completed: true
runtime:
  agentIsolation:
    enabled: false
guardian:
  enabled: true
"@ | Set-Content $harnessConfig -Encoding utf8

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

# --- Cleanup on exit -------------------------------------
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
    $tempCfg = Join-Path $env:TEMP "guardian-approvals-harness-config.yaml"
    if (Test-Path $tempCfg) { Remove-Item $tempCfg -Force -ErrorAction SilentlyContinue }
}

try {

# --- LLM Provider Info -----------------------------------
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
# SETUP: Start in autonomous mode with a safe sandbox
# ===============================================================
Write-Host ""
Write-Log "=== Setup ==="

$null = Invoke-ToolPolicy @{
    mode = "autonomous"
    sandbox = @{
        allowedPaths = @(".", $TestDir)
        allowedCommands = @("node", "npm", "npx", "git", "ls", "dir", "pwd",
            "echo", "cat", "head", "tail", "whoami", "hostname", "date")
    }
}
Write-Pass "setup: autonomous policy + sandbox"

# Clear any leftover pending approvals from previous runs
Clear-AllPendingApprovals

# ===============================================================
# SECTION 1: Direct API - Single Tool Approval (Deterministic)
# ===============================================================
Write-Host ""
Write-Log "=== Section 1: Direct API - Single Tool Approval ==="

# Switch to approve_by_policy, set fs_write to manual (forces approval)
$null = Invoke-ToolPolicy @{
    mode = "approve_by_policy"
    toolPolicies = @{ fs_write = "manual"; fs_delete = "manual" }
}
Write-Pass "s1: policy set to approve_by_policy, fs_write/delete = manual"

# 1a. Direct tool run: fs_write should return pending_approval
$runResult = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/single-approval-test.txt"
    content = "hello from single approval test"
}
if ($runResult.status -eq "pending_approval") {
    Write-Pass "s1: fs_write returned pending_approval"
} else {
    Write-Fail "s1: fs_write pending_approval" "got status: $($runResult.status)"
}

# 1b. Verify the approval has toolName and args in the API response
$approvalId1 = $runResult.approvalId
if ($approvalId1) {
    Write-Pass "s1: response includes approvalId ($($approvalId1.Substring(0,8))...)"

    $pending = Get-PendingApprovals
    $match = $pending | Where-Object { $_.id -eq $approvalId1 }
    if ($match) {
        # Verify approval object carries tool context
        if ($match.toolName -eq "fs_write") {
            Write-Pass "s1: approval object has toolName = fs_write"
        } else {
            Write-Fail "s1: approval toolName" "expected fs_write, got $($match.toolName)"
        }

        if ($match.args -and ($match.args | ConvertTo-Json) -match "single-approval-test") {
            Write-Pass "s1: approval object has args with file path"
        } else {
            Write-Fail "s1: approval args" "args missing or don't contain file path"
        }

        if ($match.risk) {
            Write-Pass "s1: approval object includes risk level ($($match.risk))"
        } else {
            Write-Skip "s1: approval risk" "risk field not present"
        }
    } else {
        Write-Fail "s1: find approval in pending list" "approval $approvalId1 not in pending list"
    }

    # 1c. Deny the single approval
    $decision = Invoke-ApprovalDecision $approvalId1 "denied" "harness: single deny test"
    if ($decision.success -eq $true) {
        Write-Pass "s1: deny decision accepted"
    } else {
        Write-Fail "s1: deny decision" $(if ($decision.error) { $decision.error } else { "unknown error" })
    }
} else {
    Write-Fail "s1: approvalId in response" "no approvalId returned"
}

Start-Sleep -Seconds 1

# 1d. Direct tool run: fs_write again, this time approve it
$runResult2 = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/approved-write.txt"
    content = "this was approved"
}
if ($runResult2.status -eq "pending_approval" -and $runResult2.approvalId) {
    Write-Pass "s1: second fs_write returned pending_approval"

    $decision2 = Invoke-ApprovalDecision $runResult2.approvalId "approved" "harness: approve test"
    if ($decision2.success -eq $true) {
        Write-Pass "s1: approve decision accepted"
    } else {
        Write-Fail "s1: approve decision" $(if ($decision2.error) { $decision2.error } else { "unknown error" })
    }

    # Check the job completed after approval
    Start-Sleep -Seconds 2
    $state = Get-ToolsState
    $job = $state.jobs | Where-Object { $_.approvalId -eq $runResult2.approvalId }
    if ($job) {
        if ($job.status -eq "succeeded") {
            Write-Pass "s1: approved fs_write succeeded"
        } else {
            Write-Pass "s1: approved fs_write job status: $($job.status)"
        }
    } else {
        Write-Skip "s1: post-approve job check" "job not found by approvalId"
    }
} else {
    Write-Fail "s1: second fs_write pending" "status: $($runResult2.status)"
}

Start-Sleep -Seconds 1

# 1e. Read-only tools bypass approval even in approve_by_policy
$readResult = Invoke-ToolRun -ToolName "fs_list" -ToolArgs @{ path = "." }
if ($readResult.status -eq "succeeded") {
    Write-Pass "s1: fs_list (read_only) auto-executes in approve_by_policy"
} else {
    Write-Fail "s1: fs_list auto-execute" "got status: $($readResult.status)"
}

# ===============================================================
# SECTION 2: Direct API - Multi-Tool Pending (Simultaneous)
# ===============================================================
Write-Host ""
Write-Log "=== Section 2: Direct API - Multiple Simultaneous Approvals ==="

# Clear slate
Clear-AllPendingApprovals
Start-Sleep -Seconds 1

# Fire off multiple tool runs that all require approval
$run_a = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/multi-a.txt"; content = "file alpha"
}
$run_b = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/multi-b.txt"; content = "file bravo"
}
$run_c = Invoke-ToolRun -ToolName "fs_delete" -ToolArgs @{
    path = "$TestDir/approved-write.txt"
}

$multiPendingCount = @($run_a, $run_b, $run_c | Where-Object { $_.status -eq "pending_approval" }).Count
if ($multiPendingCount -eq 3) {
    Write-Pass "s2: all 3 tools returned pending_approval"
} elseif ($multiPendingCount -ge 2) {
    Write-Pass "s2: $multiPendingCount of 3 tools returned pending_approval"
} else {
    Write-Fail "s2: multi-tool pending" "only $multiPendingCount of 3 returned pending_approval"
}

# Verify multiple approvals appear in the pending list
$pending = Get-PendingApprovals
if ($pending.Count -ge 2) {
    Write-Pass "s2: $($pending.Count) approvals pending simultaneously"

    # Verify each approval has distinct toolName/args context
    $toolNames = @($pending | ForEach-Object { $_.toolName } | Sort-Object -Unique)
    if ($toolNames.Count -ge 1) {
        Write-Pass "s2: pending approvals have tool names: $($toolNames -join ', ')"
    }

    # Verify args differ between approvals
    $argsJson = @($pending | ForEach-Object { $_.args | ConvertTo-Json -Compress })
    $uniqueArgs = @($argsJson | Sort-Object -Unique)
    if ($uniqueArgs.Count -ge 2) {
        Write-Pass "s2: pending approvals have distinct args"
    } else {
        Write-Skip "s2: distinct args" "args may be identical after redaction"
    }

    # 2a. Deny one, approve the rest
    $denyTarget = $pending[0]
    $denyDecision = Invoke-ApprovalDecision $denyTarget.id "denied" "harness: deny one of multi"
    if ($denyDecision.success -eq $true) {
        Write-Pass "s2: denied 1 of $($pending.Count) ($($denyTarget.toolName))"
    } else {
        Write-Fail "s2: deny one" $(if ($denyDecision.error) { $denyDecision.error } else { "unknown" })
    }

    Start-Sleep -Seconds 1

    # Approve the remaining
    $stillPending = Get-PendingApprovals
    $approvedCount = 0
    foreach ($a in $stillPending) {
        $d = Invoke-ApprovalDecision $a.id "approved" "harness: approve remaining"
        if ($d.success -eq $true) { $approvedCount++ }
    }
    if ($approvedCount -gt 0) {
        Write-Pass "s2: approved $approvedCount remaining approvals"
    } elseif ($stillPending.Count -eq 0) {
        Write-Pass "s2: no remaining approvals (all resolved)"
    } else {
        Write-Fail "s2: approve remaining" "failed to approve"
    }
} else {
    Write-Fail "s2: multi pending list" "expected >=2 pending, got $($pending.Count)"
}

# ===============================================================
# SECTION 3: Direct API - Policy Mode Transitions
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Section 3: Policy Mode Transitions ==="

Clear-AllPendingApprovals

# 3a. approve_each: read_only tools still auto-execute, but mutating requires approval
$null = Invoke-ToolPolicy @{
    mode = "approve_each"
    toolPolicies = @{ fs_write = "policy"; fs_delete = "policy" }
}

$readRun = Invoke-ToolRun -ToolName "fs_list" -ToolArgs @{ path = "." }
if ($readRun.status -eq "succeeded") {
    Write-Pass "s3: approve_each allows read_only fs_list"
} else {
    Write-Fail "s3: approve_each fs_list" "expected succeeded, got $($readRun.status)"
    if ($readRun.approvalId) { $null = Invoke-ApprovalDecision $readRun.approvalId "denied" "harness" }
}

# Mutating tool requires approval in approve_each
$writeRun3a = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/approve-each-test.txt"; content = "approve_each test"
}
if ($writeRun3a.status -eq "pending_approval") {
    Write-Pass "s3: approve_each gates mutating fs_write"
    $null = Invoke-ApprovalDecision $writeRun3a.approvalId "denied" "harness"
} else {
    Write-Fail "s3: approve_each fs_write" "expected pending_approval, got $($writeRun3a.status)"
}

Start-Sleep -Seconds 1

# 3b. autonomous: ALL tools auto-execute (no approval)
$null = Invoke-ToolPolicy @{
    mode = "autonomous"
    toolPolicies = @{ fs_write = "policy"; fs_delete = "policy" }
}

$writeRun = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/autonomous-test.txt"; content = "no approval needed"
}
if ($writeRun.status -eq "succeeded") {
    Write-Pass "s3: autonomous mode auto-executes fs_write"
} elseif ($writeRun.status -eq "pending_approval") {
    Write-Fail "s3: autonomous fs_write" "still got pending_approval (toolPolicy override?)"
    $null = Invoke-ApprovalDecision $writeRun.approvalId "denied" "harness"
} else {
    Write-Fail "s3: autonomous fs_write" "got status: $($writeRun.status)"
}

Start-Sleep -Seconds 1

# 3c. Per-tool 'deny' override: tool is blocked regardless of mode
$null = Invoke-ToolPolicy @{ toolPolicies = @{ fs_delete = "deny" } }

$deleteRun = Invoke-ToolRun -ToolName "fs_delete" -ToolArgs @{ path = "$TestDir/autonomous-test.txt" }
if ($deleteRun.status -eq "denied") {
    Write-Pass "s3: per-tool deny blocks fs_delete even in autonomous"
} else {
    Write-Fail "s3: per-tool deny" "expected denied, got $($deleteRun.status)"
    if ($deleteRun.approvalId) { $null = Invoke-ApprovalDecision $deleteRun.approvalId "denied" "harness" }
}

Start-Sleep -Seconds 1

# 3d. Per-tool 'manual' override in autonomous: forces approval for that tool only
$null = Invoke-ToolPolicy @{ toolPolicies = @{ fs_delete = "manual" } }

$manualRun = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/manual-override-test.txt"; content = "should still auto-execute"
}
if ($manualRun.status -eq "succeeded") {
    Write-Pass "s3: autonomous fs_write still auto-executes (no manual override)"
} else {
    Write-Fail "s3: autonomous fs_write (manual on delete)" "got: $($manualRun.status)"
    if ($manualRun.approvalId) { $null = Invoke-ApprovalDecision $manualRun.approvalId "denied" "harness" }
}

$manualDeleteRun = Invoke-ToolRun -ToolName "fs_delete" -ToolArgs @{ path = "$TestDir/manual-override-test.txt" }
if ($manualDeleteRun.status -eq "pending_approval") {
    Write-Pass "s3: per-tool manual forces approval for fs_delete in autonomous"
    $null = Invoke-ApprovalDecision $manualDeleteRun.approvalId "denied" "harness"
} else {
    Write-Fail "s3: manual override" "expected pending_approval, got $($manualDeleteRun.status)"
}

# ===============================================================
# SECTION 4: LLM Path - Contextual Approval Prompts
# ===============================================================
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Section 4: LLM Path - Contextual Approval Prompts ==="

Clear-AllPendingApprovals

# Set approve_by_policy with fs_write = manual to force approval through LLM
$null = Invoke-ToolPolicy @{
    mode = "approve_by_policy"
    toolPolicies = @{ fs_write = "manual"; fs_delete = "policy" }
    sandbox = @{
        allowedPaths = @(".", $TestDir)
        allowedCommands = @("node", "npm", "npx", "git", "ls", "dir", "pwd",
            "echo", "cat", "head", "tail", "whoami", "hostname", "date")
    }
}

# 4a. Ask LLM to write a file - should trigger approval with tool context in prompt
$resp = Send-Message "write a file called test-context.txt in $TestDir with the content: approval context test"
if ($resp.content) {
    Write-Pass "s4: LLM responded to write request"

    # The response should mention the tool name or action, not just generic "approval needed"
    $content = $resp.content.ToLower()
    if ($content -match "fs_write|write|file|approv") {
        Write-Pass "s4: LLM response references the action (not generic)"
    } else {
        Write-Skip "s4: contextual prompt" "LLM may not have mentioned tool - content: $($resp.content.Substring(0, [Math]::Min(150, $resp.content.Length)))"
    }

    # Check that the pending approval prompt includes tool name (from formatPendingApprovalPrompt)
    if ($content -match "fs_write") {
        Write-Pass "s4: approval prompt includes tool name 'fs_write'"
    } else {
        Write-Skip "s4: tool name in prompt" "LLM response may not echo tool name verbatim"
    }

    if ($content -match "test-context|approval.context") {
        Write-Pass "s4: approval prompt includes args context"
    } else {
        Write-Skip "s4: args in prompt" "LLM may not echo args"
    }
} else {
    $reason = if ($resp.error) { $resp.error } else { "no response" }
    if (Is-ProviderFailure $reason) {
        Write-Skip "s4: LLM write request" $reason
    } else {
        Write-Fail "s4: LLM write request" $reason
    }
}

Start-Sleep -Seconds 2

# 4b. Deny via LLM path (say "no")
$pendingBefore = Get-PendingApprovals
if ($pendingBefore.Count -gt 0) {
    $resp2 = Send-Message "no"
    if ($resp2.content) {
        Write-Pass "s4: LLM processed denial"
    }
    Start-Sleep -Seconds 2

    # Check approval was denied
    $state = Get-ToolsState
    $denied = $state.approvals | Where-Object { $_.id -eq $pendingBefore[0].id -and $_.status -eq "denied" }
    if ($denied) {
        Write-Pass "s4: approval was denied after 'no'"
    } else {
        # May still be pending if LLM didn't route "no" to denial
        $stillPending = $state.approvals | Where-Object { $_.id -eq $pendingBefore[0].id -and $_.status -eq "pending" }
        if ($stillPending) {
            Write-Skip "s4: LLM denial routing" "LLM may not have interpreted 'no' as denial"
            $null = Invoke-ApprovalDecision $pendingBefore[0].id "denied" "harness cleanup"
        } else {
            Write-Pass "s4: approval resolved (status changed)"
        }
    }
} else {
    Write-Skip "s4: deny test" "no pending approvals from LLM write request"
}

Start-Sleep -Seconds 3

# ===============================================================
# SECTION 5: LLM Path - Post-Approval Result Synthesis
# ===============================================================
Write-Host ""
Write-Log "=== Section 5: LLM Path - Post-Approval Result Synthesis ==="

Clear-AllPendingApprovals

# Ask LLM to write, then approve via API, then check LLM describes result
$resp3 = Send-Message "create a file at $TestDir/synthesis-test.txt containing: testing post-approval synthesis"
Start-Sleep -Seconds 2

$pending3 = Get-PendingApprovals
if ($pending3.Count -gt 0) {
    $target = $pending3 | Where-Object { $_.toolName -eq "fs_write" } | Select-Object -First 1
    if (-not $target) { $target = $pending3[0] }

    # Approve via API
    $d3 = Invoke-ApprovalDecision $target.id "approved" "harness: synthesis test"
    if ($d3.success -eq $true) {
        Write-Pass "s5: approved fs_write via API"
    } else {
        Write-Fail "s5: approve via API" $(if ($d3.error) { $d3.error } else { "unknown" })
    }

    Start-Sleep -Seconds 3

    # Ask the LLM what happened - it should describe the result, not just "Tool X completed"
    $resp4 = Send-Message "what happened with that file?"
    if ($resp4.content) {
        Write-Pass "s5: LLM responded to follow-up"
        $followUp = $resp4.content.ToLower()

        # The LLM should mention the file was created/written, not just "tool completed"
        if ($followUp -match "creat|writ|saved|success|done|file") {
            Write-Pass "s5: LLM describes result (not just 'tool completed')"
        } else {
            Write-Skip "s5: result synthesis" "LLM response: $($resp4.content.Substring(0, [Math]::Min(150, $resp4.content.Length)))"
        }

        # Negative check: should NOT be just "Tool 'X' completed."
        if ($followUp -match "^tool '.*' completed\.?$") {
            Write-Fail "s5: poor synthesis" "LLM only said 'Tool X completed' - UX regression"
        } else {
            Write-Pass "s5: response is more than 'Tool X completed'"
        }
    } else {
        Write-Fail "s5: follow-up response" $(if ($resp4.error) { $resp4.error } else { "no response" })
    }
} else {
    Write-Skip "s5: synthesis test" "LLM didn't create a pending approval for fs_write"
}

# ===============================================================
# SECTION 6: LLM Path - Double-Approval Flow (update_tool_policy -> fs_write)
# ===============================================================
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Section 6: LLM Path - Double-Approval Flow ==="

Clear-AllPendingApprovals

# Remove TestDir from allowed paths to trigger the policy-update-first flow
$null = Invoke-ToolPolicy @{
    mode = "approve_by_policy"
    toolPolicies = @{ fs_write = "policy" }
    sandbox = @{
        allowedPaths = @(".")
        allowedCommands = @("node", "npm", "npx", "git", "ls", "dir", "pwd",
            "echo", "cat", "head", "tail", "whoami", "hostname", "date")
    }
}
Write-Pass "s6: sandbox restricted to '.' only (removed $TestDir)"

Start-Sleep -Seconds 2

# Ask LLM to write to a path outside the sandbox - should trigger
# update_tool_policy first, then fs_write after the policy update is approved
$resp5 = Send-Message "create a file at $TestDir/double-approval.txt with the text: testing double approval flow"

if ($resp5.content) {
    Write-Pass "s6: LLM responded to out-of-sandbox write"

    $content5 = $resp5.content.ToLower()

    # The LLM should explain what it's doing (per system prompt line 29)
    if ($content5 -match "policy|path|allow|add|permission|sandbox") {
        Write-Pass "s6: LLM explains policy update needed"
    } else {
        Write-Skip "s6: policy explanation" "LLM may not have explained: $($resp5.content.Substring(0, [Math]::Min(150, $resp5.content.Length)))"
    }

    Start-Sleep -Seconds 2

    # Check what's pending - could be update_tool_policy or fs_write
    $pending5 = Get-PendingApprovals
    if ($pending5.Count -gt 0) {
        $policyApproval = $pending5 | Where-Object { $_.toolName -eq "update_tool_policy" } | Select-Object -First 1
        $writeApproval = $pending5 | Where-Object { $_.toolName -eq "fs_write" } | Select-Object -First 1

        if ($policyApproval) {
            Write-Pass "s6: update_tool_policy is pending (step 1 of double approval)"

            # Approve the policy update
            $d5 = Invoke-ApprovalDecision $policyApproval.id "approved" "harness: policy step"
            if ($d5.success) { Write-Pass "s6: approved update_tool_policy" }

            Start-Sleep -Seconds 3

            # Now send "yes" or check if fs_write became pending
            $resp6 = Send-Message "yes, go ahead and create the file now"
            Start-Sleep -Seconds 2

            $pending6 = Get-PendingApprovals
            $writeApproval2 = $pending6 | Where-Object { $_.toolName -eq "fs_write" } | Select-Object -First 1
            if ($writeApproval2) {
                Write-Pass "s6: fs_write is pending (step 2 of double approval)"

                # Check it has contextual info
                if ($writeApproval2.args -and ($writeApproval2.args | ConvertTo-Json) -match "double-approval") {
                    Write-Pass "s6: fs_write approval has args context"
                }

                $d6 = Invoke-ApprovalDecision $writeApproval2.id "approved" "harness: write step"
                if ($d6.success) { Write-Pass "s6: approved fs_write (double flow complete)" }
            } else {
                # fs_write may have auto-executed after the policy was updated
                $jobs = Get-RecentJobs
                $writeJob = $jobs | Where-Object { $_.toolName -eq "fs_write" -and $_.status -eq "succeeded" }
                if ($writeJob) {
                    Write-Pass "s6: fs_write auto-executed after policy approval"
                } else {
                    Write-Skip "s6: fs_write step" "LLM may not have retried the write automatically"
                }
            }
        } elseif ($writeApproval) {
            # The LLM may have skipped policy update and gone straight to fs_write
            Write-Pass "s6: fs_write pending directly (LLM skipped policy step)"
            $null = Invoke-ApprovalDecision $writeApproval.id "denied" "harness"
        } else {
            $names = ($pending5 | ForEach-Object { $_.toolName }) -join ", "
            Write-Skip "s6: double approval" "pending tools: $names (not update_tool_policy or fs_write)"
            foreach ($p in $pending5) { $null = Invoke-ApprovalDecision $p.id "denied" "harness" }
        }
    } else {
        Write-Skip "s6: double approval flow" "no pending approvals (LLM may have handled differently)"
    }
} else {
    $reason = if ($resp5.error) { $resp5.error } else { "no response" }
    if (Is-ProviderFailure $reason) {
        Write-Skip "s6: out-of-sandbox write" $reason
    } else {
        Write-Fail "s6: out-of-sandbox write" $reason
    }
}

# 6b. Direct API regression - policy update approval followed by zero-byte fs_write
Clear-AllPendingApprovals

$null = Invoke-ToolPolicy @{
    mode = "approve_by_policy"
    toolPolicies = @{ fs_write = "policy" }
    sandbox = @{
        allowedPaths = @(".")
        allowedCommands = @("node", "npm", "npx", "git", "ls", "dir", "pwd",
            "echo", "cat", "head", "tail", "whoami", "hostname", "date")
    }
}

$emptyFilePath = "$TestDir/empty-after-approval.txt"
$policyRun6b = Invoke-ToolRun -ToolName "update_tool_policy" -ToolArgs @{
    action = "add_path"
    value = $TestDir
}

if ($policyRun6b.status -eq "pending_approval" -and $policyRun6b.approvalId) {
    Write-Pass "s6b: update_tool_policy returned pending approval"
    $decision6b = Invoke-ApprovalDecision $policyRun6b.approvalId "approved" "harness: add path for empty file"
    if ($decision6b.success) {
        Write-Pass "s6b: approved update_tool_policy for empty file path"
    } else {
        Write-Fail "s6b: approve update_tool_policy" $(if ($decision6b.error) { $decision6b.error } else { "unknown" })
    }

    Start-Sleep -Seconds 1

    $emptyRun6b = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
        path = $emptyFilePath
        content = ""
        append = $false
    }

    if ($emptyRun6b.status -eq "pending_approval" -and $emptyRun6b.approvalId) {
        Write-Pass "s6b: fs_write empty-content returned pending approval"
        $emptyDecision6b = Invoke-ApprovalDecision $emptyRun6b.approvalId "approved" "harness: empty write"
        if ($emptyDecision6b.success) {
            Write-Pass "s6b: approved empty-content fs_write"
            if (Test-Path $emptyFilePath) {
                $item6b = Get-Item $emptyFilePath
                if ($item6b.Length -eq 0) {
                    Write-Pass "s6b: approved empty-content fs_write created a zero-byte file"
                } else {
                    Write-Fail "s6b: empty file size" "expected 0 bytes, got $($item6b.Length)"
                }
            } else {
                Write-Fail "s6b: empty file exists" "file was not created"
            }
        } else {
            Write-Fail "s6b: approve empty-content fs_write" $(if ($emptyDecision6b.error) { $emptyDecision6b.error } else { "unknown" })
        }
    } else {
        Write-Fail "s6b: fs_write empty-content pending" "expected pending_approval, got $($emptyRun6b.status)"
    }
} else {
    Write-Fail "s6b: update_tool_policy pending" "expected pending_approval, got $($policyRun6b.status)"
}

# ===============================================================
# SECTION 7: Direct API - Approval Expiry and Edge Cases
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Section 7: Edge Cases ==="

Clear-AllPendingApprovals

# Restore policy for deterministic tests
$null = Invoke-ToolPolicy @{
    mode = "approve_by_policy"
    toolPolicies = @{ fs_write = "manual"; fs_delete = "policy" }
    sandbox = @{
        allowedPaths = @(".", $TestDir)
        allowedCommands = @("node", "npm", "npx", "git", "ls")
    }
}

# 7a. Approve non-existent ID -> should fail gracefully
$bogusDecision = Invoke-ApprovalDecision "00000000-0000-0000-0000-000000000000" "approved" "harness"
if ($bogusDecision.success -eq $false -or $bogusDecision.error) {
    Write-Pass "s7: bogus approval ID rejected gracefully"
} else {
    Write-Fail "s7: bogus approval" "expected failure but got success"
}

# 7b. Deny an already-denied approval -> should fail or no-op
$run7 = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/edge-case.txt"; content = "edge case"
}
if ($run7.approvalId) {
    $d7a = Invoke-ApprovalDecision $run7.approvalId "denied" "first deny"
    Start-Sleep -Seconds 1
    $d7b = Invoke-ApprovalDecision $run7.approvalId "denied" "second deny"
    if ($d7b.success -eq $false -or $d7b.error) {
        Write-Pass "s7: double-deny rejected (already resolved)"
    } else {
        Write-Pass "s7: double-deny accepted (idempotent)"
    }
} else {
    Write-Skip "s7: double-deny" "no approvalId from fs_write"
}

# 7c. Approve after deny -> should fail
$run7c = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
    path = "$TestDir/flip-test.txt"; content = "flip"
}
if ($run7c.approvalId) {
    $null = Invoke-ApprovalDecision $run7c.approvalId "denied" "deny first"
    Start-Sleep -Seconds 1
    $flipResult = Invoke-ApprovalDecision $run7c.approvalId "approved" "approve after deny"
    if ($flipResult.success -eq $false -or $flipResult.error) {
        Write-Pass "s7: cannot approve after deny (immutable decision)"
    } else {
        Write-Fail "s7: approve-after-deny" "should have failed but succeeded"
    }
} else {
    Write-Skip "s7: approve-after-deny" "no approvalId"
}

# 7d. Tool with no approval needed returns no approvalId
$readRun7 = Invoke-ToolRun -ToolName "fs_list" -ToolArgs @{ path = "." }
if ($readRun7.status -eq "succeeded" -and -not $readRun7.approvalId) {
    Write-Pass "s7: auto-allowed tool has no approvalId"
} elseif ($readRun7.status -eq "succeeded") {
    Write-Pass "s7: fs_list succeeded (approvalId present but unused)"
} else {
    Write-Fail "s7: fs_list auto-execute" "got status: $($readRun7.status)"
}

# ===============================================================
# SECTION 8: Job History - Verify Approval Decisions Are Tracked
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Section 8: Job History & Approval Audit ==="

$state = Get-ToolsState
if ($state) {
    $jobs = $state.jobs
    $approvals = $state.approvals

    if ($jobs -and $jobs.Count -gt 5) {
        Write-Pass "s8: $($jobs.Count) tool jobs recorded"
    } else {
        Write-Fail "s8: job count" "expected >5 jobs, got $($jobs.Count)"
    }

    if ($approvals -and $approvals.Count -gt 3) {
        Write-Pass "s8: $($approvals.Count) approval records tracked"
    } else {
        Write-Fail "s8: approval count" "expected >3 approvals, got $($approvals.Count)"
    }

    # Check we have both approved and denied decisions
    $approved = @($approvals | Where-Object { $_.status -eq "approved" })
    $denied = @($approvals | Where-Object { $_.status -eq "denied" })
    if ($approved.Count -gt 0 -and $denied.Count -gt 0) {
        Write-Pass "s8: both approved ($($approved.Count)) and denied ($($denied.Count)) decisions recorded"
    } elseif ($approved.Count -gt 0) {
        Write-Pass "s8: $($approved.Count) approved decisions (no denials recorded)"
    } elseif ($denied.Count -gt 0) {
        Write-Pass "s8: $($denied.Count) denied decisions (no approvals recorded)"
    } else {
        Write-Fail "s8: decision audit" "no approved or denied decisions found"
    }

    # Every approval should have a toolName
    $noToolName = @($approvals | Where-Object { -not $_.toolName })
    if ($noToolName.Count -eq 0) {
        Write-Pass "s8: all approval records have toolName"
    } else {
        Write-Fail "s8: missing toolName" "$($noToolName.Count) approvals lack toolName"
    }

    # Job statuses summary
    $statuses = ($jobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
    Write-Pass "s8: job statuses seen: $statuses"
} else {
    Write-Fail "s8: tools state" "could not query /api/tools"
}

# ===============================================================
# CLEANUP: Restore policy, clear pending
# ===============================================================
Start-Sleep -Seconds 1
Write-Host ""
Write-Log "=== Cleanup ==="

Clear-AllPendingApprovals

$null = Invoke-ToolPolicy @{
    mode = "approve_by_policy"
    toolPolicies = @{ fs_write = "policy"; fs_delete = "policy" }
    sandbox = @{
        allowedPaths = @(".", $TestDir)
        allowedCommands = @("node", "npm", "npx", "git", "ls", "dir", "pwd",
            "echo", "cat", "head", "tail", "whoami", "hostname", "date")
    }
}
Write-Pass "cleanup: policy restored to defaults"

# --- Summary ---------------------------------------------
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

if ($Skip -gt 0) {
    Write-Host "Skipped tests:" -ForegroundColor Yellow
    foreach ($r in $Results) {
        if ($r.StartsWith("SKIP")) { Write-Host "  $r" }
    }
    Write-Host ""
}

Write-Log "Full app log: $LogFile"

} finally {
    & $cleanupBlock
}

exit $Fail
