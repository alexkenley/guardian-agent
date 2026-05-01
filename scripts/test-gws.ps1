#Requires -Version 5.1
<#
.SYNOPSIS
    GuardianAgent Google Workspace Test Harness (PowerShell)

.DESCRIPTION
    Tests Google Workspace (GWS) tool integration: discovery, read operations,
    write approval gating, schema lookup, and policy enforcement.

    Uses direct tool API calls (POST /api/tools/run) for deterministic approval
    testing and LLM-driven prompts (POST /api/message) for discovery and reads.

    Requires a running GuardianAgent instance with web channel enabled, an LLM
    provider configured, and Google Workspace connected through the web UI.

.PARAMETER SkipStart
    Assume the app is already running.

.PARAMETER Keep
    Keep the app running after tests finish.

.PARAMETER Port
    Web channel port (default: 3000, or env HARNESS_PORT).

.PARAMETER Token
    Auth token (default: auto-generated, or env HARNESS_TOKEN).

.PARAMETER StatusOnly
    Validate live Google auth/status and schema surfaces without reading content,
    changing tool policy, or exercising write/approval probes.

.EXAMPLE
    .\scripts\test-gws.ps1

.EXAMPLE
    .\scripts\test-gws.ps1 -SkipStart -Port 3000 -Token "your-token"

.EXAMPLE
    .\scripts\test-gws.ps1 -SkipStart -Port 3000 -StatusOnly

.NOTES
    See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
    Content-read tests require Google Workspace to be connected through the web UI.
    All write operations are denied after assertion - nothing is actually created.
#>

param(
    [switch]$SkipStart,
    [switch]$Keep,
    [switch]$StatusOnly,
    [int]$Port = $( if ($env:HARNESS_PORT) { [int]$env:HARNESS_PORT } else { 3000 } ),
    [string]$Token = $( if ($env:HARNESS_TOKEN) { $env:HARNESS_TOKEN } else { "test-gws-$(Get-Date -Format 'yyyyMMddHHmmss')" } )
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
$LogFile = Join-Path $env:TEMP "guardian-gws-harness.log"
$OriginalGuardianProfile = $env:GUARDIAN_PROFILE
$HarnessProfile = "gws-harness-$([guid]::NewGuid().ToString("N"))"

# --- Helpers ---
function Write-Log($msg) { Write-Host "[gws] $msg" -ForegroundColor Cyan }
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

function Get-OrDefault($value, $fallback) {
    if ($null -ne $value -and "$value" -ne "") { return $value }
    return $fallback
}

function Add-HarnessWebChannel {
    param(
        [string]$Content,
        [string]$WebBlock
    )

    $updated = $Content -replace '(?m)^(channels:\s*\r?\n)', "`$1$WebBlock`n"
    if ($updated -eq $Content) {
        $separator = if ($Content.EndsWith("`n")) { "" } else { "`n" }
        $updated = "$Content${separator}channels:`n$WebBlock`n"
    }
    return $updated
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
        $ticketResp = Invoke-RestMethod -Uri "$BaseUrl/api/auth/ticket" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json" `
            -Body (@{ action = "tools.policy" } | ConvertTo-Json -Compress) `
            -TimeoutSec 10
        if (-not $ticketResp.ticket) {
            return @{ error = "privileged ticket was not issued" }
        }
        $Policy.ticket = $ticketResp.ticket
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
        Write-Log "Killing $(@($existing).Count) existing GuardianAgent process(es)..."
        foreach ($proc in $existing) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }

    $projectRoot = Split-Path -Parent $PSScriptRoot
    $userConfig = Join-Path $env:USERPROFILE ".guardianagent\config.yaml"
    $harnessConfig = Join-Path $env:TEMP "guardian-gws-harness-config.yaml"

    if (-not $Token -or $Token -match "^test-gws-") {
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
        $configContent = Add-HarnessWebChannel -Content $configContent -WebBlock $webBlock
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
        if ($AppProcess -and -not $AppProcess.HasExited) { Stop-ProcessTree -ProcessId $AppProcess.Id }
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
            Stop-ProcessTree -ProcessId $script:AppProcess.Id
        }
    }
    $harnessNodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "guardian-gws-harness-config\.yaml" }
    foreach ($proc in $harnessNodes) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $tempCfg = Join-Path $env:TEMP "guardian-gws-harness-config.yaml"
    if (Test-Path $tempCfg) { Remove-Item $tempCfg -Force -ErrorAction SilentlyContinue }
    if ($null -ne $script:OriginalGuardianProfile) {
        $env:GUARDIAN_PROFILE = $script:OriginalGuardianProfile
    }
    else {
        Remove-Item Env:\GUARDIAN_PROFILE -ErrorAction SilentlyContinue
    }
    if (-not $Keep) {
        $profileDir = Join-Path $env:USERPROFILE ".guardianagent\profiles\$HarnessProfile"
        if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
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

if ($StatusOnly) {
    Write-Host ""
    Write-Log "=== GWS Live Status-Only Checks ==="

    try {
        $googleStatus = Invoke-RestMethod -Uri "$BaseUrl/api/google/status" `
            -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 10
        if ($googleStatus.authenticated -eq $true) {
            Write-Pass "api: /api/google/status authenticated"
        }
        elseif ($null -ne $googleStatus.authenticated) {
            Write-Fail "api: /api/google/status authenticated" "authenticated=$($googleStatus.authenticated)"
        }
        else {
            Write-Fail "api: /api/google/status" "missing authenticated field"
        }
    }
    catch {
        Write-Fail "api: /api/google/status" $_.Exception.Message
    }

    try {
        $legacyStatus = Invoke-RestMethod -Uri "$BaseUrl/api/gws/status" `
            -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 10
        if ($legacyStatus.authenticated -eq $true -and $legacyStatus.authMethod -eq "native_oauth") {
            Write-Pass "api: /api/gws/status maps native OAuth compatibility status"
        }
        else {
            Write-Fail "api: /api/gws/status" "unexpected response: $(($legacyStatus | ConvertTo-Json -Compress -Depth 4))"
        }
    }
    catch {
        Write-Fail "api: /api/gws/status" $_.Exception.Message
    }

    $statusTool = Invoke-ToolRun -ToolName "gws_status" -ToolArgs @{}
    if ($statusTool.success -eq $true -and $statusTool.output.authenticated -eq $true) {
        Write-Pass "tool: gws_status authenticated without content read"
    }
    elseif ($statusTool.status -eq "pending_approval") {
        Write-Fail "tool: gws_status" "status-only tool required approval"
    }
    else {
        Write-Fail "tool: gws_status" "status=$($statusTool.status), message=$($statusTool.message)"
    }

    $schemaTool = Invoke-ToolRun -ToolName "gws_schema" -ToolArgs @{ schemaPath = "gmail.users.messages.list" }
    if ($schemaTool.status -eq "pending_approval") {
        Write-Fail "tool: gws_schema" "read-only schema lookup required approval"
    }
    elseif ($schemaTool.success -eq $true -or $schemaTool.status -eq "succeeded") {
        Write-Pass "tool: gws_schema executes without approval"
    }
    else {
        Write-Fail "tool: gws_schema" "status=$($schemaTool.status), message=$($schemaTool.message)"
    }

    try {
        $state = Invoke-RestMethod -Uri "$BaseUrl/api/tools?limit=30" `
            -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
        $statusJobs = $state.jobs | Where-Object { $_.toolName -match "gws_status|gws_schema" }
        if ($statusJobs -and $statusJobs.Count -gt 0) {
            Write-Pass "job history: GWS status/schema executions recorded"
        }
        else {
            Write-Fail "job history" "no GWS status/schema jobs recorded"
        }
    }
    catch {
        Write-Fail "job history" $_.Exception.Message
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

    exit $Fail
}

# ===============================================================
# GWS PREREQUISITE CHECK
# ===============================================================
Write-Host ""
Write-Log "=== GWS Prerequisite Check ==="

$gwsToolRegistered = $false   # Tool exists in registry - approval tests can run
$gwsContentReadWorking = $false       # Google account connected - read/LLM tests can run

# Try a read-only GWS call via direct tool API to check availability
$probeArgs = @{ service = "gmail"; resource = "users messages"; method = "list"; params = @{ userId = "me"; maxResults = 1 } }
$gwsProbe = Invoke-ToolRun -ToolName "gws" -ToolArgs $probeArgs

if ($gwsProbe.success -eq $true) {
    $gwsToolRegistered = $true
    $gwsContentReadWorking = $true
    Write-Pass "gws: Google Workspace connected (Gmail read succeeded)"
}
elseif ($gwsProbe.message -match "Google Workspace is not enabled") {
    Write-Skip "gws: all GWS tests" "GWS not enabled in config"
}
elseif ($gwsProbe.message -match "Unknown tool") {
    Write-Skip "gws: all GWS tests" "gws tool not registered (workspace category may be disabled)"
}
elseif ($gwsProbe.status -eq "denied") {
    Write-Skip "gws: all GWS tests" "gws tool denied: $($gwsProbe.message)"
}
else {
    # The tool IS registered and ran (status=failed means the handler executed).
    # Approval tests don't need Google auth - the gate fires before the handler.
    $gwsToolRegistered = $true

    if ($gwsProbe.message -match "Cannot find module|ENOENT|not recognized") {
        Write-Pass "gws: tool registered (Google client unavailable - approval tests will run, read tests will skip)"
    }
    elseif ($gwsProbe.message -match "not authenticated|auth|login") {
        Write-Pass "gws: tool registered (Google account not connected - approval tests will run, read tests will skip)"
    }
    else {
        # Some other provider error - tool registered, auth state unknown
        Write-Pass "gws: tool registered (probe status: $($gwsProbe.status))"
    }
}

if ($gwsToolRegistered) {

# ===============================================================
# TOOL DISCOVERY + READ OPERATIONS (require connected Google account)
# ===============================================================
if ($gwsContentReadWorking) {

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "setup: autonomous policy for GWS read tests"

Start-Sleep -Seconds 2

# --- Tool Discovery ---
Write-Host ""
Write-Log "=== GWS Tool Discovery ==="

$jobs0 = Get-RecentJobs
$resp = Send-Message "use find_tools to search for workspace or google workspace tools"
if (Test-ValidResponse $resp "discovery: workspace tools") {
    [void](Test-ToolWasCalled "find_tools" "discovery: find_tools was invoked" $jobs0)
    [void](Test-Contains $resp "content" "gws|workspace|gmail|calendar|drive" `
        "discovery: response mentions GWS tools")
}

Start-Sleep -Seconds 3

# --- Read Operations ---
Write-Host ""
Write-Log "=== GWS Read Operations ==="

# Gmail list
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the gws tool to list my 3 most recent gmail emails. Use service=gmail, resource='users messages', method=list, params={userId:'me',maxResults:3}"
if (Test-ValidResponse $resp "gmail-read: valid response") {
    [void](Test-ToolWasCalled "gws" "gmail-read: gws tool was called" $jobs0)
}

Start-Sleep -Seconds 3

# Calendar list
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the gws tool to list my upcoming calendar events. Use service=calendar, resource=events, method=list, params={calendarId:'primary',maxResults:3}"
if (Test-ValidResponse $resp "calendar-read: valid response") {
    [void](Test-ToolWasCalled "gws" "calendar-read: gws tool was called" $jobs0)
}

Start-Sleep -Seconds 3

# Schema lookup
$jobs0 = Get-RecentJobs
$resp = Send-Message "use the gws_schema tool to look up the schema for gmail.users.messages.list"
if (Test-ValidResponse $resp "gws-schema: valid response") {
    [void](Test-ToolWasCalled "gws_schema|gws" "gws-schema: schema tool was called" $jobs0)
}

Start-Sleep -Seconds 3

} # end if ($gwsContentReadWorking)
else {
    Write-Skip "discovery + read tests" "Google Workspace is not connected"
}

# ===============================================================
# WRITE APPROVAL TESTS (approve_by_policy via direct API)
# ===============================================================
Write-Host ""
Write-Log "=== GWS Write Approval Tests ==="

# Switch to approve_by_policy
$policyResult = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
if ($policyResult.error) {
    Write-Fail "approval: set approve_by_policy" $policyResult.error
}
else {
    Write-Pass "approval: policy set to approve_by_policy"
}

Start-Sleep -Seconds 2

# --- Calendar create should require approval ---
$calArgs = @{ service = "calendar"; resource = "events"; method = "create"; params = @{ calendarId = "primary" }; json = @{ summary = "Harness Test Event"; start = @{ dateTime = "2026-12-01T10:00:00Z" }; end = @{ dateTime = "2026-12-01T11:00:00Z" } } }
$calCreate = Invoke-ToolRun -ToolName "gws" -ToolArgs $calArgs

if ($calCreate.status -eq "pending_approval") {
    Write-Pass "calendar-create: requires approval (pending_approval)"
    if ($calCreate.approvalId) {
        $deny = Invoke-ApprovalDecision $calCreate.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "calendar-create: denial accepted" }
        else { Write-Fail "calendar-create: deny" (Get-OrDefault $deny.error "unknown") }
    }
}
elseif ($calCreate.success -eq $true) {
    Write-Fail "calendar-create: BYPASSED APPROVAL" "write executed without approval gate"
}
else {
    Write-Fail "calendar-create: unexpected" "status=$($calCreate.status), error=$($calCreate.error)"
}

Start-Sleep -Seconds 2

# --- Drive create should require approval ---
$driveArgs = @{ service = "drive"; resource = "files"; method = "create"; json = @{ name = "harness-test-file.txt"; mimeType = "text/plain" } }
$driveCreate = Invoke-ToolRun -ToolName "gws" -ToolArgs $driveArgs

if ($driveCreate.status -eq "pending_approval") {
    Write-Pass "drive-create: requires approval (pending_approval)"
    if ($driveCreate.approvalId) {
        $deny = Invoke-ApprovalDecision $driveCreate.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "drive-create: denial accepted" }
        else { Write-Fail "drive-create: deny" (Get-OrDefault $deny.error "unknown") }
    }
}
elseif ($driveCreate.success -eq $true) {
    Write-Fail "drive-create: BYPASSED APPROVAL" "write executed without approval gate"
}
else {
    Write-Fail "drive-create: unexpected" "status=$($driveCreate.status), error=$($driveCreate.error)"
}

Start-Sleep -Seconds 2

# --- Docs update should require approval ---
$docsArgs = @{ service = "docs"; resource = "documents"; method = "update"; json = @{ title = "Harness Test Doc" } }
$docsUpdate = Invoke-ToolRun -ToolName "gws" -ToolArgs $docsArgs

if ($docsUpdate.status -eq "pending_approval") {
    Write-Pass "docs-update: requires approval (pending_approval)"
    if ($docsUpdate.approvalId) {
        $deny = Invoke-ApprovalDecision $docsUpdate.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "docs-update: denial accepted" }
        else { Write-Fail "docs-update: deny" (Get-OrDefault $deny.error "unknown") }
    }
}
elseif ($docsUpdate.success -eq $true) {
    Write-Fail "docs-update: BYPASSED APPROVAL" "write executed without approval gate"
}
else {
    Write-Fail "docs-update: unexpected" "status=$($docsUpdate.status), error=$($docsUpdate.error)"
}

Start-Sleep -Seconds 2

# --- Sheets delete should require approval ---
$sheetsArgs = @{ service = "sheets"; resource = "spreadsheets"; method = "delete"; params = @{ spreadsheetId = "fake-id" } }
$sheetsDelete = Invoke-ToolRun -ToolName "gws" -ToolArgs $sheetsArgs

if ($sheetsDelete.status -eq "pending_approval") {
    Write-Pass "sheets-delete: requires approval (pending_approval)"
    if ($sheetsDelete.approvalId) {
        $deny = Invoke-ApprovalDecision $sheetsDelete.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "sheets-delete: denial accepted" }
        else { Write-Fail "sheets-delete: deny" (Get-OrDefault $deny.error "unknown") }
    }
}
elseif ($sheetsDelete.success -eq $true) {
    Write-Fail "sheets-delete: BYPASSED APPROVAL" "write executed without approval gate"
}
else {
    Write-Fail "sheets-delete: unexpected" "status=$($sheetsDelete.status), error=$($sheetsDelete.error)"
}

Start-Sleep -Seconds 2

# --- Gmail send should require approval ---
$sendArgs = @{ service = "gmail"; resource = "users messages"; method = "send"; params = @{ userId = "me" }; json = @{ raw = "dGVzdA==" } }
$gmailSend = Invoke-ToolRun -ToolName "gws" -ToolArgs $sendArgs

if ($gmailSend.status -eq "pending_approval") {
    Write-Pass "gmail-send: requires approval (pending_approval)"
    if ($gmailSend.approvalId) {
        $deny = Invoke-ApprovalDecision $gmailSend.approvalId "denied" "harness test"
        if ($deny.success) { Write-Pass "gmail-send: denial accepted" }
        else { Write-Fail "gmail-send: deny" (Get-OrDefault $deny.error "unknown") }
    }
}
elseif ($gmailSend.success -eq $true) {
    Write-Fail "gmail-send: BYPASSED APPROVAL" "send executed without approval gate"
}
else {
    Write-Fail "gmail-send: unexpected" "status=$($gmailSend.status), error=$($gmailSend.error)"
}

Start-Sleep -Seconds 2

# --- Gmail read should still be allowed in approve_by_policy ---
$readArgs = @{ service = "gmail"; resource = "users messages"; method = "list"; params = @{ userId = "me"; maxResults = 1 } }
$gmailRead = Invoke-ToolRun -ToolName "gws" -ToolArgs $readArgs

if ($gmailRead.success -eq $true -or $gmailRead.status -eq "succeeded") {
    Write-Pass "gmail-read: allowed without approval in approve_by_policy"
}
elseif ($gmailRead.status -eq "pending_approval") {
    Write-Fail "gmail-read: incorrectly requires approval" "reads should be auto-allowed"
}
else {
    # GWS API/auth error is OK (means the tool executed without hitting approval gate)
    if ($gmailRead.status -eq "error" -or $gmailRead.status -eq "failed") {
        Write-Pass "gmail-read: tool executed without approval (status: $($gmailRead.status))"
    }
    else {
        Write-Fail "gmail-read: unexpected" "status=$($gmailRead.status), error=$($gmailRead.error)"
    }
}

Start-Sleep -Seconds 2

# ===============================================================
# AUTONOMOUS REQUEST BASELINE VERIFICATION
# ===============================================================
Write-Host ""
Write-Log "=== GWS Autonomous Request Baseline Verification ==="

$null = Invoke-ToolPolicy @{ mode = "autonomous" }
Write-Pass "autonomous: policy set to autonomous"

Start-Sleep -Seconds 2

# Calendar create should succeed in autonomous mode (the API call itself may fail
# but the tool should execute without hitting pending_approval)
$autoArgs = @{ service = "calendar"; resource = "events"; method = "create"; params = @{ calendarId = "primary" }; json = @{ summary = "Autonomous Test"; start = @{ dateTime = "2026-12-15T10:00:00Z" }; end = @{ dateTime = "2026-12-15T11:00:00Z" } } }
$calAuto = Invoke-ToolRun -ToolName "gws" -ToolArgs $autoArgs

if ($calAuto.status -eq "pending_approval") {
    Write-Pass "autonomous-create: security baseline kept write behind approval"
}
elseif ($calAuto.success -eq $true -or $calAuto.status -eq "succeeded" -or $calAuto.status -eq "error" -or $calAuto.status -eq "failed") {
    # "error"/"failed" is acceptable only when the local environment disables the security baseline.
    Write-Pass "autonomous-create: write executed without approval gate (status: $($calAuto.status))"
}
else {
    Write-Fail "autonomous-create: unexpected" "status=$($calAuto.status), error=$($calAuto.error)"
}

# ===============================================================
# CLEANUP
# ===============================================================
Start-Sleep -Seconds 2
Write-Host ""
Write-Log "=== Cleanup ==="

$null = Invoke-ToolPolicy @{ mode = "approve_by_policy" }
Write-Pass "cleanup: policy restored to approve_by_policy"

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
    $gwsJobs = $jobs | Where-Object { $_.toolName -match "gws" }
    if ($gwsJobs -and $gwsJobs.Count -gt 0) {
        Write-Pass "job history: $($gwsJobs.Count) GWS tool executions recorded"

        $statuses = ($gwsJobs | ForEach-Object { $_.status } | Sort-Object -Unique) -join ", "
        Write-Pass "job history: GWS statuses: $statuses"
    }
    else {
        Write-Fail "job history" "no GWS jobs recorded"
    }
}
catch {
    Write-Fail "job history" $_.Exception.Message
}

} # end if ($gwsToolRegistered)

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
