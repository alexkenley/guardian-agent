/**
 * Shared tooltip helper for web UI input controls.
 *
 * Applies explicit tooltips first, then fills any missing input/select/textarea
 * title attributes from nearby labels/placeholders.
 */

const DEFAULT_TOOLTIPS = {
  '#auth-token-input': 'Paste the bearer token shown at startup only if this browser is not already using the session cookie. The token grants web UI access.',
  '#filter-type': 'Restrict the audit list to one class of events such as approvals, denials, auth changes, or anomaly detections.',
  '#filter-severity': 'Use severity to cut noise fast: critical for urgent incidents, warn for review items, info for normal operational history.',
  '#filter-agent': 'Show only events tied to one agent or control-plane actor. Useful when tracing a single automation or assistant session.',
  '#filter-limit': 'How many audit rows to load in one request. Higher values show more history but make the table heavier.',
  '#cfg-profile': 'Choose which saved provider profile you want to edit. Creating a new one keeps the old profile untouched.',
  '#cfg-provider-name': 'Internal profile key used in config, routing, and fallback chains. Keep it short and stable because operators will reference it directly.',
  '#cfg-provider-type': 'The provider family determines API behavior, available models, and whether credentials are required.',
  '#cfg-model': 'Exact model ID sent to the provider. Use the live selector when available; only type manually when you know the provider accepts that model name.',
  '#cfg-base-url': 'Override the provider endpoint only for self-hosted gateways, proxies, or OpenAI-compatible custom endpoints. Leave blank for the vendor default.',
  '#cfg-api-key': 'Paste a provider key once to store it securely outside config.yaml. Leave blank when keeping the current secret or when using a credential ref instead.',
  '#cfg-local-name': 'Name for this local model endpoint. You will use this profile name when setting routed defaults, role bindings, or fallback order.',
  '#cfg-ext-name': 'Name for this hosted provider profile. Pick something operators can recognize quickly, such as openai-main or groq-fast.',
  '#cfg-local-type': 'Local provider family. This usually stays as Ollama unless another local runtime is added to the registry.',
  '#cfg-ext-type': 'Hosted provider family. Selecting one refreshes the expected model list and determines how the API request is shaped.',
  '#cfg-local-model': 'Model served by the local runtime. For Ollama this should match a pulled tag exactly.',
  '#cfg-ext-model': 'Model ID for the selected hosted provider. When credentials are available, the UI will try to load the provider\'s live model list.',
  '#cfg-local-url': 'Endpoint for the local inference server. Leave it at the default unless your runtime listens somewhere else.',
  '#cfg-ext-key': 'Simple setup path: paste the provider key once and Guardian stores it in the encrypted local secret store. Use this unless you intentionally manage secrets outside the app.',
  '#cfg-ext-url': 'Optional endpoint override for custom gateways, Azure-style wrappers, or self-hosted OpenAI-compatible servers.',
  '#cfg-ext-credential-ref': 'Advanced path only: choose an env-backed credential ref created under Credential Refs. Guardian-managed pasted keys do not appear here because they stay in the app’s secure local secret store automatically.',
  '#cfg-local-new': 'Start a fresh local provider profile without overwriting the one currently selected.',
  '#cfg-ext-new': 'Start a fresh hosted provider profile so you can compare providers or keep separate profiles for different models and keys.',
  '#cfg-local-test': 'Checks whether the named local provider is reachable and, if supported, refreshes the live model list from that runtime.',
  '#cfg-local-save': 'Saves the local provider profile into config and makes it available for default or fallback routing.',
  '#cfg-ext-test': 'Checks whether the saved hosted provider is reachable with its current config and refreshes the live model list if the provider exposes one.',
  '#cfg-ext-save': 'Saves the hosted provider profile. Paste-once secrets are stored securely; only the profile and secret reference remain in config.',
  '#cfg-telegram-test': 'Reloads the Telegram channel and validates the bot token by calling the Telegram API. Reports whether the connection succeeded.',
  '#cfg-telegram-enabled': 'Turns the Telegram channel on or off. If enabled, the bot token or credential ref and allowed chat IDs must be valid.',
  '#cfg-telegram-token': 'Paste the BotFather token once for simple setup. Guardian stores it securely and does not keep the raw token in config.yaml.',
  '#cfg-telegram-credential-ref': 'Advanced path for Telegram token management. Use this when the bot token lives in an environment variable instead of the app’s secret store.',
  '#cfg-telegram-chatids': 'Comma-separated allowlist of Telegram chat IDs. Only these chats can use the bot once Telegram is enabled.',
  '#cfg-telegram-save': 'Applies Telegram enablement, token source, and allowlist settings. Guardian will hot-reload the Telegram channel when the config is valid.',
  '#auth-mode': 'Guardian currently enforces bearer authentication for web UI and API access. This setting is mainly here for visibility and runtime control.',
  '#auth-token-source': 'Shows where the active web access token came from: persisted config, environment, or a runtime-generated ephemeral token.',
  '#auth-ttl': 'Optional browser session lifetime hint in minutes. Shorter sessions reduce exposure if a browser is left open.',
  '#auth-token-preview': 'Masked preview of the currently active token so you can confirm rotation happened without exposing the full secret.',
  '#cfg-cred-ref-select': 'Inspect an existing credential ref or create an env-backed one. Local secret-store refs appear here for visibility but are managed by the key fields elsewhere.',
  '#cfg-cred-ref-name': 'Stable ref name used by providers and integrations. Use a predictable naming pattern like llm.openai.primary or search.brave.primary.',
  '#cfg-cred-ref-env': 'Environment variable that holds the actual secret. Guardian resolves this at runtime and keeps the raw secret out of the config file.',
  '#cfg-cred-ref-description': 'Short note for operators so they can tell what a ref is for without inspecting the deployment environment.',
  '#cfg-cred-ref-save': 'Saves the env-backed credential ref mapping. The environment variable itself must exist on the machine where Guardian runs.',
  '#cfg-cred-ref-delete': 'Removes the selected credential ref mapping from config. Local secret refs should only be removed if you no longer want Guardian to use that secret.',
  '#ws-provider': 'Chooses which search backend Guardian prefers. Auto uses the best configured provider in priority order and falls back when keys are missing.',
  '#ws-brave-key': 'Paste the Brave Search key once for the simple setup path. Guardian stores it securely and uses it for live web search.',
  '#ws-brave-credential-ref': 'Advanced path for Brave Search credentials when the key is managed outside the app.',
  '#ws-perplexity-key': 'Paste the Perplexity key once if you want live Perplexity-backed search without managing environment variables manually.',
  '#ws-perplexity-credential-ref': 'Advanced path for Perplexity credentials when the secret is managed outside Guardian.',
  '#ws-openrouter-key': 'Paste the OpenRouter key once for the simple setup path. Useful when your search stack routes through OpenRouter-backed models.',
  '#ws-openrouter-credential-ref': 'Advanced path for OpenRouter search credentials when the secret is managed outside Guardian.',
  '#ws-fallbacks': 'Comma-separated provider profile names used when the default model path fails. These names must match configured provider profile names, not provider families.',
  '#ws-save': 'Saves search-provider credentials and the fallback chain used when retrieval or model routing needs a backup path.',
  '#cfg-cloud-enabled': 'Turns the cloud tool pack on or off. Disable it when you do not want Guardian to expose cloud provider tools at all.',
  '#cfg-cloud-save': 'Writes the cloud tool configuration exactly as shown in the JSON editors below.',
  '#github-client-id': 'Client ID from the GitHub OAuth App registration. This identifies your OAuth App and is safe to paste here.',
  '#github-client-secret': 'Client Secret generated from the GitHub OAuth App page. Copy it immediately after generation and treat it like a password.',
  '#github-owner': 'GitHub account or organization that owns the repository Guardian should use. This is operator-provided and is never pre-filled by Guardian.',
  '#github-repo': 'Repository name under the owner or organization above. Guardian uses this target only for approved issue/reporting actions.',
  '#browser-enabled': 'Master switch for all browser automation. Disabling removes the Playwright MCP browser tools.',
  '#browser-playwright-enabled': 'Enables Playwright MCP — full browser automation with real Chromium/Firefox/WebKit. 55+ tools for clicking, typing, screenshots, and more.',
  '#browser-playwright-browser': 'Which browser engine Playwright uses. Chromium is the default and most compatible.',
  '#browser-playwright-caps': 'Playwright capability groups (comma-separated). core is always on. Add network, storage, vision, pdf, devtools, testing as needed.',
  '#browser-domains': 'Comma-separated domains browser automation may visit. Keep this narrow; broad domain lists weaken your network boundary.',
  '#browser-save': 'Saves browser automation config. Changes require a restart to take effect.',
  '#cfg-notify-enabled': 'Master switch for security notifications. Disable it if you want audit and detections recorded without delivery alerts.',
  '#cfg-notify-min-severity': 'Only alerts at or above this severity will be delivered. Use warn or critical to reduce noise.',
  '#cfg-notify-cooldown': 'Minimum delay between repeated alerts of the same class so operators are not spammed during noisy incidents.',
  '#cfg-notify-delivery-mode': 'Selected channels uses the checkboxes below. All active channels ignores the individual selections and sends everywhere currently enabled.',
  '#cfg-notify-event-types': 'Comma-separated audit event types that should produce alerts. Add automation_finding only if you also want follow-up triage or automation summaries as notifications.',
  '#cfg-notify-suppressed-details': 'Detail subtypes to suppress even when the parent event is alertable. Use this to mute low-confidence drift or expected guardrail denials without disabling the whole parent event type.',
  '#cfg-notify-web': 'Show live alert toasts in the web UI.',
  '#cfg-notify-cli': 'Send alerts into the CLI channel.',
  '#cfg-notify-telegram': 'Send alerts to Telegram. This only works if the Telegram channel is enabled and correctly configured.',
  '#cfg-notify-save': 'Saves notification filtering and delivery settings.',
  '#sandbox-enforcement-mode': 'Strict fails closed when the strong native sandbox is unavailable. Permissive keeps Guardian running on a degraded backend, but the risky capability toggles below still stay off until you explicitly enable them.',
  '#sandbox-allow-network-tools': 'Only applies in permissive mode when native sandboxing is unavailable. Re-enables network and web-search style tools on the degraded backend.',
  '#sandbox-allow-browser-tools': 'Only applies in permissive mode when native sandboxing is unavailable. Re-enables browser automation on the degraded backend.',
  '#sandbox-allow-mcp-servers': 'Only applies in permissive mode when native sandboxing is unavailable. Re-enables third-party MCP server processes on the degraded backend.',
  '#sandbox-allow-package-managers': 'Only applies in permissive mode when native sandboxing is unavailable. Re-enables install-like package manager and remote package-launch commands on the degraded backend.',
  '#sandbox-allow-manual-terminals': 'Only applies in permissive mode when native sandboxing is unavailable. Re-enables manual PTY terminals for Code sessions on the degraded backend.',
  '#apu-paths': 'Lets the assistant ask to widen persistent filesystem path allowlists from chat or remote channels. Each request still pauses for explicit approval.',
  '#apu-commands': 'Lets the assistant ask to widen persistent shell command allowlists from chat or remote channels. Each request still pauses for explicit approval.',
  '#apu-domains': 'Lets the assistant ask to widen persistent network or browser domain allowlists from chat or remote channels. Each request still pauses for explicit approval.',
  '#apu-tool-policies': 'Lets the assistant ask for per-tool policy overrides from chat or remote channels. Each request still pauses for explicit approval.',
  '#assistant-security-monitoring-enabled': 'Turns the managed Assistant Security background scan on or off. This controls the built-in scheduler task, not manual scans.',
  '#assistant-security-monitoring-profile': 'Selects which built-in Assistant Security profile the managed background scan runs on each scheduled execution.',
  '#assistant-security-monitoring-cron': 'Cron cadence for the managed Assistant Security schedule. This drives infrastructure-led background scans, not chat activity.',
  '#assistant-security-monitoring-save': 'Saves the managed Assistant Security monitoring schedule and updates the built-in scheduled task.',
  '#assistant-security-autocontain-enabled': 'Allows high-confidence Assistant Security findings to temporarily tighten runtime controls through the normal containment service.',
  '#assistant-security-autocontain-severity': 'Minimum finding severity that can count toward automatic containment. Higher thresholds reduce noise but react later.',
  '#assistant-security-autocontain-confidence': 'Minimum Assistant Security confidence score required before a finding can influence containment. Keep this high to avoid false positives.',
  '#assistant-security-autocontain-sandbox': 'Allow sandbox failures or degraded isolation findings to contribute to temporary containment.',
  '#assistant-security-autocontain-trust-boundary': 'Allow trust-boundary findings such as degraded command paths or widened execution boundaries to contribute to temporary containment.',
  '#assistant-security-autocontain-mcp': 'Allow MCP-specific findings such as exposed third-party servers or risky overrides to contribute to temporary containment.',
  '#assistant-security-autocontain-browser': 'Allow browser-automation exposure findings to contribute to temporary containment.',
  '#assistant-security-autocontain-policy': 'Allow policy-widening findings to contribute to temporary containment.',
  '#assistant-security-autocontain-workspace': 'Allow workspace-trust findings to contribute to temporary containment.',
  '#assistant-security-autocontain-save': 'Saves the Assistant Security auto-containment thresholds and category allowlist.',
  '#tools-run-name': 'Select the exact registered tool to run manually. The description and risk class for that tool determine what the execution will do and whether approvals apply.',
  '#tools-run-origin': 'Execution context recorded in audit logs and policy decisions. Use the origin that best matches how the action is being triggered.',
  '#tools-run-args': 'Arguments passed to the tool as JSON. Use only the fields the tool expects or the request will fail validation.',
  '#tools-policy-mode': 'Choose how aggressive the system should be with tool execution: ask often, decide by policy, or run autonomously where allowed.',
  '#tools-policy-paths': 'Filesystem roots tools may touch. Keep this tight; broad paths increase the blast radius for file operations.',
  '#tools-policy-commands': 'Allowed command prefixes for shell execution. Only commands that start with one of these prefixes can run.',
  '#tools-policy-domains': 'Network and browser destinations the agent may contact. Keep this list short and deliberate to reduce SSRF and data-exfiltration risk.',
  '#intel-mode': 'Controls how far threat-intel workflows go automatically: manual only, assisted drafting, or more autonomous follow-up behavior.',
  '#intel-scan-query': 'One-off search term for this scan. Leave it blank to scan the saved watchlist instead of a temporary query.',
  '#intel-scan-darkweb': 'Adds darkweb sources to this scan only when darkweb support is enabled and actually configured.',
  '.intel-source[value="web"]': 'Standard web searching across public sites and pages.',
  '.intel-source[value="news"]': 'News and media coverage, useful for fraud, reputation, or incident reporting hits.',
  '.intel-source[value="social"]': 'Public social content where impersonation, scams, or harassment often show up first.',
  '.intel-source[value="forum"]': 'Configured forum and hostile-community connectors such as Moltbook, if enabled.',
  '.intel-source[value="darkweb"]': 'Darkweb sources. Only useful when the deployment has a real connector for that source class.',
  '#intel-watch-target': 'Add a persistent watch target such as a person, alias, company, domain, brand, or fraud phrase.',
  '#ops-name': 'Operator-friendly name for the scheduled task. Choose something that will still make sense in logs and run history later.',
  '#ops-type': 'Decides whether the schedule launches one tool directly or a multi-step workflow.',
  '#ops-target': 'The exact tool or workflow the schedule will run. Choose the concrete target, not the category.',
  '#ops-schedule-kind': 'High-level schedule builder. Use this for normal recurring jobs before dropping to raw cron.',
  '#ops-interval': 'Repeat frequency for interval-based schedules such as every 15 minutes or every 2 hours.',
  '#ops-minute': 'Minute within the hour for hourly schedules so you can stagger jobs instead of firing everything at once.',
  '#ops-time': 'Time of day for daily or weekly schedules, using the local server clock.',
  '#ops-weekday': 'Day of week for weekly schedules.',
  '#ops-cron-custom': 'Raw cron expression for advanced scheduling when the simple builder is not flexible enough.',
  '#ops-args': 'Optional JSON payload passed to the tool or workflow. Leave blank unless the target expects input.',
  '#ops-event': 'Optional event emitted after the run finishes so other automations or agents can react to it.',
  '#ops-enabled': 'If disabled, the schedule is saved but will not run until you enable it later.',
  '#ops-create-toggle': 'Opens or closes the task-creation form.',
  '#ops-save': 'Creates or updates the scheduled task with the form values shown above.',
  '#ops-cancel': 'Closes the task form and discards unsaved edits.',
  '#ops-refresh': 'Reloads tasks, presets, and run history from the server.',
  '#quick-action-select': 'Choose the structured quick action template. The template determines how your text is turned into a tool-ready task.',
  '#quick-action-input': 'Plain-language details injected into the chosen quick action template.',
  '#quick-action-run': 'Runs the selected quick action immediately using the details you entered.',
  '#chat-agent-select': 'Pick which agent should answer in this chat. Useful when you want to force work through a specific persona or provider path.',
  '#chat-provider-select': 'Choose Automatic to let Guardian route the request normally, or pick one enabled provider profile to force that chat turn through that exact profile.',
  '#chat-input': 'Message sent to the currently selected assistant agent. Tool calls, approvals, and streamed output all start from this field.',
  '[data-code-new-session]': 'Create a new coding session with its own workspace root and conversation.',
  '[data-code-reset-chat]': 'Clear the conversation and start fresh. Session and workspace remain intact.',
  '[data-code-toggle-diff]': 'Toggle between source-only and side-by-side split diff view.',
  '#auto-create-name': 'Operator-friendly name shown in the catalog and run history.',
  '#auto-create-id': 'Unique machine ID used in API calls and scheduling. Auto-generated from name. Cannot change after creation.',
  '#auto-create-mode': 'Choose how this automation is structured: a single tool run, an ordered pipeline, or a parallel pipeline.',
  '#auto-agent-mode': 'Instead of running tools deterministically, wake the assistant with the prompt below. The assistant has full access to tools, memory, and skills.',
  '#auto-single-tool-select': 'The tool this automation executes. Use Browse to see descriptions and requirements.',
  '#auto-llm-provider': 'Choose which model provider class handles instruction steps and assistant-driven runs.',
  '#auto-step-type-select': 'Choose what kind of step to add to the pipeline.',
  '#auto-step-delay-value': 'How long to pause. Combine with the unit selector (seconds/minutes/hours/days).',
  '#auto-agent-select': 'Which agent handles this automation. Default uses your main assistant.',
  '#auto-agent-channel': 'Where the response is delivered. Background: logged only. CLI/Telegram/Web: sent to that channel.',
  '#auto-agent-prompt': 'The instruction given to the agent each run. Write as if sending a chat message — the agent has full tool/memory/skill access.',
  '#auto-agent-deliver': 'When checked, sends the response to the delivery channel. Uncheck for silent runs (results still in history).',
  '#auto-single-prompt': 'Optional instruction wrapped around the tool result. Adding this auto-converts to a 2-step pipeline (tool + LLM instruction).',
  '#auto-schedule-kind': 'Choose how this automation should be scheduled, from simple presets through to a custom cron expression.',
  '#auto-output-store-enabled': 'When enabled, Guardian stores the full output of saved automation runs for historical analysis and saves a searchable memory reference to that run. This does not apply to ad hoc one-off tool usage.',
  '#auto-engine-enabled': 'Master switch for the automation engine. Disabling it prevents saved automations from executing.',
  '#auto-engine-mode': 'Choose how the automation engine approaches planning and execution.',
  '#auto-max-calls': 'Maximum number of tool calls one automation run may make before the engine stops it.',
  '#auto-max-steps': 'Maximum number of deterministic workflow steps allowed in one saved automation definition.',
  '#auto-max-parallel': 'Maximum number of workflow steps that may execute concurrently in parallel mode.',
  '#auto-step-timeout': 'Default timeout for each automation step before Guardian treats the step as failed.',
  '#auto-require-signed': 'When enabled, saved step-based automations must carry a signature before they can execute.',
  '#auto-require-dryrun': 'When enabled, deterministic automations must complete a dry run successfully before live execution is allowed.',
  '#auto-engine-save': 'Saves the runtime-wide automation engine settings shown above.',
  '#auto-pack-json': 'Raw JSON editor for access profiles. These profiles add tighter restrictions to selected automation steps.',
  '#auto-pack-upsert': 'Creates or updates the access profile defined in the JSON editor above.',
  '#appearance-font-scale': 'Increase or decrease the base text size across the entire web UI. This adjusts the root font scale, not just one page.',
  '#appearance-font-family': 'Switch the app-wide typography preset to a more readable sans or serif stack without changing the functional layout.',
  '#appearance-reduce-motion': 'Reduces transitions and animation time across the web UI for motion-sensitive operators.',
  '#appearance-reset': 'Restores the default Guardian theme, default font preset, the slightly larger default text size, and normal motion.',
};

export function applyInputTooltips(root = document, extraTooltips = {}) {
  const tooltips = { ...DEFAULT_TOOLTIPS, ...extraTooltips };

  for (const [selector, text] of Object.entries(tooltips)) {
    root.querySelectorAll(selector).forEach((el) => {
      setTooltip(el, text);
    });
  }

  root.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.getAttribute('title')) return;
    const derived = deriveTooltip(el);
    if (derived) {
      setTooltip(el, derived);
    }
  });

  // Propagate tooltips to info icons: find any .code-tooltip-icon with an empty
  // or missing title and copy the tooltip from the nearest input/select/textarea.
  root.querySelectorAll('.code-tooltip-icon').forEach((icon) => {
    if (icon.getAttribute('title')) return;
    // Try .cfg-field first, then walk up to parent/grandparent div
    const containers = [
      icon.closest('.cfg-field'),
      icon.parentElement,
      icon.parentElement?.parentElement,
    ].filter(Boolean);
    for (const container of containers) {
      const input = container.querySelector('input:not([type="hidden"]), select, textarea');
      const title = input?.getAttribute('title');
      if (title) { setTooltip(icon, title); break; }
    }
  });
}

function setTooltip(el, text) {
  el.setAttribute('title', text);
  if (!el.getAttribute('aria-label')) {
    el.setAttribute('aria-label', text);
  }
}

function deriveTooltip(el) {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;

  const id = el.getAttribute('id');
  if (id) {
    const explicit = document.querySelector(`label[for="${cssEscape(id)}"]`);
    const labelText = explicit?.textContent?.trim();
    if (labelText) return labelText;
  }

  const wrapped = el.closest('label');
  const wrappedText = wrapped?.textContent?.trim().replace(/\s+/g, ' ');
  if (wrappedText) return wrappedText;

  const parentLabel = findSiblingLabel(el);
  if (parentLabel) return parentLabel;

  const placeholder = el.getAttribute('placeholder')?.trim();
  if (placeholder) return placeholder;

  const name = el.getAttribute('name')?.trim();
  if (name) return name;

  return 'Input';
}

function findSiblingLabel(el) {
  const parent = el.parentElement;
  if (!parent) return null;
  const label = parent.querySelector('label');
  const text = label?.textContent?.trim().replace(/\s+/g, ' ');
  return text || null;
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
