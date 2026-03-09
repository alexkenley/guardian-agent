#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Web UI Approval Flow Test Harness (PowerShell)

.DESCRIPTION
    Simulates a user typing a command that requires approval,
    getting the pending_approval state, simulating the Web UI
    hitting the /api/tools/approvals/decision endpoint, and then
    sending the "continuation message" back to the LLM to verify
    the loop is broken and context is maintained.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-web-approvals-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$BaseUrl = "http://localhost:$Port"
$TimeoutStartup = 30
$TimeoutResponse = 120
$AppProcess = $null
$Pass = 0
$Fail = 0
$Skip = 0
$Results = @()
$LogFile = Join-Path $env:TEMP "guardian-web-approvals-harness.log"
$TestDir = "/tmp/harness-web-approvals-test"

function Write-Log($msg) { Write-Host "[web-approvals] $msg" -ForegroundColor Cyan }
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
    $body = @{ content = $Content; userId = "harness"; channel = "web" }
    if ($AgentId) { $body.agentId = $AgentId }
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/api/message" -Method Post -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) -TimeoutSec $TimeoutResponse
    } catch { return @{ error = $_.Exception.Message } }
}

function Invoke-ApprovalDecision {
    param([string]$ApprovalId, [string]$Decision, [string]$Reason = "")
    $body = @{ approvalId = $ApprovalId; decision = $Decision; actor = "web-user"; reason = $Reason }
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/api/tools/approvals/decision" -Method Post -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10
    } catch { return @{ success = $false; error = $_.Exception.Message } }
}

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
    $harnessConfig = Join-Path $env:TEMP "guardian-web-approvals-harness-config.yaml"
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

    Write-Log "Starting GuardianAgent with token: $Token"
    $AppProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npx tsx src/index.ts `"$harnessConfig`"" -WorkingDirectory $projectRoot -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -PassThru -WindowStyle Hidden

    $elapsed = 0; $healthy = $false
    while ($elapsed -lt $TimeoutStartup) {
        try { $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2; if ($health.status) { $healthy = $true; break } } catch {}
        Start-Sleep -Seconds 1; $elapsed++
    }
    if (-not $healthy) { Write-Host "ERROR: App failed to start" -ForegroundColor Red; exit 1 }
}

try {
    Write-Log "=== Setup ==="
    Invoke-RestMethod -Uri "$BaseUrl/api/tools/policy" -Method Post -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body (@{ mode = "approve_by_policy"; sandbox = @{ allowedPaths = @("."); allowedCommands = @("node") } } | ConvertTo-Json -Depth 3 -Compress) | Out-Null
    Write-Pass "setup: restricted sandbox"

    Write-Log "=== Web UI Simulation: Out of Bounds Write ==="
    
    # 1. Ask to write outside sandbox
    $resp1 = Send-Message "Write a file named 'web-ui-test.txt' to $TestDir with content 'hello world'"
    
    if (-not $resp1.metadata.pendingApprovals) {
        Write-Fail "s1: pending approval" "Expected pendingApprovals metadata, got none. Response: $($resp1.content)"
    } else {
        Write-Pass "s1: received pendingApprovals metadata"
        $approvalId = $resp1.metadata.pendingApprovals[0].id
        $toolName = $resp1.metadata.pendingApprovals[0].toolName
        
        Write-Log "Simulating Web UI approving $toolName ($approvalId)"
        
        # 2. Simulate Web UI hitting the decision endpoint
        $decision = Invoke-ApprovalDecision $approvalId "approved"
        if ($decision.success) {
            Write-Pass "s2: API accepted approval decision"
            
            # 3. Simulate Web UI sending the continuation message
            $summary = "$toolName: $($decision.message)"
            $continuationMsg = "[User approved the pending tool action(s). Result: $summary] Please continue with the original task."
            Write-Log "Sending continuation: $continuationMsg"
            
            $resp2 = Send-Message $continuationMsg
            
            if ($resp2.metadata.pendingApprovals -and $resp2.metadata.pendingApprovals[0].toolName -eq $toolName) {
                 Write-Fail "s3: continuation" "LLM is stuck in a loop asking for the same approval. Response: $($resp2.content)"
            } else {
                 Write-Pass "s3: continuation successful"
                 Write-Log "LLM Final Response: $($resp2.content)"
            }
        } else {
            Write-Fail "s2: API approval decision" "Failed: $($decision.error)"
        }
    }
    
} finally {
    if ($AppProcess -and -not $AppProcess.HasExited) { $AppProcess.Kill() }
    $tempCfg = Join-Path $env:TEMP "guardian-web-approvals-harness-config.yaml"
    if (Test-Path $tempCfg) { Remove-Item $tempCfg -Force -ErrorAction SilentlyContinue }
}

if ($Fail -gt 0) { exit 1 } else { exit 0 }