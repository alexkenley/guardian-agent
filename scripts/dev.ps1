# GuardianAgent — Local Development Script
# Builds, tests, checks dependencies, and starts the system.
#
# Usage:
#   .\scripts\dev.ps1              # Full build + test + start
#   .\scripts\dev.ps1 -SkipTests   # Build + start (skip tests)
#   .\scripts\dev.ps1 -BuildOnly   # Build + test only (don't start)
#   .\scripts\dev.ps1 -StartOnly   # Start without rebuilding

param(
    [switch]$SkipTests,
    [switch]$BuildOnly,
    [switch]$StartOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host ""
Write-Host "=== GuardianAgent Dev Environment ===" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Check Node.js ---
Write-Host "[1/6] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Host "  ERROR: Node.js >= 18 required (found $nodeVersion)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# --- Step 2: Install dependencies ---
Write-Host "[2/6] Checking dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "$Root\node_modules")) {
    Write-Host "  Installing dependencies..."
    npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: npm ci failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Dependencies installed" -ForegroundColor Green
} else {
    Write-Host "  Dependencies: OK (node_modules exists)" -ForegroundColor Green
}

if (-not $StartOnly) {
    # --- Step 3: Build ---
    Write-Host "[3/6] Building TypeScript..." -ForegroundColor Yellow
    if (Test-Path "$Root\dist") {
        Remove-Item -Recurse -Force "$Root\dist"
    }
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Build failed" -ForegroundColor Red
        exit 1
    }

    # Verify shebang
    $firstLine = Get-Content "$Root\dist\index.js" -First 1
    if ($firstLine -eq "#!/usr/bin/env node") {
        Write-Host "  Build: OK (shebang present)" -ForegroundColor Green
    } else {
        Write-Host "  Build: OK (WARNING: missing shebang)" -ForegroundColor Yellow
    }

    # --- Step 4: Tests ---
    if (-not $SkipTests) {
        Write-Host "[4/6] Running tests..." -ForegroundColor Yellow
        npm test
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ERROR: Tests failed" -ForegroundColor Red
            exit 1
        }
        Write-Host "  Tests: PASSED" -ForegroundColor Green
    } else {
        Write-Host "[4/6] Tests: SKIPPED" -ForegroundColor Yellow
    }
} else {
    Write-Host "[3/6] Build: SKIPPED (-StartOnly)" -ForegroundColor Yellow
    Write-Host "[4/6] Tests: SKIPPED (-StartOnly)" -ForegroundColor Yellow

    if (-not (Test-Path "$Root\dist\index.js")) {
        Write-Host "  ERROR: dist/index.js not found. Run without -StartOnly first." -ForegroundColor Red
        exit 1
    }
}

if ($BuildOnly) {
    Write-Host ""
    Write-Host "[5/6] Start: SKIPPED (-BuildOnly)" -ForegroundColor Yellow
    Write-Host "[6/6] Done." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "=== Build Complete ===" -ForegroundColor Cyan
    Write-Host "  To start manually: npm run dev" -ForegroundColor White
    Write-Host ""
    exit 0
}

# --- Step 5: Check Ollama (default LLM provider) ---
Write-Host "[5/6] Checking Ollama..." -ForegroundColor Yellow
$ollamaRunning = $false
try {
    $response = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 3 -ErrorAction Stop
    $ollamaRunning = $true
    $models = ($response.Content | ConvertFrom-Json).models
    if ($models.Count -gt 0) {
        $modelNames = ($models | ForEach-Object { $_.name }) -join ", "
        Write-Host "  Ollama: Running ($($models.Count) models: $modelNames)" -ForegroundColor Green
    } else {
        Write-Host "  Ollama: Running but no models installed" -ForegroundColor Yellow
        Write-Host "  Run: ollama pull llama3.2" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  Ollama: Not running" -ForegroundColor Yellow
    Write-Host "  The CLI will start but LLM responses will fail without a provider." -ForegroundColor Yellow
    Write-Host "  To fix: Start Ollama and run 'ollama pull llama3.2'" -ForegroundColor Yellow
    Write-Host "  Or: Configure an API provider (Anthropic/OpenAI) in config.yaml" -ForegroundColor Yellow
}

# --- Step 6: Check config file ---
$configDir = Join-Path $env:USERPROFILE ".openagent"
$configFile = Join-Path $configDir "config.yaml"

if (-not (Test-Path $configFile)) {
    Write-Host ""
    Write-Host "  No config file found. Creating default at $configFile" -ForegroundColor Yellow

    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $defaultConfig = @"
# GuardianAgent Configuration
# Docs: https://github.com/alexkenley/guardian-agent

llm:
  ollama:
    provider: ollama
    baseUrl: http://localhost:11434
    model: llama3.2

  # Uncomment to use Anthropic:
  # claude:
  #   provider: anthropic
  #   apiKey: `${ANTHROPIC_API_KEY}
  #   model: claude-sonnet-4-20250514

  # Uncomment to use OpenAI:
  # gpt:
  #   provider: openai
  #   apiKey: `${OPENAI_API_KEY}
  #   model: gpt-4o

defaultProvider: ollama

channels:
  cli:
    enabled: true
  telegram:
    enabled: false
    # botToken: `${TELEGRAM_BOT_TOKEN}
    # allowedChatIds: []
  web:
    enabled: false
    port: 3000
    # authToken: `${WEB_AUTH_TOKEN}

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
  maxStallDurationMs: 60000
  watchdogIntervalMs: 10000
  logLevel: info
"@

    Set-Content -Path $configFile -Value $defaultConfig -Encoding UTF8
    Write-Host "  Config created: $configFile" -ForegroundColor Green
} else {
    Write-Host "  Config: $configFile" -ForegroundColor Green
}

# --- Start ---
Write-Host ""
Write-Host "[6/6] Starting GuardianAgent..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Guardian: ENABLED (three-layer defense active)" -ForegroundColor Green
Write-Host "  Channel:  CLI" -ForegroundColor Green
if ($ollamaRunning) {
    Write-Host "  LLM:      Ollama (localhost:11434)" -ForegroundColor Green
} else {
    Write-Host "  LLM:      Not connected (responses will fail)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Run with tsx for dev mode (TypeScript direct execution)
npx tsx src/index.ts
