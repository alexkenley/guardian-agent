# GuardianAgent — Local Development Script
# Cleans build artifacts, rebuilds, tests, checks dependencies, and starts the system.
#
# Usage:
#   .\scripts\start-dev-windows.ps1              # Clean build + test + start
#   .\scripts\start-dev-windows.ps1 -SkipTests   # Clean build + start (skip tests)
#   .\scripts\start-dev-windows.ps1 -BuildOnly   # Clean build + test only (don't start)
#   .\scripts\start-dev-windows.ps1 -StartOnly   # Start without rebuilding

param(
    [switch]$SkipTests,
    [switch]$BuildOnly,
    [switch]$StartOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$OriginalDir = Get-Location
Set-Location $Root

function Write-WaitLine {
    param(
        [string]$Message
    )
    Write-Host "  Please wait — $Message" -ForegroundColor DarkGray
}

function Wait-ForProcessWithMessages {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,
        [string[]]$Messages = @("Working..."),
        [int]$IntervalSeconds = 4
    )

    $intervalMs = [Math]::Max(250, $IntervalSeconds * 1000)
    $index = 0
    while (-not $Process.HasExited) {
        if (-not $Process.HasExited -and $Messages.Count -gt 0) {
            $message = $Messages[$index % $Messages.Count]
            Write-WaitLine $message
            $index++
        }
        $null = $Process.WaitForExit($intervalMs)
        $Process.Refresh()
    }

    $Process.WaitForExit()
    $Process.Refresh()
    return [int]$Process.ExitCode
}

function Get-TestWaitMessages {
    return @(
        "Reticulating Splines...",
        "Correlating failing dimensions...",
        "Reindexing assertion nebulae...",
        "Consulting the flake detector...",
        "Probing CLI command routing...",
        "Verifying web channel auth paths...",
        "Exercising CORS guardrails...",
        "Stressing request body limits...",
        "Validating SSE stream handling...",
        "Auditing static path traversal blocks...",
        "Checking runtime watchdog behavior...",
        "Scanning for secret redaction leaks...",
        "Simulating prompt-injection defenses...",
        "Evaluating rate limiter thresholds...",
        "Replaying anomaly detection events...",
        "Exercising budget timeout controls...",
        "Verifying provider failover logic...",
        "Inspecting threat-intel workflows...",
        "Cross-checking moltbook connector safety...",
        "Synchronizing audit event timelines...",
        "Rebuilding provider capability map...",
        "Sampling conversation memory paths...",
        "Validating analytics persistence...",
        "Confirming sqlite fallback behavior...",
        "Exercising config loader validation...",
        "Traversing integration edge cases...",
        "Polishing response schema checks...",
        "Rehearsing incident response hooks...",
        "Watching for race-condition ghosts...",
        "Rehydrating test doubles...",
        "Inspecting guardian policy gates...",
        "Verifying denied-path enforcement...",
        "Red-teaming output scanners...",
        "Comparing state machine transitions...",
        "Sweeping telemetry breadcrumbs...",
        "Containing socket chaos...",
        "Tightening endpoint contracts...",
        "Testing dashboard callback paths...",
        "Verifying quick-actions metadata...",
        "Exercising reference-guide APIs...",
        "Aligning threat-label taxonomy...",
        "Diffing audit summaries...",
        "Rechecking provider connectivity probes...",
        "Validating agent lifecycle transitions...",
        "Measuring event-bus backpressure...",
        "Ensuring queue ordering invariants...",
        "Stress-testing concurrent dispatch...",
        "Reheating cold-start assumptions...",
        "Checking stale-session cleanup...",
        "Revisiting malformed payload handling...",
        "Reconciling SSE auth tokens...",
        "Confirming static MIME mapping...",
        "Sandboxing hostile forum connectors...",
        "Verifying defensive defaults...",
        "Running adversarial content heuristics...",
        "Replaying watchdog recovery paths...",
        "Shaping deterministic test outputs...",
        "Aligning structured log contracts...",
        "Resolving synthetic network hops...",
        "Finalizing assertion matrix...",
        "Verifying cross-platform paths...",
        "Checking Node runtime compatibility...",
        "Confirming process shutdown hygiene...",
        "Almost there, stitching final reports..."
    )
}

function Remove-DevArtifacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $pathsToRemove = @(
        (Join-Path $ProjectRoot "dist"),
        (Join-Path $ProjectRoot "coverage")
    )

    foreach ($path in $pathsToRemove) {
        if (Test-Path $path) {
            Remove-Item -Recurse -Force $path
        }
    }
}

function Get-WebAuthTokenFromContent {
    param(
        [string]$Content
    )

    $lines = $Content -split "`r?`n"
    $inWeb = $false
    $webIndent = 0
    $inAuth = $false
    $authIndent = 0

    for ($i = 0; $i -lt $lines.Length; $i++) {
        $line = $lines[$i]
        $trimmed = $line.Trim()
        $indent = $line.Length - $line.TrimStart().Length

        if (-not $inWeb -and $line -match '^\s*web:\s*$') {
            $inWeb = $true
            $webIndent = $indent
            $inAuth = $false
            continue
        }

        if ($inWeb) {
            $isNextBlock = ($trimmed -ne '') -and ($trimmed -notmatch '^#') -and ($indent -le $webIndent)
            if ($isNextBlock) {
                $inWeb = $false
                $inAuth = $false
                continue
            }
        }

        if (-not $inWeb) { continue }

        if (-not $inAuth -and $line -match '^\s*auth:\s*$') {
            $inAuth = $true
            $authIndent = $indent
            continue
        }

        if ($inAuth) {
            $isAuthNextBlock = ($trimmed -ne '') -and ($trimmed -notmatch '^#') -and ($indent -le $authIndent)
            if ($isAuthNextBlock) {
                $inAuth = $false
            }
        }

        if ($line -match '^\s*authToken:\s*(.+?)\s*$') {
            return Resolve-WebTokenValue -RawValue $Matches[1]
        }

        if ($inAuth -and $line -match '^\s*token:\s*(.+?)\s*$') {
            return Resolve-WebTokenValue -RawValue $Matches[1]
        }
    }

    return $null
}

function Resolve-WebTokenValue {
    param(
        [string]$RawValue
    )

    $raw = $RawValue.Trim().Trim("'`"")
    if (-not $raw) { return $null }

    if ($raw -match '^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$') {
        $envName = $Matches[1]
        $envValue = [Environment]::GetEnvironmentVariable($envName)
        if ($envValue) {
            return $envValue
        }
        return $null
    }

    return $raw
}

function Ensure-WebAuthTokenInContent {
    param(
        [string]$Content,
        [string]$Token
    )

    $lines = $Content -split "`r?`n"
    $result = New-Object System.Collections.Generic.List[string]

    $inWeb = $false
    $webIndent = 0
    $hasToken = $false
    $updated = $false
    $effectiveToken = $null

    for ($i = 0; $i -lt $lines.Length; $i++) {
        $line = $lines[$i]
        $trimmed = $line.Trim()
        $indent = $line.Length - $line.TrimStart().Length

        if (-not $inWeb -and $line -match '^\s*web:\s*$') {
            $inWeb = $true
            $webIndent = $indent
            $hasToken = $false
            $result.Add($line)
            continue
        }

        if ($inWeb) {
            $isNextBlock = ($trimmed -ne '') -and ($trimmed -notmatch '^#') -and ($indent -le $webIndent)
            if ($isNextBlock) {
                if (-not $hasToken) {
                    $result.Add((' ' * ($webIndent + 2)) + "authToken: $Token")
                    $effectiveToken = $Token
                    $hasToken = $true
                    $updated = $true
                }
                $inWeb = $false
            }
        }

        if ($inWeb) {
            if ($line -match '^\s*authToken:\s*(.*)$') {
                $raw = $Matches[1].Trim().Trim("'`"")
                if ($raw -match '^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$') {
                    $envName = $Matches[1]
                    $envValue = [Environment]::GetEnvironmentVariable($envName)
                    if ($envValue) {
                        $effectiveToken = $envValue
                    } else {
                        $line = (' ' * ($webIndent + 2)) + "authToken: $Token"
                        $effectiveToken = $Token
                        $updated = $true
                    }
                    $hasToken = $true
                } elseif ($raw) {
                    $effectiveToken = $raw
                    $hasToken = $true
                } else {
                    $line = (' ' * ($webIndent + 2)) + "authToken: $Token"
                    $effectiveToken = $Token
                    $hasToken = $true
                    $updated = $true
                }
            } elseif ($line -match '^\s*#\s*authToken:\s*') {
                if (-not $hasToken) {
                    $line = (' ' * ($webIndent + 2)) + "authToken: $Token"
                    $effectiveToken = $Token
                    $hasToken = $true
                    $updated = $true
                }
            }
        }

        $result.Add($line)
    }

    if ($inWeb -and -not $hasToken) {
        $result.Add((' ' * ($webIndent + 2)) + "authToken: $Token")
        $effectiveToken = $Token
        $updated = $true
    }

    return @{
        Content = ($result -join "`r`n")
        Updated = $updated
        Token = $effectiveToken
    }
}

try {

# --- Pre-flight: kill stale GuardianAgent processes and clean temp configs ---
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "src[/\\]index\.ts|dist[/\\]index\.js" }
if ($existing) {
    Write-Host "Cleaning up $($existing.Count) stale GuardianAgent process(es)..." -ForegroundColor DarkCyan
    foreach ($proc in $existing) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
}

# Remove leftover temp configs from test harnesses (prevents port/token conflicts)
Get-ChildItem -Path $env:TEMP -Filter "guardian-*-harness*.yaml" -ErrorAction SilentlyContinue |
    ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }

# --- ASCII Art Banner ---
Write-Host ""
Write-Host "   ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ ██╗ █████╗ ███╗   ██╗" -ForegroundColor Cyan
Write-Host "  ██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗██║██╔══██╗████╗  ██║" -ForegroundColor Cyan
Write-Host "  ██║  ███╗██║   ██║███████║██████╔╝██║  ██║██║███████║██╔██╗ ██║" -ForegroundColor Blue
Write-Host "  ██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║██║██╔══██║██║╚██╗██║" -ForegroundColor Blue
Write-Host "  ╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝██║██║  ██║██║ ╚████║" -ForegroundColor DarkBlue
Write-Host "   ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝" -ForegroundColor DarkBlue
Write-Host ""
Write-Host "       █████╗  ██████╗ ███████╗███╗   ██╗████████╗" -ForegroundColor Cyan
Write-Host "      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝" -ForegroundColor Cyan
Write-Host "      ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   " -ForegroundColor Blue
Write-Host "      ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   " -ForegroundColor Blue
Write-Host "      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   " -ForegroundColor DarkBlue
Write-Host "      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   " -ForegroundColor DarkBlue
Write-Host ""
Write-Host "        Four-Layer Defense  |  Real-Time Dashboard" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Check Node.js ---
Write-Host "[1/6] Checking Node.js..." -ForegroundColor DarkCyan
Write-WaitLine "Waking the runtime engines..."
try {
    $nodeVersion = node --version
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Host "  ERROR: Node.js >= 18 required (found $nodeVersion)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green
    if ($major -lt 20) {
        Write-Host "  WARNING: Node.js 20+ is recommended for full compatibility (e.g. node:sqlite tests)." -ForegroundColor DarkCyan
    }
} catch {
    Write-Host "  ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# --- Step 2: Install dependencies ---
Write-Host "[2/6] Checking dependencies..." -ForegroundColor DarkCyan
Write-WaitLine "Reticulating Splines..."
$needsInstall = $false

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    $needsInstall = $true
    Write-Host "  node_modules not found" -ForegroundColor DarkCyan
} elseif (-not (Test-Path (Join-Path $Root "node_modules\@rollup\rollup-win32-x64-msvc"))) {
    $needsInstall = $true
    Write-Host "  Dependencies installed from WSL/Linux - reinstalling for Windows..." -ForegroundColor DarkCyan
}

if ($needsInstall) {
    Write-Host "  Running npm install..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: npm install failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Dependencies installed" -ForegroundColor Green
} else {
    Write-Host "  Dependencies: OK" -ForegroundColor Green
}

# Ensure bundled CLI tools are available
Write-Host "  Checking bundled tools..." -ForegroundColor DarkCyan

if (-not $StartOnly) {
    # --- Step 3: Build ---
    Write-Host "[3/6] Building TypeScript..." -ForegroundColor DarkCyan
    Write-WaitLine "Cleaning old build artifacts and forging TypeScript into JavaScript..."
    Remove-DevArtifacts -ProjectRoot $Root
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Build failed" -ForegroundColor Red
        exit 1
    }

    $indexJs = Join-Path $Root "dist\index.js"
    $firstLine = Get-Content $indexJs -First 1
    if ($firstLine -eq "#!/usr/bin/env node") {
        Write-Host "  Build: OK (shebang present)" -ForegroundColor Green
    } else {
        Write-Host "  Build: OK (WARNING: missing shebang)" -ForegroundColor DarkCyan
    }

    # --- Step 4: Tests ---
    if (-not $SkipTests) {
        Write-Host "[4/6] Running tests..." -ForegroundColor DarkCyan
        Write-WaitLine "Interrogating the test matrix..."
        $testStart = Get-Date
        $testProc = Start-Process `
            -FilePath "npm.cmd" `
            -ArgumentList @("test", "--", "--reporter=dot") `
            -WorkingDirectory $Root `
            -NoNewWindow `
            -PassThru

        $testExitCode = Wait-ForProcessWithMessages `
            -Process $testProc `
            -Messages (Get-TestWaitMessages) `
            -IntervalSeconds 4
        $testDuration = (Get-Date) - $testStart

        if ($testExitCode -ne 0) {
            Write-Host "  Test runner exit code: $testExitCode" -ForegroundColor DarkCyan
            Write-Host "  ERROR: Tests failed" -ForegroundColor Red
            exit 1
        }
        Write-Host ("  Tests: PASSED ({0:N1}s)" -f $testDuration.TotalSeconds) -ForegroundColor Green
        if ($testDuration.TotalSeconds -gt 90) {
            Write-Host "  Tip: use -SkipTests for faster local startup when iterating." -ForegroundColor DarkCyan
        }
    } else {
        Write-Host "[4/6] Tests: SKIPPED" -ForegroundColor DarkCyan
    }
} else {
    Write-Host "[3/6] Build: SKIPPED (-StartOnly)" -ForegroundColor DarkCyan
    Write-Host "[4/6] Tests: SKIPPED (-StartOnly)" -ForegroundColor DarkCyan

    $indexJs = Join-Path $Root "dist\index.js"
    if (-not (Test-Path $indexJs)) {
        Write-Host "  ERROR: dist/index.js not found. Run without -StartOnly first." -ForegroundColor Red
        exit 1
    }
}

if ($BuildOnly) {
    Write-Host ""
    Write-Host "[5/6] Start: SKIPPED (-BuildOnly)" -ForegroundColor DarkCyan
    Write-Host "[6/6] Done." -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "=== Build Complete ===" -ForegroundColor Green
    Write-Host "  To start manually: npm run dev" -ForegroundColor DarkGreen
    Write-Host ""
    exit 0
}

# --- Step 5: Check Ollama (default LLM provider) ---
Write-Host "[5/6] Checking Ollama..." -ForegroundColor DarkCyan
Write-WaitLine "Calibrating local model links..."
$ollamaRunning = $false
try {
    $response = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    $ollamaRunning = $true
    $models = ($response.Content | ConvertFrom-Json).models
    $modelCount = $models.Count
    if ($modelCount -gt 0) {
        $modelNames = ($models | ForEach-Object { $_.name }) -join ", "
        Write-Host "  Ollama: Running - $modelCount models available ($modelNames)" -ForegroundColor Green
    } else {
        Write-Host "  Ollama: Running but no models installed" -ForegroundColor DarkCyan
        Write-Host "  Run: ollama pull llama3.2" -ForegroundColor DarkCyan
    }
} catch {
    Write-Host "  Ollama: Not running" -ForegroundColor DarkCyan
    Write-Host "  The CLI will start but LLM responses will fail without a provider." -ForegroundColor DarkCyan
    Write-Host "  To fix: Start Ollama and run 'ollama pull llama3.2'" -ForegroundColor DarkCyan
    Write-Host "  Or: Configure an API provider (Anthropic/OpenAI) via the web Config Center or CLI /config" -ForegroundColor DarkCyan
}

# --- Check config file ---
$configDir = Join-Path $env:USERPROFILE ".guardianagent"
$configFile = Join-Path $configDir "config.yaml"

if (-not (Test-Path $configFile)) {
    Write-Host ""
    Write-Host "  No config file found. Creating default at $configFile" -ForegroundColor DarkCyan

    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $defaultConfig = @'
# GuardianAgent Configuration
# Docs: https://github.com/alexkenley/guardian-agent

llm:
  ollama:
    provider: ollama
    baseUrl: http://127.0.0.1:11434
    model: llama3.2

  # Uncomment to use Anthropic:
  # claude:
  #   provider: anthropic
  #   apiKey: ${ANTHROPIC_API_KEY}
  #   model: claude-sonnet-4-20250514

  # Uncomment to use OpenAI:
  # gpt:
  #   provider: openai
  #   apiKey: ${OPENAI_API_KEY}
  #   model: gpt-4o

defaultProvider: ollama

channels:
  cli:
    enabled: true
  telegram:
    enabled: false
    # botToken: ${TELEGRAM_BOT_TOKEN}
    # allowedChatIds: []
  web:
    enabled: true
    port: 3000
    # authToken: ${WEB_AUTH_TOKEN}

guardian:
  enabled: true
  logDenials: true
  inputSanitization:
    enabled: true
    blockThreshold: 3
  rateLimit:
    maxPerMinute: 30
    maxPerHour: 500
    burstAllowed: 5
  outputScanning:
    enabled: true
    redactSecrets: true
  sentinel:
    enabled: true
    schedule: '*/5 * * * *'
  auditLog:
    maxEvents: 10000

runtime:
  maxStallDurationMs: 180000
  watchdogIntervalMs: 10000
  logLevel: warn
'@

    Set-Content -Path $configFile -Value $defaultConfig -Encoding UTF8
    Write-Host "  Config created: $configFile" -ForegroundColor Green
} else {
    Write-Host "  Config: $configFile" -ForegroundColor Green
}

# --- Check if web channel is enabled in existing config ---
$webEnabled = $false
$webPort = 3000
$webAuthToken = $null
if (Test-Path $configFile) {
    $configContent = Get-Content $configFile -Raw
    if ($configContent -match '(?m)^(\s*logLevel:\s*)info(\s*)$') {
        $configContent = [regex]::Replace($configContent, '(?m)^(\s*logLevel:\s*)info(\s*)$', '${1}warn$2')
        Set-Content -Path $configFile -Value $configContent -Encoding UTF8
        Write-Host "  Runtime log level set to warn (reduced CLI noise)." -ForegroundColor DarkCyan
    }
    if ($configContent -match 'web:\s*\n\s*enabled:\s*true') {
        $webEnabled = $true
    }
    if ($configContent -match 'port:\s*(\d+)') {
        $webPort = [int]$Matches[1]
    }
    # Auto-enable web channel if it's disabled
    if (-not $webEnabled -and $configContent -match 'web:\s*\n\s*enabled:\s*false') {
        Write-Host "  Enabling web dashboard in config..." -ForegroundColor DarkCyan
        $configContent = $configContent -replace '(web:\s*\n\s*enabled:\s*)false', '${1}true'
        Set-Content -Path $configFile -Value $configContent -Encoding UTF8
        $webEnabled = $true
    }

    if ($webEnabled) {
        $webAuthToken = Get-WebAuthTokenFromContent -Content $configContent
        if (-not $webAuthToken) {
            $generatedToken = [Guid]::NewGuid().ToString('N')
            $ensureResult = Ensure-WebAuthTokenInContent -Content $configContent -Token $generatedToken
            $configContent = [string]$ensureResult.Content
            if ([bool]$ensureResult.Updated) {
                Set-Content -Path $configFile -Value $configContent -Encoding UTF8
                Write-Host "  Web auth token set in config for dashboard access." -ForegroundColor Green
            }
            $webAuthToken = [string]$ensureResult.Token
        }
    }
}

# --- Start ---
Write-Host ""
Write-Host "[6/6] Starting GuardianAgent..." -ForegroundColor DarkCyan
Write-Host ""

# Launch the built output directly.
# This script already completed a TypeScript build, so using dist avoids
# tsx-specific Windows process quirks and makes startup failures easier to spot.
$env:NODE_NO_WARNINGS = "1"
$entryPoint = Join-Path $Root "dist\index.js"
if (-not (Test-Path $entryPoint)) {
    throw "Built entry point not found: $entryPoint"
}

& node $entryPoint
$agentExitCode = $LASTEXITCODE

if ($agentExitCode -ne 0) {
    Write-Host ""
    Write-Host "  GuardianAgent exited with code $agentExitCode." -ForegroundColor Red
    exit $agentExitCode
}

} finally {
    Set-Location $OriginalDir
}
