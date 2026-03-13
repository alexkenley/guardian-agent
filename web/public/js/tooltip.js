/**
 * Shared tooltip helper for dashboard input controls.
 *
 * Applies explicit tooltips first, then fills any missing input/select/textarea
 * title attributes from nearby labels/placeholders.
 */

const DEFAULT_TOOLTIPS = {
  '#auth-token-input': 'Paste the bearer token shown at startup only if this browser is not already using the session cookie. The token grants dashboard access.',
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
  '#cfg-local-name': 'Name for this local model endpoint. You will use this profile name when setting the default provider or fallback order.',
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
  '#auth-mode': 'Guardian currently enforces bearer authentication for dashboard/API access. This setting is mainly here for visibility and runtime control.',
  '#auth-token-source': 'Shows where the active dashboard token came from: persisted config, environment, or a runtime-generated ephemeral token.',
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
  '#browser-enabled': 'Enables or disables browser automation tools that open managed browser sessions for rendered websites.',
  '#browser-domains': 'Comma-separated domains browser automation may visit. Keep this narrow; broad domain lists weaken your network boundary.',
  '#browser-max-sessions': 'Maximum number of concurrent managed browser sessions. Lower values reduce resource usage and operational risk.',
  '#browser-idle-timeout': 'How long an unused browser session stays open before Guardian closes it automatically.',
  '#browser-save': 'Saves browser automation policy and resource limits. These settings usually require a restart to fully apply.',
  '#cfg-notify-enabled': 'Master switch for security notifications. Disable it if you want audit and detections recorded without delivery alerts.',
  '#cfg-notify-min-severity': 'Only alerts at or above this severity will be delivered. Use warn or critical to reduce noise.',
  '#cfg-notify-cooldown': 'Minimum delay between repeated alerts of the same class so operators are not spammed during noisy incidents.',
  '#cfg-notify-delivery-mode': 'Selected channels uses the checkboxes below. All active channels ignores the individual selections and sends everywhere currently enabled.',
  '#cfg-notify-event-types': 'Comma-separated audit event types that should produce alerts. Leave empty to keep the current configured set.',
  '#cfg-notify-suppressed-details': 'Detail subtypes to suppress even when the parent event is alertable. Use this to mute noisy but expected changes.',
  '#cfg-notify-web': 'Show live alert toasts in the web UI.',
  '#cfg-notify-cli': 'Send alerts into the CLI channel.',
  '#cfg-notify-telegram': 'Send alerts to Telegram. This only works if the Telegram channel is enabled and correctly configured.',
  '#cfg-notify-save': 'Saves notification filtering and delivery settings.',
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
  '#chat-input': 'Message sent to the currently selected assistant agent. Tool calls, approvals, and streamed output all start from this field.',
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
