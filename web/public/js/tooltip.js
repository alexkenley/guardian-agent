/**
 * Shared tooltip helper for dashboard input controls.
 *
 * Applies explicit tooltips first, then fills any missing input/select/textarea
 * title attributes from nearby labels/placeholders.
 */

const DEFAULT_TOOLTIPS = {
  '#auth-token-input': 'Paste the dashboard bearer token from startup logs to authenticate this browser session.',
  '#filter-type': 'Filter audit log entries by event category.',
  '#filter-severity': 'Show only critical, warning, or info security events.',
  '#filter-agent': 'Filter events for a specific agent ID.',
  '#filter-limit': 'Maximum number of audit events to load.',
  '#cfg-profile': 'Choose an existing provider profile or create a new one.',
  '#cfg-provider-name': 'Unique profile name used in runtime config.',
  '#cfg-provider-type': 'External provider backend (OpenAI or Anthropic).',
  '#cfg-model': 'Model ID to use when this profile is selected.',
  '#cfg-base-url': 'Optional custom endpoint. Leave blank for provider defaults.',
  '#cfg-api-key': 'API key for external providers. Leave blank to keep the existing key.',
  '#cfg-set-default': 'Set this profile as the assistant default provider after save.',
  '#cfg-telegram-enabled': 'Enable or disable Telegram channel integration.',
  '#cfg-telegram-token': 'Telegram bot token from @BotFather. Leave blank to keep current token.',
  '#cfg-telegram-chatids': 'Comma-separated chat IDs allowed to use this bot.',
  '#auth-mode': 'Choose how dashboard/API authentication is enforced.',
  '#auth-token-source': 'Shows whether the active token comes from config, environment, or ephemeral runtime generation.',
  '#auth-ttl': 'Optional client session hint in minutes.',
  '#auth-token-preview': 'Masked preview of the currently active bearer token.',
  '#auth-token-input-new': 'Set a new token value. Leave empty to keep existing token.',
  '#tools-run-name': 'Choose a registered tool to execute.',
  '#tools-run-origin': 'Execution source context used for audit and policy decisions.',
  '#tools-run-args': 'Tool arguments as JSON object.',
  '#tools-policy-mode': 'Global approval strategy for tool execution.',
  '#tools-policy-paths': 'Comma-separated filesystem roots allowed for tool access. Supports C:\\... and /mnt/c/... path formats.',
  '#tools-policy-commands': 'Comma-separated command prefixes allowed for shell_safe.',
  '#tools-policy-domains': 'Comma-separated allowed domains for network/browser tools.',
  '#intel-mode': 'Response automation level for drafted threat-intel actions.',
  '#intel-scan-query': 'Optional one-off query. Leave empty to scan the full watchlist.',
  '#intel-scan-darkweb': 'Include darkweb sources in this scan (if enabled in config).',
  '.intel-source[value="web"]': 'Scan standard web sources.',
  '.intel-source[value="news"]': 'Scan news content and media sources.',
  '.intel-source[value="social"]': 'Scan social platforms and public conversations.',
  '.intel-source[value="forum"]': 'Scan configured forum connectors like Moltbook.',
  '.intel-source[value="darkweb"]': 'Scan darkweb sources (disabled unless explicitly enabled).',
  '#intel-watch-target': 'Add a person, handle, domain, brand, or phrase to monitor.',
  '#ops-name': 'Human-readable name for this scheduled task.',
  '#ops-type': 'Run a single tool or a multi-step playbook.',
  '#ops-target': 'Tool name (e.g. net_arp_scan) or playbook ID to execute.',
  '#ops-cron': 'Cron: min hour day month weekday. Examples: */15 * * * * = every 15 min, 0 0 * * * = daily midnight.',
  '#ops-args': 'Optional JSON args for the tool. Example: {"host":"192.168.1.1","count":3}',
  '#ops-event': 'Optional event name emitted after each run. Other agents can subscribe to this.',
  '#ops-enabled': 'Active schedules run automatically. Disable to pause without deleting.',
  '#quick-action-select': 'Choose a structured quick-action template.',
  '#quick-action-input': 'Provide details that will be injected into the selected template.',
  '#chat-agent-select': 'Select the active agent for this chat session.',
  '#chat-input': 'Type a message for the selected assistant agent.',
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
