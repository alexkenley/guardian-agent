#!/usr/bin/env bash
# GuardianAgent — Local Development Script (Linux / macOS / WSL)
# Builds, tests, checks dependencies, and starts the system.
#
# Usage:
#   bash scripts/start-dev-unix.sh              # Full build + test + start
#   bash scripts/start-dev-unix.sh --skip-tests # Build + start (skip tests)
#   bash scripts/start-dev-unix.sh --build-only # Build + test only (don't start)
#   bash scripts/start-dev-unix.sh --start-only # Start without rebuilding

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Flags ──────────────────────────────────────────────────────
SKIP_TESTS=false
BUILD_ONLY=false
START_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --build-only) BUILD_ONLY=true ;;
    --start-only) START_ONLY=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Colors ─────────────────────────────────────────────────────
if [ -t 1 ]; then
  CYAN='\033[36m'
  BLUE='\033[38;5;33m'
  LBLUE='\033[38;5;75m'
  DBLUE='\033[38;5;27m'
  GREEN='\033[32m'
  RED='\033[31m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  CYAN='' BLUE='' LBLUE='' DBLUE='' GREEN='' RED='' DIM='' RESET=''
fi

# ── Banner ─────────────────────────────────────────────────────
echo ""
echo -e "${LBLUE}   ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ ██╗ █████╗ ███╗   ██╗${RESET}"
echo -e "${LBLUE}  ██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗██║██╔══██╗████╗  ██║${RESET}"
echo -e "${BLUE}  ██║  ███╗██║   ██║███████║██████╔╝██║  ██║██║███████║██╔██╗ ██║${RESET}"
echo -e "${BLUE}  ██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║██║██╔══██║██║╚██╗██║${RESET}"
echo -e "${DBLUE}  ╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝██║██║  ██║██║ ╚████║${RESET}"
echo -e "${DBLUE}   ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝${RESET}"
echo ""
echo -e "${LBLUE}        █████╗  ██████╗ ███████╗███╗   ██╗████████╗${RESET}"
echo -e "${LBLUE}       ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝${RESET}"
echo -e "${BLUE}       ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ${RESET}"
echo -e "${BLUE}       ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ${RESET}"
echo -e "${DBLUE}       ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ${RESET}"
echo -e "${DBLUE}       ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ${RESET}"
echo ""
echo -e "${LBLUE}      Four-Layer Defense${RESET}  ${DIM}|${RESET}  ${LBLUE}Real-Time Dashboard${RESET}"
echo ""

# ── Step 1: Check Node.js ─────────────────────────────────────
echo -e "${CYAN}[1/6] Checking Node.js...${RESET}"
if ! command -v node &>/dev/null; then
  echo -e "  ${RED}ERROR: Node.js not found. Install from https://nodejs.org${RESET}"
  exit 1
fi
NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "  ${RED}ERROR: Node.js >= 18 required (found $NODE_VERSION)${RESET}"
  exit 1
fi
echo -e "  ${GREEN}Node.js: $NODE_VERSION${RESET}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "  ${DIM}WARNING: Node.js 20+ recommended for full compatibility (e.g. node:sqlite tests).${RESET}"
fi

# ── Step 2: Install dependencies ──────────────────────────────
echo -e "${CYAN}[2/6] Checking dependencies...${RESET}"
if [ ! -d "node_modules" ]; then
  echo "  Running npm install..."
  npm install
  echo -e "  ${GREEN}Dependencies installed${RESET}"
else
  echo -e "  ${GREEN}Dependencies: OK${RESET}"
fi

# Ensure bundled CLI tools are available
echo -e "${CYAN}    Checking bundled tools...${RESET}"
node scripts/ensure-qmd.mjs >/dev/null 2>&1 && echo -e "  ${GREEN}QMD: OK${RESET}" || echo -e "  ${DIM}QMD: not available (optional)${RESET}"

if [ "$START_ONLY" = true ]; then
  echo -e "${CYAN}[3/6] Build: SKIPPED (--start-only)${RESET}"
  echo -e "${CYAN}[4/6] Tests: SKIPPED (--start-only)${RESET}"
  if [ ! -f "dist/index.js" ]; then
    echo -e "  ${RED}ERROR: dist/index.js not found. Run without --start-only first.${RESET}"
    exit 1
  fi
else
  # ── Step 3: Build ─────────────────────────────────────────────
  echo -e "${CYAN}[3/6] Building TypeScript...${RESET}"
  rm -rf dist
  npm run build
  if [ -f "dist/index.js" ]; then
    echo -e "  ${GREEN}Build: OK${RESET}"
  else
    echo -e "  ${RED}ERROR: Build failed${RESET}"
    exit 1
  fi

  # ── Step 4: Tests ─────────────────────────────────────────────
  if [ "$SKIP_TESTS" = true ]; then
    echo -e "${CYAN}[4/6] Tests: SKIPPED${RESET}"
  else
    echo -e "${CYAN}[4/6] Running tests...${RESET}"
    TEST_START=$(date +%s)
    npx vitest run --reporter=dot
    TEST_END=$(date +%s)
    TEST_DURATION=$((TEST_END - TEST_START))
    echo -e "  ${GREEN}Tests: PASSED (${TEST_DURATION}s)${RESET}"
    if [ "$TEST_DURATION" -gt 90 ]; then
      echo -e "  ${DIM}Tip: use --skip-tests for faster local startup when iterating.${RESET}"
    fi
  fi
fi

if [ "$BUILD_ONLY" = true ]; then
  echo ""
  echo -e "${CYAN}[5/6] Start: SKIPPED (--build-only)${RESET}"
  echo -e "${CYAN}[6/6] Done.${RESET}"
  echo ""
  echo -e "${GREEN}=== Build Complete ===${RESET}"
  echo -e "  ${DIM}To start manually: bash scripts/start-dev-unix.sh --start-only${RESET}"
  echo ""
  exit 0
fi

# ── Step 5: Check Ollama ──────────────────────────────────────
echo -e "${CYAN}[5/6] Checking Ollama...${RESET}"
OLLAMA_RUNNING=false
if curl -sf --max-time 3 http://localhost:11434/api/tags &>/dev/null; then
  OLLAMA_RUNNING=true
  MODEL_COUNT=$(curl -sf --max-time 3 http://localhost:11434/api/tags | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const j=JSON.parse(d);console.log((j.models||[]).length)}catch{console.log(0)}
    })" 2>/dev/null || echo "0")
  echo -e "  ${GREEN}Ollama: Running ($MODEL_COUNT models available)${RESET}"
else
  echo -e "  ${DIM}Ollama: Not running${RESET}"
  echo -e "  ${DIM}The CLI will start but LLM responses will fail without a provider.${RESET}"
  echo -e "  ${DIM}To fix: Start Ollama and run 'ollama pull llama3.2'${RESET}"
  echo -e "  ${DIM}Or: Configure an API provider (Anthropic/OpenAI) via web Config Center or CLI /config${RESET}"
fi

# ── Check config file ─────────────────────────────────────────
CONFIG_DIR="$HOME/.guardianagent"
CONFIG_FILE="$CONFIG_DIR/config.yaml"

if [ ! -f "$CONFIG_FILE" ]; then
  echo ""
  echo -e "  ${DIM}No config file found. Creating default at $CONFIG_FILE${RESET}"
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" << 'YAMLEOF'
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
  logLevel: warn
YAMLEOF
  echo -e "  ${GREEN}Config created: $CONFIG_FILE${RESET}"
else
  echo -e "  ${GREEN}Config: $CONFIG_FILE${RESET}"
fi

# ── Step 6: Start ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}[6/6] Starting GuardianAgent...${RESET}"
echo ""
echo -e "  ${DBLUE}+-------------------------------------------------+${RESET}"
echo -e "  ${DBLUE}|${RESET}         ${LBLUE}SYSTEM STATUS${RESET}                          ${DBLUE}|${RESET}"
echo -e "  ${DBLUE}+-------------------------------------------------+${RESET}"
echo -e "  ${DBLUE}|${RESET}  Guardian:  ${GREEN}ACTIVE${RESET} (4-layer defense)            ${DBLUE}|${RESET}"
echo -e "  ${DBLUE}|${RESET}  Channels:  CLI + Web Dashboard               ${DBLUE}|${RESET}"
echo -e "  ${DBLUE}|${RESET}  Dashboard: ${GREEN}http://localhost:3000${RESET}              ${DBLUE}|${RESET}"
if [ "$OLLAMA_RUNNING" = true ]; then
echo -e "  ${DBLUE}|${RESET}  LLM:       ${GREEN}Ollama (localhost:11434)${RESET}           ${DBLUE}|${RESET}"
else
echo -e "  ${DBLUE}|${RESET}  LLM:       ${DIM}Not connected${RESET}                      ${DBLUE}|${RESET}"
fi
echo -e "  ${DBLUE}+-------------------------------------------------+${RESET}"
echo ""
echo -e "  ${DIM}Press Ctrl+C to stop.${RESET}"
echo ""

# Use tsx if available, otherwise node
export NODE_NO_WARNINGS=1
if [ -x "node_modules/.bin/tsx" ]; then
  exec node_modules/.bin/tsx src/index.ts
else
  exec node dist/index.js
fi
