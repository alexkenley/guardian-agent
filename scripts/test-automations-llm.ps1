#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Automation LLM-Path Test Harness (PowerShell)

.DESCRIPTION
    Tests whether the LLM can discover, select, and correctly invoke automation
    tools from natural language prompts — the same path a real user takes.

    Covers: tool discovery, single-tool automation creation, multi-step pipeline
    creation, tool composition for monitoring, listing, running, dry-running,
    schedule management, and deletion — all via POST /api/message (LLM chat path).

    Unlike test-automation.ps1 (direct API), this tests the LLM's understanding
    of the automation taxonomy and its ability to translate user intent into the
    right tool calls with correct arguments.

    Requires a running GuardianAgent instance with web channel enabled and an LLM
    provider configured (Ollama, Anthropic, or OpenAI).

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.EXAMPLE
    .\scripts\test-automations-llm.ps1

.EXAMPLE
    .\scripts\test-automations-llm.ps1 -SkipStart -Port 3000 -Token "your-token"

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    These tests are LLM-dependent and non-deterministic. Broad assertions
    are used to accommodate different models. Expect occasional flakes
    with smaller or slower models.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-autollm-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$LogFile = Join-Path $env:TEMP "guardian-autollm-harness.log"

# ─── Helpers ─────────────────────────────────────────────────
function Write-Log($msg) { Write-Host "[auto-llm] $msg" -ForegroundColor Cyan }
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

function Test-ToolWasCalled {
    param([string]$ToolPattern, [string]$Name, $JobsBefore)
    $jobsAfter = Get-RecentJobs
    # Find jobs that appeared after the prompt (not in the before snapshot)
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

function Test-ToolWasCalledMultiple {
    param([string[]]$ToolPatterns, [string]$Name, $JobsBefore)
    $jobsAfter = Get-RecentJobs
    $beforeIds = @()
    if ($JobsBefore) { $beforeIds = $JobsBefore | ForEach-Object { $_.id } }
    $newJobs = $jobsAfter | Where-Object { $_.id -notin $beforeIds }
    $allMatched = @()
    foreach ($pattern in $ToolPatterns) {
        $matched = $newJobs | Where-Object { $_.toolName -match $pattern }
        if ($matched) { $allMatched += $matched }
    }
    if ($allMatched.Count -ge $ToolPatterns.Count) {
        $names = ($allMatched | ForEach-Object { $_.toolName } | Sort-Object -Unique) -join ", "
        Write-Pass "$Name (called: $names)"
        return $true
    }
    else {
        $allNames = ($newJobs | ForEach-Object { $_.toolName }) -join ", "
        $patternsStr = $ToolPatterns -join ", "
        if ($allNames) {
            Write-Fail $Name "expected tools matching [$patternsStr], got: $allNames"
        }
        else {
            Write-Fail $Name "no tool calls detected (expected: $patternsStr)"
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
    $harnessConfig = Join-Path $env:TEMP "guardian-autollm-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-autollm-") {
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
    $tempCfg = Join-Path $env:TEMP "guardian-autollm-harness-config.yaml"
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

# ─── Prerequisite: verify automation tools are registered ─────
Write-Host ""
Write-Log "=== Prerequisite Check ==="

$autoToolsAvailable = $false
$probeResult = Invoke-ToolRun -ToolName "automation_list" -ToolArgs @{}

if ($probeResult.success -eq $true -or $probeResult.status -eq "succeeded" -or $probeResult.status -eq "failed") {
    $autoToolsAvailable = $true
    Write-Pass "prerequisite: automation tools available"
}
elseif ($probeResult.message -match "Unknown tool" -or $probeResult.error -match "Unknown tool") {
    Write-Skip "prerequisite: all tests" "automation tools not registered"
}
else {
    Write-Skip "prerequisite: all tests" "unexpected probe: status=$($probeResult.status)"
}

if ($autoToolsAvailable) {

# ═══════════════════════════════════════════════════════════════
# Set autonomous mode for all LLM-path tests
# ═══════════════════════════════════════════════════════════════
$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for LLM tests"

# ═══════════════════════════════════════════════════════════════
# SECTION 1: TOOL DISCOVERY
# Can the LLM find automation tools via find_tools?
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Log "=== Section 1: Tool Discovery ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "what automation tools do you have? use find_tools to search for automation tools"
if (Test-ValidResponse $resp "discovery: automation tools query") {
    [void](Test-Contains $resp "content" "automat|schedule|save|run|delete|enable" `
        "discovery: mentions automation concepts")
    [void](Test-ToolWasCalled "find_tools" "discovery: find_tools was invoked" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "can you list the specific automation tools available? I need to know about automation_save, automation_list, automation_run, automation_set_enabled, automation_delete"
if (Test-ValidResponse $resp "discovery: specific tool names") {
    [void](Test-Contains $resp "content" "automation_save|automation_list|automation_run|automation_delete" `
        "discovery: mentions specific tool names")
}

# ═══════════════════════════════════════════════════════════════
# SECTION 2: SINGLE-TOOL AUTOMATION CREATION
# "Create an automation that checks system info every hour"
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 2: Single-Tool Automation Creation ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save now to create an automation with these exact args: id 'sys-health-check', name 'System Health Check', enabled true, kind 'workflow', mode 'sequential', steps array with one step: id 'step-1', toolName 'sys_info'. Do not schedule it."
if (Test-ValidResponse $resp "create-single: basic creation") {
    [void](Test-Contains $resp "content" "creat|automat|sys.health|health|save" `
        "create-single: confirms creation")
    [void](Test-ToolWasCalled "automation_save" "create-single: automation_save was called" $jobs0)
}

Start-Sleep -Seconds 5

# Verify it exists by listing
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_list now to show all automations"
if (Test-ValidResponse $resp "create-single: verify via list") {
    [void](Test-Contains $resp "content" "sys.health|Health.Check|health.check|automation|workflow" `
        "create-single: automation appears in list")
    [void](Test-ToolWasCalled "automation_list" "create-single: automation_list was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SECTION 3: PIPELINE AUTOMATION CREATION
# "Create a multi-step automation that checks resources then processes"
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 3: Pipeline Automation Creation ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save now with these exact args: id 'full-system-check', name 'Full System Check', enabled true, kind 'workflow', mode 'sequential', steps array with two steps: [{id:'step-1', toolName:'sys_resources'}, {id:'step-2', toolName:'sys_processes'}]. Execute the tool, do not just describe it."
if (Test-ValidResponse $resp "create-pipeline: sequential creation") {
    [void](Test-Contains $resp "content" "creat|automat|sequential|full.system|pipeline|step" `
        "create-pipeline: confirms multi-step creation")
    [void](Test-ToolWasCalled "automation_save" "create-pipeline: automation_save was called" $jobs0)
}

Start-Sleep -Seconds 3

# Parallel pipeline
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save now with these exact args: id 'quick-network-check', name 'Quick Network Check', enabled true, kind 'workflow', mode 'parallel', steps [{id:'step-1', toolName:'net_interfaces'}, {id:'step-2', toolName:'net_dns_lookup', args:{host:'localhost'}}, {id:'step-3', toolName:'net_port_check', args:{host:'127.0.0.1', port:$Port}}]. Execute the tool, do not just describe it."
if (Test-ValidResponse $resp "create-pipeline: parallel creation") {
    [void](Test-Contains $resp "content" "creat|automat|parallel|network|quick" `
        "create-pipeline: confirms parallel creation")
    $toolCalled = Test-ToolWasCalled "automation_save" "create-pipeline: automation_save was called" $jobs0
    if (-not $toolCalled) {
        # Nudge: local model may have searched tools but not executed — follow up
        Start-Sleep -Seconds 3
        $jobs0 = Get-RecentJobs
        $resp = Send-Message "you searched for the tool but didn't execute it. Call automation_save now with id 'quick-network-check', name 'Quick Network Check', enabled true, kind 'workflow', mode 'parallel', steps [{id:'step-1', toolName:'net_interfaces'}, {id:'step-2', toolName:'net_dns_lookup', args:{host:'localhost'}}, {id:'step-3', toolName:'net_port_check', args:{host:'127.0.0.1', port:$Port}}]."
        if (Test-ValidResponse $resp "create-pipeline: parallel retry") {
            [void](Test-ToolWasCalled "automation_save" "create-pipeline: automation_save was called (retry)" $jobs0)
        }
    }
}

# ═══════════════════════════════════════════════════════════════
# SECTION 4: SCHEDULING AN AUTOMATION
# "Schedule the sys-health-check to run every 30 minutes"
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 4: Scheduling ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save now with these exact args: id 'sys-health-check', name 'System Health Check', enabled true, kind 'workflow', mode 'sequential', steps array with one step: id 'step-1', toolName 'sys_info', schedule object with enabled true and cron '*/30 * * * *'. Execute the tool, do not just describe it."
if (Test-ValidResponse $resp "schedule: create scheduled task") {
    [void](Test-Contains $resp "content" "schedul|cron|30|task|minute|creat" `
        "schedule: confirms schedule creation")
    [void](Test-ToolWasCalled "automation_save" "schedule: automation_save was called" $jobs0)
}

Start-Sleep -Seconds 3

# Verify schedule by listing tasks
$jobs0 = Get-RecentJobs
$resp = Send-Message "list all automations using automation_list and show me the schedules"
if (Test-ValidResponse $resp "schedule: verify via automation_list") {
    [void](Test-ToolWasCalled "automation_list" "schedule: automation_list was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SECTION 5: TOOL COMPOSITION FOR MONITORING
# Can the LLM compose existing tools into monitoring pipelines?
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 5: Tool Composition for Monitoring ==="

# HTTP monitoring — the LLM should compose net_port_check + web_fetch
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save now with these exact args: id 'http-monitor-local', name 'HTTP Monitor Local', enabled true, kind 'workflow', mode 'sequential', steps [{id:'step-1', toolName:'net_port_check', args:{host:'127.0.0.1', port:$Port}}, {id:'step-2', toolName:'web_fetch', args:{url:'http://127.0.0.1:$Port/health'}}]. Execute the tool, do not just describe it."
if (Test-ValidResponse $resp "compose-http: HTTP monitoring pipeline") {
    [void](Test-Contains $resp "content" "creat|automat|monitor|http|sequential|pipeline|port|fetch|health" `
        "compose-http: confirms HTTP monitoring concept")
    [void](Test-ToolWasCalled "automation_save" "compose-http: automation_save was called" $jobs0)
}

Start-Sleep -Seconds 3

# Network monitoring composition
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save now with these exact args: id 'network-sweep', name 'Network Sweep', enabled true, kind 'workflow', mode 'parallel', steps [{id:'step-1', toolName:'net_ping', args:{host:'127.0.0.1'}}, {id:'step-2', toolName:'net_interfaces'}, {id:'step-3', toolName:'net_connections'}]. Execute the tool, do not just describe it."
if (Test-ValidResponse $resp "compose-net: network sweep pipeline") {
    [void](Test-Contains $resp "content" "creat|automat|network|parallel|sweep|ping|interface|connection" `
        "compose-net: confirms network monitoring concept")
    $toolCalled = Test-ToolWasCalled "automation_save" "compose-net: automation_save was called" $jobs0
    if (-not $toolCalled) {
        # Nudge: local model may have searched tools but not executed — follow up
        Start-Sleep -Seconds 3
        $jobs0 = Get-RecentJobs
        $resp = Send-Message "you searched for the tool but didn't execute it. Call automation_save now with id 'network-sweep', name 'Network Sweep', enabled true, kind 'workflow', mode 'parallel', steps [{id:'step-1', toolName:'net_ping', args:{host:'127.0.0.1'}}, {id:'step-2', toolName:'net_interfaces'}, {id:'step-3', toolName:'net_connections'}]."
        if (Test-ValidResponse $resp "compose-net: network sweep retry") {
            [void](Test-ToolWasCalled "automation_save" "compose-net: automation_save was called (retry)" $jobs0)
        }
    }
}

# ═══════════════════════════════════════════════════════════════
# SECTION 6: RUNNING AUTOMATIONS
# Can the LLM run and dry-run automations?
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 6: Running Automations ==="

# Dry run
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_run now with automationId 'sys-health-check' and dryRun true. Execute the tool immediately."
if (Test-ValidResponse $resp "run: dry run") {
    [void](Test-Contains $resp "content" "dry|run|sys.health|result|info|system|step|check" `
        "run: confirms dry run execution")
    [void](Test-ToolWasCalled "automation_run" "run: automation_run was called for dry run" $jobs0)
}

Start-Sleep -Seconds 5

# Real run
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_run now with automationId 'sys-health-check' and dryRun false. Execute it for real."
if (Test-ValidResponse $resp "run: real execution") {
    [void](Test-Contains $resp "content" "ran|execut|complet|result|system|success|info|step" `
        "run: confirms real execution")
    [void](Test-ToolWasCalled "automation_run" "run: automation_run was called for real run" $jobs0)
}

Start-Sleep -Seconds 5

# Run the pipeline
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_run with automationId 'full-system-check' and dryRun false. Execute it now."
if (Test-ValidResponse $resp "run: pipeline execution") {
    [void](Test-ToolWasCalled "automation_run" "run: automation_run was called for pipeline" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SECTION 7: SCHEDULE MANAGEMENT
# Can the LLM update and manage schedules?
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 7: Schedule Management ==="

# First list automations to inspect the current schedule
$jobs0 = Get-RecentJobs
$resp = Send-Message "list all automations and show me their IDs and schedules"
if (Test-ValidResponse $resp "sched-mgmt: list automations") {
    [void](Test-ToolWasCalled "automation_list" "sched-mgmt: automation_list was called" $jobs0)
}

Start-Sleep -Seconds 3

# Ask to update the schedule through automation_save
$jobs0 = Get-RecentJobs
$resp = Send-Message "I need to change the sys-health-check schedule to every 5 minutes. First call automation_list to confirm the automation, then call automation_save with id 'sys-health-check', name 'System Health Check', enabled true, kind 'workflow', mode 'sequential', steps [{id:'step-1', toolName:'sys_info'}], and schedule {enabled true, cron '*/5 * * * *'}. Execute both tools now."
if (Test-ValidResponse $resp "sched-mgmt: update schedule") {
    [void](Test-Contains $resp "content" "updat|chang|schedul|5|minute|cron|task" `
        "sched-mgmt: confirms schedule update")
    [void](Test-ToolWasCalled "automation_save|automation_list" "sched-mgmt: automation_save or automation_list was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SECTION 8: NATURAL LANGUAGE AUTOMATION REQUESTS
# Higher-level requests that test the LLM's understanding
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 8: Natural Language Requests ==="

# Vague request — LLM should ask clarifying questions or make reasonable defaults
$jobs0 = Get-RecentJobs
$resp = Send-Message "I want to set up monitoring for my network. What kind of automations can you create for me?"
if (Test-ValidResponse $resp "natural: monitoring suggestion") {
    [void](Test-Contains $resp "content" "ping|port|scan|interface|connection|monitor|automat|network" `
        "natural: suggests relevant monitoring tools")
}

Start-Sleep -Seconds 3

# Cron schedule from natural language — split into two explicit steps
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save to create a daily scheduled automation with these exact args: id 'daily-resource-check', name 'Daily Resource Check', enabled true, kind 'workflow', mode 'sequential', steps [{id:'step-1', toolName:'sys_resources'}], schedule {enabled true, cron '0 9 * * *'}. Execute the tool now."
if (Test-ValidResponse $resp "natural: daily schedule creation") {
    [void](Test-Contains $resp "content" "creat|automat|daily|9|schedul|resource|workflow|task" `
        "natural: confirms daily scheduled automation")
    [void](Test-ToolWasCalled "automation_save" "natural: automation_save was called" $jobs0)
}

Start-Sleep -Seconds 5

# Weekday-only schedule
$jobs0 = Get-RecentJobs
$resp = Send-Message "call automation_save to create a weekday scheduled automation with these exact args: id 'weekday-net-check', name 'Weekday Net Check', enabled true, kind 'workflow', mode 'sequential', steps [{id:'step-1', toolName:'net_interfaces'}], schedule {enabled true, cron '0 8 * * 1-5'}. Execute the tool now."
if (Test-ValidResponse $resp "natural: weekday schedule") {
    [void](Test-Contains $resp "content" "creat|automat|weekday|schedul|8" `
        "natural: confirms weekday scheduled automation")
    [void](Test-ToolWasCalled "automation_save" "natural: automation_save was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SECTION 9: LISTING AND INSPECTING
# Can the LLM provide useful summaries of automations?
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 9: Listing & Inspection ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "show me all my automations and their current status"
if (Test-ValidResponse $resp "list: show all automations") {
    [void](Test-Contains $resp "content" "sys.health|full.system|http.monitor|network|automat" `
        "list: shows automation names")
    [void](Test-ToolWasCalled "automation_list" "list: automation_list was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "how many automations do I have? list them with automation_list."
if (Test-ValidResponse $resp "list: count automations") {
    [void](Test-ToolWasCalled "automation_list" "list: automation_list was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SECTION 10: DELETION
# Can the LLM delete automations and their schedules?
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 10: Deletion ==="

# Delete a single-tool automation
$jobs0 = Get-RecentJobs
$resp = Send-Message "delete the sys-health-check automation using automation_delete"
if (Test-ValidResponse $resp "delete: single automation") {
    [void](Test-Contains $resp "content" "delet|remov|sys.health" `
        "delete: confirms deletion")
    [void](Test-ToolWasCalled "automation_delete" "delete: automation_delete was called" $jobs0)
}

Start-Sleep -Seconds 3

# Delete a pipeline
$jobs0 = Get-RecentJobs
$resp = Send-Message "delete the full-system-check automation"
if (Test-ValidResponse $resp "delete: pipeline automation") {
    [void](Test-ToolWasCalled "automation_delete" "delete: automation_delete was called for pipeline" $jobs0)
}

Start-Sleep -Seconds 3

# Delete the HTTP monitor
$jobs0 = Get-RecentJobs
$resp = Send-Message "delete the http-monitor-local automation"
if (Test-ValidResponse $resp "delete: http monitor automation") {
    [void](Test-ToolWasCalled "automation_delete" "delete: automation_delete was called for http monitor" $jobs0)
}

Start-Sleep -Seconds 3

# Delete remaining test automations
$jobs0 = Get-RecentJobs
$resp = Send-Message "delete all remaining test automations: quick-network-check, network-sweep, daily-resource-check, weekday-net-check. Use automation_delete for each one."
if (Test-ValidResponse $resp "delete: cleanup remaining") {
    [void](Test-ToolWasCalled "automation_delete" "delete: automation_delete was called for cleanup" $jobs0)
}

Start-Sleep -Seconds 3

# Clean up any remaining saved automations from the harness run
$jobs0 = Get-RecentJobs
$resp = Send-Message "list all automations with automation_list. If there are any harness test automations remaining, delete them with automation_delete."
if (Test-ValidResponse $resp "delete: cleanup tasks") {
    [void](Test-ToolWasCalled "automation_list|automation_delete" "delete: automation cleanup tools were called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SECTION 11: EDGE CASES
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 5
Write-Host ""
Write-Log "=== Section 11: Edge Cases ==="

# Non-existent automation
$jobs0 = Get-RecentJobs
$resp = Send-Message "run the automation called 'this-does-not-exist-xyz' using automation_run"
if (Test-ValidResponse $resp "edge: non-existent automation") {
    [void](Test-Contains $resp "content" "not found|doesn.t exist|error|fail|no.*automat|no.*workflow|unknown|could not|can.t be run" `
        "edge: reports automation not found")
}

Start-Sleep -Seconds 3

# Cron sub-minute interval
$resp = Send-Message "can you create an automation that runs every 30 seconds?"
if (Test-ValidResponse $resp "edge: sub-minute interval") {
    [void](Test-Contains $resp "content" "minut|minimum|limit|can.t|cannot|1.minute|not.*support|30.*second|cron" `
        "edge: explains cron minimum interval limitation")
}

# ═══════════════════════════════════════════════════════════════
# JOB HISTORY — verify tool activity was tracked
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Job History Verification ==="

try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=200" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5

    $jobs = $state.jobs
    $autoJobs = $jobs | Where-Object {
        $_.toolName -match "automation_save|automation_delete|automation_run|automation_list|automation_set_enabled|find_tools"
    }
    if ($autoJobs -and $autoJobs.Count -gt 0) {
        Write-Pass "job history: $($autoJobs.Count) automation-related tool executions recorded"

        $toolNames = ($autoJobs | ForEach-Object { $_.toolName } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: tools used: $toolNames"

        # Check for key tools that should have been called
        $expectedTools = @("automation_save", "automation_list", "automation_run", "automation_delete")
        $missingTools = @()
        foreach ($tool in $expectedTools) {
            $found = $autoJobs | Where-Object { $_.toolName -eq $tool }
            if (-not $found) { $missingTools += $tool }
        }
        if ($missingTools.Count -eq 0) {
            Write-Pass "job history: all expected automation tools were called"
        }
        else {
            $missing = $missingTools -join ", "
            Write-Fail "job history: missing tool calls" "never called: $missing"
        }
    }
    else {
        Write-Fail "job history" "no automation jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

} # end if ($autoToolsAvailable)

# ═══════════════════════════════════════════════════════════════
# CLEANUP: Restore policy
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
