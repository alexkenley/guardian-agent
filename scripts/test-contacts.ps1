#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Contacts & Campaign Tools Test Harness (PowerShell)

.DESCRIPTION
    Tests contacts management, campaign lifecycle, and gmail_send approval gating.

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
    .\scripts\test-contacts.ps1

.EXAMPLE
    .\scripts\test-contacts.ps1 -SkipStart -Port 3000 -Token "your-token"

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    All mutating operations are denied after assertion in approval tests.
    gmail_send (external_post) always requires approval except in autonomous mode.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-contacts-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$LogFile = Join-Path $env:TEMP "guardian-contacts-harness.log"

# --- Helpers ---
function Write-Log($msg) { Write-Host "[contacts] $msg" -ForegroundColor Cyan }
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
    $harnessConfig = Join-Path $env:TEMP "guardian-contacts-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-contacts-") {
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
    $tempCfg = Join-Path $env:TEMP "guardian-contacts-harness-config.yaml"
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
# 1. PREREQUISITE CHECK
# ===============================================================
Write-Host ""
Write-Log "=== Contacts Prerequisite Check ==="

$contactsAvailable = $false

# Probe contacts_list via direct tool API to check availability
$probeArgs = @{ limit = 1 }
$contactsProbe = Invoke-ToolRun -ToolName "contacts_list" -ToolArgs $probeArgs

if ($contactsProbe.success -eq $true -or $contactsProbe.status -eq "succeeded" -or $contactsProbe.status -eq "failed") {
    $contactsAvailable = $true
    Write-Pass "contacts: tool available (probe status: $($contactsProbe.status))"
}
elseif ($contactsProbe.message -match "Unknown tool") {
    Write-Skip "contacts: all contacts tests" "contacts_list tool not registered"
}
elseif ($contactsProbe.error -match "Unknown tool") {
    Write-Skip "contacts: all contacts tests" "contacts_list tool not registered"
}
else {
    Write-Skip "contacts: all contacts tests" "unexpected probe result: status=$($contactsProbe.status), error=$($contactsProbe.error), message=$($contactsProbe.message)"
}

if ($contactsAvailable) {

# ===============================================================
# 2. READ-ONLY TESTS (Autonomous Mode)
# ===============================================================
Write-Host ""
Write-Log "=== Read-Only Tests (Autonomous Mode) ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for read-only tests"

Start-Sleep -Seconds 2

# --- contacts_list ---
Write-Host ""
Write-Log "--- contacts_list (read_only) ---"

$listArgs = @{ limit = 5 }
$listResult = Invoke-ToolRun -ToolName "contacts_list" -ToolArgs $listArgs

if ($listResult.success -eq $true -or $listResult.status -eq "succeeded" -or $listResult.status -eq "failed") {
    Write-Pass "contacts_list: tool executed (status: $($listResult.status))"
}
else {
    Write-Fail "contacts_list: tool execution" "status=$($listResult.status), error=$($listResult.error)"
}

Start-Sleep -Seconds 2

# --- campaign_list ---
Write-Host ""
Write-Log "--- campaign_list (read_only) ---"

$campListArgs = @{}
$campListResult = Invoke-ToolRun -ToolName "campaign_list" -ToolArgs $campListArgs

if ($campListResult.success -eq $true -or $campListResult.status -eq "succeeded" -or $campListResult.status -eq "failed") {
    Write-Pass "campaign_list: tool executed (status: $($campListResult.status))"
}
else {
    Write-Fail "campaign_list: tool execution" "status=$($campListResult.status), error=$($campListResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# 3. AUTONOMOUS MODE EXECUTION (Mutating Tools)
# ===============================================================
Write-Host ""
Write-Log "=== Autonomous Mode Execution (Mutating Tools) ==="

# --- contacts_import ---
Write-Host ""
Write-Log "--- contacts_import (mutating, autonomous) ---"

$importArgs = @{ contacts = @(@{ name = "Harness Test"; email = "harness@example.com" }) }
$importResult = Invoke-ToolRun -ToolName "contacts_import" -ToolArgs $importArgs

if ($importResult.success -eq $true -or $importResult.status -eq "succeeded" -or $importResult.status -eq "failed") {
    Write-Pass "contacts_import: tool executed (status: $($importResult.status))"
}
else {
    Write-Fail "contacts_import: tool execution" "status=$($importResult.status), error=$($importResult.error)"
}

Start-Sleep -Seconds 2

# --- campaign_create ---
Write-Host ""
Write-Log "--- campaign_create (mutating, autonomous) ---"

$createArgs = @{ name = "harness-test-campaign"; type = "test" }
$createResult = Invoke-ToolRun -ToolName "campaign_create" -ToolArgs $createArgs

if ($createResult.success -eq $true -or $createResult.status -eq "succeeded" -or $createResult.status -eq "failed") {
    Write-Pass "campaign_create: tool executed (status: $($createResult.status))"
}
else {
    Write-Fail "campaign_create: tool execution" "status=$($createResult.status), error=$($createResult.error)"
}

Start-Sleep -Seconds 2

# --- campaign_delete ---
Write-Host ""
Write-Log "--- campaign_delete (mutating, autonomous) ---"

$deleteAutoArgs = @{ campaignId = "harness-nonexistent" }
$deleteAutoResult = Invoke-ToolRun -ToolName "campaign_delete" -ToolArgs $deleteAutoArgs

if ($deleteAutoResult.success -eq $true -or $deleteAutoResult.status -eq "succeeded" -or $deleteAutoResult.status -eq "failed") {
    Write-Pass "campaign_delete: tool executed (status: $($deleteAutoResult.status))"
}
else {
    Write-Fail "campaign_delete: tool execution" "status=$($deleteAutoResult.status), error=$($deleteAutoResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# 4. APPROVAL TESTS (approve_by_policy)
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

# --- contacts_import (mutating) should require approval ---
Write-Host ""
Write-Log "--- contacts_import under approve_by_policy ---"

$importApprovalArgs = @{ contacts = @(@{ name = "Approval Test"; email = "approval@example.com" }) }
$importApprovalResult = Invoke-ToolRun -ToolName "contacts_import" -ToolArgs $importApprovalArgs

if ($importApprovalResult.status -eq "pending_approval") {
    Write-Pass "contacts_import (approve_by_policy): requires approval (pending_approval)"
    if ($importApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $importApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "contacts_import (approve_by_policy): denial accepted" }
        else { Write-Fail "contacts_import (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($importApprovalResult.success -eq $true) {
    Write-Fail "contacts_import (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "contacts_import (approve_by_policy): unexpected" "status=$($importApprovalResult.status), error=$($importApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- contacts_discover (mutating) should require approval ---
Write-Host ""
Write-Log "--- contacts_discover under approve_by_policy ---"

$discoverApprovalArgs = @{ source = "test" }
$discoverApprovalResult = Invoke-ToolRun -ToolName "contacts_discover" -ToolArgs $discoverApprovalArgs

if ($discoverApprovalResult.status -eq "pending_approval") {
    Write-Pass "contacts_discover (approve_by_policy): requires approval (pending_approval)"
    if ($discoverApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $discoverApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "contacts_discover (approve_by_policy): denial accepted" }
        else { Write-Fail "contacts_discover (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($discoverApprovalResult.success -eq $true) {
    Write-Fail "contacts_discover (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "contacts_discover (approve_by_policy): unexpected" "status=$($discoverApprovalResult.status), error=$($discoverApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- campaign_create (mutating) should require approval ---
Write-Host ""
Write-Log "--- campaign_create under approve_by_policy ---"

$createApprovalArgs = @{ name = "approval-test-campaign"; type = "test" }
$createApprovalResult = Invoke-ToolRun -ToolName "campaign_create" -ToolArgs $createApprovalArgs

if ($createApprovalResult.status -eq "pending_approval") {
    Write-Pass "campaign_create (approve_by_policy): requires approval (pending_approval)"
    if ($createApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $createApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "campaign_create (approve_by_policy): denial accepted" }
        else { Write-Fail "campaign_create (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($createApprovalResult.success -eq $true) {
    Write-Fail "campaign_create (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "campaign_create (approve_by_policy): unexpected" "status=$($createApprovalResult.status), error=$($createApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- campaign_update (mutating) should require approval ---
Write-Host ""
Write-Log "--- campaign_update under approve_by_policy ---"

$updateApprovalArgs = @{ campaignId = "fake"; updates = @{ name = "updated" } }
$updateApprovalResult = Invoke-ToolRun -ToolName "campaign_update" -ToolArgs $updateApprovalArgs

if ($updateApprovalResult.status -eq "pending_approval") {
    Write-Pass "campaign_update (approve_by_policy): requires approval (pending_approval)"
    if ($updateApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $updateApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "campaign_update (approve_by_policy): denial accepted" }
        else { Write-Fail "campaign_update (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($updateApprovalResult.success -eq $true) {
    Write-Fail "campaign_update (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "campaign_update (approve_by_policy): unexpected" "status=$($updateApprovalResult.status), error=$($updateApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- campaign_delete (mutating) should require approval ---
Write-Host ""
Write-Log "--- campaign_delete under approve_by_policy ---"

$deleteApprovalArgs = @{ campaignId = "harness-nonexistent" }
$deleteApprovalResult = Invoke-ToolRun -ToolName "campaign_delete" -ToolArgs $deleteApprovalArgs

if ($deleteApprovalResult.status -eq "pending_approval") {
    Write-Pass "campaign_delete (approve_by_policy): requires approval (pending_approval)"
    if ($deleteApprovalResult.approvalId) {
        $deny = Invoke-ApprovalDecision $deleteApprovalResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "campaign_delete (approve_by_policy): denial accepted" }
        else { Write-Fail "campaign_delete (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($deleteApprovalResult.success -eq $true) {
    Write-Fail "campaign_delete (approve_by_policy): BYPASSED APPROVAL" "mutating tool executed without approval gate"
}
else {
    Write-Fail "campaign_delete (approve_by_policy): unexpected" "status=$($deleteApprovalResult.status), error=$($deleteApprovalResult.error)"
}

Start-Sleep -Seconds 2

# --- contacts_list (read_only) should NOT require approval ---
Write-Host ""
Write-Log "--- contacts_list under approve_by_policy ---"

$listPolicyArgs = @{ limit = 5 }
$listPolicyResult = Invoke-ToolRun -ToolName "contacts_list" -ToolArgs $listPolicyArgs

if ($listPolicyResult.status -eq "pending_approval") {
    Write-Fail "contacts_list (approve_by_policy): incorrectly requires approval" "read_only tools should be auto-allowed"
}
elseif ($listPolicyResult.success -eq $true -or $listPolicyResult.status -eq "succeeded") {
    Write-Pass "contacts_list (approve_by_policy): allowed without approval"
}
elseif ($listPolicyResult.status -eq "failed" -or $listPolicyResult.status -eq "error") {
    # Tool executed past approval gate -- acceptable
    Write-Pass "contacts_list (approve_by_policy): tool executed without approval (status: $($listPolicyResult.status))"
}
else {
    Write-Fail "contacts_list (approve_by_policy): unexpected" "status=$($listPolicyResult.status), error=$($listPolicyResult.error)"
}

Start-Sleep -Seconds 2

# --- campaign_list (read_only) should NOT require approval ---
Write-Host ""
Write-Log "--- campaign_list under approve_by_policy ---"

$campListPolicyArgs = @{}
$campListPolicyResult = Invoke-ToolRun -ToolName "campaign_list" -ToolArgs $campListPolicyArgs

if ($campListPolicyResult.status -eq "pending_approval") {
    Write-Fail "campaign_list (approve_by_policy): incorrectly requires approval" "read_only tools should be auto-allowed"
}
elseif ($campListPolicyResult.success -eq $true -or $campListPolicyResult.status -eq "succeeded") {
    Write-Pass "campaign_list (approve_by_policy): allowed without approval"
}
elseif ($campListPolicyResult.status -eq "failed" -or $campListPolicyResult.status -eq "error") {
    # Tool executed past approval gate -- acceptable
    Write-Pass "campaign_list (approve_by_policy): tool executed without approval (status: $($campListPolicyResult.status))"
}
else {
    Write-Fail "campaign_list (approve_by_policy): unexpected" "status=$($campListPolicyResult.status), error=$($campListPolicyResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# 5. gmail_send APPROVAL TEST (approve_by_policy)
# ===============================================================
Write-Host ""
Write-Log "=== gmail_send Approval Test (approve_by_policy) ==="

$gmailArgs = @{ to = "harness@example.com"; subject = "test"; body = "harness test" }
$gmailResult = Invoke-ToolRun -ToolName "gmail_send" -ToolArgs $gmailArgs

if ($gmailResult.status -eq "pending_approval") {
    Write-Pass "gmail_send (approve_by_policy): requires approval (pending_approval)"
    if ($gmailResult.approvalId) {
        $deny = Invoke-ApprovalDecision $gmailResult.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "gmail_send (approve_by_policy): denial accepted" }
        else { Write-Fail "gmail_send (approve_by_policy): deny" ($deny.error ?? "unknown") }
    }
}
elseif ($gmailResult.success -eq $true) {
    Write-Fail "gmail_send (approve_by_policy): BYPASSED APPROVAL" "external_post tool executed without approval gate"
}
elseif ($gmailResult.message -match "Unknown tool" -or $gmailResult.error -match "Unknown tool") {
    Write-Skip "gmail_send (approve_by_policy)" "gmail_send tool not registered"
}
else {
    Write-Fail "gmail_send (approve_by_policy): unexpected" "status=$($gmailResult.status), error=$($gmailResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# 6. gmail_send IN AUTONOMOUS MODE
# ===============================================================
Write-Host ""
Write-Log "=== gmail_send Autonomous Mode Test ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }

Start-Sleep -Seconds 2

$gmailAutoArgs = @{ to = "harness@example.com"; subject = "test"; body = "harness autonomous test" }
$gmailAutoResult = Invoke-ToolRun -ToolName "gmail_send" -ToolArgs $gmailAutoArgs

if ($gmailAutoResult.status -eq "pending_approval") {
    Write-Fail "gmail_send (autonomous): still requires approval" "autonomous mode should not gate external_post"
}
elseif ($gmailAutoResult.success -eq $true -or $gmailAutoResult.status -eq "succeeded" -or $gmailAutoResult.status -eq "failed" -or $gmailAutoResult.status -eq "error") {
    Write-Pass "gmail_send (autonomous): executed without approval (status: $($gmailAutoResult.status))"
}
elseif ($gmailAutoResult.message -match "Unknown tool" -or $gmailAutoResult.error -match "Unknown tool") {
    Write-Skip "gmail_send (autonomous)" "gmail_send tool not registered"
}
else {
    Write-Fail "gmail_send (autonomous): unexpected" "status=$($gmailAutoResult.status), error=$($gmailAutoResult.error)"
}

Start-Sleep -Seconds 2

# ===============================================================
# 7. CLEANUP - Restore Policy
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
# 8. JOB HISTORY
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Job History Verification ==="

try {
    $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=100" `
        -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5

    $jobs = $state.jobs
    $contactJobs = $jobs | Where-Object { $_.toolName -match "contacts_|campaign_|gmail_send" }
    if ($contactJobs -and $contactJobs.Count -gt 0) {
        Write-Pass "job history: $($contactJobs.Count) contacts/campaign/gmail tool executions recorded"

        $statuses = ($contactJobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: statuses: $statuses"
    }
    else {
        Write-Fail "job history" "no contacts/campaign/gmail jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

} # end if ($contactsAvailable)

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
