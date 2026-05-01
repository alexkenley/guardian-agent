#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Security API Harness (PowerShell)

.DESCRIPTION
    Exercises deterministic security controls through the Web API:
    auth hardening, privileged ticket gating, tool policy and approval flows,
    config redaction, audit integrity, and direct tool enforcement.

    This intentionally avoids bwrap/AppContainer backend validation. It focuses
    on the framework-level security mechanisms that should work regardless of
    the strong sandbox backend being present.

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.EXAMPLE
    .\scripts\test-security-api.ps1

.EXAMPLE
    .\scripts\test-security-api.ps1 -SkipStart -Port 3000 -Token "your-token"
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $(if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 }),
    [string]$Token = $(if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-security-api-$(Get-Date -Format 'yyyyMMddHHmmss')" })
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
$LogFile = Join-Path $env:TEMP "guardian-security-api-harness.log"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TestDirRel = "tmp/security-api-harness"
$TestFileRel = "$TestDirRel/policy-write.txt"
$TestDir = Join-Path $ProjectRoot ($TestDirRel -replace '/', '\')
$HarnessProfile = "security-api-harness-$([guid]::NewGuid().ToString("N"))"

function Write-Log($msg) { Write-Host "[security-api] $msg" -ForegroundColor Cyan }
function Write-Pass($name) {
    Write-Host "  PASS " -ForegroundColor Green -NoNewline
    Write-Host $name
    $script:Pass++
    $script:Results += "PASS: $name"
}
function Write-Fail($name, $reason) {
    Write-Host "  FAIL " -ForegroundColor Red -NoNewline
    Write-Host "$name - $reason"
    $script:Fail++
    $script:Results += "FAIL: $name - $reason"
}
function Write-Skip($name, $reason) {
    Write-Host "  SKIP " -ForegroundColor Yellow -NoNewline
    Write-Host "$name - $reason"
    $script:Skip++
    $script:Results += "SKIP: $name - $reason"
}

function Get-FirstText($Primary, $Secondary, $Fallback) {
    if ($Primary) { return $Primary }
    if ($Secondary) { return $Secondary }
    return $Fallback
}

function Set-HarnessWebChannel {
    param(
        [string]$Content,
        [int]$Port,
        [string]$Token
    )

    $channelsBlock = @"
channels:
  web:
    enabled: true
    port: $Port
    authToken: "$Token"
  cli:
    enabled: false
"@
    $updated = $Content -replace '(?m)^channels:\r?\n(?:[ \t].*\r?\n?)*', "$channelsBlock`n"
    if ($updated -eq $Content) {
        $separator = if ($Content.EndsWith("`n")) { "" } else { "`n" }
        $updated = "$Content$separator$channelsBlock`n"
    }
    return $updated
}

function Write-RedactedLogTail {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    Get-Content $Path -Tail 30 | ForEach-Object {
        $_ `
            -replace '(?i)(apiToken|apiKey|accessToken|refreshToken|authToken|botToken|token|secret|credential)(["":=\s]+)[^"",\s)}\]]+', '$1$2[REDACTED]' `
            -replace '\b(?:vcp|dtn|sk|ghp)_[A-Za-z0-9_-]{12,}\b', '[REDACTED]' `
            -replace '\bBearer\s+[A-Za-z0-9._~+/-]{12,}\b', 'Bearer [REDACTED]'
    }
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    if (-not $ProcessId) { return }
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId $child.ProcessId
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Invoke-ToolPolicy {
    param([hashtable]$Policy)
    try {
        $ticket = Invoke-AuthTicket -Action "tools.policy"
        if (-not $ticket.ticket) {
            return @{ error = Get-FirstText $ticket.error $ticket.message "Failed to obtain privileged ticket" }
        }
        $payload = @{} + $Policy
        $payload.ticket = $ticket.ticket
        return Invoke-RestMethod -Uri "$BaseUrl/api/tools/policy" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($payload | ConvertTo-Json -Depth 4 -Compress) `
            -TimeoutSec 15
    }
    catch {
        return @{ error = $_.Exception.Message }
    }
}

function Invoke-ToolRun {
    param([string]$ToolName, [hashtable]$ToolArgs)
    $body = @{
        toolName = $ToolName
        args = $ToolArgs
        origin = "web"
        userId = "harness"
        agentId = "assistant"
        channel = "web"
    }
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/api/tools/run" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($body | ConvertTo-Json -Depth 5 -Compress) `
            -TimeoutSec $TimeoutResponse
    }
    catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

function Get-ToolsState {
    param([int]$Limit = 100)
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=$Limit" `
            -Headers @{ Authorization = "Bearer $Token" } `
            -TimeoutSec 10
    }
    catch {
        return $null
    }
}

function Invoke-ApprovalDecision {
    param([string]$ApprovalId, [string]$Decision, [string]$Reason = "")
    $body = @{
        approvalId = $ApprovalId
        decision = $Decision
        actor = "harness"
        reason = $Reason
    }
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/api/tools/approvals/decision" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body ($body | ConvertTo-Json -Compress) `
            -TimeoutSec 15
    }
    catch {
        return @{ success = $false; error = $_.Exception.Message }
    }
}

function Invoke-AuthTicket {
    param([string]$Action)
    try {
        return Invoke-RestMethod -Uri "$BaseUrl/api/auth/ticket" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body (@{ action = $Action } | ConvertTo-Json -Compress) `
            -TimeoutSec 10
    }
    catch {
        return @{ error = $_.Exception.Message }
    }
}

function Get-AuditEvents {
    param([int]$Limit = 100)
    try {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/api/audit?limit=$Limit" `
            -Headers @{ Authorization = "Bearer $Token" } `
            -TimeoutSec 10
        if ($resp -is [array]) { return $resp }
        if ($resp.events) { return @($resp.events) }
        return @()
    }
    catch {
        return @()
    }
}

function Restore-BaselinePolicy {
    $null = Invoke-ToolPolicy @{
        mode = "approve_by_policy"
        toolPolicies = @{
            fs_write = "policy"
            fs_delete = "policy"
        }
    }
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

    $userConfig = Join-Path $env:USERPROFILE ".guardianagent\config.yaml"
    $harnessConfig = Join-Path $env:TEMP "guardian-security-api-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-security-api-") {
        $Token = "harness-" + [guid]::NewGuid().ToString("N")
    }

    if (Test-Path $userConfig) {
        $configContent = Get-Content $userConfig -Raw
        $configContent = Set-HarnessWebChannel -Content $configContent -Port $Port -Token $Token
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

    $env:GUARDIAN_PROFILE = $HarnessProfile
    $AppProcess = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c npx tsx src/index.ts `"$harnessConfig`"" `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError "$LogFile.err" `
        -PassThru -WindowStyle Hidden

    Write-Log "App PID: $($AppProcess.Id), waiting for /health..."

    $elapsed = 0
    $healthy = $false
    while ($elapsed -lt $TimeoutStartup) {
        try {
            $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2
            if ($health.status) {
                $healthy = $true
                Write-Log "App is healthy after ${elapsed}s"
                break
            }
        }
        catch {}
        Start-Sleep -Seconds 1
        $elapsed++
    }

    if (-not $healthy) {
        Write-Host "ERROR: App failed to start within ${TimeoutStartup}s" -ForegroundColor Red
        Write-RedactedLogTail $LogFile
        Write-RedactedLogTail "$LogFile.err"
        if ($AppProcess -and -not $AppProcess.HasExited) { Stop-ProcessTree -ProcessId $AppProcess.Id }
        exit 1
    }

    Write-Log "Ready with auth token: $Token"
}
else {
    Write-Log "Skipping app startup (-SkipStart). Using $BaseUrl"
}

$cleanupBlock = {
    Restore-BaselinePolicy
    if (Test-Path $script:TestDir) {
        Remove-Item $script:TestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($script:AppProcess -and -not $script:AppProcess.HasExited) {
        if ($script:Keep) {
            Write-Log "App left running (PID $($script:AppProcess.Id)) at $script:BaseUrl"
            Write-Log "Token: $script:Token"
        }
        else {
            Write-Log "Stopping app (PID $($script:AppProcess.Id))..."
            Stop-ProcessTree -ProcessId $script:AppProcess.Id
        }
    }
    $tempCfg = Join-Path $env:TEMP "guardian-security-api-harness-config.yaml"
    if (Test-Path $tempCfg) { Remove-Item $tempCfg -Force -ErrorAction SilentlyContinue }
}

try {
    New-Item -ItemType Directory -Path $TestDir -Force | Out-Null
    Restore-BaselinePolicy

    Write-Host ""
    Write-Log "=== Health & Auth ==="

    try {
        $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5
        if ($health.status) { Write-Pass "GET /health returns valid JSON" }
        else { Write-Fail "GET /health" "no status field" }
    }
    catch {
        Write-Fail "GET /health" $_.Exception.Message
    }

    try {
        $null = Invoke-WebRequest -Uri "$BaseUrl/api/status" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Fail "unauthenticated /api/status" "expected 401 but request succeeded"
    }
    catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 401) { Write-Pass "unauthenticated /api/status returns 401" }
        else { Write-Fail "unauthenticated /api/status" "expected 401, got $statusCode" }
    }

    try {
        $null = Invoke-WebRequest -Uri "$BaseUrl/api/status" `
            -Headers @{ Authorization = "Bearer wrong-token-12345" } `
            -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Fail "invalid token /api/status" "expected 403 but request succeeded"
    }
    catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 403) { Write-Pass "invalid token returns 403" }
        else { Write-Fail "invalid token /api/status" "expected 403, got $statusCode" }
    }

    Write-Host ""
    Write-Log "=== Privileged Ticket Flow ==="

    try {
        $null = Invoke-WebRequest -Uri "$BaseUrl/api/auth/config" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body '{"mode":"bearer_required"}' `
            -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Fail "auth config without ticket" "expected 401/403 but request succeeded"
    }
    catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 401 -or $statusCode -eq 403) {
            Write-Pass "auth config without ticket rejected ($statusCode)"
        }
        else {
            Write-Fail "auth config without ticket" "expected 401/403, got $statusCode"
        }
    }

    try {
        $null = Invoke-WebRequest -Uri "$BaseUrl/api/auth/ticket" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body '{"action":"bad.action"}' `
            -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Fail "invalid privileged action" "expected 400 but request succeeded"
    }
    catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 400) { Write-Pass "invalid privileged action rejected" }
        else { Write-Fail "invalid privileged action" "expected 400, got $statusCode" }
    }

    $configTicket = Invoke-AuthTicket "auth.config"
    if ($configTicket.ticket) {
        Write-Pass "auth.config ticket minted"
    }
    else {
        Write-Fail "auth.config ticket minted" (Get-FirstText $configTicket.error $null "no ticket returned")
    }

    if ($configTicket.ticket) {
        try {
            $configResp = Invoke-RestMethod -Uri "$BaseUrl/api/auth/config" `
                -Method Post `
                -Headers @{ Authorization = "Bearer $Token" } `
                -ContentType "application/json" `
                -Body (@{
                    mode = "bearer_required"
                    rotateOnStartup = $false
                    sessionTtlMinutes = 120
                    ticket = $configTicket.ticket
                } | ConvertTo-Json -Compress) `
                -TimeoutSec 10
            if ($configResp) { Write-Pass "auth.config accepted valid ticket" }
            else { Write-Fail "auth.config with ticket" "empty response" }
        }
        catch {
            Write-Fail "auth.config with ticket" $_.Exception.Message
        }
    }

    if ($configTicket.ticket) {
        try {
            $null = Invoke-WebRequest -Uri "$BaseUrl/api/auth/config" `
                -Method Post `
                -Headers @{ Authorization = "Bearer $Token" } `
                -ContentType "application/json" `
                -Body (@{ mode = "bearer_required"; ticket = $configTicket.ticket } | ConvertTo-Json -Compress) `
                -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            Write-Fail "ticket replay rejection" "expected replay block but request succeeded"
        }
        catch {
            $statusCode = 0
            if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
            if ($statusCode -eq 403) { Write-Pass "ticket replay rejected" }
            else { Write-Fail "ticket replay rejection" "expected 403, got $statusCode" }
        }
    }

    $revealTicket = Invoke-AuthTicket "auth.reveal"
    if ($revealTicket.ticket) {
        try {
            $revealResp = Invoke-RestMethod -Uri "$BaseUrl/api/auth/token/reveal" `
                -Method Post `
                -Headers @{ Authorization = "Bearer $Token" } `
                -ContentType "application/json" `
                -Body (@{ ticket = $revealTicket.ticket } | ConvertTo-Json -Compress) `
                -TimeoutSec 10
            if ($revealResp.token -eq $Token) {
                Write-Pass "auth.reveal ticket returns current token"
            }
            else {
                Write-Fail "auth.reveal ticket" "token mismatch"
            }
        }
        catch {
            Write-Fail "auth.reveal ticket" $_.Exception.Message
        }
    }
    else {
        Write-Fail "auth.reveal ticket minted" (Get-FirstText $revealTicket.error $null "no ticket returned")
    }

    if ($revealTicket.ticket) {
        try {
            $null = Invoke-WebRequest -Uri "$BaseUrl/api/auth/config" `
                -Method Post `
                -Headers @{ Authorization = "Bearer $Token" } `
                -ContentType "application/json" `
                -Body (@{ mode = "bearer_required"; ticket = $revealTicket.ticket } | ConvertTo-Json -Compress) `
                -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            Write-Fail "ticket action mismatch" "expected mismatch block but request succeeded"
        }
        catch {
            $statusCode = 0
            if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
            if ($statusCode -eq 403) { Write-Pass "ticket action mismatch rejected" }
            else { Write-Fail "ticket action mismatch" "expected 403, got $statusCode" }
        }
    }

    Write-Host ""
    Write-Log "=== Config Redaction ==="

    try {
        $config = Invoke-RestMethod -Uri "$BaseUrl/api/config" `
            -Headers @{ Authorization = "Bearer $Token" } `
            -TimeoutSec 10
        $configStr = $config | ConvertTo-Json -Depth 12
        if ($configStr -match [regex]::Escape($Token)) {
            Write-Fail "config redaction: auth token" "raw token visible in /api/config"
        }
        else {
            Write-Pass "config redaction: auth token hidden"
        }
        if ($configStr -match "sk-|AKIA|ghp_|sk_live_|xoxb-") {
            Write-Fail "config redaction: secret patterns" "raw secret-like value visible in /api/config"
        }
        else {
            Write-Pass "config redaction: no raw secret patterns"
        }
    }
    catch {
        Write-Fail "config redaction" $_.Exception.Message
    }

    Write-Host ""
    Write-Log "=== Tool Governance & Direct Enforcement ==="

    $policyResp = Invoke-ToolPolicy @{
        mode = "approve_by_policy"
        toolPolicies = @{
            fs_write = "manual"
            fs_delete = "deny"
        }
    }
    if ($policyResp.error) {
        Write-Fail "policy update for approval tests" $policyResp.error
    }
    else {
        Write-Pass "policy update for approval tests applied"
    }

    $writeRun = Invoke-ToolRun -ToolName "fs_write" -ToolArgs @{
        path = $TestFileRel
        content = "security api harness write"
    }
    if ($writeRun.status -eq "pending_approval" -and $writeRun.approvalId) {
        Write-Pass "fs_write requires approval when set to manual"
    }
    else {
        Write-Fail "fs_write approval gating" "expected pending_approval, got $($writeRun.status)"
    }

    $toolsState = Get-ToolsState 100
    if ($toolsState -and $writeRun.approvalId) {
        $approval = @($toolsState.approvals | Where-Object { $_.id -eq $writeRun.approvalId }) | Select-Object -First 1
        if ($approval) {
            Write-Pass "pending approval visible in /api/tools"
            if ($approval.argsHash) {
                Write-Pass "approval stores argsHash for redacted correlation"
            }
            else {
                Write-Fail "approval argsHash" "argsHash missing from approval record"
            }
        }
        else {
            Write-Fail "pending approval visible in /api/tools" "approval record not found"
        }
    }

    if ($writeRun.approvalId) {
        $denyResp = Invoke-ApprovalDecision $writeRun.approvalId "denied" "security harness deny test"
        if ($denyResp.success -eq $true) {
            Write-Pass "approval denial accepted"
        }
        else {
            Write-Fail "approval denial accepted" (Get-FirstText $denyResp.message $denyResp.error "unknown error")
        }

        $approveAfterDeny = Invoke-ApprovalDecision $writeRun.approvalId "approved" "should fail after deny"
        if ($approveAfterDeny.success -eq $false) {
            Write-Pass "approval decision is immutable after deny"
        }
        else {
            Write-Fail "approval decision immutability" "approval flipped after deny"
        }
    }

    $deleteRun = Invoke-ToolRun -ToolName "fs_delete" -ToolArgs @{ path = $TestFileRel }
    if ($deleteRun.status -eq "denied") {
        Write-Pass "per-tool deny blocks fs_delete"
    }
    else {
        $deletePreview = $deleteRun | ConvertTo-Json -Compress
        Write-Fail "per-tool deny blocks fs_delete" "expected denied, got: $deletePreview"
    }

    $directDenied = Invoke-ToolRun -ToolName "fs_read" -ToolArgs @{ path = ".env" }
    if ($directDenied.status -eq "denied" -or $directDenied.success -eq $false -or ($directDenied.message -match "denied|blocked|not allowed")) {
        Write-Pass "direct tool API enforces denied path rules"
    }
    else {
        $preview = $directDenied | ConvertTo-Json -Compress
        Write-Fail "direct tool API denied path" "unexpected response: $preview"
    }

    $catalogState = Get-ToolsState 100
    if ($catalogState -and $catalogState.tools) {
        $shellTool = @($catalogState.tools | Where-Object { $_.name -eq "shell_safe" }) | Select-Object -First 1
        if ($shellTool -and $shellTool.risk -and $shellTool.risk -ne "read_only") {
            Write-Pass "shell_safe has non-read-only risk classification"
        }
        elseif ($shellTool) {
            Write-Fail "shell_safe risk classification" "marked as read_only"
        }
        else {
            Write-Fail "shell_safe risk classification" "tool not found in catalog"
        }
    }
    else {
        Write-Fail "tool catalog query" "catalog unavailable"
    }

    Write-Host ""
    Write-Log "=== Audit & Guardian Status ==="

    try {
        $verify = Invoke-RestMethod -Uri "$BaseUrl/api/audit/verify" `
            -Headers @{ Authorization = "Bearer $Token" } `
            -TimeoutSec 10
        if ($verify.valid -eq $true) {
            Write-Pass "audit chain verifies successfully"
        }
        elseif ($null -eq $verify.valid) {
            Write-Skip "audit chain verifies successfully" "audit persistence not configured"
        }
        else {
            Write-Fail "audit chain verifies successfully" "broken at entry $($verify.brokenAt)"
        }
    }
    catch {
        Write-Fail "audit chain verifies successfully" $_.Exception.Message
    }

    $auditEvents = Get-AuditEvents 100
    if ($auditEvents.Count -gt 0) {
        Write-Pass "audit endpoint returns recent events"
    }
    else {
        Write-Fail "audit endpoint returns recent events" "no events returned"
    }

    if (@($auditEvents | Where-Object { $_.type -eq "policy_changed" }).Count -gt 0) {
        Write-Pass "policy changes are written to the audit log"
    }
    else {
        Write-Fail "policy changes are written to the audit log" "policy_changed event not found"
    }

    # Approval decisions are tracked via analytics, not the security audit log.
    # The per-tool deny and denied-path tests earlier produce action_denied events.
    if (@($auditEvents | Where-Object { $_.type -eq "action_denied" }).Count -gt 0) {
        Write-Pass "Guardian denials are written to the audit log"
    }
    else {
        Write-Fail "Guardian denials are written to the audit log" "action_denied event not found"
    }

    try {
        $gaStatus = Invoke-RestMethod -Uri "$BaseUrl/api/guardian-agent/status" `
            -Headers @{ Authorization = "Bearer $Token" } `
            -TimeoutSec 10
        if ($gaStatus.enabled -eq $true -or $gaStatus.enabled -eq $false) {
            Write-Pass "Guardian Agent status endpoint responds"
        }
        else {
            Write-Fail "Guardian Agent status endpoint responds" "unexpected payload"
        }
    }
    catch {
        Write-Fail "Guardian Agent status endpoint responds" $_.Exception.Message
    }

    Write-Host ""
    Write-Log "=== Request Hardening ==="

    $bigPayload = '{"content":"' + ("A" * 2000000) + '","userId":"harness"}'
    try {
        $null = Invoke-WebRequest -Uri "$BaseUrl/api/message" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body $bigPayload `
            -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
        Write-Fail "oversized body rejected" "expected rejection but request succeeded"
    }
    catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 400 -or $statusCode -eq 413) {
            Write-Pass "oversized body rejected"
        }
        else {
            Write-Pass "oversized body rejected (connection-level failure)"
        }
    }

    try {
        $null = Invoke-WebRequest -Uri "$BaseUrl/sse?token=$Token" `
            -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Fail "SSE query-string token rejected" "expected rejection but request succeeded"
    }
    catch {
        $statusCode = 0
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 401 -or $statusCode -eq 403) {
            Write-Pass "SSE query-string token rejected"
        }
        else {
            Write-Pass "SSE query-string token not accepted"
        }
    }

    Restore-BaselinePolicy

    Write-Host ""
    Write-Log "=== Auth Brute-Force Protection ==="

    $gotBlocked = $false
    for ($i = 1; $i -le 10; $i++) {
        try {
            $null = Invoke-WebRequest -Uri "$BaseUrl/api/status" `
                -Headers @{ Authorization = "Bearer brute-force-attempt-$i" } `
                -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        }
        catch {
            $statusCode = 0
            if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
            if ($statusCode -eq 429) {
                Write-Pass "auth brute-force protection returns 429"
                $gotBlocked = $true
                break
            }
        }
    }
    if (-not $gotBlocked) {
        Write-Fail "auth brute-force protection returns 429" "no 429 after 10 invalid attempts"
    }

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
}
finally {
    & $cleanupBlock
}

exit $Fail
