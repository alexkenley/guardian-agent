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

write_wait_line() {
  echo -e "  ${DIM}Please wait — ${LBLUE}$1${RESET}"
}

format_elapsed_label() {
  local total_seconds=$1
  printf '%02d:%02d' $((total_seconds / 60)) $((total_seconds % 60))
}

show_animated_wait_frame() {
  local frame=$1
  local message=$2
  local elapsed_seconds=$3
  local frame_index=$4
  local label
  local -a frame_colors=("$CYAN" "$LBLUE" "$BLUE" "$DBLUE")
  local frame_color="${frame_colors[$((frame_index % ${#frame_colors[@]}))]}"
  label=$(format_elapsed_label "$elapsed_seconds")
  printf "\r  %b%s%b %bPlease wait — %b%b%s%b %b(%s)%b%-24s" \
    "$frame_color" "$frame" "$RESET" \
    "$DIM" "$LBLUE" "$message" "$RESET" \
    "$CYAN" "$label" "$RESET" ""
}

clear_animated_wait_frame() {
  printf '\r%-120s\r' ' '
}

resolve_web_token_value() {
  local raw="$1"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  raw="${raw#\"}"
  raw="${raw%\"}"
  raw="${raw#\'}"
  raw="${raw%\'}"
  if [ -z "$raw" ]; then
    return 1
  fi
  if [[ "$raw" =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$ ]]; then
    local env_name="${BASH_REMATCH[1]}"
    local env_value="${!env_name:-}"
    if [ -n "$env_value" ]; then
      printf '%s\n' "$env_value"
      return 0
    fi
    return 1
  fi
  printf '%s\n' "$raw"
}

get_web_auth_token_from_file() {
  local file="$1"
  local in_web=false
  local web_indent=0
  local in_auth=false
  local auth_indent=0
  local line trimmed indent

  while IFS= read -r line || [ -n "$line" ]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    indent=$(( ${#line} - ${#trimmed} ))

    if [ "$in_web" = false ] && [[ "$trimmed" == "web:" ]]; then
      in_web=true
      web_indent=$indent
      in_auth=false
      continue
    fi

    if [ "$in_web" = true ] && [[ -n "$trimmed" && ! "$trimmed" =~ ^# && $indent -le $web_indent ]]; then
      in_web=false
      in_auth=false
    fi

    [ "$in_web" = true ] || continue

    if [ "$in_auth" = false ] && [[ "$trimmed" == "auth:" ]]; then
      in_auth=true
      auth_indent=$indent
      continue
    fi

    if [ "$in_auth" = true ] && [[ -n "$trimmed" && ! "$trimmed" =~ ^# && $indent -le $auth_indent ]]; then
      in_auth=false
    fi

    if [[ "$trimmed" =~ ^authToken:[[:space:]]*(.+)$ ]]; then
      resolve_web_token_value "${BASH_REMATCH[1]}"
      return $?
    fi

    if [ "$in_auth" = true ] && [[ "$trimmed" =~ ^token:[[:space:]]*(.+)$ ]]; then
      resolve_web_token_value "${BASH_REMATCH[1]}"
      return $?
    fi
  done < "$file"

  return 1
}

get_web_rotate_on_startup_from_file() {
  local file="$1"
  local in_web=false
  local web_indent=0
  local in_auth=false
  local auth_indent=0
  local line trimmed indent

  while IFS= read -r line || [ -n "$line" ]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    indent=$(( ${#line} - ${#trimmed} ))

    if [ "$in_web" = false ] && [[ "$trimmed" == "web:" ]]; then
      in_web=true
      web_indent=$indent
      in_auth=false
      continue
    fi

    if [ "$in_web" = true ] && [[ -n "$trimmed" && ! "$trimmed" =~ ^# && $indent -le $web_indent ]]; then
      in_web=false
      in_auth=false
    fi

    [ "$in_web" = true ] || continue

    if [ "$in_auth" = false ] && [[ "$trimmed" == "auth:" ]]; then
      in_auth=true
      auth_indent=$indent
      continue
    fi

    if [ "$in_auth" = true ] && [[ -n "$trimmed" && ! "$trimmed" =~ ^# && $indent -le $auth_indent ]]; then
      in_auth=false
    fi

    if [ "$in_auth" = true ] && [[ "$trimmed" =~ ^rotateOnStartup:[[:space:]]*(.+)$ ]]; then
      local raw="${BASH_REMATCH[1]}"
      raw="${raw#"${raw%%[![:space:]]*}"}"
      raw="${raw%"${raw##*[![:space:]]}"}"
      raw="${raw#\"}"
      raw="${raw%\"}"
      raw="${raw#\'}"
      raw="${raw%\'}"
      [ "$raw" = "true" ]
      return $?
    fi
  done < "$file"

  return 1
}

wait_for_process_with_messages() {
  local pid=$1
  local interval_seconds=$2
  shift 2
  local -a messages=("$@")
  local -a frames=("[=   ]" "[==  ]" "[=== ]" "[ ===]" "[  ===]" "[   ==]" "[   =]" "[  ==]")
  local start_epoch
  start_epoch=$(date +%s)
  local last_message_epoch=$start_epoch
  local message_index=0
  local frame_index=0

  if [ "${#messages[@]}" -gt 1 ]; then
    local i j tmp
    for ((i=${#messages[@]} - 1; i>0; i--)); do
      j=$((RANDOM % (i + 1)))
      tmp=${messages[i]}
      messages[i]=${messages[j]}
      messages[j]=$tmp
    done
  fi

  local message="${messages[0]:-Working...}"

  while kill -0 "$pid" 2>/dev/null; do
    local now_epoch
    now_epoch=$(date +%s)

    if [ "${#messages[@]}" -gt 0 ] && { [ "$message_index" -eq 0 ] || [ $((now_epoch - last_message_epoch)) -ge "$interval_seconds" ]; }; then
      message="${messages[$((message_index % ${#messages[@]}))]}"
      message_index=$((message_index + 1))
      last_message_epoch=$now_epoch
    fi

    show_animated_wait_frame "${frames[$((frame_index % ${#frames[@]}))]}" "$message" $((now_epoch - start_epoch)) "$frame_index"
    frame_index=$((frame_index + 1))
    sleep 0.2
  done

  wait "$pid"
  local exit_code=$?
  clear_animated_wait_frame
  echo ""
  return "$exit_code"
}

show_process_log_tail() {
  local path=$1
  local label=$2
  local tail_lines=${3:-80}

  if [ ! -f "$path" ]; then
    return
  fi

  if [ ! -s "$path" ]; then
    return
  fi

  echo -e "  ${CYAN}${label} (last ${tail_lines} lines):${RESET}"
  tail -n "$tail_lines" "$path" | while IFS= read -r line; do
    echo -e "    ${DIM}${line}${RESET}"
  done
}

invoke_process_quietly_with_animation() {
  local failure_label=$1
  local interval_seconds=$2
  shift 2

  if [ "$1" != "--" ]; then
    echo "invoke_process_quietly_with_animation requires -- before the command" >&2
    return 2
  fi
  shift

  local stdout_path
  local stderr_path
  stdout_path=$(mktemp "${TMPDIR:-/tmp}/guardianagent-startup-stdout.XXXXXX")
  stderr_path=$(mktemp "${TMPDIR:-/tmp}/guardianagent-startup-stderr.XXXXXX")

  "$@" >"$stdout_path" 2>"$stderr_path" &
  local pid=$!

  if ! wait_for_process_with_messages "$pid" "$interval_seconds" "${TEST_WAIT_MESSAGES[@]}"; then
    local exit_code=$?
    show_process_log_tail "$stdout_path" "$failure_label output"
    show_process_log_tail "$stderr_path" "$failure_label errors"
    rm -f "$stdout_path" "$stderr_path"
    return "$exit_code"
  fi

  rm -f "$stdout_path" "$stderr_path"
  return 0
}

TEST_WAIT_MESSAGES=(
  "Reticulating Splines..."
  "Correlating failing dimensions..."
  "Reindexing assertion nebulae..."
  "Consulting the flake detector..."
  "Probing CLI command routing..."
  "Verifying web channel auth paths..."
  "Exercising CORS guardrails..."
  "Stressing request body limits..."
  "Validating SSE stream handling..."
  "Auditing static path traversal blocks..."
  "Checking runtime watchdog behavior..."
  "Scanning for secret redaction leaks..."
  "Simulating prompt-injection defenses..."
  "Evaluating rate limiter thresholds..."
  "Replaying anomaly detection events..."
  "Exercising budget timeout controls..."
  "Verifying provider failover logic..."
  "Inspecting threat-intel workflows..."
  "Cross-checking moltbook connector safety..."
  "Synchronizing audit event timelines..."
  "Rebuilding provider capability map..."
  "Sampling conversation memory paths..."
  "Validating analytics persistence..."
  "Confirming sqlite fallback behavior..."
  "Exercising config loader validation..."
  "Traversing integration edge cases..."
  "Polishing response schema checks..."
  "Rehearsing incident response hooks..."
  "Watching for race-condition ghosts..."
  "Rehydrating test doubles..."
  "Inspecting guardian policy gates..."
  "Verifying denied-path enforcement..."
  "Red-teaming output scanners..."
  "Comparing state machine transitions..."
  "Sweeping telemetry breadcrumbs..."
  "Containing socket chaos..."
  "Tightening endpoint contracts..."
  "Testing dashboard callback paths..."
  "Verifying quick-actions metadata..."
  "Exercising reference-guide APIs..."
  "Aligning threat-label taxonomy..."
  "Diffing audit summaries..."
  "Rechecking provider connectivity probes..."
  "Validating agent lifecycle transitions..."
  "Measuring event-bus backpressure..."
  "Ensuring queue ordering invariants..."
  "Stress-testing concurrent dispatch..."
  "Reheating cold-start assumptions..."
  "Checking stale-session cleanup..."
  "Revisiting malformed payload handling..."
  "Reconciling SSE auth tokens..."
  "Confirming static MIME mapping..."
  "Sandboxing hostile forum connectors..."
  "Verifying defensive defaults..."
  "Running adversarial content heuristics..."
  "Replaying watchdog recovery paths..."
  "Shaping deterministic test outputs..."
  "Aligning structured log contracts..."
  "Resolving synthetic network hops..."
  "Finalizing assertion matrix..."
  "Verifying cross-platform paths..."
  "Checking Node runtime compatibility..."
  "Confirming process shutdown hygiene..."
  "Charging the shield generators..."
  "Rerouting power from life support to CI..."
  "Checking whether the cake is still a lie..."
  "Rolling for initiative against flaky tests..."
  "Spinning up the TARDIS stabilizers..."
  "Calibrating the flux capacitor..."
  "Escorting the payload through staging..."
  "Deploying extra pylons for test coverage..."
  "Untangling redstone timing loops..."
  "Checking for creepers near the build cache..."
  "Sharpening the Master Sword of refactors..."
  "Feeding quarters into the arcade cabinet..."
  "Cleaning the cartridge contacts..."
  "Defragging the holodeck..."
  "Triangulating the stargate glyphs..."
  "Counting to 42, just to be safe..."
  "Booting the cyberdeck diagnostics..."
  "Cooling the warp core..."
  "Listening for the dial-up handshake of destiny..."
  "Syncing save files with the cloud kingdom..."
  "Grinding XP for integration tests..."
  "Speedrunning the dependency dungeon..."
  "Loading the next biome..."
  "Checking if the boss music is justified..."
  "Almost there, stitching final reports..."
)

# ── Step 1: Check Node.js ─────────────────────────────────────
echo -e "${CYAN}[1/6] Checking Node.js...${RESET}"
write_wait_line "Waking the runtime engines..."
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
write_wait_line "Reticulating Splines..."
NEEDS_INSTALL=false
if [ ! -d "node_modules" ]; then
  NEEDS_INSTALL=true
  echo "  node_modules not found"
elif [ ! -d "node_modules/node-pty" ]; then
  NEEDS_INSTALL=true
  echo "  node-pty not found in node_modules — reinstalling dependencies..."
fi

if [ "$NEEDS_INSTALL" = true ]; then
  echo "  Running npm install..."
  npm install
  echo -e "  ${GREEN}Dependencies installed${RESET}"
else
  echo -e "  ${GREEN}Dependencies: OK${RESET}"
fi

# Ensure bundled CLI tools are available
echo -e "${CYAN}    Checking bundled tools...${RESET}"

# Install Playwright browser if @playwright/mcp is a dependency and Chromium is missing
if [ -d "node_modules/@playwright/mcp" ]; then
  write_wait_line "Checking Playwright Chromium browser..."
  if ! npx playwright install --dry-run chromium 2>/dev/null | grep -q "already installed" 2>/dev/null; then
    echo "  Installing Playwright Chromium browser..."
    npx playwright install chromium 2>/dev/null || {
      echo -e "  ${DIM}Playwright Chromium install failed — browser automation may not work.${RESET}"
      echo -e "  ${DIM}Run manually: npx playwright install chromium${RESET}"
    }
    echo -e "  ${GREEN}Playwright Chromium: OK${RESET}"
  else
    echo -e "  ${GREEN}Playwright Chromium: OK${RESET}"
  fi
fi

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
  write_wait_line "Cleaning old build artifacts and forging TypeScript into JavaScript..."
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
    write_wait_line "Interrogating the test matrix..."
    TEST_START=$(date +%s)
    invoke_process_quietly_with_animation "Test runner" 4 -- npx vitest run --reporter=dot
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

if get_web_rotate_on_startup_from_file "$CONFIG_FILE"; then
  echo -e "  ${DIM}Web dashboard auth is set to rotate on startup.${RESET}"
  echo -e "  ${DIM}GuardianAgent will print a runtime-ephemeral dashboard token in this terminal at startup.${RESET}"
elif configured_web_auth_token=$(get_web_auth_token_from_file "$CONFIG_FILE"); then
  echo -e "  ${DIM}Web dashboard auth token is pinned in config or env and will be reused.${RESET}"
  echo -e "  ${DIM}Remove it or enable channels.web.auth.rotateOnStartup to switch back to per-run terminal tokens.${RESET}"
else
  echo -e "  ${DIM}Web dashboard auth token is not pinned in config.${RESET}"
  echo -e "  ${DIM}GuardianAgent will print a runtime-ephemeral dashboard token in this terminal at startup.${RESET}"
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
