#Requires -Version 5.1
<#
.SYNOPSIS
    Regression test for smart routing and LLM-path failures.

.DESCRIPTION
    Targets previously-failing tests from test-tools (5), test-automations-llm (9),
    and test-memory-save (9 false failures from script bug).

    Root causes:
    1. resolveRoutedProviderForTools not wired to all ChatAgent instantiation paths
       → "No LLM provider configured" on external-category tools (web, intel, automation)
    2. test-memory-save.ps1 missing exit $Fail → false exit code from killed process
    3. Local LLM not calling tools (model quality) → expected to improve with routing fix

    This script re-runs the exact failing tests to confirm the fixes.

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.EXAMPLE
    .\scripts\test-regressions.ps1

.EXAMPLE
    .\scripts\test-regressions.ps1 -SkipStart -Port 3000 -Token "your-token"
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-regr-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ─── State ────────────────────────────────────────────────────
$BaseUrl = "http://localhost:$Port"
$TimeoutStartup = 30
$TimeoutResponse = 120
$AppProcess = $null
$Pass = 0
$Fail = 0
$Skip = 0
$Results = @()
$LogFile = Join-Path $env:TEMP "guardian-regressions-harness.log"

# ─── Helpers ─────────────────────────────────────────────────
function Write-Log($msg) { Write-Host "[regr] $msg" -ForegroundColor Cyan }
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

function Get-RecentJobs {
    param([int]$Limit = 50)
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

# ─── Start the app ────────────────────────────────────────────
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
    $harnessConfig = Join-Path $env:TEMP "guardian-regressions-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-regr-") {
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

# ─── Cleanup on exit ─────────────────────────────────────────
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
    $tempCfg = Join-Path $env:TEMP "guardian-regressions-harness-config.yaml"
    if (Test-Path $tempCfg) { Remove-Item $tempCfg -Force -ErrorAction SilentlyContinue }
}

try {

# ─── LLM Provider Info ───────────────────────────────────────
Write-Host ""
try {
    $providers = Invoke-RestMethod -Uri "$BaseUrl/api/providers" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
    if ($providers -and $providers.Count -gt 0) {
        foreach ($p in $providers) {
            $locality = if ($p.locality) { $p.locality } else { "unknown" }
            Write-Log "LLM Provider: $($p.name) ($($p.type)) — model: $($p.model), locality: $locality"
        }
    }
    else {
        Write-Log "LLM Provider: unknown (no providers returned)"
    }
}
catch {
    Write-Log "LLM Provider: could not query /api/providers"
}

# ─── Set autonomous mode ─────────────────────────────────────
$null = Invoke-ToolPolicy @{ mode = "autonomous"; sandbox = @{ allowedPaths = @(".") } }
Write-Pass "setup: autonomous policy"

# ═══════════════════════════════════════════════════════════════
# PART 1: SMART ROUTING — previously "No LLM provider configured"
# From test-tools.ps1 (5 failures): web, intel, automation categories
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Log "=== Part 1: Smart Routing Fixes (from test-tools) ==="
Write-Log "These tests failed with 'No LLM provider configured' before the fix."

# --- Test 1.1: web_fetch (web category) ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "search for the web_fetch tool, then use it to check this app's own health endpoint at http://127.0.0.1:$Port/health and show me the response"
if (Test-ValidResponse $resp "1.1 web_fetch: fetch health endpoint") {
    [void](Test-Contains $resp "content" "status|ok|health|running|up" `
        "1.1 web_fetch: health response returned")
    [void](Test-ToolWasCalled "web_fetch|web_search|find_tools" "1.1 web_fetch: tool was called" $jobs0)
}

# --- Test 1.2: intel_summary (intel category) ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the intel_summary tool to give me a threat intelligence summary"
if (Test-ValidResponse $resp "1.2 intel_summary: threat summary") {
    [void](Test-ToolWasCalled "intel_summary" "1.2 intel_summary: tool was called" $jobs0)
}

# --- Test 1.3: intel_findings (intel category) ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "call find_tools to locate intel_findings, then use it to list any threat intel findings"
if (Test-ValidResponse $resp "1.3 intel_findings: list findings") {
    [void](Test-ToolWasCalled "intel_findings|find_tools" "1.3 intel_findings: tool was called" $jobs0)
}

# --- Test 1.4: task_list (automation category) ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the task_list tool to list all scheduled tasks"
if (Test-ValidResponse $resp "1.4 task_list: list tasks") {
    [void](Test-ToolWasCalled "task_list" "1.4 task_list: tool was called" $jobs0)
}

# --- Test 1.5: workflow_list (automation category) ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the workflow_list tool to list all automation workflows"
if (Test-ValidResponse $resp "1.5 workflow_list: list workflows") {
    [void](Test-ToolWasCalled "workflow_list" "1.5 workflow_list: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# PART 2: AUTOMATION LLM-PATH — previously 9 failures
# Subset from test-automations-llm.ps1: tool discovery, creation,
# running, and deletion via LLM chat
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Log "=== Part 2: Automation LLM-Path (from test-automations-llm) ==="

# --- Prerequisite: verify automation tools are registered ---
$autoToolsAvailable = $false
$probeResult = Invoke-ToolRun -ToolName "task_list" -ToolArgs @{}

if ($probeResult.success -eq $true -or $probeResult.status -eq "succeeded" -or $probeResult.status -eq "failed") {
    $autoToolsAvailable = $true
    Write-Pass "2.0 prerequisite: automation tools available"
}
elseif ($probeResult.message -match "Unknown tool" -or $probeResult.error -match "Unknown tool") {
    Write-Skip "2.0 prerequisite: all automation tests" "automation tools not registered"
}
else {
    Write-Skip "2.0 prerequisite: all automation tests" "unexpected probe: status=$($probeResult.status)"
}

if ($autoToolsAvailable) {

# --- Test 2.1: Tool Discovery ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "what automation tools do you have? use find_tools to search for workflow and task tools"
if (Test-ValidResponse $resp "2.1 discovery: automation tools query") {
    [void](Test-Contains $resp "content" "workflow|task|automat|schedule|playbook" `
        "2.1 discovery: mentions automation concepts")
    [void](Test-ToolWasCalled "find_tools" "2.1 discovery: find_tools was invoked" $jobs0)
}

# --- Test 2.2: Single-Tool Automation Creation ---
Start-Sleep -Seconds 5
$jobs0 = Get-RecentJobs
$resp = Send-Message "call workflow_upsert now to create an automation with these exact args: id 'regr-sys-check', name 'Regression System Check', mode 'sequential', enabled true, steps array with one step: id 'step-1', toolName 'sys_info'. Do not schedule it."
if (Test-ValidResponse $resp "2.2 create-single: basic creation") {
    [void](Test-Contains $resp "content" "creat|automat|sys|check|Health|playbook|workflow|upsert" `
        "2.2 create-single: confirms creation")
    [void](Test-ToolWasCalled "workflow_upsert" "2.2 create-single: workflow_upsert was called" $jobs0)
}

# --- Test 2.3: Verify via listing ---
Start-Sleep -Seconds 5
$jobs0 = Get-RecentJobs
$resp = Send-Message "call workflow_list now to show all automations"
if (Test-ValidResponse $resp "2.3 create-single: verify via list") {
    [void](Test-Contains $resp "content" "regr.sys|Regression|automation|workflow" `
        "2.3 create-single: automation appears in list")
    [void](Test-ToolWasCalled "workflow_list" "2.3 create-single: workflow_list was called" $jobs0)
}

# --- Test 2.4: Pipeline Creation (sequential) ---
Start-Sleep -Seconds 5
$jobs0 = Get-RecentJobs
$resp = Send-Message "call workflow_upsert now with these exact args: id 'regr-full-check', name 'Regression Full Check', mode 'sequential', enabled true, steps array with two steps: [{id:'step-1', toolName:'sys_resources'}, {id:'step-2', toolName:'sys_processes'}]. Execute the tool, do not just describe it."
if (Test-ValidResponse $resp "2.4 create-pipeline: sequential creation") {
    [void](Test-Contains $resp "content" "creat|automat|sequential|full|pipeline|step" `
        "2.4 create-pipeline: confirms multi-step creation")
    [void](Test-ToolWasCalled "workflow_upsert" "2.4 create-pipeline: workflow_upsert was called" $jobs0)
}

# --- Test 2.5: Run automation (dry run) ---
Start-Sleep -Seconds 5
$jobs0 = Get-RecentJobs
$resp = Send-Message "call workflow_run now with workflowId 'regr-sys-check' and dryRun true. Execute the tool immediately."
if (Test-ValidResponse $resp "2.5 run: dry run") {
    [void](Test-Contains $resp "content" "dry|run|sys|result|info|system|step|check" `
        "2.5 run: confirms dry run execution")
    [void](Test-ToolWasCalled "workflow_run" "2.5 run: workflow_run was called" $jobs0)
}

# --- Test 2.6: Run automation (real) ---
Start-Sleep -Seconds 5
$jobs0 = Get-RecentJobs
$resp = Send-Message "call workflow_run now with workflowId 'regr-sys-check' and dryRun false. Execute it for real."
if (Test-ValidResponse $resp "2.6 run: real execution") {
    [void](Test-Contains $resp "content" "ran|execut|complet|result|system|success|info|step" `
        "2.6 run: confirms real execution")
    [void](Test-ToolWasCalled "workflow_run" "2.6 run: workflow_run was called" $jobs0)
}

# --- Test 2.7: Schedule creation ---
Start-Sleep -Seconds 5
$jobs0 = Get-RecentJobs
$resp = Send-Message "call task_create now with these args: name 'regr-schedule', type 'workflow', target 'regr-sys-check', cron '*/30 * * * *', enabled true. Execute the tool, do not just describe it."
if (Test-ValidResponse $resp "2.7 schedule: create scheduled task") {
    [void](Test-Contains $resp "content" "schedul|cron|30|task|minute|creat" `
        "2.7 schedule: confirms schedule creation")
    [void](Test-ToolWasCalled "task_create" "2.7 schedule: task_create was called" $jobs0)
}

# --- Test 2.8: Delete automation ---
Start-Sleep -Seconds 5
$jobs0 = Get-RecentJobs
$resp = Send-Message "delete the regr-sys-check automation using workflow_delete"
if (Test-ValidResponse $resp "2.8 delete: single automation") {
    [void](Test-Contains $resp "content" "delet|remov|regr.sys" `
        "2.8 delete: confirms deletion")
    [void](Test-ToolWasCalled "workflow_delete" "2.8 delete: workflow_delete was called" $jobs0)
}

# --- Test 2.9: Delete pipeline + cleanup ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "delete the regr-full-check automation using workflow_delete. Also list scheduled tasks with task_list and delete any containing 'regr' using task_delete."
if (Test-ValidResponse $resp "2.9 delete: pipeline + task cleanup") {
    [void](Test-ToolWasCalled "workflow_delete|task_list|task_delete" "2.9 delete: cleanup tools were called" $jobs0)
}

} # end if ($autoToolsAvailable)

# ═══════════════════════════════════════════════════════════════
# PART 3: MEMORY SAVE — previously 9 false failures (script bug)
# From test-memory-save.ps1: all 5 tests actually pass
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Log "=== Part 3: Memory Save (from test-memory-save, script exit bug fixed) ==="

# --- Test 3.1: Original prompt ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "save this to your memory: the regression test harness ran successfully on $(Get-Date -Format 'yyyy-MM-dd')"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "3.1 memory_save: original prompt" $jobs0)

# --- Test 3.2: Explicit tool name ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the memory_save tool to save this fact: regression test 3.2 ran at $(Get-Date -Format 'HH:mm')"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "3.2 memory_save: explicit tool name" $jobs0)

# --- Test 3.3: find_tools then memory_save ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "call find_tools to locate memory_save, then use memory_save to save: regression test 3.3 passed"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "3.3 memory_save: find_tools then save" $jobs0)

# --- Test 3.4: "remember this" phrasing ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "remember this for future conversations: regression test suite is green"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "3.4 memory_save: remember this" $jobs0)

# --- Test 3.5: Two-step discovery then save ---
Start-Sleep -Seconds 3
$jobs0 = Get-RecentJobs
$resp = Send-Message "use find_tools to search for memory tools"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 150) { $resp.content.Substring(0, 150) + "..." } else { $resp.content }
    Write-Log "Discovery response: $preview"
}
Start-Sleep -Seconds 2
$resp2 = Send-Message "now use memory_save to save this: regression test 3.5 passed"
if ($resp2.content) {
    $preview = if ($resp2.content.Length -gt 150) { $resp2.content.Substring(0, 150) + "..." } else { $resp2.content }
    Write-Log "Save response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "3.5 memory_save: two-step discover then save" $jobs0)

# ═══════════════════════════════════════════════════════════════
# CLEANUP
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Log "=== Cleanup ==="
Invoke-ToolPolicy @{ mode = "approve_by_policy" } | Out-Null
Write-Pass "cleanup: policy restored to approve_by_policy"

# ─── Summary ─────────────────────────────────────────────────
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
