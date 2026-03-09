#Requires -Version 5.1
<#
.SYNOPSIS
    Diagnostic script for memory_save tool selection failure.
.DESCRIPTION
    Tests 5 different prompt phrasings to identify which ones cause the LLM
    to call memory_save vs just acknowledging verbally.
#>

param(
    [switch]$SkipStart,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "diag-memsave-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$Results = @()
$LogFile = Join-Path $env:TEMP "guardian-memsave-harness.log"

# ─── Helpers (same as test-tools.ps1) ─────────────────────────
function Write-Log($msg) { Write-Host "[diag] $msg" -ForegroundColor Cyan }
function Write-Pass($name) {
    Write-Host "  PASS " -ForegroundColor Green -NoNewline; Write-Host $name
    $script:Pass++; $script:Results += "PASS: $name"
}
function Write-Fail($name, $reason) {
    Write-Host "  FAIL " -ForegroundColor Red -NoNewline; Write-Host "$name - $reason"
    $script:Fail++; $script:Results += "FAIL: $name - $reason"
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
        if ($allNames) { Write-Fail $Name "expected tool matching '$ToolPattern', got: $allNames" }
        else { Write-Fail $Name "no tool calls detected" }
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

# ─── Start the app (copied from test-tools.ps1) ──────────────
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
    $harnessConfig = Join-Path $env:TEMP "guardian-memsave-harness-config.yaml"

    if (-not $Token -or $Token -match "^diag-memsave-") {
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
        if ($AppProcess -and -not $AppProcess.HasExited) { $AppProcess.Kill() }
        exit 1
    }
    Write-Log "Ready with auth token: $Token"
}

# ─── Set autonomous mode ──────────────────────────────────────
$null = Invoke-ToolPolicy @{
    mode = "autonomous"
    sandbox = @{
        allowedPaths = @(".")
    }
}
Write-Log "Policy set to autonomous"

# ─── LLM Provider Info ───────────────────────────────────────
try {
    $statusResp = Invoke-RestMethod -Uri "$BaseUrl/api/status" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
    if ($statusResp.llm) {
        foreach ($p in $statusResp.llm.PSObject.Properties) {
            $v = $p.Value
            Write-Log "LLM Provider: $($p.Name) ($($v.provider)) — model: $($v.model), locality: $($v.locality)"
        }
    }
} catch {}

Write-Log ""
Write-Log "=== memory_save diagnostic ==="
Write-Log ""

# --- Test 1: Original prompt (the one that fails) ---
Write-Log "--- Test 1: Original prompt ---"
$jobs0 = Get-RecentJobs
$resp = Send-Message "save this to your memory: the tool exercise harness ran successfully on $(Get-Date -Format 'yyyy-MM-dd')"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "test1: original prompt" $jobs0)

Start-Sleep -Seconds 3

# --- Test 2: Explicit "use memory_save tool" ---
Write-Log ""
Write-Log "--- Test 2: Explicit tool name ---"
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the memory_save tool to save this fact: diagnostic test 2 ran at $(Get-Date -Format 'HH:mm')"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "test2: explicit tool name" $jobs0)

Start-Sleep -Seconds 3

# --- Test 3: "call find_tools to locate memory_save, then save..." ---
Write-Log ""
Write-Log "--- Test 3: find_tools then memory_save ---"
$jobs0 = Get-RecentJobs
$resp = Send-Message "call find_tools to locate memory_save, then use memory_save to save: diagnostic test 3 passed"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "test3: find_tools then save" $jobs0)

Start-Sleep -Seconds 3

# --- Test 4: "remember this" phrasing ---
Write-Log ""
Write-Log "--- Test 4: 'remember this' phrasing ---"
$jobs0 = Get-RecentJobs
$resp = Send-Message "remember this for future conversations: my favorite color is blue"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 200) { $resp.content.Substring(0, 200) + "..." } else { $resp.content }
    Write-Log "Response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "test4: remember this" $jobs0)

Start-Sleep -Seconds 3

# --- Test 5: Two-step — first discover, then save in separate message ---
Write-Log ""
Write-Log "--- Test 5: Two-step discovery then save ---"
$jobs0 = Get-RecentJobs
$resp = Send-Message "use find_tools to search for memory tools"
if ($resp.content) {
    $preview = if ($resp.content.Length -gt 150) { $resp.content.Substring(0, 150) + "..." } else { $resp.content }
    Write-Log "Discovery response: $preview"
}
Start-Sleep -Seconds 2
$resp2 = Send-Message "now use memory_save to save this: diagnostic test 5 passed"
if ($resp2.content) {
    $preview = if ($resp2.content.Length -gt 150) { $resp2.content.Substring(0, 150) + "..." } else { $resp2.content }
    Write-Log "Save response: $preview"
}
[void](Test-ToolWasCalled "memory_save" "test5: two-step discover then save" $jobs0)

# ─── Summary ──────────────────────────────────────────────────
Write-Log ""
Write-Log "============================================"
Write-Log "  PASS: $Pass  FAIL: $Fail  Total: $($Pass + $Fail)"
Write-Log "============================================"
if ($Fail -gt 0) {
    Write-Log ""
    Write-Log "Failed tests:"
    $Results | Where-Object { $_ -match "^FAIL" } | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
}
Write-Log ""
Write-Log "Full app log: $LogFile"

if ($AppProcess -and -not $AppProcess.HasExited) {
    Write-Log "Stopping app (PID $($AppProcess.Id))..."
    $AppProcess.Kill()
}

exit $Fail
