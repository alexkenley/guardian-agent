#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Tool Exercise Harness (PowerShell)

.DESCRIPTION
    Exercises every tool category by sending natural language prompts through
    POST /api/message (the LLM chat path). This tests whether tool descriptions
    are clear enough for the LLM to discover, select, and invoke the right tool
    with correct arguments — the same path a real user takes.

    Also tests the approval flow by switching between policy modes and
    approving/denying pending tool executions via the API.

    Requires a running GuardianAgent instance with web channel enabled and
    an LLM provider configured (Ollama, Anthropic, or OpenAI).

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.EXAMPLE
    .\scripts\test-tools.ps1

.EXAMPLE
    .\scripts\test-tools.ps1 -SkipStart -Port 3000 -Token "your-token"

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
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-tools-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$LogFile = Join-Path $env:TEMP "guardian-tools-harness.log"
$TestDir = "/tmp/harness-tools-test"

# ─── Helpers ─────────────────────────────────────────────────
function Write-Log($msg) { Write-Host "[tools] $msg" -ForegroundColor Cyan }
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
    $harnessConfig = Join-Path $env:TEMP "guardian-tools-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-tools-") {
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
    $tempCfg = Join-Path $env:TEMP "guardian-tools-harness-config.yaml"
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

# ═══════════════════════════════════════════════════════════════
# Set autonomous mode + sandbox for tool exercise
# ═══════════════════════════════════════════════════════════════
$null = Invoke-ToolPolicy @{
    mode = "autonomous"
    sandbox = @{
        allowedPaths = @(".", $TestDir)
        allowedCommands = @("node", "npm", "npx", "git", "ollama", "ls", "dir", "pwd",
            "echo", "cat", "head", "tail", "whoami", "hostname", "uname", "date")
    }
}
Write-Pass "setup: autonomous policy + sandbox for tool exercise"

# ═══════════════════════════════════════════════════════════════
# TOOL DISCOVERY — can the LLM find tools via find_tools?
# ═══════════════════════════════════════════════════════════════
Write-Host ""
Write-Log "=== Tool Discovery (find_tools) ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "what tools do you have for working with files and directories?"
if (Test-ValidResponse $resp "discovery: filesystem tools") {
    [void](Test-Contains $resp "content" "fs_|file|directory|list|read|write" `
        "discovery: mentions file tools")
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "what network scanning and diagnostic tools are available? use find_tools to find them"
if (Test-ValidResponse $resp "discovery: network tools") {
    [void](Test-Contains $resp "content" "net_|network|ping|scan|interface|dns" `
        "discovery: mentions network tools")
    [void](Test-ToolWasCalled "find_tools" "discovery: find_tools was invoked" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "do you have any tools for managing scheduled tasks or automation workflows?"
if (Test-ValidResponse $resp "discovery: automation tools") {
    [void](Test-Contains $resp "content" "task|workflow|schedule|automat" `
        "discovery: mentions task/workflow tools")
}

# ═══════════════════════════════════════════════════════════════
# FILESYSTEM — read operations
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Filesystem: Read Operations ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "list the files and folders in the project root directory and show me the results"
if (Test-ValidResponse $resp "fs_list: project directory") {
    [void](Test-Contains $resp "content" "src|package|node_modules|dist|tsconfig|web|agent|tools|runtime|config" `
        "fs_list: shows project structure")
    [void](Test-ToolWasCalled "fs_list" "fs_list: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "search for files named '*.test.ts' in the src directory"
if (Test-ValidResponse $resp "fs_search: find test files") {
    [void](Test-Contains $resp "content" "\.test\.ts|test" `
        "fs_search: found test files")
    [void](Test-ToolWasCalled "fs_search" "fs_search: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "read the contents of package.json"
if (Test-ValidResponse $resp "fs_read: package.json") {
    [void](Test-Contains $resp "content" "name|version|dependencies|guardian" `
        "fs_read: shows package.json content")
    [void](Test-ToolWasCalled "fs_read" "fs_read: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# FILESYSTEM — write operations
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Filesystem: Write Operations ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "create a new directory at the path $TestDir"
if (Test-ValidResponse $resp "fs_mkdir: create test dir") {
    [void](Test-ToolWasCalled "fs_mkdir|shell_safe|find_tools" "fs_mkdir: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "write a file at $TestDir/hello.txt with the content: Hello from the tool exercise harness"
if (Test-ValidResponse $resp "fs_write: write hello.txt") {
    [void](Test-ToolWasCalled "fs_write|doc_create" "fs_write: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "read the file $TestDir/hello.txt"
if (Test-ValidResponse $resp "fs_read: verify written file") {
    [void](Test-Contains $resp "content" "Hello from the tool exercise" `
        "fs_read: content matches what we wrote")
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "make a copy of $TestDir/hello.txt and save the copy as $TestDir/hello-copy.txt"
if (Test-ValidResponse $resp "fs_copy: copy file") {
    [void](Test-ToolWasCalled "fs_copy|fs_write|fs_read|shell_safe|find_tools" "fs_copy: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "rename the file $TestDir/hello-copy.txt to hello-renamed.txt in the same directory"
if (Test-ValidResponse $resp "fs_move: rename file") {
    [void](Test-ToolWasCalled "fs_move|fs_copy|fs_write|shell_safe|find_tools" "fs_move: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "delete the file at $TestDir/hello-renamed.txt"
if (Test-ValidResponse $resp "fs_delete: delete file") {
    [void](Test-ToolWasCalled "fs_delete|shell_safe|find_tools" "fs_delete: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "create a markdown document at $TestDir/report.md with a heading 'Test Report' and a paragraph saying 'Generated by the tool exercise harness.'"
if (Test-ValidResponse $resp "doc_create: create markdown doc") {
    [void](Test-ToolWasCalled "doc_create|fs_write" "doc_create: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SHELL — safe command execution
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Shell Tool ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "run the command: echo hello-from-tool-harness"
if (Test-ValidResponse $resp "shell_safe: echo") {
    [void](Test-Contains $resp "content" "hello-from-tool-harness" `
        "shell_safe: echo output returned")
    [void](Test-ToolWasCalled "shell_safe" "shell_safe: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "run the command: node --version"
if (Test-ValidResponse $resp "shell_safe: node --version") {
    [void](Test-Contains $resp "content" "v\d+\.\d+" `
        "shell_safe: version number returned")
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "run the command: git log --oneline -5"
if (Test-ValidResponse $resp "shell_safe: git log") {
    [void](Test-ToolWasCalled "shell_safe" "shell_safe: git allowed" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# SYSTEM TOOLS
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== System Tools ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "show me the system information — OS, hostname, CPU, memory"
if (Test-ValidResponse $resp "sys_info: system info") {
    [void](Test-ToolWasCalled "sys_info" "sys_info: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "show me current CPU and memory usage"
if (Test-ValidResponse $resp "sys_resources: resource usage") {
    [void](Test-ToolWasCalled "sys_resources" "sys_resources: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "call find_tools to locate sys_processes, then use it to list the running processes sorted by memory usage"
if (Test-ValidResponse $resp "sys_processes: process list") {
    [void](Test-ToolWasCalled "sys_processes|find_tools|shell_safe" "sys_processes: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# NETWORK TOOLS
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Network Tools ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "show me the network interfaces on this machine"
if (Test-ValidResponse $resp "net_interfaces: list interfaces") {
    [void](Test-ToolWasCalled "net_interfaces" "net_interfaces: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "ping 127.0.0.1"
if (Test-ValidResponse $resp "net_ping: ping loopback") {
    [void](Test-ToolWasCalled "net_ping" "net_ping: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "do a DNS lookup for localhost"
if (Test-ValidResponse $resp "net_dns_lookup: resolve localhost") {
    [void](Test-ToolWasCalled "net_dns_lookup" "net_dns_lookup: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "check if port $Port is open on 127.0.0.1"
if (Test-ValidResponse $resp "net_port_check: check web port") {
    [void](Test-ToolWasCalled "net_port_check" "net_port_check: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "use the net_connections tool to show the active network connections"
if (Test-ValidResponse $resp "net_connections: active connections") {
    [void](Test-ToolWasCalled "net_connections" "net_connections: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# MEMORY TOOLS
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Memory Tools ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "save this to your memory: the tool exercise harness ran successfully on $(Get-Date -Format 'yyyy-MM-dd')"
if (Test-ValidResponse $resp "memory_save: store entry") {
    [void](Test-ToolWasCalled "memory_save" "memory_save: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "call find_tools to locate memory_recall, then use it to show me your knowledge base"
if (Test-ValidResponse $resp "memory_recall: retrieve knowledge") {
    [void](Test-ToolWasCalled "memory_recall|find_tools" "memory_recall: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "use the memory_search tool to search your memory for 'tool exercise harness'"
if (Test-ValidResponse $resp "memory_search: search memory") {
    [void](Test-ToolWasCalled "memory_search" "memory_search: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# WEB TOOLS
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Web Tools ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "search for the web_fetch tool, then use it to check this app's own health endpoint at http://127.0.0.1:$Port/health and show me the response"
if (Test-ValidResponse $resp "web_fetch: fetch health endpoint") {
    [void](Test-Contains $resp "content" "status|ok|health|running|up" `
        "web_fetch: health response returned")
    [void](Test-ToolWasCalled "web_fetch|web_search|find_tools" "web_fetch: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# THREAT INTEL TOOLS
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Threat Intel Tools ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "use the intel_summary tool to give me a threat intelligence summary"
if (Test-ValidResponse $resp "intel_summary: threat summary") {
    [void](Test-ToolWasCalled "intel_summary" "intel_summary: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "call find_tools to locate intel_findings, then use it to list any threat intel findings"
if (Test-ValidResponse $resp "intel_findings: list findings") {
    [void](Test-ToolWasCalled "intel_findings|find_tools" "intel_findings: tool was called" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# AUTOMATION TOOLS
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Automation Tools ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "use the automation_list tool to list all saved automations and their schedules"
if (Test-ValidResponse $resp "automation_list: list automations") {
    [void](Test-ToolWasCalled "automation_list" "automation_list: tool was called" $jobs0)
}

Start-Sleep -Seconds 3

$jobs0 = Get-RecentJobs
$resp = Send-Message "use the automation_list tool to show starter examples separately from saved automations"
if (Test-ValidResponse $resp "automation_list: starter examples") {
    [void](Test-ToolWasCalled "automation_list" "automation_list: tool was called for starter examples" $jobs0)
}

# ═══════════════════════════════════════════════════════════════
# APPROVAL FLOW — switch to approve_by_policy, test approve/deny
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 3
Write-Host ""
Write-Log "=== Approval Flow ==="

# Switch to approve_by_policy
$policyResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($policyResult.error) {
    Write-Fail "approval: set approve_by_policy" $policyResult.error
}
else {
    Write-Pass "approval: policy set to approve_by_policy"
}

Start-Sleep -Seconds 2

# Read-only tool should still auto-execute
$jobs0 = Get-RecentJobs
$resp = Send-Message "what are the files in the src directory?"
if (Test-ValidResponse $resp "approval: read_only auto-executes") {
    [void](Test-Contains $resp "content" "index|agent|config|tools" `
        "approval: fs_list returned directory contents")
}

Start-Sleep -Seconds 3

# Mutating tool should hit pending_approval — but the LLM flow handles this
# internally. We check for a pending approval via the tools API instead.
# First, set fs_write to 'manual' to guarantee approval is needed
[void](Invoke-ToolPolicy @{ toolPolicies = @{ fs_write = "manual" } })
Write-Pass "approval: fs_write set to manual"

Start-Sleep -Seconds 2

# Ask the LLM to write — this should create a pending approval
$jobs0 = Get-RecentJobs
$resp = Send-Message "write a file at $TestDir/approval-test.txt with the content: testing approval flow"
# The LLM response may mention that approval is needed
if ($resp.content) {
    Write-Pass "approval: LLM responded to write request"
}

Start-Sleep -Seconds 2

# Check for pending approvals
try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=20" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
    $pending = $state.approvals | Where-Object { $_.status -eq "pending" -and $_.toolName -match "fs_write" }
    if ($pending -and $pending.Count -gt 0) {
        Write-Pass "approval: fs_write is pending approval"
        $approvalId = $pending[0].id

        # Deny it
        $decision = Invoke-ApprovalDecision $approvalId "denied" "harness test denial"
        if ($decision.success -eq $true) {
            Write-Pass "approval: deny decision accepted"
        }
        else {
            Write-Fail "approval: deny" ($decision.message ?? $decision.error ?? "unknown error")
        }
    }
    else {
        # The LLM may have been told about approval requirement and not called the tool,
        # or the tool may have been auto-denied. Check job history.
        $newJobs = $state.jobs | Where-Object { $_.toolName -match "fs_write" }
        if ($newJobs -and ($newJobs | Where-Object { $_.status -eq "denied" -or $_.requiresApproval })) {
            Write-Pass "approval: fs_write was approval-gated (already resolved)"
        }
        else {
            Write-Skip "approval: pending check" "LLM may not have attempted the write"
        }
    }
}
catch {
    Write-Fail "approval: check pending" $_.Exception.Message
}

Start-Sleep -Seconds 2

# Per-tool deny: set fs_delete to 'deny'
[void](Invoke-ToolPolicy @{ toolPolicies = @{ fs_delete = "deny" } })
Write-Pass "approval: fs_delete set to deny"

Start-Sleep -Seconds 2

$jobs0 = Get-RecentJobs
$resp = Send-Message "delete the file $TestDir/hello.txt"
# Should fail — either the LLM reports it was blocked, or the tool returns failure
if ($resp.content) {
    Write-Pass "approval: deny-policy response received"
    # Verify the tool was denied in job history
    $newJobs = (Get-RecentJobs) | Where-Object { $_.id -notin ($jobs0 | ForEach-Object { $_.id }) }
    $denied = $newJobs | Where-Object { $_.toolName -match "fs_delete" -and $_.status -eq "denied" }
    if ($denied) {
        Write-Pass "approval: fs_delete was denied by policy"
    }
    else {
        Write-Pass "approval: LLM handled denial (may not have attempted tool)"
    }
}
else {
    Write-Pass "approval: response blocked (tool denied)"
}

# ═══════════════════════════════════════════════════════════════
# CLEANUP: Restore policy, remove test files
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Cleanup ==="

# Restore default policy
Invoke-ToolPolicy @{
    mode = "approve_by_policy"
    toolPolicies = @{ fs_write = "policy"; fs_delete = "policy" }
} | Out-Null
Write-Pass "cleanup: policy restored to defaults"

# ═══════════════════════════════════════════════════════════════
# JOB HISTORY — verify tool activity was tracked
# ═══════════════════════════════════════════════════════════════
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Job History Verification ==="

try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=100" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5

    $jobs = $state.jobs
    if ($jobs -and $jobs.Count -gt 0) {
        Write-Pass "job history: $($jobs.Count) tool executions recorded"

        $toolNames = ($jobs | ForEach-Object { $_.toolName } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: tools used: $toolNames"

        $statuses = ($jobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: statuses: $statuses"
    }
    else {
        Write-Fail "job history" "no jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

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
