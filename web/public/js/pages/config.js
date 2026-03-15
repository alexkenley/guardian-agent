/**
 * Configuration page — product setup and policy, not operational monitoring.
 */

import { api } from '../api.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';
import { themes, getSavedTheme, applyTheme } from '../theme.js';

// Shared state loaded once and passed to tabs
let currentContainer = null;
let sharedConfig = null;
let sharedProviders = null;
let sharedSetupStatus = null;
let sharedAuthStatus = null;
let sharedProviderTypes = null;
const configUiState = {
  selectedProviderProfiles: {
    local: null,
    external: null,
  },
};
const FALLBACK_PROVIDER_TYPES = [
  { name: 'ollama', displayName: 'Ollama', compatible: false, locality: 'local' },
  { name: 'openai', displayName: 'OpenAI', compatible: false, locality: 'external' },
  { name: 'anthropic', displayName: 'Anthropic', compatible: false, locality: 'external' },
  { name: 'groq', displayName: 'Groq', compatible: true, locality: 'external' },
  { name: 'mistral', displayName: 'Mistral AI', compatible: true, locality: 'external' },
  { name: 'deepseek', displayName: 'DeepSeek', compatible: true, locality: 'external' },
  { name: 'together', displayName: 'Together AI', compatible: true, locality: 'external' },
  { name: 'xai', displayName: 'xAI (Grok)', compatible: true, locality: 'external' },
  { name: 'google', displayName: 'Google Gemini', compatible: true, locality: 'external' },
];
const CONFIG_HELP = {
  aiSearch: {
    'AI Provider Configuration': {
      whatItIs: 'This section is where you define the actual LLM profiles Guardian can use, including local runtimes such as Ollama and hosted APIs such as OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI, and Google.',
      whatSeeing: 'You are seeing separate local and external provider editors, saved provider-profile buttons, provider-type selectors, model controls, credential fields, endpoint overrides, and test/save actions.',
      whatCanDo: 'Add a new provider, edit an existing one, switch models, load live model lists where supported, replace stored credentials, and decide which named provider profile exists for routing and fallback.',
      howLinks: 'Every assistant response, automation, tool-routing decision, and fallback chain ultimately depends on the provider profiles configured here.',
    },
    'Configured Providers': {
      whatItIs: 'This section is the runtime-facing inventory of provider profiles that Guardian currently knows about and can attempt to use.',
      whatSeeing: 'You are seeing each configured provider name, provider family, locality, active model, connection status, base URL, and any live model metadata returned by the runtime.',
      whatCanDo: 'Use it to confirm that saved config became a usable runtime provider, compare configured profiles, and troubleshoot why a provider is offline, mispointed, or missing.',
      howLinks: 'It validates whether the setup work done in AI Provider Configuration has actually produced a provider the rest of the system can call.',
    },
    'Web Search & Model Fallback': {
      whatItIs: 'This section controls how Guardian reaches out beyond the base model when it needs web results, external search providers, or a secondary model path after a provider failure.',
      whatSeeing: 'You are seeing web-search provider settings, search enablement, fallback-model controls, credential-ref inputs for search APIs, and retrieval behavior options.',
      whatCanDo: 'Turn external search on or off, configure Brave/Perplexity/OpenRouter-style search credentials, and decide what model or provider path should be used when the primary path cannot answer cleanly.',
      howLinks: 'These settings directly affect research, threat-intel scanning, retrieval-backed answers, and resilience when the main model path fails.',
    },
    'Document Sources': {
      whatItIs: 'This section controls the local and remote document collections Guardian can index for retrieval-augmented answers.',
      whatSeeing: 'You are seeing source-management controls, current indexing/search state, add-source entry points, and actions for refreshing or rebuilding source indexes.',
      whatCanDo: 'Enable document search, register new source collections, refresh index status, and trigger reindexing when source content changes.',
      howLinks: 'These sources feed the retrieval layer used by the assistant, research tasks, and any workflow that needs grounded answers from your own material.',
    },
    'Add Source': {
      whatItIs: 'This is the source-registration form for adding a new folder, file set, or supported remote content location into Guardian\'s searchable document corpus.',
      whatSeeing: 'You are seeing the fields needed to name the source, identify its type, and tell Guardian where the underlying files or URLs live.',
      whatCanDo: 'Create a new indexed source without hand-editing config, then immediately bring that source into the retrieval pipeline.',
      howLinks: 'Anything added here becomes part of Configured Sources and can then be searched or retrieved by AI and automation features.',
    },
    'Configured Sources': {
      whatItIs: 'This section is the live registry of document collections already attached to Guardian\'s retrieval system.',
      whatSeeing: 'You are seeing source names, types, paths or origins, indexing state, and the actions available to refresh, reindex, or remove each source.',
      whatCanDo: 'Audit which sources are active, identify stale or broken indexes, and manage the source set that contributes to retrieval answers.',
      howLinks: 'It is the operational counterpart to Add Source and determines what private material the assistant can ground answers against.',
    },
  },
  toolsPolicy: {
    'Sandbox Status': {
      whatItIs: 'This section reports the exact isolation and enforcement backend currently protecting tool execution.',
      whatSeeing: 'You are seeing whether a sandbox is active, what backend is in use, whether strict mode is on, and whether policy is currently constraining tool access.',
      whatCanDo: 'Use it to explain why a tool can or cannot run before you start loosening allowlists or changing approvals.',
      howLinks: 'It is the runtime reality check for the policy choices made elsewhere in Tools & Policy.',
    },
    'Runtime Notices': {
      whatItIs: 'This section surfaces active warnings emitted by the tool runtime itself, not just saved configuration.',
      whatSeeing: 'You are seeing notices about degraded providers, disabled tool classes, missing prerequisites, or runtime conditions that can change tool behavior.',
      whatCanDo: 'Read these notices before troubleshooting because they often explain failures without needing to inspect logs.',
      howLinks: 'They provide immediate context for approvals, routing, allowlists, and tool failures elsewhere on this tab.',
    },
    'Execution Mode': {
      whatItIs: 'This section sets the global execution posture for the tool layer before per-tool overrides are considered.',
      whatSeeing: 'You are seeing the top-level switches for dry-run behavior, automatic routing, and other system-wide execution defaults.',
      whatCanDo: 'Change the overall risk and autonomy posture for tools without editing every category and tool individually.',
      howLinks: 'These settings become the baseline that the category, catalog, approval, and policy sections build on.',
    },
    'Tool Categories': {
      whatItIs: 'This section groups the registered tool catalog into broad families such as file, web, shell, browser, and cloud operations.',
      whatSeeing: 'You are seeing category-level enablement, counts, and routing defaults that apply to all tools in that family unless a tool-level override exists.',
      whatCanDo: 'Disable risky families wholesale, or steer an entire category toward the local or external reasoning path.',
      howLinks: 'These category settings act as the default policy layer beneath global execution mode and above the individual tool catalog.',
    },
    'Tool Catalog': {
      whatItIs: 'This is the per-tool control plane for every registered tool Guardian can expose to operators, agents, and automations.',
      whatSeeing: 'You are seeing individual tool names, categories, risk levels, enabled state, and any routing or execution overrides applied at the tool level.',
      whatCanDo: 'Inspect exactly what a tool can do and override category defaults when one tool needs tighter or looser handling than its peers.',
      howLinks: 'This is the last configuration layer before a tool is actually invoked by chat, automations, or manual runs.',
    },
    'Pending Approvals': {
      whatItIs: 'This section is the live queue of tool actions that reached a human-approval checkpoint.',
      whatSeeing: 'You are seeing approval requests with origin channel, requested action, risk context, and the decision controls to allow or deny them.',
      whatCanDo: 'Act as the human control point for risky operations that the runtime refused to execute autonomously.',
      howLinks: 'It is where policy, risk scoring, and operator judgment meet before a blocked action can continue.',
    },
    'Recent Tool Jobs': {
      whatItIs: 'This section is the recent execution log for tool runs that were attempted by users, agents, or automations.',
      whatSeeing: 'You are seeing job records with status, origin, duration, and a compact success or failure summary.',
      whatCanDo: 'Trace what just happened, confirm whether a run finished, and quickly identify failing or noisy tools.',
      howLinks: 'It closes the loop after approvals and routing by showing what actually executed and how it ended.',
    },
    'Allowed Paths': {
      whatItIs: 'This section defines which filesystem roots sandboxed tools are allowed to read from or write to.',
      whatSeeing: 'You are seeing the current path allowlist and the controls to add, review, or remove approved directory roots.',
      whatCanDo: 'Constrain file access tightly enough that tool mistakes or hostile prompts cannot wander across the whole machine.',
      howLinks: 'These paths are one of the hard boundaries the sandbox uses when file-capable tools run.',
    },
    'Allowed Commands': {
      whatItIs: 'This section defines which shell command prefixes Guardian is allowed to execute when shell tools are enabled.',
      whatSeeing: 'You are seeing the approved command-prefix list and the controls used to grant or revoke command patterns.',
      whatCanDo: 'Allow only the exact command families you trust instead of giving shell access a broad blank check.',
      howLinks: 'These prefixes are enforced when shell jobs are approved or executed through tool workflows.',
    },
    'Allowed Domains': {
      whatItIs: 'This section defines the outbound network destinations tools and browser automation are allowed to contact.',
      whatSeeing: 'You are seeing the domain allowlist used for network requests, browser visits, and other outbound-capable tools.',
      whatCanDo: 'Restrict external access to the services you actually need and cut down SSRF, exfiltration, and accidental browsing risk.',
      howLinks: 'This allowlist is one of the main network-policy controls enforced by the tool runtime.',
    },
  },
  integrations: {
    'Telegram Channel': {
      whatItIs: 'This section configures Telegram as a real operator channel for commands, alerts, and assistant interaction outside the web UI.',
      whatSeeing: 'You are seeing the controls for bot enablement, bot token or token ref, allowed chat IDs, and the current Telegram channel state.',
      whatCanDo: 'Connect a bot, restrict which Telegram chats may use it, and decide whether Telegram is available as an operator surface at all.',
      howLinks: 'Once enabled, Telegram becomes another place to receive notifications and run approved Guardian workflows.',
    },
    'Browser Automation': {
      whatItIs: 'This section controls the browser-automation runtime used by tools that need to open sites, click through pages, or inspect rendered content.',
      whatSeeing: 'You are seeing browser enablement, domain restrictions, concurrency limits, and runtime timeout controls.',
      whatCanDo: 'Decide whether browser automation is allowed, where it is allowed to go, and how much parallel browser activity the system can sustain.',
      howLinks: 'These limits affect any workflow that depends on rendered-page automation rather than plain HTTP requests.',
    },
    'Google Workspace': {
      whatItIs: 'This section handles setup for the Google Workspace integration layer, including authentication and service availability.',
      whatSeeing: 'You are seeing installation status, authentication guidance, enablement controls, and connectivity checks for Google-backed capabilities.',
      whatCanDo: 'Connect Guardian to Google services before enabling Gmail, Drive, Calendar, or related tool actions.',
      howLinks: 'Successful setup here unlocks Google Workspace tools for use by the assistant and automation layer.',
    },
  },
  system: {
    'Web Authentication': {
      whatItIs: 'This section controls how access to the dashboard and API is authenticated, including the current bearer-token posture.',
      whatSeeing: 'You are seeing auth mode, token source, session timing, and the controls to rotate or reveal the active token.',
      whatCanDo: 'Rotate web access credentials, verify where the current token came from, and tune how long browser sessions should remain valid.',
      howLinks: 'These settings govern entry into the whole web surface, so every other dashboard feature depends on them being correct.',
    },
    'Security Alerts': {
      whatItIs: 'This section decides which security events should create outbound notifications and where those notifications should go.',
      whatSeeing: 'You are seeing the threshold, event filters, cooldowns, and delivery-channel controls that shape the alert stream.',
      whatCanDo: 'Reduce noisy alerting, route important events to the right channels, and define which classes of incidents deserve active delivery.',
      howLinks: 'These settings control the delivery path for alerts generated by Security, Sentinel, and promoted automation findings.',
    },
    'Guardian Agent': {
      whatItIs: 'This section configures the Guardian evaluation layer that reviews risky actions before they are allowed to execute.',
      whatSeeing: 'You are seeing controls for enablement, provider selection, failure handling, and evaluation timeout.',
      whatCanDo: 'Tune how aggressively Guardian reviews actions, what model path performs those reviews, and what should happen if the evaluator is unavailable.',
      howLinks: 'This directly affects pre-execution safety checks for tools, approvals, and autonomous workflows.',
    },
    'Policy-as-Code Engine': {
      whatItIs: 'This section controls the rule-based policy engine that can enforce or shadow-test declarative rules alongside the rest of the runtime.',
      whatSeeing: 'You are seeing engine enablement, enforcement mode, per-family overrides, and shadow-run statistics.',
      whatCanDo: 'Turn policy-as-code on or off, decide whether it enforces or only observes, and reload rules when the policy set changes.',
      howLinks: 'It shapes how decisions are made for tools, events, and system behavior when rule-based governance is enabled.',
    },
    'Sentinel Audit': {
      whatItIs: 'This section exposes Sentinel as a retrospective audit-analysis tool over the system\'s existing event and action history.',
      whatSeeing: 'You are seeing a manual run surface and the findings or recommendations produced by the last Sentinel pass.',
      whatCanDo: 'Trigger anomaly analysis on demand and review whether Sentinel sees suspicious patterns in prior activity.',
      howLinks: 'It complements real-time monitoring by looking backward across the audit trail for patterns that were not obvious live.',
    },
    'Trust Preset': {
      whatItIs: 'This section applies a bundled trust posture that adjusts multiple security and autonomy settings at once.',
      whatSeeing: 'You are seeing the currently active preset and the predefined posture choices available for the system.',
      whatCanDo: 'Move the whole system toward a stricter or looser default stance without manually touching every policy control.',
      howLinks: 'The selected preset influences the defaults that other security, tool, and approval settings inherit from.',
    },
    'Danger Zone': {
      whatItIs: 'This section contains the destructive reset actions for config, stored state, and other persistent Guardian data.',
      whatSeeing: 'You are seeing wipe and reset controls together with the scope and consequence of each destructive action.',
      whatCanDo: 'Use it only when you intentionally want to reinitialize the product, clear stored data, or recover from a broken setup by starting over.',
      howLinks: 'These controls affect the entire installation, not just one page or feature, so they sit apart from normal configuration actions.',
    },
  },
  appearance: {},
};

export async function renderConfig(container, options = {}) {
  currentContainer = container;
  container.innerHTML = '<h2 class="page-title">Configuration</h2><div class="loading">Loading...</div>';

  try {
    [sharedConfig, sharedProviders, sharedSetupStatus, sharedAuthStatus, sharedProviderTypes] = await Promise.all([
      api.config(),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.setupStatus().catch(() => null),
      api.authStatus().catch(() => null),
      api.providerTypes().catch(() => FALLBACK_PROVIDER_TYPES),
    ]);

    container.innerHTML = `
      <h2 class="page-title">Configuration</h2>
      ${renderGuidancePanel({
        kicker: 'Configuration Guide',
        title: 'Product setup and policy ownership',
        whatItIs: 'Configuration is the home for product setup, tool policy, integrations, system controls, and appearance.',
        whatSeeing: 'You are seeing tabs that separate AI/search setup, tool policy, integrations, system controls, and visual preferences.',
        whatCanDo: 'Use this page to configure how GuardianAgent behaves, connects, authenticates, and notifies.',
        howLinks: 'This page defines setup and policy. Operational investigation, monitoring, and workflow execution stay on their owner pages.',
      })}
    `;

    createTabs(container, [
      { id: 'ai-search', label: 'AI & Search', render: renderAiSearchTab },
      { id: 'tools-policy', label: 'Tools & Policy', render: renderToolsPolicyTab },
      { id: 'integrations', label: 'Integrations', render: renderIntegrationsTab },
      { id: 'system', label: 'System', render: renderSystemTab },
      { id: 'appearance', label: 'Appearance', render: renderAppearanceTab },
    ], normalizeConfigTab(options?.tab));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<h2 class="page-title">Configuration</h2><div class="loading">Error: ${esc(message)}</div>`;
  }
}

export async function updateConfig() {
  if (!currentContainer) return;
  const activeTab = currentContainer.dataset.activeTab;
  await renderConfig(currentContainer, activeTab ? { tab: activeTab } : {});
}

function normalizeConfigTab(tab) {
  if (!tab) return 'ai-search';
  if (tab === 'providers' || tab === 'search-sources' || tab === 'cloud') return 'ai-search';
  if (tab === 'tools' || tab === 'policy') return 'tools-policy';
  if (tab === 'settings') return 'system';
  return tab;
}

function renderAiSearchTab(panel) {
  panel.innerHTML = '';
  panel.insertAdjacentHTML('beforeend', renderGuidancePanel({
    kicker: 'AI & Search',
    compact: true,
    whatItIs: 'This tab configures AI providers, search behavior, and document retrieval sources.',
    whatSeeing: 'You are seeing provider setup, search fallback controls, and source management.',
    whatCanDo: 'Set up language models, tune search-backed retrieval, and manage indexed document sources.',
    howLinks: 'These settings affect assistant responses and any workflows that rely on model or retrieval behavior.',
  }));

  const providersPanel = document.createElement('div');
  renderProvidersTab(providersPanel);
  panel.appendChild(providersPanel);

  panel.appendChild(createWebSearchPanel(sharedConfig, panel));
  panel.appendChild(createCredentialRefsPanel(panel));

  const sourcesPanel = document.createElement('div');
  renderSearchSourcesTab(sourcesPanel);
  panel.appendChild(sourcesPanel);

  applyInputTooltips(panel);
  enhanceSectionHelp(panel, CONFIG_HELP.aiSearch, createGenericHelpFactory('Configuration AI & Search'));
  activateContextHelp(panel);
}

function renderToolsPolicyTab(panel) {
  panel.innerHTML = '';
  panel.insertAdjacentHTML('beforeend', renderGuidancePanel({
    kicker: 'Tools & Policy',
    compact: true,
    whatItIs: 'This tab controls the tool runtime, approvals, sandbox policy, and allowlists.',
    whatSeeing: 'You are seeing runtime state, routing controls, approval queues, and policy allowlists.',
    whatCanDo: 'Tune tool behavior, approve actions, and manage the constraints that govern tool execution.',
    howLinks: 'These settings shape what operational pages and automations are allowed to do when they invoke tools.',
  }));

  const toolsPanel = document.createElement('div');
  panel.appendChild(toolsPanel);
  void renderToolsTab(toolsPanel);

  const policyPanel = document.createElement('div');
  panel.appendChild(policyPanel);
  void renderPolicyTab(policyPanel);
}

function renderIntegrationsTab(panel) {
  panel.innerHTML = '';
  panel.insertAdjacentHTML('beforeend', renderGuidancePanel({
    kicker: 'Integrations',
    compact: true,
    whatItIs: 'This tab configures external service integrations and operator channels.',
    whatSeeing: 'You are seeing integration-specific setup for Telegram and browser automation.',
    whatCanDo: 'Connect or validate external integrations before the assistant or automations use them.',
    howLinks: 'These integrations extend what the product can reach, but they are configured here rather than in operational pages.',
  }));

  panel.appendChild(createTelegramPanel(sharedConfig, panel));
  panel.appendChild(createBrowserPanel(sharedConfig, panel));

  applyInputTooltips(panel);
  enhanceSectionHelp(panel, CONFIG_HELP.integrations, createGenericHelpFactory('Configuration Integrations'));
  activateContextHelp(panel);
}

function renderSystemTab(panel) {
  panel.innerHTML = '';
  panel.insertAdjacentHTML('beforeend', renderGuidancePanel({
    kicker: 'System',
    compact: true,
    whatItIs: 'This tab contains system-wide controls for authentication, notifications, trust posture, and internal policy engines.',
    whatSeeing: 'You are seeing overview cards plus configuration panels for auth, alert delivery, Guardian, Sentinel, and trust posture.',
    whatCanDo: 'Adjust the product-level controls that affect access, enforcement, alert delivery, and reset behavior.',
    howLinks: 'These are system settings, not operational dashboards, and they influence behavior across the whole app.',
  }));

  panel.appendChild(createOverview(sharedConfig, sharedProviders, sharedSetupStatus));
  panel.appendChild(createAuthPanel(sharedConfig, sharedAuthStatus, panel));
  panel.appendChild(createNotificationsPanel(sharedConfig, panel));
  panel.appendChild(createGuardianAgentPanel());
  panel.appendChild(createPolicyEnginePanel());
  panel.appendChild(createSentinelAuditPanel());
  panel.appendChild(createTrustPresetPanel(sharedConfig));
  panel.appendChild(createDangerZonePanel());

  applyInputTooltips(panel);
  enhanceSectionHelp(panel, CONFIG_HELP.system, createGenericHelpFactory('Configuration System'));
  activateContextHelp(panel);
}

// ─── Providers Tab ───────────────────────────────────────

function renderProvidersTab(panel) {
  const config = sharedConfig;
  const providers = sharedProviders;
  panel.innerHTML = '';

  panel.appendChild(createProviderPanel(config, providers, panel));
  panel.appendChild(createProviderStatusTable(config, providers, panel));
  applyInputTooltips(panel);
}

function createProviderPanel(config, providers, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const providerTypes = getProviderTypeCatalog();
  const preferredProviders = config?.assistant?.tools?.preferredProviders || {};
  const credentialRefOptions = renderCredentialRefOptions(
    config?.assistant?.credentials?.refs || {},
    (meta) => meta?.source === 'env',
  );
  const externalDefaultKeyPlaceholder = 'Paste once to store securely';

  const providerMap = Object.entries(config.llm || {}).reduce((acc, [name, cfg]) => {
    const live = providers.find(p => p.name === name);
    acc[name] = {
      ...cfg,
      locality: live?.locality || (cfg.provider === 'ollama' ? 'local' : 'external'),
      connected: live?.connected,
      availableModels: live?.availableModels || [],
    };
    return acc;
  }, {});

  const localNames = Object.keys(providerMap).filter(name => providerMap[name].locality === 'local');
  const externalNames = Object.keys(providerMap).filter(name => providerMap[name].locality !== 'local');
  const localProviderTypeOptions = providerTypes
    .filter((type) => type.locality === 'local')
    .map((type) => `<option value="${escAttr(type.name)}">${esc(type.displayName)}</option>`)
    .join('');
  const externalProviderTypeOptions = providerTypes
    .filter((type) => type.locality !== 'local')
    .map((type) => `<option value="${escAttr(type.name)}">${esc(type.displayName)}</option>`)
    .join('');

  section.innerHTML = `
    <details class="cfg-provider-accordion" id="cfg-provider-panel" open>
      <summary class="cfg-provider-summary">
        <span class="cfg-provider-summary-title">AI Provider Configuration</span>
        <span class="cfg-provider-summary-note">Local and external providers live here. Hosted providers support both simple paste-once keys and advanced env-backed credential refs.</span>
      </summary>
      <div class="cfg-center-body">
        <datalist id="cfg-credential-ref-options">${credentialRefOptions}</datalist>

        <div style="display: grid; grid-template-columns: 240px 1fr; gap: 1.5rem; align-items: start;">
          <!-- Left Side: List of Providers -->
          <div style="display: flex; flex-direction: column; gap: 1.25rem; border-right: 1px solid var(--border); padding-right: 1.5rem;">
            <!-- Local Providers -->
            <div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                <h4 style="margin: 0; font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Local</h4>
                <button class="btn btn-secondary" id="cfg-local-new" type="button" style="padding: 0.15rem 0.5rem; font-size: 0.75rem; border-radius: 4px;">+ Add</button>
              </div>
              <div id="cfg-local-profiles" style="display:flex; flex-direction: column; gap: 0.35rem;"></div>
            </div>
            
            <!-- External Providers -->
            <div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                <h4 style="margin: 0; font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">External</h4>
                <button class="btn btn-secondary" id="cfg-ext-new" type="button" style="padding: 0.15rem 0.5rem; font-size: 0.75rem; border-radius: 4px;">+ Add</button>
              </div>
              <div id="cfg-ext-profiles" style="display:flex; flex-direction: column; gap: 0.35rem;"></div>
            </div>
          </div>

          <!-- Right Side: Editor form -->
          <div style="min-height: 300px;">
            <div id="cfg-provider-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 3rem; color: var(--text-muted); text-align: center;">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 1rem; opacity: 0.5;">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                <line x1="12" y1="22.08" x2="12" y2="12"></line>
              </svg>
              <div>Select a provider from the left or create a new one to edit configuration.</div>
            </div>

            <div id="cfg-local-panel" style="display: none;">
              <div class="table-header" style="padding-left:0;padding-right:0;">
                <h3>Local Provider Settings</h3>
                <span class="cfg-header-note">On-device runtimes registered as local</span>
              </div>
              <div id="cfg-local-active-note" style="margin:0.5rem 0 0.75rem;font-size:0.72rem;color:var(--text-muted);"></div>
              <div class="cfg-form-grid">
                <div class="cfg-field"><label>Provider Name</label><input id="cfg-local-name" type="text" placeholder="ollama"></div>
                <div class="cfg-field"><label>Provider Type</label><select id="cfg-local-type">${localProviderTypeOptions}</select></div>
                <div class="cfg-field"><label>Model</label><select id="cfg-local-model-select" style="display:none"></select><input id="cfg-local-model" type="text" placeholder="llama3.2"></div>
                <div class="cfg-field"><label>Base URL</label><input id="cfg-local-url" type="text" placeholder="http://127.0.0.1:11434"></div>
              </div>
              <div class="cfg-actions" style="margin-top: 1.5rem;">
                <button class="btn btn-secondary" id="cfg-local-test" type="button">Test Connection</button>
                <button class="btn btn-primary" id="cfg-local-save" type="button">Save Config</button>
                <span id="cfg-local-status" class="cfg-save-status"></span>
              </div>
            </div>

            <div id="cfg-ext-panel" style="display: none;">
              <div class="table-header" style="padding-left:0;padding-right:0;">
                <h3>External Provider Settings</h3>
                <span class="cfg-header-note">Hosted APIs and OpenAI-compatible provider families</span>
              </div>
              <div id="cfg-ext-active-note" style="margin:0.5rem 0 0.75rem;font-size:0.72rem;color:var(--text-muted);"></div>
              <div class="cfg-form-grid">
                <div class="cfg-field"><label>Provider Name</label><input id="cfg-ext-name" type="text" placeholder="claude"></div>
                <div class="cfg-field"><label>Provider Type</label><select id="cfg-ext-type">${externalProviderTypeOptions}</select></div>
                <div class="cfg-field"><label>Model</label><select id="cfg-ext-model-select" style="display:none"></select><input id="cfg-ext-model" type="text" placeholder="claude-sonnet-4-6"></div>
                <div class="cfg-field"><label>API Key</label><input id="cfg-ext-key" type="password" placeholder="${externalDefaultKeyPlaceholder}"></div>
                <div class="cfg-field"><label style="display:flex;align-items:center;gap:0.35rem;justify-content:flex-start;cursor:pointer;"><input id="cfg-ext-credential-ref-enabled" type="checkbox" title="Use an environment-backed credential ref instead of the local secret store"> Enable Credential Ref</label><input id="cfg-ext-credential-ref" type="text" list="cfg-credential-ref-options" placeholder="llm.openai.primary" disabled></div>
                <div class="cfg-field"><label>Base URL (optional)</label><input id="cfg-ext-url" type="text" placeholder="Optional custom endpoint"></div>
              </div>
              <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
                Simple mode: paste a key once and Guardian stores it in the encrypted local secret store. Advanced mode: leave API Key blank and use an environment-backed Credential Ref. App-managed local secrets stay automatic and do not show up in the advanced field.
              </div>
              <div id="cfg-ext-secret-note" style="margin-top:0.35rem;font-size:0.72rem;color:var(--text-muted);"></div>
              <div class="cfg-actions" style="margin-top: 1.5rem;">
                <button class="btn btn-secondary" id="cfg-ext-test" type="button">Test Connection</button>
                <button class="btn btn-primary" id="cfg-ext-save" type="button">Save Config</button>
                <span id="cfg-ext-status" class="cfg-save-status"></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </details>
  `;

  function getSuggestedName(side, type) {
    const normalizedType = String(type || '').trim().toLowerCase();
    let base = side === 'local' ? 'ollama' : 'openai';
    if (normalizedType === 'anthropic') base = 'claude';
    else if (normalizedType === 'google') base = 'gemini';
    else if (normalizedType && normalizedType !== 'openai' && normalizedType !== 'ollama') base = normalizedType.replace(/[^a-z0-9]+/g, '-') || base;
    if (!providerMap[base]) return base;
    let i = 2;
    while (providerMap[`${base}${i}`]) i += 1;
    return `${base}${i}`;
  }

  function getDefaultModel(side, type) {
    const normalizedType = String(type || '').trim().toLowerCase();
    if (normalizedType === 'ollama') return 'llama3.2';
    if (normalizedType === 'anthropic') return 'claude-sonnet-4-6';
    if (normalizedType === 'openai') return 'gpt-4o';
    if (normalizedType === 'groq') return 'llama-3.3-70b-versatile';
    if (normalizedType === 'mistral') return 'mistral-large-latest';
    if (normalizedType === 'deepseek') return 'deepseek-chat';
    if (normalizedType === 'together') return 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
    if (normalizedType === 'xai') return 'grok-2-latest';
    if (normalizedType === 'google') return 'gemini-2.0-flash';
    return side === 'local' ? 'local-model' : 'provider-model';
  }

  function isKnownProviderType(side, type) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const expectedLocality = side === 'local' ? 'local' : 'external';
    return providerTypes.some((candidate) => candidate.name === normalizedType && candidate.locality === expectedLocality);
  }

  function wirePanel(side) {
    const isLocal = side === 'local';
    const prefix = isLocal ? 'cfg-local' : 'cfg-ext';
    const names = isLocal ? localNames : externalNames;

    const profilesEl = section.querySelector(`#${prefix}-profiles`);
    const newBtnEl = section.querySelector(`#${prefix}-new`);
    const activeNoteEl = section.querySelector(`#${prefix}-active-note`);
    const secretNoteEl = isLocal ? null : section.querySelector('#cfg-ext-secret-note');
    const nameEl = section.querySelector(`#${prefix}-name`);
    const modelInputEl = section.querySelector(`#${prefix}-model`);
    const modelSelectEl = section.querySelector(`#${prefix}-model-select`);
    const urlEl = section.querySelector(`#${prefix}-url`);
    const statusEl = section.querySelector(`#${prefix}-status`);
    const typeEl = section.querySelector(`#${prefix}-type`);
    const keyEl = isLocal ? null : section.querySelector('#cfg-ext-key');
    const credentialRefEl = isLocal ? null : section.querySelector('#cfg-ext-credential-ref');
    const credentialRefCheckbox = isLocal ? null : section.querySelector('#cfg-ext-credential-ref-enabled');
    if (credentialRefCheckbox && credentialRefEl) {
      credentialRefCheckbox.addEventListener('change', () => {
        credentialRefEl.disabled = !credentialRefCheckbox.checked;
        if (!credentialRefCheckbox.checked) credentialRefEl.value = '';
      });
    }
    let selectedProfile = names.includes(configUiState.selectedProviderProfiles[side])
      ? configUiState.selectedProviderProfiles[side]
      : names.includes(config.defaultProvider)
      ? config.defaultProvider
      : (names[0] || null);

    // Model accessor — reads from whichever element is visible
    const modelEl = {
      get value() { return modelSelectEl.style.display !== 'none' ? modelSelectEl.value : modelInputEl.value; },
      set value(v) { modelInputEl.value = v; if (modelSelectEl.style.display !== 'none') modelSelectEl.value = v; },
    };

    /** Show a <select> dropdown if models are available, otherwise fall back to text input. */
    function updateModelSelector(models, currentModel) {
      if (models && models.length > 0) {
        const customOpt = currentModel && !models.includes(currentModel)
          ? `<option value="${esc(currentModel)}">${esc(currentModel)} (custom)</option>` : '';
        modelSelectEl.innerHTML = customOpt + models.map(m =>
          `<option value="${esc(m)}"${m === currentModel ? ' selected' : ''}>${esc(m)}</option>`
        ).join('');
        modelSelectEl.style.display = '';
        modelInputEl.style.display = 'none';
      } else {
        modelSelectEl.style.display = 'none';
        modelInputEl.style.display = '';
      }
    }

    function getSelectedEntry() {
      return selectedProfile ? providerMap[selectedProfile] : null;
    }

    function isProviderTypeChanged(nextProviderType = typeEl?.value) {
      if (isLocal || !selectedProfile) return false;
      const entry = getSelectedEntry();
      if (!entry?.provider) return false;
      return entry.provider.trim().toLowerCase() !== String(nextProviderType || '').trim().toLowerCase();
    }

    function getEffectiveCredentialRef(nextProviderType = typeEl?.value) {
      if (isLocal) return undefined;
      const explicitRef = credentialRefEl?.value.trim();
      if (explicitRef) return explicitRef;
      if (!selectedProfile || isProviderTypeChanged(nextProviderType)) return undefined;
      return getSelectedEntry()?.credentialRef?.trim() || undefined;
    }

    function refreshSecretNote(nextProviderType = typeEl?.value) {
      if (!secretNoteEl) return;
      const explicitRef = credentialRefEl?.value.trim();
      if (keyEl?.value.trim()) {
        secretNoteEl.textContent = 'A newly pasted key will be stored in Guardian\'s encrypted local secret store when you save.';
        return;
      }
      if (explicitRef) {
        const ref = getCredentialRefMeta(explicitRef);
        const envLabel = ref?.env ? ` (${ref.env})` : '';
        secretNoteEl.textContent = `This provider will use the env-backed credential ref ${explicitRef}${envLabel}.`;
        return;
      }
      const entry = getSelectedEntry();
      const existingRef = entry?.credentialRef?.trim();
      const existingMeta = getCredentialRefMeta(existingRef);
      if (!entry || !existingRef) {
        secretNoteEl.textContent = 'No credential is configured yet. Paste an API key for the simple path or choose an env-backed credential ref for the advanced path.';
        return;
      }
      if (isProviderTypeChanged(nextProviderType)) {
        secretNoteEl.textContent = 'Provider type changed. Re-enter credentials before saving so Guardian does not guess which key should apply to the new provider family.';
        return;
      }
      if (existingMeta?.source === 'local') {
        secretNoteEl.textContent = 'This profile already has a key stored in Guardian\'s encrypted local secret store. Leave API Key blank to keep it, or paste a new key to replace it.';
        return;
      }
      if (existingMeta?.source === 'env') {
        const envLabel = existingMeta.env ? ` (${existingMeta.env})` : '';
        secretNoteEl.textContent = `This profile already uses the env-backed credential ref ${existingRef}${envLabel}.`;
        return;
      }
      secretNoteEl.textContent = 'This profile already has a credential ref configured.';
    }

    async function refreshLiveModels(options = {}) {
      const providerType = typeEl?.value.trim().toLowerCase() || (isLocal ? 'ollama' : 'openai');
      const currentModel = options.currentModel || modelEl.value.trim() || getDefaultModel(side, providerType);
      if (!providerType || !isKnownProviderType(side, providerType)) {
        updateModelSelector([], currentModel);
        if (!modelEl.value.trim()) modelEl.value = currentModel;
        return;
      }

      const effectiveCredentialRef = getEffectiveCredentialRef(providerType);
      if (!isLocal && !keyEl?.value.trim() && !effectiveCredentialRef) {
        updateModelSelector([], currentModel);
        modelInputEl.value = currentModel;
        activeNoteEl.textContent = 'Select a provider type, then paste an API key or choose an env-backed credential ref to load the live model list.';
        return;
      }

      try {
        activeNoteEl.textContent = `Loading ${providerType} models...`;
        const result = await api.providerModels({
          providerType,
          model: currentModel,
          apiKey: keyEl?.value.trim() || undefined,
          credentialRef: effectiveCredentialRef,
          baseUrl: urlEl.value.trim() || undefined,
        });
        const models = Array.isArray(result?.models) ? result.models.filter(Boolean) : [];
        if (models.length > 0) {
          updateModelSelector(models, currentModel);
          if (!currentModel || !models.includes(currentModel)) {
            modelEl.value = models[0];
          }
          activeNoteEl.textContent = `${providerType} models loaded.`;
        } else {
          updateModelSelector([], currentModel);
          modelInputEl.value = currentModel;
          activeNoteEl.textContent = `${providerType} did not return any models. You can still enter a model ID manually.`;
        }
      } catch (err) {
        updateModelSelector([], currentModel);
        modelInputEl.value = currentModel;
        const reason = err instanceof Error ? err.message : String(err);
        activeNoteEl.textContent = `Could not load ${providerType} models yet: ${reason}`;
      }
    }

    function renderProfiles() {
      const buttons = names.map(name => {
        const info = providerMap[name];
        const isActive = selectedProfile === name;
        const tone = info.connected === false ? 'badge-errored' : 'badge-idle';
        const roleBadges = [];
        if (name === config.defaultProvider) roleBadges.push('global');
        if (info.locality === 'local' && preferredProviders.local === name) roleBadges.push('local');
        if (info.locality === 'external' && preferredProviders.external === name) roleBadges.push('external');
        const badgeLabel = roleBadges.length > 0 ? ` ${roleBadges.join(' / ')}` : '';
        return `
          <div
            style="display:flex; justify-content:space-between; align-items:center; padding: 0.5rem 0.6rem; border-radius: 6px; cursor:pointer; background: ${isActive ? 'var(--bg-hover)' : 'transparent'}; border: 1px solid ${isActive ? 'var(--border)' : 'transparent'}; transition: background 0.15s ease;"
            data-provider-profile="${escAttr(name)}"
            title="${escAttr(`${name} (${info.provider}${badgeLabel})`)}"
          >
            <div style="display:flex; flex-direction:column; overflow:hidden;">
              <span style="font-size: 0.85rem; font-weight: ${isActive ? '600' : '500'}; color: ${isActive ? 'var(--text-primary)' : 'var(--text-secondary)'}; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${esc(name)}</span>
              <span style="font-size: 0.65rem; color: var(--text-muted);">${esc(info.provider)}${badgeLabel ? ` • ${esc(badgeLabel.trim())}` : ''}</span>
            </div>
            <span class="badge ${tone}" style="font-size:0.6rem; padding: 0.15rem 0.3rem;">${info.connected === false ? 'offline' : 'online'}</span>
          </div>
        `;
      }).join('');
      profilesEl.innerHTML = buttons || '<span class="text-muted" style="font-size:0.78rem;">No configured providers yet.</span>';
      profilesEl.querySelectorAll('[data-provider-profile]').forEach((btn) => {
        btn.addEventListener('click', () => {
          // Deselect the other side explicitly via DOM state
          const otherSide = isLocal ? 'external' : 'local';
          configUiState.selectedProviderProfiles[otherSide] = null;
          const otherPrefix = isLocal ? 'cfg-ext' : 'cfg-local';
          const otherProfilesEl = section.querySelector(`#${otherPrefix}-profiles`);
          if (otherProfilesEl) {
            otherProfilesEl.querySelectorAll('[data-provider-profile]').forEach(el => {
              el.style.background = 'transparent';
              el.style.border = '1px solid transparent';
              const spans = el.querySelectorAll('span');
              if (spans.length > 0) spans[0].style.fontWeight = '500';
              if (spans.length > 0) spans[0].style.color = 'var(--text-secondary)';
            });
          }

          selectedProfile = btn.getAttribute('data-provider-profile');
          configUiState.selectedProviderProfiles[side] = selectedProfile;
          applyProfile(selectedProfile);
          renderProfiles();
        });
      });
    }

    function applyProfile(name) {
      const placeholder = section.querySelector('#cfg-provider-placeholder');
      const localPanel = section.querySelector('#cfg-local-panel');
      const extPanel = section.querySelector('#cfg-ext-panel');
      const titleEl = isLocal ? localPanel?.querySelector('h3') : extPanel?.querySelector('h3');
      const saveBtnEl = isLocal ? section.querySelector('#cfg-local-save') : section.querySelector('#cfg-ext-save');

      if (placeholder) placeholder.style.display = 'none';
      if (localPanel) localPanel.style.display = isLocal ? 'block' : 'none';
      if (extPanel) extPanel.style.display = isLocal ? 'none' : 'block';

      // Clear selection from other side
      const otherSide = isLocal ? 'external' : 'local';
      configUiState.selectedProviderProfiles[otherSide] = null;
      const otherPrefix = isLocal ? 'cfg-ext' : 'cfg-local';
      const otherProfilesEl = section.querySelector(`#${otherPrefix}-profiles`);
      if (otherProfilesEl) {
        otherProfilesEl.querySelectorAll('[data-provider-profile]').forEach(el => {
          el.style.background = 'transparent';
          el.style.border = '1px solid transparent';
          const spans = el.querySelectorAll('span');
          if (spans.length > 0) spans[0].style.fontWeight = '500';
          if (spans.length > 0) spans[0].style.color = 'var(--text-secondary)';
        });
      }

      if (!name) {
        if (titleEl) titleEl.textContent = isLocal ? 'Add New Local Provider' : 'Add New External Provider';
        if (saveBtnEl) saveBtnEl.textContent = 'Create Provider';
        if (typeEl) typeEl.disabled = false;
        if (nameEl) nameEl.disabled = false;
        const pt = isLocal ? 'ollama' : 'openai';
        if (typeEl) typeEl.value = pt;
        nameEl.value = getSuggestedName(side, pt);
        const defaultModel = getDefaultModel(side, pt);
        updateModelSelector([], null);
        modelInputEl.value = defaultModel;
        urlEl.value = isLocal && pt === 'ollama' ? 'http://127.0.0.1:11434' : '';
        if (keyEl) {
          keyEl.value = '';
          keyEl.placeholder = externalDefaultKeyPlaceholder;
        }
        if (credentialRefEl) {
          credentialRefEl.value = '';
          credentialRefEl.disabled = true;
          if (credentialRefCheckbox) credentialRefCheckbox.checked = false;
        }
        configUiState.selectedProviderProfiles[side] = null;
        activeNoteEl.textContent = isLocal
          ? 'Creating a new local provider. Choose the provider type from the dropdown, then set its name and model.'
          : 'Creating a new external provider. All supported hosted provider families are listed in the Provider Type dropdown.';
        refreshSecretNote(pt);
        void refreshLiveModels({ currentModel: defaultModel });
        return;
      }
      const entry = providerMap[name];
      if (!entry) return;
      if (titleEl) titleEl.textContent = `Edit ${name}`;
      if (saveBtnEl) saveBtnEl.textContent = 'Save Config';
      if (typeEl) typeEl.disabled = true;
      if (nameEl) nameEl.disabled = true;
      nameEl.value = name;
      if (typeEl) typeEl.value = entry.provider || '';
      updateModelSelector(entry.availableModels, entry.model || '');
      if (!entry.availableModels?.length) modelInputEl.value = entry.model || '';
      urlEl.value = entry.baseUrl || '';
      if (keyEl) {
        keyEl.value = '';
        keyEl.placeholder = getSecretFieldPlaceholder(entry.credentialRef, externalDefaultKeyPlaceholder);
      }
      if (credentialRefEl) {
        const editableRef = getEditableCredentialRef(entry.credentialRef);
        credentialRefEl.value = editableRef;
        if (credentialRefCheckbox) {
          credentialRefCheckbox.checked = !!editableRef;
          credentialRefEl.disabled = !editableRef;
        }
      }
      configUiState.selectedProviderProfiles[side] = name;
      activeNoteEl.textContent = `Editing ${name}. Provider type is shown explicitly in the dropdown; use New ${isLocal ? 'Local' : 'External'} Provider to start a fresh one.`;
      refreshSecretNote(entry.provider || '');
      void refreshLiveModels({ currentModel: entry.model || '' });
    }

    newBtnEl?.addEventListener('click', () => {
      selectedProfile = null;
      configUiState.selectedProviderProfiles[side] = null;
      applyProfile(null);
      renderProfiles();
    });

    typeEl?.addEventListener('change', () => {
      if (!isLocal && isProviderTypeChanged(typeEl.value)) {
        if (credentialRefEl) {
          credentialRefEl.value = '';
          credentialRefEl.disabled = true;
          if (credentialRefCheckbox) credentialRefCheckbox.checked = false;
        }
        if (keyEl) keyEl.value = '';
      }
      if (!selectedProfile) {
        const lastSuggestedName = nameEl.dataset.lastSuggestedName || '';
        if (!nameEl.value.trim() || nameEl.value === lastSuggestedName) {
          nameEl.value = getSuggestedName(side, typeEl.value);
        }
        if (!modelEl.value.trim()) {
          modelEl.value = getDefaultModel(side, typeEl.value);
        }
        nameEl.dataset.lastSuggestedType = typeEl.value;
        nameEl.dataset.lastSuggestedName = nameEl.value;
      }
      refreshSecretNote(typeEl.value);
      void refreshLiveModels({ currentModel: modelEl.value.trim() || getDefaultModel(side, typeEl.value) });
    });

    urlEl.addEventListener('change', () => {
      void refreshLiveModels({ currentModel: modelEl.value.trim() });
    });
    credentialRefEl?.addEventListener('change', () => {
      refreshSecretNote(typeEl?.value);
      void refreshLiveModels({ currentModel: modelEl.value.trim() });
    });
    keyEl?.addEventListener('change', () => {
      refreshSecretNote(typeEl?.value);
      void refreshLiveModels({ currentModel: modelEl.value.trim() });
    });

    section.querySelector(`#${prefix}-test`).addEventListener('click', async () => {
      const providerName = nameEl.value.trim();
      if (!providerName) { statusEl.textContent = 'Set provider name first.'; statusEl.style.color = 'var(--warning)'; return; }
      statusEl.textContent = `Testing ${providerName}...`;
      statusEl.style.color = 'var(--text-muted)';
      try {
        const latest = await api.providersStatus();
        const found = latest.find(p => p.name === providerName);
        if (!found) { statusEl.textContent = `'${providerName}' not in runtime (save first).`; statusEl.style.color = 'var(--warning)'; return; }
        if (found.connected === false) { statusEl.textContent = `${providerName}: disconnected.`; statusEl.style.color = 'var(--error)'; }
        else {
          const count = found.availableModels?.length || 0;
          statusEl.textContent = `${providerName}: connected (${count} model${count === 1 ? '' : 's'}).`;
          statusEl.style.color = 'var(--success)';
          // Refresh model dropdown with live models
          if (found.availableModels?.length) {
            const currentModel = modelSelectEl.style.display !== 'none' ? modelSelectEl.value : modelInputEl.value;
            updateModelSelector(found.availableModels, currentModel);
            if (providerMap[providerName]) providerMap[providerName].availableModels = found.availableModels;
          }
        }
      } catch (err) { statusEl.textContent = `Test failed: ${err instanceof Error ? err.message : String(err)}`; statusEl.style.color = 'var(--error)'; }
    });

    section.querySelector(`#${prefix}-save`).addEventListener('click', async () => {
      const providerName = nameEl.value.trim();
      const model = modelEl.value.trim();
      const baseUrl = urlEl.value.trim();
      const providerType = typeEl?.value.trim().toLowerCase() || (isLocal ? 'ollama' : 'openai');

      if (!providerName) { statusEl.textContent = 'Provider name is required.'; statusEl.style.color = 'var(--error)'; return; }
      if (!providerType) { statusEl.textContent = 'Provider type is required.'; statusEl.style.color = 'var(--error)'; return; }
      if (!isKnownProviderType(side, providerType)) {
        statusEl.textContent = `Unknown ${side} provider type '${providerType}'.`;
        statusEl.style.color = 'var(--error)';
        return;
      }
      if (!model) { statusEl.textContent = 'Model is required.'; statusEl.style.color = 'var(--error)'; return; }
      if (!isLocal && isProviderTypeChanged(providerType) && !keyEl?.value.trim() && !(credentialRefCheckbox?.checked && credentialRefEl?.value.trim())) {
        statusEl.textContent = 'Provider type changed. Paste a new API key or choose an env-backed credential ref before saving.';
        statusEl.style.color = 'var(--error)';
        return;
      }

      const payload = {
        llmMode: isLocal ? 'ollama' : 'external',
        providerName, providerType, model,
        baseUrl: baseUrl || undefined,
        apiKey: keyEl?.value.trim() || undefined,
        credentialRef: credentialRefCheckbox?.checked && credentialRefEl ? credentialRefEl.value.trim() : undefined,
        setupCompleted: true,
      };

      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.applyConfig(payload);
        statusEl.textContent = result.message;
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
        if (result.success) {
          await updateConfig();
        }
      } catch (err) { statusEl.textContent = err instanceof Error ? err.message : String(err); statusEl.style.color = 'var(--error)'; }
    });

    renderProfiles();
    if (selectedProfile) {
      applyProfile(selectedProfile);
    }
  }

  wirePanel('local');
  wirePanel('external');
  applyInputTooltips(section);
  return section;
}

function getProviderTypeCatalog() {
  if (Array.isArray(sharedProviderTypes) && sharedProviderTypes.length > 0) {
    return sharedProviderTypes;
  }
  return FALLBACK_PROVIDER_TYPES;
}

function getCredentialRefRegistry(config = sharedConfig) {
  return config?.assistant?.credentials?.refs || {};
}

function getCredentialRefMeta(refName, config = sharedConfig) {
  if (!refName) return undefined;
  return getCredentialRefRegistry(config)[refName];
}

function getSecretFieldPlaceholder(refName, fallback) {
  const ref = getCredentialRefMeta(refName);
  if (ref?.source === 'local') {
    return 'Configured in secure local storage. Paste to replace.';
  }
  if (ref?.source === 'env') {
    return `Managed by ${ref.env || 'an environment variable'}. Paste to switch to local storage.`;
  }
  return fallback;
}

function getEditableCredentialRef(refName, config = sharedConfig) {
  const ref = getCredentialRefMeta(refName, config);
  return ref?.source === 'env' ? refName : '';
}

function renderCredentialRefOptions(refs, filterFn = null) {
  return Object.keys(refs || {})
    .filter((name) => (typeof filterFn === 'function' ? filterFn(refs[name], name) : true))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<option value="${escAttr(name)}">${esc(name)}</option>`)
    .join('');
}

function createCredentialRefsPanel(settingsPanel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const refs = { ...getCredentialRefRegistry() };
  const allNames = Object.keys(refs).sort((a, b) => a.localeCompare(b));
  const localRefs = allNames.filter((n) => refs[n]?.source === 'local');
  const envRefs = allNames.filter((n) => refs[n]?.source === 'env');

  section.innerHTML = `
    <div class="table-header">
      <h3>Credential Refs</h3>
      <span class="cfg-header-note">Manage how secrets are stored. Most users never need this page &mdash; pasting keys elsewhere handles everything.</span>
    </div>
    <div class="cfg-center-body">

      ${localRefs.length > 0 ? `
      <div style="margin-bottom:1rem;">
        <h4 style="margin:0 0 0.35rem;font-size:0.85rem;">Auto-managed (local secret store)</h4>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:0.5rem;">Created automatically when you paste keys in provider, search, or integration settings. Stored in the encrypted local secret store.</div>
        <table>
          <thead><tr><th>Ref</th><th>Used By</th><th>Description</th><th style="width:4rem;"></th></tr></thead>
          <tbody>
            ${localRefs.map((name) => `
              <tr data-ref="${escAttr(name)}">
                <td><code style="font-size:0.75rem;">${esc(name)}</code></td>
                <td style="font-size:0.8rem;">${esc(describeRefUsage(name, sharedConfig))}</td>
                <td style="font-size:0.8rem;">${esc(refs[name]?.description || '-')}</td>
                <td><button class="btn btn-sm btn-danger cred-ref-delete-btn" data-ref="${escAttr(name)}" title="Delete this ref and its stored secret">Delete</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ` : ''}

      <div style="margin-bottom:0.5rem;">
        <h4 style="margin:0 0 0.35rem;font-size:0.85rem;">Environment-backed refs</h4>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:0.5rem;">Advanced: point a ref at a host environment variable. Use the credential ref checkboxes in provider/integration settings to activate.</div>
        ${envRefs.length > 0 ? `
        <table>
          <thead><tr><th>Ref</th><th>Env Variable</th><th>Description</th><th style="width:4rem;"></th></tr></thead>
          <tbody>
            ${envRefs.map((name) => `
              <tr data-ref="${escAttr(name)}">
                <td><code style="font-size:0.75rem;">${esc(name)}</code></td>
                <td style="font-size:0.8rem;"><code>${esc(refs[name]?.env || '')}</code></td>
                <td style="font-size:0.8rem;">${esc(refs[name]?.description || '-')}</td>
                <td><button class="btn btn-sm btn-danger cred-ref-delete-btn" data-ref="${escAttr(name)}" title="Delete this env ref">Delete</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ` : '<div style="font-size:0.8rem;color:var(--text-muted);margin:0.5rem 0;">No environment-backed refs configured.</div>'}
      </div>

      <div class="cfg-divider"></div>
      <h4 style="margin:0 0 0.35rem;font-size:0.85rem;">Create new environment ref</h4>
      <div class="cfg-form-grid">
        <div class="cfg-field"><label>Ref Name</label><input id="cfg-cred-ref-name" type="text" placeholder="llm.openai.primary"></div>
        <div class="cfg-field"><label>Environment Variable</label><input id="cfg-cred-ref-env" type="text" placeholder="OPENAI_API_KEY"></div>
        <div class="cfg-field"><label>Description (optional)</label><input id="cfg-cred-ref-description" type="text" placeholder="Primary OpenAI key for hosted fallback"></div>
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="cfg-cred-ref-save" type="button">Create Env Ref</button>
        <span id="cfg-cred-ref-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const nameEl = section.querySelector('#cfg-cred-ref-name');
  const envEl = section.querySelector('#cfg-cred-ref-env');
  const descriptionEl = section.querySelector('#cfg-cred-ref-description');
  const statusEl = section.querySelector('#cfg-cred-ref-status');

  // Delete buttons (inline per-row)
  section.querySelectorAll('.cred-ref-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const refName = btn.dataset.ref;
      if (!refName) return;
      const nextRefs = { ...(sharedConfig?.assistant?.credentials?.refs || {}) };
      delete nextRefs[refName];
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const result = await api.updateConfig({
          assistant: { credentials: { refs: nextRefs } },
        });
        if (result.success) {
          const row = btn.closest('tr');
          if (row) row.remove();
        } else {
          statusEl.textContent = result.message;
          statusEl.style.color = 'var(--warning)';
          btn.disabled = false;
          btn.textContent = 'Delete';
        }
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    });
  });

  // Create new env ref
  section.querySelector('#cfg-cred-ref-save')?.addEventListener('click', async () => {
    const refName = nameEl.value.trim();
    const env = envEl.value.trim();
    const description = descriptionEl.value.trim();
    if (!refName || !env) {
      statusEl.textContent = 'Ref name and environment variable are required.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    const nextRefs = {
      ...(sharedConfig?.assistant?.credentials?.refs || {}),
      [refName]: {
        source: 'env',
        env,
        description: description || undefined,
      },
    };

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConfig({
        assistant: { credentials: { refs: nextRefs } },
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success) {
        await updateConfig();
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  applyInputTooltips(section);
  return section;
}

/** Describe what a credential ref is used by, based on current config. */
function describeRefUsage(refName, config) {
  const usages = [];
  for (const [name, llm] of Object.entries(config?.llm || {})) {
    if (llm?.credentialRef === refName) usages.push(`Provider: ${name}`);
  }
  if (config?.channels?.telegram?.botTokenCredentialRef === refName) usages.push('Telegram bot token');
  const ws = config?.assistant?.tools?.webSearch || {};
  if (ws.braveCredentialRef === refName) usages.push('Brave search');
  if (ws.perplexityCredentialRef === refName) usages.push('Perplexity search');
  if (ws.openRouterCredentialRef === refName) usages.push('OpenRouter search');
  return usages.length > 0 ? usages.join(', ') : 'Unused';
}

function createProviderStatusTable(config, providers, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const preferredProviders = config?.assistant?.tools?.preferredProviders || {};
  const providerEntries = Object.entries(config.llm || {});
  const rows = providerEntries.map(([name, cfg]) => {
    const live = providers.find(p => p.name === name);
    const connected = live ? (live.connected !== false) : true;
    const locality = live?.locality || (cfg.provider === 'ollama' ? 'local' : 'external');
    const statusBadge = '<span class="badge ' + (connected ? 'badge-idle' : 'badge-errored') + '">' + (connected ? 'Connected' : 'Disconnected') + '</span>';
    const modelList = live?.availableModels?.slice(0, 5).join(', ') || '-';
    const isDefault = name === config.defaultProvider;
    const isLocalDefault = locality === 'local' && preferredProviders.local === name;
    const isExternalDefault = locality === 'external' && preferredProviders.external === name;
    const defaultBadges = [
      isDefault ? ' <span class="badge badge-idle">global default</span>' : '',
      isLocalDefault ? ' <span class="badge badge-running">local default</span>' : '',
      isExternalDefault ? ' <span class="badge badge-running">external default</span>' : '',
    ].join('');
    const globalActionBtn = isDefault
      ? '<span class="text-muted" style="font-size:0.75rem" title="Global default provider used for the main default chat path and fallback ordering. This is separate from the preferred local or external routed provider.">Current default</span>'
      : '<button class="btn btn-sm set-default-provider-btn" data-provider="' + esc(name) + '" title="Set the global default provider used for the main default chat path and fallback ordering. This does not change the preferred local or external routed provider.">Set as Default</button>';
    const localityLabel = locality === 'local' ? 'Local' : 'External';
    const preferredActionBtn = (locality === 'local' ? isLocalDefault : isExternalDefault)
      ? '<span class="text-muted" style="font-size:0.75rem" title="' + escAttr(locality === 'local'
        ? 'Preferred provider when Guardian routes work to the local tier. This does not change the global default provider.'
        : 'Preferred provider when Guardian routes work to the external tier. This does not change the global default provider.') + '">Current ' + localityLabel.toLowerCase() + ' default</span>'
      : '<button class="btn btn-sm set-preferred-provider-btn" data-provider="' + esc(name) + '" data-locality="' + esc(locality) + '" title="' + escAttr(locality === 'local'
        ? 'Set the preferred provider used when Guardian routes work to the local tier. This does not change the global default provider.'
        : 'Set the preferred provider used when Guardian routes work to the external tier. This does not change the global default provider.') + '">Set as ' + localityLabel + ' Default</button>';
    return '<tr><td><strong>' + esc(name) + '</strong>' + defaultBadges + '</td><td>' + esc(cfg.provider) + '</td><td>' + esc(cfg.model) + '</td><td>' + esc(locality) + '</td><td>' + statusBadge + '</td><td>' + esc(modelList) + '</td><td style="display:flex;gap:0.5rem;flex-wrap:wrap;">' + globalActionBtn + preferredActionBtn + '</td></tr>';
  }).join('');

  section.innerHTML = `
    <div class="table-header"><h3>Configured Providers</h3></div>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Locality</th><th>Status</th><th>Available Models</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">No providers configured</td></tr>'}</tbody>
    </table>
  `;

  section.querySelectorAll('.set-default-provider-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const providerName = btn.dataset.provider;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const result = await api.setDefaultProvider(providerName);
        if (result.success) {
          sharedConfig.defaultProvider = providerName;
          if (panel) renderProvidersTab(panel);
        } else {
          alert('Failed to set default provider: ' + (result.message || 'Unknown error'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
      btn.disabled = false;
    });
  });

  section.querySelectorAll('.set-preferred-provider-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const providerName = btn.dataset.provider;
      const locality = btn.dataset.locality;
      if (!providerName || (locality !== 'local' && locality !== 'external')) return;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const result = await api.updateConfig({
          assistant: {
            tools: {
              preferredProviders: {
                ...(sharedConfig?.assistant?.tools?.preferredProviders || {}),
                [locality]: providerName,
              },
            },
          },
        });
        if (result.success) {
          sharedConfig.assistant = sharedConfig.assistant || {};
          sharedConfig.assistant.tools = sharedConfig.assistant.tools || {};
          sharedConfig.assistant.tools.preferredProviders = {
            ...(sharedConfig.assistant.tools.preferredProviders || {}),
            [locality]: providerName,
          };
          if (panel) renderProvidersTab(panel);
        } else {
          alert('Failed to set ' + locality + ' default provider: ' + (result.message || 'Unknown error'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
      btn.disabled = false;
    });
  });

  return section;
}

// ─── Tools Tab ───────────────────────────────────────────

async function renderToolsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [state] = await Promise.all([
      api.toolsState(80),
    ]);
    const tools = state.tools || [];
    const approvals = state.approvals || [];
    const jobs = state.jobs || [];
    const categories = state.categories || [];
    const notices = state.notices || [];
    const sandbox = state.sandbox || null;
    const routing = state.providerRouting || {};
    const defaultLocality = state.defaultProviderLocality || 'local';
    const categoryDefaults = state.categoryDefaults || {};
    // Effective routing: user tool-level > user category-level > computed category default > default provider locality
    const effectiveRoute = (key, category) => {
      if (routing[key]) return routing[key];
      if (category && routing[category]) return routing[category];
      if (category && categoryDefaults[category]) return categoryDefaults[category];
      return defaultLocality;
    };
    // For category rows, the effective default is the computed category default
    const effectiveCategoryRoute = (category) => {
      if (routing[category]) return routing[category];
      if (categoryDefaults[category]) return categoryDefaults[category];
      return defaultLocality;
    };

    panel.innerHTML = `
      <div class="intel-summary-grid">
        <div class="status-card ${state.enabled ? 'success' : 'error'}">
          <div class="card-title">Tool Runtime</div>
          <div class="card-value">${state.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Assistant + manual task execution</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Catalog</div>
          <div class="card-value">${tools.length}</div>
          <div class="card-subtitle">Available tools</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Pending Tool Approvals</div>
          <div class="card-value">${approvals.filter(a => a.status === 'pending').length}</div>
          <div class="card-subtitle">Global queue across channels</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Recent Jobs</div>
          <div class="card-value">${jobs.length}</div>
          <div class="card-subtitle">Execution history</div>
        </div>
        <div class="status-card ${sandbox?.enforcementMode === 'strict' ? 'success' : 'warning'}">
          <div class="card-title">Sandbox Mode</div>
          <div class="card-value">${esc((sandbox?.enforcementMode || 'unknown').toUpperCase())}</div>
          <div class="card-subtitle">${esc(sandbox ? `${sandbox.availability} on ${sandbox.platform}` : 'No sandbox status available')}</div>
        </div>
      </div>

      ${sandbox ? `
      <div class="table-container">
        <div class="table-header"><h3>Sandbox Status</h3></div>
        <div style="padding:0.9rem 1rem;display:grid;gap:0.5rem;">
          <div style="font-size:0.85rem;color:var(--text-secondary);">
            Backend: <strong>${esc(sandbox.backend)}</strong> |
            Availability: <strong>${esc(sandbox.availability)}</strong> |
            Enforcement: <strong>${esc(sandbox.enforcementMode)}</strong>
          </div>
          ${Array.isArray(sandbox.reasons) && sandbox.reasons.length > 0 ? `
            <div style="font-size:0.78rem;color:var(--text-muted);">${sandbox.reasons.map(reason => esc(reason)).join(' ')}</div>
          ` : ''}
          ${sandbox.enforcementMode === 'strict' && sandbox.availability !== 'strong' ? `
            <div style="font-size:0.78rem;color:var(--warning);margin-top:0.25rem;">
              Strict mode is active but native sandboxing is unavailable — some tools (shell, browser, network) are disabled.
              To allow these tools, go to <strong>Tools &amp; Policy</strong> and set Sandbox Mode to <strong>Permissive</strong>.
            </div>
          ` : ''}
        </div>
      </div>
      ` : ''}

      ${notices.length > 0 ? `
      <div class="table-container">
        <div class="table-header"><h3>Runtime Notices</h3></div>
        <div style="padding:0.9rem 1rem;display:grid;gap:0.75rem;">
          ${notices.map(notice => `
            <div class="cfg-check-item ${notice.level === 'warn' ? 'warning' : 'complete'}">
              <div class="cfg-check-head">
                <span class="cfg-check-title">${notice.level === 'warn' ? 'Warning' : 'Notice'}</span>
                <span class="badge ${notice.level === 'warn' ? 'badge-queued' : 'badge-running'}">${esc(notice.level.toUpperCase())}</span>
              </div>
              <div class="cfg-check-detail">${esc(notice.message)}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <div class="table-container">
        <div class="table-header"><h3>Execution Mode</h3></div>
        <div style="padding:0.75rem 1rem;display:flex;flex-direction:column;gap:0.5rem;">
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <label style="font-size:0.75rem;color:var(--text-secondary);display:flex;align-items:center;gap:0.5rem;">
              <input type="checkbox" id="dry-run-toggle" ${state.dryRunDefault ? 'checked' : ''}>
              Dry Run Mode
            </label>
            <span style="font-size:0.72rem;color:var(--text-muted);">When enabled, mutating tools validate but do not execute side effects.</span>
          </div>
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <label style="font-size:0.75rem;color:var(--text-secondary);display:flex;align-items:center;gap:0.5rem;">
              <input type="checkbox" id="provider-routing-toggle" ${state.providerRoutingEnabled !== false ? 'checked' : ''}>
              Smart LLM Routing
            </label>
            <span style="font-size:0.72rem;color:var(--text-muted);" title="When enabled, tools are automatically routed between local and external LLM providers based on the task type. External operations (web, email, workspace) use the external model for better quality synthesis, while local operations (filesystem, shell, network) use the local model for speed. Disable to force all tools through your default provider only.">Automatically route tool results between local and external models based on task type. <span style="cursor:help;text-decoration:underline dotted;">(?)</span></span>
          </div>
        </div>
      </div>

      ${categories.length > 0 ? '<div class="table-container"><div class="table-header"><h3>Tool Categories</h3></div><table><thead><tr><th>Category</th><th>Label</th><th>Tools</th><th>Status</th><th>LLM</th><th>Description</th></tr></thead><tbody>' + categories.map(cat => { const cv = effectiveCategoryRoute(cat.category); return '<tr><td>' + esc(cat.category) + '</td><td>' + esc(cat.label) + '</td><td>' + cat.toolCount + '</td><td><label class="toggle-switch" style="margin:0;"><input type="checkbox" class="category-toggle" data-category="' + escAttr(cat.category) + '"' + (cat.enabled ? ' checked' : '') + '><span class="toggle-slider"></span></label></td><td><select class="provider-route-select" data-route-key="' + escAttr(cat.category) + '" data-route-scope="category"><option value="local"' + (cv === 'local' ? ' selected' : '') + '>Local</option><option value="external"' + (cv === 'external' ? ' selected' : '') + '>External</option></select></td><td style="font-size:0.72rem;">' + esc(cat.description) + '</td></tr>'; }).join('') + '</tbody></table></div>' : ''}

      <div class="table-container">
        <div class="table-header">
          <h3>Tool Catalog</h3>
          <button class="btn btn-secondary" id="tools-refresh" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Refresh</button>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Risk</th><th>LLM</th><th>Description</th></tr></thead>
          <tbody>
            ${tools.length === 0
              ? '<tr><td colspan="4">No tools registered.</td></tr>'
              : tools.map(tool => { const tv = effectiveRoute(tool.name, tool.category); return '<tr><td>' + esc(tool.name) + '</td><td><span class="badge ' + riskClass(tool.risk) + '">' + esc(tool.risk) + '</span></td><td><select class="provider-route-select" data-route-key="' + escAttr(tool.name) + '" data-route-scope="tool" data-tool-category="' + escAttr(tool.category || '') + '"><option value="local"' + (tv === 'local' ? ' selected' : '') + '>Local</option><option value="external"' + (tv === 'external' ? ' selected' : '') + '>External</option></select></td><td>' + esc(tool.description) + '</td></tr>'; }).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Pending Approvals</h3></div>
        <table>
          <thead><tr><th>Approval</th><th>Tool</th><th>Risk</th><th>Origin</th><th>Created</th><th>Decision</th></tr></thead>
          <tbody>
            ${approvals.length === 0
              ? '<tr><td colspan="6">No approvals.</td></tr>'
              : approvals.map(approval => `
                <tr>
                  <td title="${esc(approval.id)}">${esc(shortId(approval.id))}</td>
                  <td>${esc(approval.toolName)}</td>
                  <td>${esc(approval.risk)}</td>
                  <td>${esc(approval.origin)}</td>
                  <td>${esc(formatDate(approval.createdAt))}</td>
                  <td>
                    ${approval.status === 'pending' ? `
                      <button class="btn btn-secondary tool-approve" data-approval-id="${escAttr(approval.id)}" data-decision="approved">Approve</button>
                      <button class="btn btn-secondary tool-approve" data-approval-id="${escAttr(approval.id)}" data-decision="denied">Deny</button>
                    ` : `<span class="badge ${approval.status === 'approved' ? 'badge-running' : 'badge-errored'}">${esc(approval.status)}</span>`}
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Tool Jobs</h3></div>
        <table>
          <thead><tr><th>Job</th><th>Tool</th><th>Status</th><th>Origin</th><th>Created</th><th>Duration</th><th>Detail</th></tr></thead>
          <tbody>
            ${jobs.length === 0
              ? '<tr><td colspan="7">No tool jobs yet.</td></tr>'
              : jobs.map(job => `
                <tr>
                  <td title="${esc(job.id)}">${esc(shortId(job.id))}</td>
                  <td>${esc(job.toolName)}</td>
                  <td><span class="badge ${statusClass(job.status)}">${esc(job.status)}</span></td>
                  <td>${esc(job.origin)}</td>
                  <td>${esc(formatDate(job.createdAt))}</td>
                  <td>${job.durationMs ? `${job.durationMs}ms` : '-'}</td>
                  <td>${esc(job.error || job.resultPreview || job.argsPreview || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;

    panel.querySelector('#tools-refresh')?.addEventListener('click', () => renderToolsTab(panel));

    // Smart LLM Routing toggle
    const routingToggle = panel.querySelector('#provider-routing-toggle');
    if (routingToggle) {
      routingToggle.addEventListener('change', async () => {
        const enabled = routingToggle.checked;
        try {
          const result = await api.updateToolProviderRouting({ enabled });
          if (!result.success) {
            alert(result.message || 'Failed to update routing.');
            routingToggle.checked = !enabled;
          } else {
            // Disable/enable the per-category and per-tool dropdowns
            panel.querySelectorAll('.provider-route-select').forEach(sel => { sel.disabled = !enabled; });
          }
        } catch (err) {
          alert(err.message || 'Failed to update routing.');
          routingToggle.checked = !enabled;
        }
      });
      // Set initial disabled state on dropdowns if routing is off
      if (!routingToggle.checked) {
        panel.querySelectorAll('.provider-route-select').forEach(sel => { sel.disabled = true; });
      }
    }

    panel.querySelectorAll('.category-toggle').forEach(toggle => {
      toggle.addEventListener('change', async () => {
        const category = toggle.getAttribute('data-category');
        const enabled = toggle.checked;
        if (!category) return;
        try {
          const result = await api.toggleToolCategory({ category, enabled });
          if (!result.success) { alert(result.message || 'Failed to toggle category.'); toggle.checked = !enabled; }
          else await renderToolsTab(panel);
        } catch (err) { alert(err.message || 'Failed to toggle category.'); toggle.checked = !enabled; }
      });
    });

    panel.querySelectorAll('.provider-route-select').forEach(select => {
      select.addEventListener('change', async () => {
        const key = select.getAttribute('data-route-key');
        const scope = select.getAttribute('data-route-scope');
        const value = select.value;
        if (!key) return;

        // If category changed, cascade to all tool selects in that category
        if (scope === 'category') {
          panel.querySelectorAll('.provider-route-select[data-route-scope="tool"]').forEach(toolSel => {
            if (toolSel.getAttribute('data-tool-category') === key) {
              toolSel.value = value;
            }
          });
        }

        // Build the full routing map from current UI state.
        // Only persist entries that differ from the computed default for that key.
        const updated = {};
        panel.querySelectorAll('.provider-route-select').forEach(sel => {
          const k = sel.getAttribute('data-route-key');
          const v = sel.value;
          if (!k) return;
          const scope = sel.getAttribute('data-route-scope');
          // For categories: compare against computed category default
          // For tools: compare against user category override or computed category default
          const cat = scope === 'tool' ? sel.getAttribute('data-tool-category') : k;
          const computedDefault = (cat && categoryDefaults[cat]) || defaultLocality;
          if (scope === 'tool') {
            // Tool-level: only persist if different from the category-level effective route
            const catOverride = routing[cat] || computedDefault;
            if (v !== catOverride) { updated[k] = v; }
          } else {
            // Category-level: only persist if different from computed default
            if (v !== computedDefault) { updated[k] = v; }
          }
        });
        try {
          const result = await api.updateToolProviderRouting({ routing: updated });
          if (!result.success) { alert(result.message || 'Failed to update routing.'); }
          // Update local routing ref so subsequent changes see correct state
          Object.keys(routing).forEach(k => delete routing[k]);
          Object.assign(routing, updated);
        } catch (err) { alert(err.message || 'Failed to update routing.'); }
      });
    });

    panel.querySelectorAll('.tool-approve').forEach(button => {
      button.addEventListener('click', async () => {
        const approvalId = button.getAttribute('data-approval-id');
        const decision = button.getAttribute('data-decision');
        if (!approvalId || !decision) return;
        try {
          const result = await api.decideToolApproval({ approvalId, decision, actor: 'web-user' });
          if (!result.success) alert(result.message || 'Failed to update approval.');
          await renderToolsTab(panel);
        } catch (err) { alert(err.message || 'Failed to update approval.'); }
      });
    });

    applyInputTooltips(panel);
    enhanceSectionHelp(panel, CONFIG_HELP.toolsPolicy, createGenericHelpFactory('Configuration Tools & Policy'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message || String(err))}</div>`;
  }
}

// ─── Policy Tab (Interactive Allowlist Editor) ───────────

async function renderPolicyTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const state = await api.toolsState(1);
    const policy = state.policy || { mode: 'approve_by_policy', sandbox: { allowedPaths: [], allowedCommands: [], allowedDomains: [] } };

    const categories = [
      { key: 'allowedPaths', label: 'Allowed Paths', icon: 'folder', placeholder: 'e.g. /home/user/data', hint: 'Filesystem paths the sandbox can access' },
      { key: 'allowedCommands', label: 'Allowed Commands', icon: 'terminal', placeholder: 'e.g. ls, cat, ping', hint: 'Shell commands the sandbox can execute' },
      { key: 'allowedDomains', label: 'Allowed Domains', icon: 'globe', placeholder: 'e.g. api.github.com', hint: 'Network domains the sandbox can reach' },
    ];

    const iconSvgs = {
      folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
      terminal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
    };

    const modeLabels = {
      approve_all: { label: 'Approve All', desc: 'Every tool call requires manual approval', tone: 'warning' },
      approve_by_policy: { label: 'Policy-Based', desc: 'Allowlisted items auto-approve; others require confirmation', tone: 'info' },
      auto_approve: { label: 'Auto Approve', desc: 'All tool calls execute without approval', tone: 'error' },
    };

    function render() {
      const modeInfo = modeLabels[policy.mode] || { label: policy.mode, desc: '', tone: 'info' };
      const totalItems = categories.reduce((sum, c) => sum + (policy.sandbox?.[c.key]?.length || 0), 0);

      panel.innerHTML = `
        <div class="policy-overview">
          <div class="status-card ${modeInfo.tone}">
            <div class="card-title">Execution Mode</div>
            <div class="card-value">${esc(modeInfo.label)}</div>
            <div class="card-subtitle">${esc(modeInfo.desc)}</div>
          </div>
          <div class="status-card accent">
            <div class="card-title">Allowlist Entries</div>
            <div class="card-value">${totalItems}</div>
            <div class="card-subtitle">${categories.map(c => `${policy.sandbox?.[c.key]?.length || 0} ${c.label.toLowerCase().replace('allowed ', '')}`).join(', ')}</div>
          </div>
        </div>

        <div class="policy-columns">
          ${categories.map(cat => {
            const items = policy.sandbox?.[cat.key] || [];
            return `
              <div class="table-container policy-category-card" data-category="${cat.key}">
                <div class="table-header">
                  <h3>${iconSvgs[cat.icon]} ${esc(cat.label)}</h3>
                  <span class="badge badge-idle">${items.length}</span>
                </div>
                <div class="cfg-center-body">
                  <p class="policy-hint">${esc(cat.hint)}</p>
                  <div class="policy-add-row">
                    <input type="text" class="policy-add-input" data-category="${cat.key}" placeholder="${esc(cat.placeholder)}">
                    <button class="btn btn-primary btn-sm policy-add-btn" data-category="${cat.key}">Add</button>
                  </div>
                  <div class="policy-item-list" data-category="${cat.key}">
                    ${items.length === 0
                      ? '<div class="policy-empty">No entries yet</div>'
                      : items.map(item => `
                        <div class="policy-item" data-category="${cat.key}" data-item="${escAttr(item)}">
                          <code>${esc(item)}</code>
                          <button class="policy-item-remove" data-category="${cat.key}" data-item="${escAttr(item)}" title="Remove ${esc(item)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </div>
                      `).join('')}
                  </div>
                  <div class="policy-feedback" data-category="${cat.key}"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;

      // Wire add buttons and Enter key
      panel.querySelectorAll('.policy-add-btn').forEach(btn => {
        btn.addEventListener('click', () => addItem(btn.dataset.category));
      });
      panel.querySelectorAll('.policy-add-input').forEach(input => {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(input.dataset.category); });
      });

      // Wire remove buttons
      panel.querySelectorAll('.policy-item-remove').forEach(btn => {
        btn.addEventListener('click', () => removeItem(btn.dataset.category, btn.dataset.item));
      });

      applyInputTooltips(panel);
      enhanceSectionHelp(panel, CONFIG_HELP.toolsPolicy, createGenericHelpFactory('Configuration Policy'));
      activateContextHelp(panel);
    }

    function feedback(catKey, message, tone = 'muted') {
      const el = panel.querySelector(`.policy-feedback[data-category="${catKey}"]`);
      if (!el) return;
      el.textContent = message;
      el.style.color = tone === 'error' ? 'var(--error)' : tone === 'success' ? 'var(--success)' : tone === 'warning' ? 'var(--warning)' : 'var(--text-muted)';
      if (tone === 'success') setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, 2000);
    }

    async function addItem(catKey) {
      const input = panel.querySelector(`.policy-add-input[data-category="${catKey}"]`);
      if (!input) return;
      // Support comma-separated bulk add
      const values = input.value.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;

      const current = policy.sandbox?.[catKey] || [];
      const dupes = values.filter(v => current.includes(v));
      const newValues = values.filter(v => !current.includes(v));

      if (newValues.length === 0) {
        feedback(catKey, dupes.length === 1 ? `"${dupes[0]}" already exists.` : 'All items already exist.', 'warning');
        return;
      }

      const updated = [...current, ...newValues];
      feedback(catKey, 'Saving...', 'muted');
      try {
        const result = await api.updateToolPolicy({ sandbox: { [catKey]: updated } });
        if (result.success !== false) {
          if (!policy.sandbox) policy.sandbox = {};
          policy.sandbox[catKey] = updated;
          const added = newValues.length === 1 ? `Added "${newValues[0]}"` : `Added ${newValues.length} items`;
          const dupeNote = dupes.length > 0 ? ` (${dupes.length} duplicate${dupes.length > 1 ? 's' : ''} skipped)` : '';
          render();
          feedback(catKey, added + dupeNote, 'success');
        } else {
          feedback(catKey, result.message || 'Failed to save.', 'error');
        }
      } catch (err) {
        feedback(catKey, err instanceof Error ? err.message : String(err), 'error');
      }
    }

    async function removeItem(catKey, item) {
      const current = policy.sandbox?.[catKey] || [];
      const updated = current.filter(i => i !== item);

      // Optimistic UI: immediately fade the item
      const itemEl = panel.querySelector(`.policy-item[data-category="${catKey}"][data-item="${CSS.escape(item)}"]`);
      if (itemEl) itemEl.style.opacity = '0.4';

      try {
        const result = await api.updateToolPolicy({ sandbox: { [catKey]: updated } });
        if (result.success !== false) {
          policy.sandbox[catKey] = updated;
          render();
          feedback(catKey, `Removed "${item}"`, 'success');
        } else {
          if (itemEl) itemEl.style.opacity = '1';
          feedback(catKey, result.message || 'Failed to remove.', 'error');
        }
      } catch (err) {
        if (itemEl) itemEl.style.opacity = '1';
        feedback(catKey, err instanceof Error ? err.message : String(err), 'error');
      }
    }

    render();
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message || String(err))}</div>`;
  }
}

// ─── Search Sources Tab ──────────────────────────────────

function renderSearchSourcesTab(panel) {
  const searchCfg = sharedConfig?.assistant?.tools?.search || {};
  const state = {
    enabled: searchCfg.enabled !== false,
    runtimeAvailable: searchCfg.enabled !== false,
    status: null,
    sources: Array.isArray(searchCfg.sources) ? [...searchCfg.sources] : [],
    filter: '',
  };

  panel.innerHTML = `
    <div class="intel-summary-grid search-summary-grid" id="search-summary-grid"></div>
    <div class="search-feedback search-feedback-muted" id="search-feedback"></div>

    <div class="table-container">
      <div class="table-header">
        <h3>Document Sources</h3>
        <div class="search-toolbar-actions">
          <button class="btn btn-secondary btn-sm" id="search-config-toggle" type="button">${state.enabled ? 'Disable Search' : 'Enable Search'}</button>
          <button class="btn btn-secondary btn-sm" id="search-refresh" type="button">Refresh</button>
          <button class="btn btn-secondary btn-sm" id="search-reindex-all" type="button" ${state.enabled ? '' : 'disabled'}>Reindex All</button>
          <button class="btn btn-primary btn-sm" id="search-add-source" type="button" aria-expanded="false">+ Add Source</button>
        </div>
      </div>
      <div class="cfg-center-body">
        <div class="search-filter-row">
          <div class="search-filter-field">
            <label for="search-source-filter">Filter Sources</label>
            <input id="search-source-filter" type="text" placeholder="Filter by id, name, path, or type">
          </div>
          <div class="search-hint">
            ${state.enabled
    ? 'Add, enable, disable, reindex, and remove document sources from one place.'
    : 'Document Search is disabled in config. Enable it here, then restart to activate runtime source management.'}
          </div>
        </div>
      </div>
    </div>

    <div class="table-container search-add-form-wrap" id="search-add-form-wrap" hidden>
      <div class="table-header"><h3>Add Source</h3></div>
      <div class="cfg-center-body">
        <form id="search-add-form" class="search-add-form-grid">
          <div class="cfg-field"><label>ID (collection)</label><input name="id" required placeholder="my-notes"></div>
          <div class="cfg-field"><label>Display Name</label><input name="name" required placeholder="My Notes"></div>
          <div class="cfg-field">
            <label>Type</label>
            <select name="type">
              <option value="directory">Directory</option>
              <option value="git">Git Repository</option>
              <option value="url">URL</option>
              <option value="file">Single File</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Path / URL</label>
            <div class="search-path-row">
              <input name="path" required placeholder="S:\\Development or https://...">
              <button class="btn btn-secondary btn-sm" type="button" id="search-path-browse" hidden>Browse...</button>
            </div>
            <div class="search-muted" id="search-path-picker-note" hidden>Opens the local Windows path picker on this machine.</div>
          </div>
          <div class="cfg-field" data-search-field="globs">
            <label>Globs</label>
            <input name="globs" placeholder="**/*.md, **/*.txt">
          </div>
          <div class="cfg-field" data-search-field="branch">
            <label>Git Branch</label>
            <input name="branch" placeholder="main">
          </div>
          <div class="cfg-field search-form-span-2">
            <label>Description</label>
            <input name="description" placeholder="Optional description">
          </div>
          <div class="cfg-actions search-form-span-2">
            <button class="btn btn-primary" type="submit">Add Source</button>
            <button class="btn btn-secondary" type="button" id="search-add-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <div class="table-container">
      <div class="table-header">
        <h3>Configured Sources</h3>
        <span class="cfg-header-note" id="search-source-count">0 sources</span>
      </div>
      <div class="cfg-center-body search-sources-wrap" id="search-sources-area">
        <div class="loading">Loading...</div>
      </div>
    </div>
  `;

  const feedbackEl = panel.querySelector('#search-feedback');
  const summaryEl = panel.querySelector('#search-summary-grid');
  const configToggleBtn = panel.querySelector('#search-config-toggle');
  const addBtn = panel.querySelector('#search-add-source');
  const addWrap = panel.querySelector('#search-add-form-wrap');
  const addForm = panel.querySelector('#search-add-form');
  const addCancelBtn = panel.querySelector('#search-add-cancel');
  const pathInput = addForm.querySelector('input[name="path"]');
  const pathBrowseBtn = addForm.querySelector('#search-path-browse');
  const pathPickerNote = addForm.querySelector('#search-path-picker-note');
  const refreshBtn = panel.querySelector('#search-refresh');
  const reindexAllBtn = panel.querySelector('#search-reindex-all');
  const filterInput = panel.querySelector('#search-source-filter');
  const sourcesArea = panel.querySelector('#search-sources-area');
  const sourceCountEl = panel.querySelector('#search-source-count');

  const typeLabels = {
    directory: 'Directory',
    git: 'Git Repo',
    url: 'URL',
    file: 'File',
  };

  function setFeedback(message, tone = 'muted') {
    feedbackEl.className = `search-feedback search-feedback-${tone}`;
    feedbackEl.textContent = message;
  }

  function canManageSources() {
    return state.enabled && state.runtimeAvailable;
  }

  function isUnavailableError(err) {
    const message = err instanceof Error ? err.message : String(err || '');
    return /404|not found|not available/i.test(message);
  }

  function updateManageControls() {
    const canManage = canManageSources();
    addBtn.disabled = !state.enabled;
    addBtn.classList.toggle('btn-primary', state.enabled);
    addBtn.classList.toggle('btn-secondary', !state.enabled);
    addBtn.title = state.enabled
      ? 'Add a new document source'
      : 'Enable Document Search in config first.';
    reindexAllBtn.disabled = !canManage;
    filterInput.disabled = false;
    configToggleBtn.textContent = state.enabled ? 'Disable Search' : 'Enable Search';
    if (state.enabled) {
      configToggleBtn.classList.remove('btn-primary');
      configToggleBtn.classList.add('btn-secondary');
    } else {
      configToggleBtn.classList.remove('btn-secondary');
      configToggleBtn.classList.add('btn-primary');
    }
  }

  function renderSummary() {
    const installed = state.enabled
      ? (state.status?.installed === true ? 'Yes' : state.status?.installed === false ? 'No' : 'Unknown')
      : 'Disabled';
    const installedTone = state.enabled
      ? (state.status?.installed === true ? 'success' : state.status?.installed === false ? 'error' : 'warning')
      : 'warning';
    const collections = Array.isArray(state.status?.collections) ? state.status.collections.length : 0;
    const sourceCount = state.sources.length;
    const enabledCount = state.sources.filter((source) => source.enabled !== false).length;
    const versionValue = state.status?.version ? esc(state.status.version) : 'n/a';

    summaryEl.innerHTML = `
      <div class="status-card ${installedTone}">
        <div class="card-title">Search Active</div>
        <div class="card-value">${esc(installed)}</div>
        <div class="card-subtitle">${state.enabled ? 'Runtime availability' : 'Service is not active in current config'}</div>
      </div>
      <div class="status-card info">
        <div class="card-title">Search Version</div>
        <div class="card-value">${versionValue}</div>
        <div class="card-subtitle">Reported by runtime status</div>
      </div>
      <div class="status-card accent">
        <div class="card-title">Collections</div>
        <div class="card-value">${collections}</div>
        <div class="card-subtitle">Known in search index</div>
      </div>
      <div class="status-card warning">
        <div class="card-title">Configured Sources</div>
        <div class="card-value">${sourceCount}</div>
        <div class="card-subtitle">${enabledCount} enabled</div>
      </div>
    `;
  }

  function toggleAddForm(show) {
    addWrap.hidden = !show;
    addBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      addForm.querySelector('input[name="id"]')?.focus();
    }
  }

  function syncAddFormFields() {
    const type = addForm.querySelector('select[name="type"]')?.value || 'directory';
    const globsField = addForm.querySelector('[data-search-field="globs"]');
    const branchField = addForm.querySelector('[data-search-field="branch"]');
    const showGlobs = type === 'directory' || type === 'git';
    const showBranch = type === 'git';
    const canBrowsePath = type === 'directory' || type === 'file';
    if (globsField) globsField.hidden = !showGlobs;
    if (branchField) branchField.hidden = !showBranch;
    if (pathBrowseBtn) {
      pathBrowseBtn.hidden = !canBrowsePath;
      pathBrowseBtn.textContent = type === 'file' ? 'Browse File...' : 'Browse Folder...';
    }
    if (pathPickerNote) pathPickerNote.hidden = !canBrowsePath;
    if (pathInput) {
      pathInput.placeholder = type === 'url'
        ? 'https://...'
        : type === 'git'
          ? 'S:\\Development\\repo or https://github.com/org/repo.git'
          : type === 'file'
            ? 'S:\\Development\\notes\\README.md'
            : 'S:\\Development';
    }
  }

  function renderSources() {
    const canManage = canManageSources();
    const normalized = state.filter.trim().toLowerCase();
    const filtered = normalized
      ? state.sources.filter((source) => {
        const haystack = [
          source.id,
          source.name,
          source.path,
          source.type,
          source.description,
        ].map((item) => String(item || '').toLowerCase()).join(' ');
        return haystack.includes(normalized);
      })
      : state.sources;

    sourceCountEl.textContent = `${filtered.length} of ${state.sources.length} source${state.sources.length === 1 ? '' : 's'}`;

    if (state.sources.length === 0) {
      sourcesArea.innerHTML = `
        <div class="search-empty-state">
          <strong>No sources configured.</strong>
          <span>Add a source to start indexing notes, repos, or documents.</span>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      sourcesArea.innerHTML = `
        <div class="search-empty-state">
          <strong>No matching sources.</strong>
          <span>Try a different filter or clear the search input.</span>
        </div>
      `;
      return;
    }

    sourcesArea.innerHTML = `
      <div class="search-table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Type</th><th>Path</th><th>Pattern</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            ${filtered.map((source) => {
    const globs = Array.isArray(source.globs) && source.globs.length > 0
      ? source.globs.map((glob) => `<code>${esc(glob)}</code>`).join(', ')
      : '<span class="search-muted">default</span>';
    const branch = source.branch ? ` <span class="search-muted">(${esc(source.branch)})</span>` : '';
    return `
                <tr>
                  <td>
                    <strong>${esc(source.name)}</strong>
                    <div class="search-muted">${esc(source.id)}${source.description ? ` • ${esc(source.description)}` : ''}</div>
                  </td>
                  <td>${esc(typeLabels[source.type] || source.type)}${branch}</td>
                  <td class="search-path-cell" title="${esc(source.path)}">${esc(source.path)}</td>
                  <td>${globs}</td>
                  <td>
                    <label class="toggle-switch">
                      <input type="checkbox" ${source.enabled !== false ? 'checked' : ''} data-source-id="${escAttr(source.id)}" class="search-toggle" ${canManage ? '' : 'disabled'}>
                      <span class="toggle-slider"></span>
                    </label>
                  </td>
                  <td class="search-actions-cell">
                    <button class="btn btn-secondary btn-sm search-action" data-action="reindex" data-source-id="${escAttr(source.id)}" ${canManage ? '' : 'disabled'}>Reindex</button>
                    <button class="btn btn-danger btn-sm search-action" data-action="remove" data-source-id="${escAttr(source.id)}" ${canManage ? '' : 'disabled'}>Remove</button>
                  </td>
                </tr>
              `;
  }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function refreshStatus() {
    if (!state.enabled) return;
    state.status = await api.searchStatus();
  }

  async function refreshSources() {
    if (!state.enabled) return;
    state.sources = await api.searchSources();
  }

  async function refreshAll(showMessage = false) {
    try {
      if (state.enabled) {
        try {
          await Promise.all([refreshStatus(), refreshSources()]);
          state.runtimeAvailable = !!(state.status?.available || state.status?.installed);
        } catch (err) {
          if (isUnavailableError(err)) {
            state.runtimeAvailable = false;
            state.status = {
              installed: false,
              available: false,
              version: 'native',
              collections: [],
              configuredSources: [],
              vectorSearchAvailable: false,
            };
            state.sources = Array.isArray(sharedConfig?.assistant?.tools?.search?.sources)
              ? [...sharedConfig.assistant.tools.search.sources]
              : [];
          } else {
            throw err;
          }
        }
      }
      renderSummary();
      renderSources();
      updateManageControls();
      if (showMessage) setFeedback('Search sources refreshed.', 'success');
      if (state.enabled && !state.runtimeAvailable) {
        setFeedback('Document Search is enabled in config, but the runtime endpoints are unavailable. You can still save sources to config and they will apply once search is active.', 'warning');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFeedback(`Failed to refresh search sources: ${message}`, 'error');
      renderSummary();
      renderSources();
      updateManageControls();
    }
  }

  configToggleBtn.addEventListener('click', async () => {
    const nextEnabled = !state.enabled;
    configToggleBtn.disabled = true;
    try {
      const result = await api.updateConfig({
        assistant: {
          tools: {
            search: { enabled: nextEnabled },
          },
        },
      });
      if (!result.success) {
        throw new Error(result.message || 'Failed to update Document Search setting.');
      }

      state.enabled = nextEnabled;
      state.runtimeAvailable = nextEnabled ? state.runtimeAvailable : false;
      if (sharedConfig) {
        sharedConfig.assistant = sharedConfig.assistant || {};
        sharedConfig.assistant.tools = sharedConfig.assistant.tools || {};
        sharedConfig.assistant.tools.search = sharedConfig.assistant.tools.search || { sources: [] };
        sharedConfig.assistant.tools.search.enabled = nextEnabled;
      }
      if (!nextEnabled) {
        toggleAddForm(false);
      }
      renderSummary();
      renderSources();
      updateManageControls();
      setFeedback(
        `Document Search ${nextEnabled ? 'enabled' : 'disabled'} and hot-reloaded.`,
        'success',
      );
      if (nextEnabled) {
        void refreshAll();
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      configToggleBtn.disabled = false;
    }
  });

  addBtn.addEventListener('click', () => {
    if (!state.enabled) {
      setFeedback('Document Search is disabled in configuration. Enable it first to manage sources.', 'warning');
      return;
    }
    toggleAddForm(addWrap.hidden);
  });

  addCancelBtn.addEventListener('click', () => {
    addForm.reset();
    syncAddFormFields();
    toggleAddForm(false);
  });

  pathBrowseBtn?.addEventListener('click', async () => {
    const sourceType = addForm.querySelector('select[name="type"]')?.value || 'directory';
    const kind = sourceType === 'file' ? 'file' : 'directory';
    pathBrowseBtn.disabled = true;
    try {
      const result = await api.pickSearchPath(kind);
      if (result?.canceled) {
        setFeedback('Path selection cancelled.', 'muted');
        return;
      }
      if (!result?.success || !result?.path) {
        throw new Error(result?.message || 'Path picker failed.');
      }
      pathInput.value = result.path;
      setFeedback(result.message || 'Path selected.', 'success');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err), 'warning');
    } finally {
      pathBrowseBtn.disabled = false;
    }
  });

  addForm.querySelector('select[name="type"]')?.addEventListener('change', syncAddFormFields);

  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.enabled) {
      setFeedback('Enable Document Search in configuration first.', 'warning');
      return;
    }

    const submitBtn = addForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';
    try {
      const formData = new FormData(addForm);
      const sourceId = String(formData.get('id') || '').trim();
      const sourceType = String(formData.get('type') || 'directory').trim();
      const sourcePath = String(formData.get('path') || '').trim();
      const sourceName = String(formData.get('name') || '').trim();
      if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(sourceId)) {
        throw new Error('Source ID must be 2-64 chars using letters, numbers, dash, or underscore.');
      }
      if (!sourceName) throw new Error('Display Name is required.');
      if (!sourcePath) throw new Error('Path / URL is required.');

      const supportsGlobs = sourceType === 'directory' || sourceType === 'git';
      const globsRaw = String(formData.get('globs') || '').trim();
      const source = {
        id: sourceId,
        name: sourceName,
        type: sourceType,
        path: sourcePath,
        globs: supportsGlobs && globsRaw
          ? globsRaw.split(',').map((glob) => glob.trim()).filter(Boolean)
          : undefined,
        branch: sourceType === 'git'
          ? (String(formData.get('branch') || '').trim() || undefined)
          : undefined,
        description: String(formData.get('description') || '').trim() || undefined,
        enabled: true,
      };

      // 1. If runtime is available, add to live store. If the runtime routes
      // are unavailable, fall back to config-only persistence.
      let runtimeUpdated = false;
      if (state.runtimeAvailable) {
        try {
          const result = await api.searchSourceAdd(source);
          if (result?.success === false) {
            throw new Error(result.message || 'Failed to add source to the live search runtime.');
          }
          runtimeUpdated = true;
        } catch (err) {
          if (isUnavailableError(err)) {
            state.runtimeAvailable = false;
          } else {
            throw err;
          }
        }
      }

      // 2. Persist to config so it survives restart
      const currentSources = Array.isArray(sharedConfig?.assistant?.tools?.search?.sources)
        ? [...sharedConfig.assistant.tools.search.sources]
        : [];
      
      // Upsert
      const existingIdx = currentSources.findIndex(s => s.id === source.id);
      if (existingIdx >= 0) {
        currentSources[existingIdx] = source;
      } else {
        currentSources.push(source);
      }

      const configResult = await api.updateConfig({
        assistant: {
          tools: {
            search: { sources: currentSources },
          },
        },
      });

      if (!configResult.success) {
        throw new Error(configResult.message || 'Failed to persist source to config.');
      }

      // Update local state
      state.sources = currentSources;
      if (sharedConfig) {
        sharedConfig.assistant = sharedConfig.assistant || {};
        sharedConfig.assistant.tools = sharedConfig.assistant.tools || {};
        sharedConfig.assistant.tools.search = sharedConfig.assistant.tools.search || {};
        sharedConfig.assistant.tools.search.sources = currentSources;
      }

      toggleAddForm(false);
      addForm.reset();
      syncAddFormFields();
      renderSources();
      
      setFeedback(
        runtimeUpdated
          ? `Source '${source.id}' added and hot-reloaded.`
          : `Source '${source.id}' saved to config. Search runtime is currently unavailable, so it will load once search becomes active.`,
        runtimeUpdated ? 'success' : 'warning',
      );
      void refreshAll();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Source';
    }
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await refreshAll(true);
    } finally {
      refreshBtn.disabled = false;
    }
  });

  reindexAllBtn.addEventListener('click', async () => {
    if (!canManageSources()) {
      setFeedback('Reindex is unavailable until Document Search is enabled and active in runtime.', 'warning');
      return;
    }
    reindexAllBtn.disabled = true;
    reindexAllBtn.textContent = 'Reindexing...';
    try {
      const result = await api.searchReindex();
      if (!result.success) throw new Error(result.message || 'Reindex all failed.');
      setFeedback('Reindex started for all sources.', 'success');
    } catch (err) {
      setFeedback(`Reindex failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      reindexAllBtn.disabled = false;
      reindexAllBtn.textContent = 'Reindex All';
    }
  });

  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value || '';
    renderSources();
  });

  sourcesArea.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('search-toggle')) return;
    const sourceId = target.dataset.sourceId;
    if (!sourceId || !canManageSources()) return;

    target.disabled = true;
    try {
      const result = await api.searchSourceToggle(sourceId, target.checked);
      if (!result.success) throw new Error(result.message || 'Unable to update source status.');
      const item = state.sources.find((source) => source.id === sourceId);
      if (item) item.enabled = target.checked;
      setFeedback(`Source '${sourceId}' ${target.checked ? 'enabled' : 'disabled'}.`, 'success');
      renderSources();
    } catch (err) {
      target.checked = !target.checked;
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      target.disabled = false;
    }
  });

  sourcesArea.addEventListener('click', async (event) => {
    const button = event.target instanceof HTMLElement
      ? event.target.closest('.search-action')
      : null;
    if (!(button instanceof HTMLButtonElement)) return;
    if (!canManageSources()) return;

    const action = button.dataset.action;
    const sourceId = button.dataset.sourceId;
    if (!action || !sourceId) return;

    button.disabled = true;
    const originalLabel = button.textContent || '';
    try {
      if (action === 'reindex') {
        button.textContent = 'Reindexing...';
        const result = await api.searchReindex(sourceId);
        if (!result.success) throw new Error(result.message || `Reindex failed for '${sourceId}'.`);
        setFeedback(`Reindex started for '${sourceId}'.`, 'success');
      } else if (action === 'remove') {
        if (!confirm(`Remove source '${sourceId}'?`)) return;
        button.textContent = 'Removing...';
        const result = await api.searchSourceRemove(sourceId);
        if (!result.success) throw new Error(result.message || `Failed to remove '${sourceId}'.`);
        state.sources = state.sources.filter((source) => source.id !== sourceId);
        setFeedback(`Removed source '${sourceId}'.`, 'success');
        renderSources();
        renderSummary();
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });

  syncAddFormFields();
  renderSummary();
  renderSources();
  updateManageControls();
  if (!state.enabled) {
    state.runtimeAvailable = false;
    updateManageControls();
    setFeedback('Document Search is disabled in config. Enable it here, then restart GuardianAgent to activate indexing.', 'warning');
  } else {
    setFeedback('Loading search status and sources...', 'muted');
    void refreshAll();
  }
}

// ─── Cloud Tab ───────────────────────────────────────────

function renderCloudTab(panel) {
  const cloud = sharedConfig?.assistant?.tools?.cloud || {
    enabled: false,
    cpanelProfiles: [],
    vercelProfiles: [],
    cloudflareProfiles: [],
    awsProfiles: [],
    gcpProfiles: [],
    azureProfiles: [],
    profileCounts: { cpanel: 0, vercel: 0, cloudflare: 0, aws: 0, gcp: 0, azure: 0, total: 0 },
    security: {
      inlineSecretProfileCount: 0,
      credentialRefCount: 0,
      selfSignedProfileCount: 0,
      customEndpointProfileCount: 0,
    },
  };
  const providers = [
    {
      key: 'cpanelProfiles',
      label: 'cPanel / WHM',
      note: 'Profile keys: id, name, type, host, port, username, credentialRef, ssl, allowSelfSigned, defaultCpanelUser. Add apiToken only when setting or rotating an inline token.',
    },
    {
      key: 'vercelProfiles',
      label: 'Vercel',
      note: 'Profile keys: id, name, apiBaseUrl, credentialRef, teamId, slug. Add apiToken only when setting or rotating an inline token.',
    },
    {
      key: 'cloudflareProfiles',
      label: 'Cloudflare',
      note: 'Profile keys: id, name, apiBaseUrl, credentialRef, accountId, defaultZoneId. Add apiToken only when setting or rotating an inline token.',
    },
    {
      key: 'awsProfiles',
      label: 'AWS',
      note: 'Profile keys: id, name, region, accessKeyIdCredentialRef, secretAccessKeyCredentialRef, sessionTokenCredentialRef, endpoints. Add accessKeyId/secretAccessKey/sessionToken only when setting or rotating inline credentials.',
    },
    {
      key: 'gcpProfiles',
      label: 'GCP',
      note: 'Profile keys: id, name, projectId, location, accessTokenCredentialRef, serviceAccountCredentialRef, endpoints. Add accessToken or serviceAccountJson only when setting or rotating inline credentials.',
    },
    {
      key: 'azureProfiles',
      label: 'Azure',
      note: 'Profile keys: id, name, subscriptionId, tenantId, accessTokenCredentialRef, clientIdCredentialRef, clientSecretCredentialRef, defaultResourceGroup, blobBaseUrl, endpoints. Add accessToken/clientId/clientSecret only when setting or rotating inline credentials.',
    },
  ];

  panel.innerHTML = `
    <div class="intel-summary-grid">
      <div class="status-card ${cloud.enabled ? 'success' : 'error'}">
        <div class="card-title">Cloud Runtime</div>
        <div class="card-value">${cloud.enabled ? 'Enabled' : 'Disabled'}</div>
        <div class="card-subtitle">Cloud and hosting tools</div>
      </div>
      <div class="status-card info">
        <div class="card-title">Profiles</div>
        <div class="card-value">${cloud.profileCounts?.total || 0}</div>
        <div class="card-subtitle">Configured provider connections</div>
      </div>
      <div class="status-card ${cloud.security?.inlineSecretProfileCount ? 'warning' : 'success'}">
        <div class="card-title">Inline Secrets</div>
        <div class="card-value">${cloud.security?.inlineSecretProfileCount || 0}</div>
        <div class="card-subtitle">Prefer credential refs when possible</div>
      </div>
      <div class="status-card ${cloud.security?.selfSignedProfileCount ? 'warning' : 'accent'}">
        <div class="card-title">TLS Exceptions</div>
        <div class="card-value">${cloud.security?.selfSignedProfileCount || 0}</div>
        <div class="card-subtitle">Profiles allowing self-signed certs</div>
      </div>
      <div class="status-card ${cloud.security?.customEndpointProfileCount ? 'warning' : 'info'}">
        <div class="card-title">Custom Endpoints</div>
        <div class="card-value">${cloud.security?.customEndpointProfileCount || 0}</div>
        <div class="card-subtitle">Override APIs or emulator endpoints</div>
      </div>
    </div>

    <div class="table-container">
      <div class="table-header">
        <h3>Cloud Configuration</h3>
        <span class="cfg-header-note">Editable provider blocks for <code>assistant.tools.cloud</code></span>
      </div>
      <div class="cfg-center-body">
        <div class="cfg-form-grid">
          <div class="cfg-field">
            <label>Enable Cloud Tools</label>
            <select id="cfg-cloud-enabled">
              <option value="true" ${cloud.enabled ? 'selected' : ''}>Enabled</option>
              <option value="false" ${!cloud.enabled ? 'selected' : ''}>Disabled</option>
            </select>
          </div>
          <div class="cfg-field" style="grid-column: 1 / -1;">
            <label>Security Notes</label>
            <div style="font-size:0.75rem;color:var(--text-muted);line-height:1.5;">
              Fields ending in <code>Configured</code> are informational only and indicate an inline secret already exists.<br>
              To rotate an inline secret, add the real secret field into the JSON for that profile. Leaving secret fields out preserves the current stored value.
            </div>
          </div>
        </div>
        <div class="cfg-actions">
          <button class="btn btn-primary" id="cfg-cloud-save" type="button">Save Cloud Configuration</button>
          <span id="cfg-cloud-status" class="cfg-save-status"></span>
        </div>
      </div>
    </div>
  `;

  for (const provider of providers) {
    const section = document.createElement('div');
    section.className = 'table-container';
    const profiles = cloud[provider.key] || [];

    // Build per-profile credential ref + test UI
    let profileCards = '';
    for (const profile of profiles) {
      const pid = profile.id || '';
      const pName = profile.name || pid;
      const hasCredRef = !!(profile.credentialRef || profile.accessKeyIdCredentialRef || profile.accessTokenCredentialRef || profile.serviceAccountCredentialRef || profile.clientIdCredentialRef);
      const credRefValue = profile.credentialRef || profile.accessKeyIdCredentialRef || profile.accessTokenCredentialRef || profile.serviceAccountCredentialRef || profile.clientIdCredentialRef || '';
      const tokenConfigured = !!(profile.apiTokenConfigured || profile.accessKeyIdConfigured || profile.accessTokenConfigured || profile.serviceAccountJsonConfigured || profile.clientIdConfigured);
      const statusLabel = tokenConfigured || hasCredRef ? 'Credential configured' : 'No credential';
      const statusColor = tokenConfigured || hasCredRef ? 'var(--success)' : 'var(--text-muted)';
      profileCards += `
        <div style="border:1px solid var(--border);border-radius:var(--radius);padding:0.6rem 0.75rem;margin-bottom:0.5rem;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem;">
            <strong style="font-size:0.78rem;">${esc(pName)}</strong>
            <span style="font-size:0.68rem;color:${statusColor};">${statusLabel}</span>
          </div>
          <div class="cfg-field" style="margin-bottom:0.4rem;">
            <label style="display:flex;align-items:center;gap:0.35rem;justify-content:flex-start;cursor:pointer;"><input type="checkbox" class="cloud-cred-ref-toggle" data-provider="${esc(provider.key)}" data-profile-id="${escAttr(pid)}" title="Use an environment-backed credential ref" ${hasCredRef ? 'checked' : ''}> Enable Credential Ref</label>
            <input type="text" class="cloud-cred-ref-input" data-provider="${esc(provider.key)}" data-profile-id="${escAttr(pid)}" value="${escAttr(credRefValue)}" placeholder="cloud.${esc(provider.key.replace('Profiles', ''))}.${escAttr(pid)}" ${hasCredRef ? '' : 'disabled'}>
          </div>
          <div class="cfg-actions" style="margin-top:0.3rem;">
            <button class="btn btn-secondary cloud-test-btn" data-provider="${esc(provider.key)}" data-profile-id="${escAttr(pid)}" type="button">Test Connection</button>
            <span class="cloud-test-status" data-provider="${esc(provider.key)}" data-profile-id="${escAttr(pid)}" style="font-size:0.72rem;"></span>
          </div>
        </div>`;
    }
    if (!profiles.length) {
      profileCards = '<div style="font-size:0.75rem;color:var(--text-muted);padding:0.4rem 0;">No profiles configured.</div>';
    }

    section.innerHTML = `
      <div class="table-header">
        <h3>${esc(provider.label)}</h3>
        <span class="cfg-header-note">${profiles.length} profile${profiles.length === 1 ? '' : 's'}</span>
      </div>
      <div class="cfg-center-body">
        ${profileCards}
        <details style="margin-top:0.5rem;">
          <summary style="font-size:0.72rem;color:var(--text-muted);cursor:pointer;user-select:none;">Advanced JSON Editor</summary>
          <div style="margin-top:0.35rem;margin-bottom:0.25rem;font-size:0.72rem;color:var(--text-muted);line-height:1.45;">${provider.note}</div>
          <textarea
            id="cfg-cloud-${provider.key}"
            spellcheck="false"
            style="width:100%;min-height:180px;padding:0.85rem;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-size:0.74rem;border:1px solid var(--border);border-radius:10px;background:var(--bg-panel);color:var(--text-primary);resize:vertical;"
          >${esc(JSON.stringify(profiles, null, 2))}</textarea>
        </details>
      </div>
    `;

    // Wire credential ref toggles
    for (const toggle of section.querySelectorAll('.cloud-cred-ref-toggle')) {
      const input = section.querySelector(`.cloud-cred-ref-input[data-provider="${toggle.dataset.provider}"][data-profile-id="${toggle.dataset.profileId}"]`);
      if (input) {
        toggle.addEventListener('change', () => {
          input.disabled = !toggle.checked;
          if (!toggle.checked) input.value = '';
        });
      }
    }

    // Wire test buttons
    for (const btn of section.querySelectorAll('.cloud-test-btn')) {
      btn.addEventListener('click', async () => {
        const statusSpan = section.querySelector(`.cloud-test-status[data-provider="${btn.dataset.provider}"][data-profile-id="${btn.dataset.profileId}"]`);
        if (statusSpan) {
          statusSpan.textContent = 'Testing...';
          statusSpan.style.color = 'var(--text-muted)';
        }
        try {
          const result = await api.cloudTest(btn.dataset.provider, btn.dataset.profileId);
          if (statusSpan) {
            statusSpan.textContent = result.message || (result.success ? 'Connected' : 'Failed');
            statusSpan.style.color = result.success ? 'var(--success)' : 'var(--error)';
          }
        } catch (err) {
          if (statusSpan) {
            statusSpan.textContent = err instanceof Error ? err.message : String(err);
            statusSpan.style.color = 'var(--error)';
          }
        }
      });
    }

    panel.appendChild(section);
  }

  const statusEl = panel.querySelector('#cfg-cloud-status');
  panel.querySelector('#cfg-cloud-save')?.addEventListener('click', async () => {
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const payload = {
        enabled: panel.querySelector('#cfg-cloud-enabled')?.value === 'true',
      };
      for (const provider of providers) {
        const text = panel.querySelector(`#cfg-cloud-${provider.key}`)?.value || '[]';
        payload[provider.key] = parseJsonArray(text, provider.label);
      }
      const result = await api.updateConfig({
        assistant: {
          tools: {
            cloud: payload,
          },
        },
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success) {
        sharedConfig = await api.config();
        renderCloudTab(panel);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  applyInputTooltips(panel);
}

// ─── Settings Tab ────────────────────────────────────────

function renderSettingsTab(panel) {
  const config = sharedConfig;
  const providers = sharedProviders;
  const setupStatus = sharedSetupStatus;
  const authStatus = sharedAuthStatus;

  panel.innerHTML = '';

  // Overview/Readiness — always visible at top
  panel.appendChild(createOverview(config, providers, setupStatus));

  // ── Helper: create an accordion group ──
  function makeGroup(title, summary, items, openByDefault) {
    const group = document.createElement('div');
    group.className = 'cfg-group' + (openByDefault ? ' open' : '');

    const header = document.createElement('div');
    header.className = 'cfg-group-header';
    header.innerHTML = `
      <span class="cfg-group-chevron">&#9654;</span>
      <span class="cfg-group-title">${esc(title)}</span>
      <span class="cfg-group-summary">${summary}</span>
    `;
    header.addEventListener('click', () => group.classList.toggle('open'));
    group.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cfg-group-body';
    const grid = document.createElement('div');
    grid.className = 'cfg-group-grid';

    for (const item of items) {
      const wrapper = document.createElement('div');
      wrapper.className = 'cfg-item' + (item.fullWidth ? ' full-width' : '');

      const itemHeader = document.createElement('div');
      itemHeader.className = 'cfg-item-header';
      itemHeader.innerHTML = `
        <span class="cfg-item-chevron">&#9654;</span>
        <span class="cfg-item-title">${esc(item.title)}</span>
        <span class="cfg-item-badge">${item.badge || ''}</span>
      `;
      itemHeader.addEventListener('click', () => wrapper.classList.toggle('open'));
      wrapper.appendChild(itemHeader);

      const itemBody = document.createElement('div');
      itemBody.className = 'cfg-item-body';
      const panelEl = item.panel;
      if (panelEl) {
        // Remove the table-header (we use our own accordion header instead)
        const tableHeader = panelEl.querySelector('.table-header');
        if (tableHeader) tableHeader.remove();
        // Remove table-container border/bg since the cfg-item provides it
        panelEl.style.background = 'none';
        panelEl.style.border = 'none';
        panelEl.style.margin = '0';
        itemBody.appendChild(panelEl);
      }
      wrapper.appendChild(itemBody);
      grid.appendChild(wrapper);
    }

    body.appendChild(grid);
    group.appendChild(body);
    return group;
  }

  // ── Build summaries ──
  const telegramEnabled = config.channels?.telegram?.enabled;
  const sandboxMode = config.assistant?.tools?.sandbox?.enforcementMode || 'strict';
  const apu = config.assistant?.tools?.agentPolicyUpdates || {};
  const apuCount = [apu.allowedPaths !== false, !!apu.allowedCommands, apu.allowedDomains !== false].filter(Boolean).length;
  const gaConfig = config.guardian?.guardianAgent;
  const trustPreset = config.guardian?.trustPreset || 'custom';
  const authMode = authStatus?.tokenConfigured ? 'Configured' : 'Not set';
  const notifications = config.assistant?.notifications || {};
  const notificationsBadge = notifications.enabled !== false
    ? (notifications.deliveryMode === 'all'
      ? 'All channels'
      : summarizeNotificationDestinations(notifications.destinations))
    : 'Disabled';

  // ── Layout container ──
  const layout = document.createElement('div');
  layout.className = 'cfg-categories-layout';
  const leftCol = document.createElement('div');
  const rightCol = document.createElement('div');
  layout.appendChild(leftCol);
  layout.appendChild(rightCol);
  panel.appendChild(layout);

  // ── Channels group ──
  leftCol.appendChild(makeGroup('Channels', `${telegramEnabled ? 'Telegram active' : 'CLI + Web'}`, [
    {
      title: 'Telegram',
      badge: telegramEnabled ? 'Enabled' : 'Disabled',
      panel: createTelegramPanel(config, panel),
    },
    {
      title: 'Web Search & Fallback',
      badge: config.assistant?.tools?.webSearch?.provider || 'auto',
      panel: createWebSearchPanel(config, panel),
    },
  ]));

  // ── Integrations group ──
  leftCol.appendChild(makeGroup('Integrations', '', [
    {
      title: 'Browser Automation',
      badge: config.assistant?.tools?.browser?.enabled !== false ? 'Enabled' : 'Disabled',
      panel: createBrowserPanel(config, panel),
    },
    {
      title: 'Google Workspace',
      badge: 'Cloud > Connections',
      panel: (() => {
        const el = document.createElement('div');
        el.className = 'table-container';
        el.innerHTML = '<div class="cfg-center-body" style="font-size:0.8rem;color:var(--text-secondary);">Google Workspace setup has moved to <strong>Cloud &gt; Connections</strong>.</div>';
        return el;
      })(),
    },
  ]));

  // ── Security group ──
  leftCol.appendChild(makeGroup('Security', `${sandboxMode} sandbox`, [
    {
      title: 'Guardian Agent',
      badge: gaConfig?.enabled !== false ? `${gaConfig?.llmProvider || 'auto'}` : 'Disabled',
      panel: createGuardianAgentPanel(),
    },
    {
      title: 'Policy-as-Code Engine',
      badge: (config.guardian?.policy?.mode || 'shadow'),
      panel: createPolicyEnginePanel(),
    },
    {
      title: 'Sentinel Audit',
      badge: 'Retrospective analysis',
      panel: createSentinelAuditPanel(),
    },
    {
      title: 'Security Alerts',
      badge: notificationsBadge,
      panel: createNotificationsPanel(config, panel),
    },
    {
      title: 'Sandbox Enforcement',
      badge: sandboxMode,
      panel: createSandboxPanel(config),
    },
    {
      title: 'Trust Preset',
      badge: trustPreset,
      panel: createTrustPresetPanel(config),
    },
    {
      title: 'Agent Policy Access',
      badge: `${apuCount}/3 enabled`,
      panel: createAgentPolicyAccessPanel(config, panel),
    },
  ], true));

  // ── System group ──
  rightCol.appendChild(makeGroup('System', authMode, [
    {
      title: 'Authentication',
      badge: authMode,
      panel: createAuthPanel(config, authStatus, panel),
    },
    {
      title: 'Danger Zone',
      badge: '',
      panel: createDangerZonePanel(),
    },
  ], true));

  // ── Config Snapshots group (collapsed by default) ──
  function makeSnapshotPanel(data) {
    const el = document.createElement('div');
    el.className = 'table-container';
    el.innerHTML = `<div class="cfg-center-body"><pre style="font-size:0.72rem;overflow-x:auto;max-height:400px;overflow-y:auto;">${highlight(JSON.stringify(data, null, 2))}</pre></div>`;
    return el;
  }
  rightCol.appendChild(makeGroup('Config Snapshots', 'Read-only', [
    { title: 'Channels', badge: 'read-only', panel: makeSnapshotPanel(config.channels), fullWidth: true },
    { title: 'Guardian', badge: 'read-only', panel: makeSnapshotPanel(config.guardian), fullWidth: true },
    { title: 'Runtime', badge: 'read-only', panel: makeSnapshotPanel(config.runtime), fullWidth: true },
    { title: 'Cloud', badge: 'read-only', panel: makeSnapshotPanel(config.assistant?.tools?.cloud || {}), fullWidth: true },
    { title: 'Assistant', badge: 'read-only', panel: makeSnapshotPanel(config.assistant), fullWidth: true },
  ]));
}

function createOverview(config, providers, setupStatus) {
  const wrap = document.createElement('div');
  wrap.className = 'cfg-settings-overview';
  const cards = document.createElement('div');
  cards.className = 'cfg-overview-grid';
  const defaultProvider = providers.find(p => p.name === config.defaultProvider);
  const connectedText = defaultProvider ? (defaultProvider.connected === false ? 'Disconnected' : 'Connected') : 'Unknown';
  const connectedTone = defaultProvider && defaultProvider.connected === false ? 'error' : 'success';
  const cloud = config.assistant?.tools?.cloud;

  cards.appendChild(createMiniCard('Readiness', setupStatus?.ready ? 'Ready' : 'Needs attention', setupStatus?.completed ? 'Baseline saved' : 'Configuration pending', setupStatus?.ready ? 'success' : 'warning'));
  cards.appendChild(createMiniCard('Default Provider', config.defaultProvider || 'None', connectedText, connectedTone));
  cards.appendChild(createMiniCard('Providers', String(Object.keys(config.llm || {}).length), `${providers.length} detected`, 'info'));
  cards.appendChild(createMiniCard('Telegram', config.channels?.telegram?.enabled ? 'Enabled' : 'Disabled', 'Configure in Integrations', config.channels?.telegram?.enabled ? 'success' : 'warning'));
  cards.appendChild(createMiniCard('Cloud', cloud?.enabled ? 'Enabled' : 'Disabled', `${cloud?.profileCounts?.total || 0} profiles`, cloud?.enabled ? 'success' : 'warning'));
  wrap.appendChild(cards);

  return wrap;
}

function createTelegramPanel(config, settingsPanel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const telegram = config.channels?.telegram || {};
  const credentialRefOptions = renderCredentialRefOptions(config?.assistant?.credentials?.refs || {});
  const enabled = !!telegram.enabled;
  const tokenConfigured = !!telegram.botTokenConfigured;
  const rawCredentialRef = telegram.botTokenCredentialRef || '';
  const credentialRefMeta = getCredentialRefMeta(rawCredentialRef);
  // Only show credential ref in the UI if it's an env-backed ref the user explicitly created.
  // Auto-managed local refs are invisible plumbing — the user just sees "Configured" on the token field.
  const credentialRef = credentialRefMeta?.source === 'env' ? rawCredentialRef : '';
  const tokenPlaceholder = tokenConfigured
    ? getSecretFieldPlaceholder(credentialRef, 'Configured. Paste to replace.')
    : 'Paste once to store securely';
  const chatIdPreview = Array.isArray(telegram.allowedChatIds) && telegram.allowedChatIds.length > 0
    ? telegram.allowedChatIds.join(', ')
    : '';

  section.innerHTML = `
    <div class="table-header">
      <h3>Telegram Channel</h3>
      <span class="cfg-header-note">Paste the bot token once for secure local storage, or use an advanced env-backed credential ref.</span>
    </div>
    <div class="cfg-center-body">
      <datalist id="cfg-telegram-credential-ref-options">${credentialRefOptions}</datalist>
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enable Telegram</label>
          <select id="cfg-telegram-enabled">
            <option value="false" ${!enabled ? 'selected' : ''}>No</option>
            <option value="true" ${enabled ? 'selected' : ''}>Yes</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Bot Token</label>
          <input id="cfg-telegram-token" type="password" placeholder="${escAttr(tokenPlaceholder)}">
        </div>
        <div class="cfg-field">
          <label style="display:flex;align-items:center;gap:0.35rem;justify-content:flex-start;cursor:pointer;"><input id="cfg-telegram-credential-ref-enabled" type="checkbox" title="Use an environment-backed credential ref instead of the local secret store" ${credentialRef ? 'checked' : ''}> Enable Credential Ref</label>
          <input id="cfg-telegram-credential-ref" type="text" list="cfg-telegram-credential-ref-options" value="${escAttr(credentialRef)}" placeholder="telegram.bot.primary" ${credentialRef ? '' : 'disabled'}>
        </div>
        <div class="cfg-field">
          <label>Allowed Chat IDs</label>
          <input id="cfg-telegram-chatids" type="text" value="${esc(chatIdPreview)}" placeholder="12345,-1001234567890">
        </div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        Simple mode: paste the BotFather token here and Guardian stores it in the encrypted local secret store. Advanced mode: leave Bot Token blank, create an env-backed ref in Credential Refs, and enter that ref name here. Send one message to the bot, then run <code>getUpdates</code> to find <code>message.chat.id</code>.
      </div>
      <div style="margin-top:0.35rem;font-size:0.72rem;color:var(--text-muted);">Telegram changes hot-reload when the token/ref and allowlist are valid.</div>
      <div class="cfg-actions">
        <button class="btn btn-secondary" id="cfg-telegram-test" type="button">Test Connection</button>
        <button class="btn btn-primary" id="cfg-telegram-save" type="button">Save Telegram Settings</button>
        <span id="cfg-telegram-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const tgCredRefCheckbox = section.querySelector('#cfg-telegram-credential-ref-enabled');
  const tgCredRefInput = section.querySelector('#cfg-telegram-credential-ref');
  if (tgCredRefCheckbox && tgCredRefInput) {
    tgCredRefCheckbox.addEventListener('change', () => {
      tgCredRefInput.disabled = !tgCredRefCheckbox.checked;
      if (!tgCredRefCheckbox.checked) tgCredRefInput.value = '';
    });
  }

  const statusEl = section.querySelector('#cfg-telegram-status');
  section.querySelector('#cfg-telegram-save')?.addEventListener('click', async () => {
    const enabledVal = section.querySelector('#cfg-telegram-enabled')?.value === 'true';
    const token = section.querySelector('#cfg-telegram-token')?.value.trim() || undefined;
    const botTokenCredentialRef = tgCredRefCheckbox?.checked ? (tgCredRefInput?.value.trim() || undefined) : undefined;
    const chatIdsRaw = section.querySelector('#cfg-telegram-chatids')?.value || '';

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    try {
      const result = await api.updateConfig({
        channels: {
          telegram: {
            enabled: enabledVal,
            botToken: token,
            botTokenCredentialRef,
            allowedChatIds: parseChatIdsOrUndefined(chatIdsRaw),
          },
        },
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success) {
        await refreshSettingsOverview(settingsPanel);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  section.querySelector('#cfg-telegram-test')?.addEventListener('click', async () => {
    statusEl.textContent = 'Testing Telegram connection...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.telegramTest();
      statusEl.textContent = result.message || (result.success ? 'Connected' : 'Failed');
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  applyInputTooltips(section);
  return section;
}

function createNotificationsPanel(config, settingsPanel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const notifications = config.assistant?.notifications || {};
  const enabled = notifications.enabled !== false;
  const minSeverity = notifications.minSeverity || 'warn';
  const auditEventTypes = Array.isArray(notifications.auditEventTypes) ? notifications.auditEventTypes : [];
  const suppressedDetailTypes = Array.isArray(notifications.suppressedDetailTypes) ? notifications.suppressedDetailTypes : [];
  const cooldownSeconds = Math.max(0, Math.round((notifications.cooldownMs || 0) / 1000));
  const deliveryMode = notifications.deliveryMode || 'selected';
  const destinations = notifications.destinations || { web: false, cli: true, telegram: false };

  section.innerHTML = `
    <div class="table-header">
      <h3>Security Alerts</h3>
      <span class="cfg-header-note">Filter noisy alerts and choose delivery channels</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enable Alerts</label>
          <select id="cfg-notify-enabled">
            <option value="true" ${enabled ? 'selected' : ''}>Enabled</option>
            <option value="false" ${!enabled ? 'selected' : ''}>Disabled</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Minimum Severity</label>
          <select id="cfg-notify-min-severity">
            <option value="info" ${minSeverity === 'info' ? 'selected' : ''}>Info</option>
            <option value="warn" ${minSeverity === 'warn' ? 'selected' : ''}>Warn</option>
            <option value="critical" ${minSeverity === 'critical' ? 'selected' : ''}>Critical</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Cooldown (seconds)</label>
          <input id="cfg-notify-cooldown" type="number" min="0" max="86400" value="${cooldownSeconds}">
        </div>
        <div class="cfg-field">
          <label>Channel Delivery</label>
          <select id="cfg-notify-delivery-mode">
            <option value="selected" ${deliveryMode === 'selected' ? 'selected' : ''}>Selected channels</option>
            <option value="all" ${deliveryMode === 'all' ? 'selected' : ''}>All active channels</option>
          </select>
        </div>
        <div class="cfg-field" style="grid-column: 1 / -1;">
          <label>Alert Event Types</label>
          <input id="cfg-notify-event-types" type="text" value="${esc(auditEventTypes.join(', '))}" placeholder="host_alert, gateway_alert, anomaly_detected">
        </div>
        <div class="cfg-field" style="grid-column: 1 / -1;">
          <label>Suppressed Detail Types</label>
          <input id="cfg-notify-suppressed-details" type="text" value="${esc(suppressedDetailTypes.join(', '))}" placeholder="new_external_destination, new_listening_port">
        </div>
      </div>

      <div id="cfg-notify-destinations" class="cfg-form-grid" style="margin-top:0.75rem;">
        <div class="cfg-field">
          <label><input id="cfg-notify-web" type="checkbox" ${destinations.web ? 'checked' : ''}> Web UI alerts</label>
        </div>
        <div class="cfg-field">
          <label><input id="cfg-notify-cli" type="checkbox" ${destinations.cli ? 'checked' : ''}> CLI alerts</label>
        </div>
        <div class="cfg-field">
          <label><input id="cfg-notify-telegram" type="checkbox" ${destinations.telegram ? 'checked' : ''}> Telegram alerts</label>
        </div>
      </div>

      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        Defaults are CLI-only. Web alerts appear as a live tray in the dashboard shell. Telegram delivery also requires the Telegram channel to be enabled and at least one allowed chat ID to be configured.
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="cfg-notify-save" type="button">Save Alert Settings</button>
        <span id="cfg-notify-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#cfg-notify-status');
  const deliveryModeSelect = section.querySelector('#cfg-notify-delivery-mode');
  const destinationsWrap = section.querySelector('#cfg-notify-destinations');

  function syncDeliveryMode() {
    destinationsWrap.style.opacity = deliveryModeSelect.value === 'all' ? '0.55' : '1';
    destinationsWrap.style.pointerEvents = deliveryModeSelect.value === 'all' ? 'none' : '';
  }

  syncDeliveryMode();
  deliveryModeSelect?.addEventListener('change', syncDeliveryMode);

  section.querySelector('#cfg-notify-save')?.addEventListener('click', async () => {
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    try {
      const result = await api.updateConfig({
        assistant: {
          notifications: {
            enabled: section.querySelector('#cfg-notify-enabled')?.value === 'true',
            minSeverity: section.querySelector('#cfg-notify-min-severity')?.value,
            cooldownMs: Math.max(0, Number(section.querySelector('#cfg-notify-cooldown')?.value || 0)) * 1000,
            deliveryMode: section.querySelector('#cfg-notify-delivery-mode')?.value,
            auditEventTypes: parseCommaList(section.querySelector('#cfg-notify-event-types')?.value),
            suppressedDetailTypes: parseCommaList(section.querySelector('#cfg-notify-suppressed-details')?.value),
            destinations: {
              web: !!section.querySelector('#cfg-notify-web')?.checked,
              cli: !!section.querySelector('#cfg-notify-cli')?.checked,
              telegram: !!section.querySelector('#cfg-notify-telegram')?.checked,
            },
          },
        },
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success) {
        await refreshSettingsOverview(settingsPanel);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  applyInputTooltips(section);
  return section;
}

async function refreshSettingsOverview(panel) {
  try {
    const [nextConfig, nextSetupStatus] = await Promise.all([
      api.config().catch(() => sharedConfig),
      api.setupStatus().catch(() => sharedSetupStatus),
    ]);

    if (nextConfig) sharedConfig = nextConfig;
    if (nextSetupStatus) sharedSetupStatus = nextSetupStatus;

    const currentOverview = panel.querySelector('.cfg-settings-overview');
    if (!currentOverview || !sharedConfig) return;

    const updatedOverview = createOverview(sharedConfig, sharedProviders || [], sharedSetupStatus);
    panel.replaceChild(updatedOverview, currentOverview);
  } catch {
    // Best-effort refresh; keep existing UI if status fetch fails.
  }
}

function createWebSearchPanel(config, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const ws = config.assistant?.tools?.webSearch || {};
  const fallbacks = config.fallbacks || [];
  const providerNames = Object.keys(config.llm || {});
  const credentialRefOptions = renderCredentialRefOptions(config?.assistant?.credentials?.refs || {});
  // Only show env-backed refs in the UI; auto-managed local refs are invisible plumbing.
  const isEnvRef = (refName) => refName && getCredentialRefMeta(refName)?.source === 'env';
  const braveRef = isEnvRef(ws.braveCredentialRef) ? ws.braveCredentialRef : '';
  const perplexityRef = isEnvRef(ws.perplexityCredentialRef) ? ws.perplexityCredentialRef : '';
  const openRouterRef = isEnvRef(ws.openRouterCredentialRef) ? ws.openRouterCredentialRef : '';

  section.innerHTML = `
    <div class="table-header">
      <h3>Web Search &amp; Model Fallback</h3>
      <span class="cfg-header-note">Search keys can be pasted once into secure local storage or provided via advanced credential refs.</span>
    </div>
    <div class="cfg-center-body">
      <datalist id="ws-credential-ref-options">${credentialRefOptions}</datalist>
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Search Provider</label>
          <select id="ws-provider">
            <option value="auto" ${ws.provider === 'auto' || !ws.provider ? 'selected' : ''}>Auto (best available)</option>
            <option value="brave" ${ws.provider === 'brave' ? 'selected' : ''}>Brave</option>
            <option value="perplexity" ${ws.provider === 'perplexity' ? 'selected' : ''}>Perplexity</option>
            <option value="duckduckgo" ${ws.provider === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo (no key)</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Brave API Key</label>
          <input id="ws-brave-key" type="password" placeholder="${escAttr(ws.braveConfigured ? getSecretFieldPlaceholder(ws.braveCredentialRef, 'Configured. Paste to replace.') : 'BSA...')}">
        </div>
        <div class="cfg-field">
          <label style="display:flex;align-items:center;gap:0.35rem;justify-content:flex-start;cursor:pointer;"><input id="ws-brave-credential-ref-enabled" type="checkbox" title="Use an environment-backed credential ref instead of the local secret store" ${braveRef ? 'checked' : ''}> Enable Credential Ref</label>
          <input id="ws-brave-credential-ref" type="text" list="ws-credential-ref-options" value="${esc(braveRef)}" placeholder="search.brave.primary" ${braveRef ? '' : 'disabled'}>
        </div>
        <div class="cfg-field">
          <label>Perplexity API Key</label>
          <input id="ws-perplexity-key" type="password" placeholder="${escAttr(ws.perplexityConfigured ? getSecretFieldPlaceholder(ws.perplexityCredentialRef, 'Configured. Paste to replace.') : 'pplx-...')}">
        </div>
        <div class="cfg-field">
          <label style="display:flex;align-items:center;gap:0.35rem;justify-content:flex-start;cursor:pointer;"><input id="ws-perplexity-credential-ref-enabled" type="checkbox" title="Use an environment-backed credential ref instead of the local secret store" ${perplexityRef ? 'checked' : ''}> Enable Credential Ref</label>
          <input id="ws-perplexity-credential-ref" type="text" list="ws-credential-ref-options" value="${esc(perplexityRef)}" placeholder="search.perplexity.primary" ${perplexityRef ? '' : 'disabled'}>
        </div>
        <div class="cfg-field">
          <label>OpenRouter API Key</label>
          <input id="ws-openrouter-key" type="password" placeholder="${escAttr(ws.openRouterConfigured ? getSecretFieldPlaceholder(ws.openRouterCredentialRef, 'Configured. Paste to replace.') : 'sk-or-...')}">
        </div>
        <div class="cfg-field">
          <label style="display:flex;align-items:center;gap:0.35rem;justify-content:flex-start;cursor:pointer;"><input id="ws-openrouter-credential-ref-enabled" type="checkbox" title="Use an environment-backed credential ref instead of the local secret store" ${openRouterRef ? 'checked' : ''}> Enable Credential Ref</label>
          <input id="ws-openrouter-credential-ref" type="text" list="ws-credential-ref-options" value="${esc(openRouterRef)}" placeholder="search.openrouter.primary" ${openRouterRef ? '' : 'disabled'}>
        </div>
      </div>
      <div class="cfg-divider"></div>
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Model Fallback Chain</label>
          <input id="ws-fallbacks" type="text" value="${esc(fallbacks.join(', '))}" placeholder="e.g. claude, gpt (comma-separated)">
        </div>
        <div class="cfg-field">
          <label>Available Providers</label>
          <input type="text" readonly value="${esc(providerNames.join(', '))}" style="opacity:0.7;">
        </div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">Auto selects best search provider: Brave &gt; Perplexity &gt; DuckDuckGo. Paste-once keys go to the encrypted local secret store; credential refs are the advanced environment-backed option.</div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="ws-save" type="button">Save Search &amp; Fallback</button>
        <span id="ws-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#ws-save-status');

  // Wire up credential ref checkboxes
  for (const prefix of ['ws-brave', 'ws-perplexity', 'ws-openrouter']) {
    const cb = section.querySelector(`#${prefix}-credential-ref-enabled`);
    const inp = section.querySelector(`#${prefix}-credential-ref`);
    if (cb && inp) {
      cb.addEventListener('change', () => {
        inp.disabled = !cb.checked;
        if (!cb.checked) inp.value = '';
      });
    }
  }

  section.querySelector('#ws-save')?.addEventListener('click', async () => {
    const provider = section.querySelector('#ws-provider').value;
    const fallbacksRaw = section.querySelector('#ws-fallbacks').value.trim();
    const fallbackList = fallbacksRaw ? fallbacksRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    const getRefVal = (id) => {
      const cb = section.querySelector(`#${id}-enabled`);
      const inp = section.querySelector(`#${id}`);
      return cb?.checked ? (inp?.value.trim() || '') : '';
    };
    try {
      const result = await api.saveSearchConfig({
        webSearchProvider: provider,
        perplexityApiKey: section.querySelector('#ws-perplexity-key').value.trim() || undefined,
        perplexityCredentialRef: getRefVal('ws-perplexity-credential-ref'),
        openRouterApiKey: section.querySelector('#ws-openrouter-key').value.trim() || undefined,
        openRouterCredentialRef: getRefVal('ws-openrouter-credential-ref'),
        braveApiKey: section.querySelector('#ws-brave-key').value.trim() || undefined,
        braveCredentialRef: getRefVal('ws-brave-credential-ref'),
        fallbacks: fallbackList,
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) { statusEl.textContent = err instanceof Error ? err.message : String(err); statusEl.style.color = 'var(--error)'; }
  });

  applyInputTooltips(section);
  return section;
}

function createBrowserPanel(config, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const browser = config.assistant?.tools?.browser || {};
  const enabled = browser.enabled !== false;
  const playwrightEnabled = browser.playwrightEnabled !== false;
  const lightpandaEnabled = browser.lightpandaEnabled === true;
  const playwrightBrowser = browser.playwrightBrowser || 'chromium';
  const playwrightCaps = browser.playwrightCaps || 'network,storage';
  const domains = (browser.allowedDomains || config.assistant?.tools?.allowedDomains || []).join(', ');

  const browserEngines = ['chromium', 'firefox', 'webkit', 'chrome', 'msedge'];
  const browserOptions = browserEngines.map(b => `<option value="${b}" ${playwrightBrowser === b ? 'selected' : ''}>${b}</option>`).join('');

  section.innerHTML = `
    <div class="table-header">
      <h3>Browser Automation</h3>
      <span class="cfg-header-note">MCP-based browser tools (Playwright + Lightpanda)</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field"><label>Browser Tools</label><select id="browser-enabled"><option value="true" ${enabled ? 'selected' : ''}>Enabled</option><option value="false" ${!enabled ? 'selected' : ''}>Disabled</option></select></div>
        <div class="cfg-field"><label>Playwright</label><select id="browser-playwright-enabled"><option value="true" ${playwrightEnabled ? 'selected' : ''}>Enabled</option><option value="false" ${!playwrightEnabled ? 'selected' : ''}>Disabled</option></select></div>
        <div class="cfg-field"><label>Lightpanda</label><select id="browser-lightpanda-enabled"><option value="true" ${lightpandaEnabled ? 'selected' : ''}>Enabled</option><option value="false" ${!lightpandaEnabled ? 'selected' : ''}>Disabled</option></select></div>
        <div class="cfg-field"><label>Browser Engine</label><select id="browser-playwright-browser">${browserOptions}</select></div>
        <div class="cfg-field"><label>Capabilities</label><input id="browser-playwright-caps" type="text" value="${esc(playwrightCaps)}" placeholder="network,storage"></div>
        <div class="cfg-field"><label>Allowed Domains</label><input id="browser-domains" type="text" value="${esc(domains)}" placeholder="example.com, github.com"></div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">Changes require a restart to take effect. Playwright provides full browser automation; Lightpanda is a lightweight reader (beta).</div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="browser-save" type="button">Save Browser Config</button>
        <span id="browser-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#browser-save-status');
  section.querySelector('#browser-save')?.addEventListener('click', async () => {
    const enabledVal = section.querySelector('#browser-enabled').value === 'true';
    const pwEnabled = section.querySelector('#browser-playwright-enabled').value === 'true';
    const lpEnabled = section.querySelector('#browser-lightpanda-enabled').value === 'true';
    const pwBrowser = section.querySelector('#browser-playwright-browser').value;
    const pwCaps = section.querySelector('#browser-playwright-caps').value.trim() || 'network,storage';
    const domainsRaw = section.querySelector('#browser-domains').value.trim();
    const domainList = domainsRaw ? domainsRaw.split(',').map(d => d.trim()).filter(Boolean) : [];
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.saveBrowserConfig({
        enabled: enabledVal,
        playwrightEnabled: pwEnabled,
        lightpandaEnabled: lpEnabled,
        playwrightBrowser: pwBrowser,
        playwrightCaps: pwCaps,
        allowedDomains: domainList.length > 0 ? domainList : undefined,
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) { statusEl.textContent = err instanceof Error ? err.message : String(err); statusEl.style.color = 'var(--error)'; }
  });

  applyInputTooltips(section);
  return section;
}

function createSandboxPanel(config) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const sandbox = config.assistant?.tools?.sandbox || {};
  const mode = sandbox.enforcementMode || 'strict';

  section.innerHTML = `
    <div class="table-header">
      <h3>Sandbox Enforcement</h3>
      <span class="cfg-header-note">OS-level process isolation for tool execution</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enforcement Mode</label>
          <select id="sandbox-enforcement-mode">
            <option value="strict" ${mode === 'strict' ? 'selected' : ''}>Strict — disable risky tools when native sandbox unavailable</option>
            <option value="permissive" ${mode === 'permissive' ? 'selected' : ''}>Permissive — allow all tools even without native sandbox</option>
          </select>
        </div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        <strong>Strict</strong> disables shell, browser, and network tools when native sandboxing (bwrap) is not available.
        <strong>Permissive</strong> allows these tools to run unsandboxed. Use permissive if you trust your environment (e.g. local dev machine).
        Restart required after changes.
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="sandbox-save" type="button">Save Sandbox Config</button>
        <span id="sandbox-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#sandbox-save-status');
  section.querySelector('#sandbox-save')?.addEventListener('click', async () => {
    const modeVal = section.querySelector('#sandbox-enforcement-mode').value;
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConfig({
        assistant: { tools: { sandbox: { enforcementMode: modeVal } } },
      });
      statusEl.textContent = result.message || 'Saved';
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  return section;
}

function createAgentPolicyAccessPanel(config, settingsPanel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const apu = config.assistant?.tools?.agentPolicyUpdates || {};
  const pathsEnabled = apu.allowedPaths !== false;
  const commandsEnabled = !!apu.allowedCommands;
  const domainsEnabled = apu.allowedDomains !== false;

  section.innerHTML = `
    <div class="table-header">
      <h3>Agent Policy Access</h3>
      <span class="cfg-header-note">Allow the assistant to modify sandbox policy via chat (always requires user approval)</span>
    </div>
    <div class="cfg-center-body">
      <div style="display:grid;gap:0.6rem;padding:0.25rem 0;">
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;cursor:pointer;">
          <input type="checkbox" id="apu-paths" ${pathsEnabled ? 'checked' : ''}>
          <span>Manage filesystem paths</span>
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;cursor:pointer;">
          <input type="checkbox" id="apu-commands" ${commandsEnabled ? 'checked' : ''}>
          <span>Manage shell commands</span>
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem;cursor:pointer;">
          <input type="checkbox" id="apu-domains" ${domainsEnabled ? 'checked' : ''}>
          <span>Manage network domains</span>
        </label>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        When enabled, the assistant can use the <code>update_tool_policy</code> tool to add or remove paths, commands, or domains from the sandbox allowlist.
        Every change <strong>always requires explicit user approval</strong> regardless of policy mode.
        Useful for remote control via Telegram or other channels where the web UI is not accessible.
        Restart required after changes.
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="apu-save" type="button">Save</button>
        <span id="apu-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const statusEl = section.querySelector('#apu-save-status');
  section.querySelector('#apu-save')?.addEventListener('click', async () => {
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConfig({
        assistant: {
          tools: {
            agentPolicyUpdates: {
              allowedPaths: section.querySelector('#apu-paths').checked,
              allowedCommands: section.querySelector('#apu-commands').checked,
              allowedDomains: section.querySelector('#apu-domains').checked,
            },
          },
        },
      });
      statusEl.textContent = result.message || 'Saved';
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  return section;
}

function createGuardianAgentPanel() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Guardian Agent</h3>
      <span class="cfg-header-note">Inline LLM-powered action evaluation</span>
    </div>
    <div class="cfg-center-body" id="guardian-agent-body">
      <div class="loading" style="font-size:0.8rem;">Loading...</div>
    </div>
  `;

  async function load() {
    const body = section.querySelector('#guardian-agent-body');
    if (!body) return;
    try {
      const status = await api.guardianAgentStatus();
      body.innerHTML = `
        <div class="cfg-form-grid">
          <div class="cfg-field">
            <label>Enabled</label>
            <select id="ga-enabled">
              <option value="true" ${status.enabled ? 'selected' : ''}>Enabled</option>
              <option value="false" ${!status.enabled ? 'selected' : ''}>Disabled</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>LLM Provider</label>
            <select id="ga-llm-provider">
              <option value="auto" ${status.llmProvider === 'auto' ? 'selected' : ''}>Auto (local first, then external)</option>
              <option value="local" ${status.llmProvider === 'local' ? 'selected' : ''}>Local (Ollama)</option>
              <option value="external" ${status.llmProvider === 'external' ? 'selected' : ''}>External (OpenAI/Anthropic)</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Fail Mode</label>
            <select id="ga-fail-open">
              <option value="true" ${status.failOpen ? 'selected' : ''}>Fail-open (allow when LLM unavailable)</option>
              <option value="false" ${!status.failOpen ? 'selected' : ''}>Fail-closed (block when LLM unavailable)</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Timeout (ms)</label>
            <input type="number" id="ga-timeout" value="${status.timeoutMs || 8000}" min="1000" max="30000" step="1000">
          </div>
        </div>
        <div style="margin-top:0.75rem;">
          <button class="btn btn-sm" id="ga-save-btn">Save</button>
          <span id="ga-save-status" style="font-size:0.74rem;margin-left:0.5rem;"></span>
        </div>
        <div style="margin-top:0.5rem;font-size:0.74rem;color:var(--text-muted);">
          Guardian Agent evaluates tool actions via LLM before execution. Mutating and network actions are checked; read-only actions are skipped.
        </div>
      `;
      section.querySelector('#ga-save-btn')?.addEventListener('click', async () => {
        const statusEl = section.querySelector('#ga-save-status');
        try {
          await api.updateGuardianAgent({
            enabled: section.querySelector('#ga-enabled').value === 'true',
            llmProvider: section.querySelector('#ga-llm-provider').value,
            failOpen: section.querySelector('#ga-fail-open').value === 'true',
            timeoutMs: parseInt(section.querySelector('#ga-timeout').value, 10) || 8000,
          });
          if (statusEl) { statusEl.textContent = 'Saved'; statusEl.style.color = 'var(--success)'; }
        } catch (err) {
          if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
        }
      });
    } catch (err) {
      body.innerHTML = `<div style="font-size:0.8rem;color:var(--text-secondary);">Guardian Agent status unavailable.</div>`;
    }
  }
  load();
  return section;
}

function createSentinelAuditPanel() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Sentinel Audit</h3>
      <span class="cfg-header-note">Retrospective security analysis</span>
    </div>
    <div class="cfg-center-body">
      <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.75rem;">
        Sentinel analyzes audit logs for anomalous patterns: denial spikes, capability probing, secret detection, and error storms.
        Runs automatically on a cron schedule, or trigger on-demand below.
      </div>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        <button class="btn btn-sm" id="sentinel-run-btn">Run Audit Now</button>
        <span id="sentinel-run-status" style="font-size:0.74rem;"></span>
      </div>
      <div id="sentinel-results" style="margin-top:0.75rem;display:none;"></div>
    </div>
  `;

  section.querySelector('#sentinel-run-btn')?.addEventListener('click', async () => {
    const statusEl = section.querySelector('#sentinel-run-status');
    const resultsEl = section.querySelector('#sentinel-results');
    if (statusEl) { statusEl.textContent = 'Running...'; statusEl.style.color = 'var(--text-muted)'; }
    try {
      const result = await api.runSentinelAudit();
      if (statusEl) {
        const total = (result.anomalies?.length || 0) + (result.llmFindings?.length || 0);
        statusEl.textContent = total > 0 ? total + ' finding(s)' : 'No anomalies detected';
        statusEl.style.color = total > 0 ? 'var(--warning)' : 'var(--success)';
      }
      if (resultsEl && ((result.anomalies?.length || 0) + (result.llmFindings?.length || 0)) > 0) {
        resultsEl.style.display = 'block';
        const items = [
          ...(result.anomalies || []).map(a => `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.8rem;">
            <span class="status-badge ${a.severity === 'critical' ? 'status-error' : 'status-warning'}" style="font-size:0.65rem;">${esc(a.severity)}</span>
            <strong>${esc(a.type)}</strong>: ${esc(a.description)}${a.agentId ? ' <span style="color:var(--text-muted);">('+esc(a.agentId)+')</span>' : ''}
          </div>`),
          ...(result.llmFindings || []).map(f => `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.8rem;">
            <span class="status-badge ${f.severity === 'critical' ? 'status-error' : 'status-warning'}" style="font-size:0.65rem;">${esc(f.severity)}</span>
            ${esc(f.description)}
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem;">Recommendation: ${esc(f.recommendation)}</div>
          </div>`),
        ];
        resultsEl.innerHTML = items.join('');
      } else if (resultsEl) {
        resultsEl.style.display = 'none';
      }
    } catch (err) {
      if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
    }
  });

  return section;
}

function createPolicyEnginePanel() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Policy-as-Code Engine</h3>
      <span class="cfg-header-note">Declarative rule evaluation</span>
    </div>
    <div class="cfg-center-body" id="policy-engine-body">
      <div class="loading" style="font-size:0.8rem;">Loading...</div>
    </div>
  `;

  async function load() {
    const body = section.querySelector('#policy-engine-body');
    if (!body) return;
    try {
      const status = await api.policyStatus();
      const familyMode = (fam) => status.families?.[fam] || status.mode || 'off';

      body.innerHTML = `
        <div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:0.75rem;line-height:1.5;">
          The policy engine evaluates tool requests against declarative JSON rules. Rules are loaded from
          <code style="font-size:0.72rem;background:var(--bg-secondary);padding:0.1rem 0.3rem;border-radius:3px;">${esc(status.rulesPath || 'policies/')}</code>
          and compiled into fast matchers at startup.
        </div>
        <div class="cfg-form-grid">
          <div class="cfg-field">
            <label>Enabled</label>
            <select id="pe-enabled">
              <option value="true" ${status.enabled ? 'selected' : ''}>Enabled</option>
              <option value="false" ${!status.enabled ? 'selected' : ''}>Disabled</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Mode</label>
            <select id="pe-mode">
              <option value="off" ${status.mode === 'off' ? 'selected' : ''}>Off &mdash; engine disabled, legacy decide() only</option>
              <option value="shadow" ${status.mode === 'shadow' ? 'selected' : ''}>Shadow &mdash; compare with legacy, log mismatches (recommended)</option>
              <option value="enforce" ${status.mode === 'enforce' ? 'selected' : ''}>Enforce &mdash; engine is authoritative, replaces legacy logic</option>
            </select>
          </div>
          <div class="cfg-field">
            <label>Mismatch Log Limit</label>
            <input type="number" id="pe-mismatch-limit" value="${status.mismatchLogLimit || 1000}" min="100" max="100000" step="100">
          </div>
        </div>

        <div style="margin-top:0.5rem;">
          <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:0.5rem;font-weight:500;">Per-Family Mode Overrides</div>
          <div class="cfg-form-grid" style="grid-template-columns:1fr 1fr;">
            <div class="cfg-field">
              <label>Tool Family</label>
              <select id="pe-fam-tool">
                <option value="inherit" ${familyMode('tool') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.tool === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.tool === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.tool === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Admin Family</label>
              <select id="pe-fam-admin">
                <option value="inherit" ${familyMode('admin') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.admin === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.admin === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.admin === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Guardian Family</label>
              <select id="pe-fam-guardian">
                <option value="inherit" ${familyMode('guardian') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.guardian === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.guardian === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.guardian === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
            <div class="cfg-field">
              <label>Event Family</label>
              <select id="pe-fam-event">
                <option value="inherit" ${familyMode('event') === status.mode ? 'selected' : ''}>Inherit (${esc(status.mode)})</option>
                <option value="off" ${status.families?.event === 'off' ? 'selected' : ''}>Off</option>
                <option value="shadow" ${status.families?.event === 'shadow' ? 'selected' : ''}>Shadow</option>
                <option value="enforce" ${status.families?.event === 'enforce' ? 'selected' : ''}>Enforce</option>
              </select>
            </div>
          </div>
        </div>

        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-sm" id="pe-save-btn">Save</button>
          <button class="btn btn-sm" id="pe-reload-btn" style="background:var(--bg-secondary);color:var(--text);">Reload Rules</button>
          <span id="pe-save-status" style="font-size:0.74rem;margin-left:0.25rem;"></span>
        </div>

        <div id="pe-stats" style="margin-top:0.75rem;"></div>

        <div style="margin-top:0.5rem;font-size:0.74rem;color:var(--text-muted);line-height:1.45;">
          <strong>Mode descriptions:</strong><br>
          <strong>Off</strong> &mdash; The policy engine is completely disabled. All tool decisions use the legacy <code>decide()</code> logic
          (explicit per-tool overrides, risk classification, and mode-based defaults). No policy evaluation occurs.<br>
          <strong>Shadow</strong> &mdash; The policy engine runs alongside legacy <code>decide()</code> on every tool request.
          Both decisions are computed, but only the legacy decision is used. Mismatches are logged and classified
          (<em>policy_too_strict</em>, <em>policy_too_permissive</em>, <em>normalization_bug</em>, <em>legacy_bug</em>)
          for safe, data-driven migration. This is the recommended starting mode.<br>
          <strong>Enforce</strong> &mdash; The policy engine's decision is authoritative. The legacy <code>decide()</code> path is bypassed entirely.
          Only use this after shadow mode has demonstrated a 99%+ match rate with zero <em>policy_too_permissive</em> mismatches
          over a sustained period (recommended: 14 days).
        </div>
      `;

      // Render shadow stats if available
      if (status.shadowStats && status.shadowStats.totalComparisons > 0) {
        const s = status.shadowStats;
        const rate = (s.matchRate * 100).toFixed(1);
        const statsEl = section.querySelector('#pe-stats');
        if (statsEl) {
          const rateColor = s.matchRate >= 0.99 ? 'var(--success)' : s.matchRate >= 0.95 ? 'var(--warning)' : 'var(--error)';
          statsEl.innerHTML = `
            <div style="font-size:0.74rem;color:var(--text-muted);font-weight:500;margin-bottom:0.3rem;">Shadow Mode Statistics</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:0.5rem;font-size:0.78rem;">
              <div>Comparisons: <strong>${s.totalComparisons.toLocaleString()}</strong></div>
              <div>Mismatches: <strong style="color:${s.totalMismatches > 0 ? 'var(--warning)' : 'var(--success)'}">${s.totalMismatches.toLocaleString()}</strong></div>
              <div>Match rate: <strong style="color:${rateColor}">${rate}%</strong></div>
            </div>
            ${s.totalMismatches > 0 ? `
              <div style="margin-top:0.3rem;font-size:0.72rem;color:var(--text-muted);">
                By class:
                ${Object.entries(s.mismatchesByClass).filter(([,v]) => v > 0).map(([k,v]) => `<span style="margin-right:0.5rem;">${esc(k)}: <strong>${v}</strong></span>`).join('')}
              </div>
            ` : ''}
          `;
        }
      }

      // Rule count
      const statsEl = section.querySelector('#pe-stats');
      if (statsEl && status.ruleCount !== undefined) {
        const countLine = document.createElement('div');
        countLine.style.cssText = 'font-size:0.74rem;color:var(--text-muted);margin-top:0.3rem;';
        countLine.textContent = 'Loaded rules: ' + status.ruleCount;
        statsEl.appendChild(countLine);
      }

      // Save handler
      section.querySelector('#pe-save-btn')?.addEventListener('click', async () => {
        const statusEl = section.querySelector('#pe-save-status');
        try {
          const families = {};
          for (const fam of ['tool', 'admin', 'guardian', 'event']) {
            const val = section.querySelector('#pe-fam-' + fam)?.value;
            if (val && val !== 'inherit') families[fam] = val;
          }
          await api.updatePolicy({
            enabled: section.querySelector('#pe-enabled').value === 'true',
            mode: section.querySelector('#pe-mode').value,
            mismatchLogLimit: parseInt(section.querySelector('#pe-mismatch-limit').value, 10) || 1000,
            families: Object.keys(families).length > 0 ? families : undefined,
          });
          if (statusEl) { statusEl.textContent = 'Saved'; statusEl.style.color = 'var(--success)'; }
        } catch (err) {
          if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
        }
      });

      // Reload handler
      section.querySelector('#pe-reload-btn')?.addEventListener('click', async () => {
        const statusEl = section.querySelector('#pe-save-status');
        try {
          const result = await api.reloadPolicy();
          if (statusEl) {
            statusEl.textContent = `Reloaded: ${result.loaded} rules loaded, ${result.skipped} skipped` +
              (result.errors?.length ? `, ${result.errors.length} error(s)` : '');
            statusEl.style.color = result.errors?.length ? 'var(--warning)' : 'var(--success)';
          }
          // Refresh the panel to update stats
          setTimeout(load, 500);
        } catch (err) {
          if (statusEl) { statusEl.textContent = err.message || 'Error'; statusEl.style.color = 'var(--error)'; }
        }
      });

    } catch (err) {
      body.innerHTML = `<div style="font-size:0.8rem;color:var(--text-secondary);">Policy engine status unavailable.</div>`;
    }
  }
  load();
  return section;
}

function createTrustPresetPanel(config) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const currentPreset = config.guardian?.trustPreset || '';
  section.innerHTML = `
    <div class="table-header"><h3>Trust Preset</h3><span class="cfg-header-note">Quick security posture configuration</span></div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Security Posture</label>
          <select id="trust-preset-select">
            <option value="" ${!currentPreset ? 'selected' : ''}>Custom (no preset)</option>
            <option value="locked" ${currentPreset === 'locked' ? 'selected' : ''}>Locked — read-only, strict limits</option>
            <option value="safe" ${currentPreset === 'safe' ? 'selected' : ''}>Safe — read + email, moderate limits</option>
            <option value="balanced" ${currentPreset === 'balanced' ? 'selected' : ''}>Balanced — read/write/exec, standard limits</option>
            <option value="power" ${currentPreset === 'power' ? 'selected' : ''}>Power — all capabilities, high limits</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Active Preset</label>
          <input type="text" readonly value="${esc(currentPreset || 'none')}" style="opacity:0.7;">
        </div>
      </div>
      <div style="margin-top:0.75rem;font-size:0.74rem;color:var(--text-muted);">Presets set baseline capabilities, rate limits, and tool policies. Changes require a restart.</div>
    </div>
  `;
  return section;
}

function createAuthPanel(config, authStatus, panel) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const mode = 'bearer_required';
  const tokenConfigured = !!authStatus?.tokenConfigured;
  const tokenSource = authStatus?.tokenSource || config.channels?.web?.auth?.tokenSource || 'ephemeral';
  const ttl = authStatus?.sessionTtlMinutes ?? config.channels?.web?.auth?.sessionTtlMinutes ?? '';

  section.innerHTML = `
    <div class="table-header"><h3>Web Authentication</h3><span class="cfg-header-note">Bearer token controls for dashboard and API access</span></div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field"><label>Auth Mode</label><input id="auth-mode" type="text" readonly value="${mode}"></div>
        <div class="cfg-field"><label>Token Source</label><input id="auth-token-source" type="text" value="${esc(tokenSource)}" readonly></div>
        <div class="cfg-field"><label>Session TTL Minutes</label><input id="auth-ttl" type="number" min="1" placeholder="120" value="${esc(String(ttl))}"></div>
        <div class="cfg-field"><label>Current Token</label><input id="auth-token-preview" type="text" readonly value="${tokenConfigured ? esc(authStatus?.tokenPreview || 'configured') : 'not configured'}"></div>
      </div>
      <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);">
        Rotated tokens are runtime-ephemeral and are not written back to local config.
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="auth-save" type="button">Save Auth Settings</button>
        <button class="btn btn-secondary" id="auth-rotate" type="button">Rotate Token</button>
        <button class="btn btn-secondary" id="auth-reveal" type="button">Reveal Token</button>
        <span id="auth-save-status" class="cfg-save-status"></span>
      </div>
    </div>
  `;

  const ttlEl = section.querySelector('#auth-ttl');
  const tokenPreviewEl = section.querySelector('#auth-token-preview');
  const statusEl = section.querySelector('#auth-save-status');
  const setStatus = (text, color) => { statusEl.textContent = text; statusEl.style.color = color; };

  section.querySelector('#auth-save')?.addEventListener('click', async () => {
    const payload = {
      mode: 'bearer_required',
      sessionTtlMinutes: ttlEl.value ? Number(ttlEl.value) : undefined,
    };
    setStatus('Saving...', 'var(--text-muted)');
    try {
      const result = await api.updateAuth(payload);
      setStatus(result.message, result.success ? 'var(--success)' : 'var(--warning)');
      if (result.status?.tokenPreview) tokenPreviewEl.value = result.status.tokenPreview;
    } catch (err) { setStatus(err instanceof Error ? err.message : String(err), 'var(--error)'); }
  });

  section.querySelector('#auth-rotate')?.addEventListener('click', async () => {
    setStatus('Rotating...', 'var(--text-muted)');
    try {
      const result = await api.rotateAuthToken();
      if (result.token) tokenPreviewEl.value = `${result.token.slice(0, 4)}...${result.token.slice(-4)}`;
      setStatus(result.message || 'Ephemeral token rotated.', result.success ? 'var(--success)' : 'var(--warning)');
    } catch (err) { setStatus(err instanceof Error ? err.message : String(err), 'var(--error)'); }
  });

  section.querySelector('#auth-reveal')?.addEventListener('click', async () => {
    setStatus('Revealing...', 'var(--text-muted)');
    try {
      const result = await api.revealAuthToken();
      if (result.success && result.token) { tokenPreviewEl.value = result.token; setStatus('Token revealed. Keep it private.', 'var(--warning)'); }
      else setStatus('No active token.', 'var(--warning)');
    } catch (err) { setStatus(err instanceof Error ? err.message : String(err), 'var(--error)'); }
  });

  applyInputTooltips(section);
  return section;
}

function createDangerZonePanel() {
  const section = document.createElement('div');
  section.className = 'table-container danger-zone';

  const scopes = [
    { scope: 'data', label: 'Clear Data', desc: 'Delete conversations, analytics, audit logs, memory, devices, tasks, and network data. Config is preserved.' },
    { scope: 'config', label: 'Reset Config', desc: 'Reset config.yaml to defaults. All data is preserved.' },
    { scope: 'all', label: 'Clear Everything', desc: 'Delete all data and config, then shut down the server.' },
  ];

  section.innerHTML = `
    <div class="table-header"><h3 style="color: var(--error);">Danger Zone</h3><span class="cfg-header-note">Irreversible reset operations</span></div>
    <div class="cfg-center-body" id="danger-zone-body">
      ${scopes.map(s => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border);">
          <div style="flex: 1;">
            <div style="font-size: 0.82rem; color: var(--text-primary); font-weight: 600;">${esc(s.label)}</div>
            <div style="font-size: 0.74rem; color: var(--text-secondary); margin-top: 0.2rem;">${esc(s.desc)}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; margin-left: 1rem;">
            <button class="btn btn-danger" data-reset-scope="${esc(s.scope)}">${esc(s.label)}</button>
            <span class="cfg-save-status" data-reset-status="${esc(s.scope)}"></span>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  for (const s of scopes) {
    const btn = section.querySelector(`[data-reset-scope="${s.scope}"]`);
    const statusEl = section.querySelector(`[data-reset-status="${s.scope}"]`);
    btn?.addEventListener('click', async () => {
      const msg = s.scope === 'all'
        ? 'This will DELETE all data AND config, then shut down the server. Are you sure?'
        : `This will ${s.label.toLowerCase()}. Are you sure?`;
      if (!confirm(msg)) return;
      btn.disabled = true;
      statusEl.textContent = 'Working...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.factoryReset(s.scope);
        if (s.scope === 'all') {
          const body = section.querySelector('#danger-zone-body');
          if (body) body.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--error); font-size: 0.9rem;">Server is shutting down. Reload the page once the server restarts.</div>';
        } else {
          statusEl.textContent = result.message || 'Done.';
          statusEl.style.color = 'var(--success)';
          btn.disabled = false;
        }
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
        btn.disabled = false;
      }
    });
  }

  return section;
}

// ─── Shared Utilities ────────────────────────────────────

function createMiniCard(title, value, subtitle, tone) {
  const card = document.createElement('div');
  card.className = `status-card ${tone}`;
  card.innerHTML = `<div class="card-title">${esc(title)}</div><div class="card-value">${esc(String(value))}</div><div class="card-subtitle">${esc(String(subtitle))}</div>`;
  return card;
}

function createSection(title, data) {
  const section = document.createElement('div');
  section.className = 'config-section';
  const header = document.createElement('div');
  header.className = 'config-section-header';
  header.innerHTML = `<span>${esc(title)}</span><span class="toggle-icon">&#9654;</span>`;
  const body = document.createElement('div');
  body.className = 'config-section-body';
  body.innerHTML = `<pre>${highlight(JSON.stringify(data, null, 2))}</pre>`;
  let collapsed = true;
  body.style.display = 'none';
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    header.querySelector('.toggle-icon').innerHTML = collapsed ? '&#9654;' : '&#9660;';
  });
  section.append(header, body);
  return section;
}

function highlight(json) {
  return json.replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span class="config-key">$1</span>:')
    .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span class="config-string">$1</span>')
    .replace(/:\s*(\d+(?:\.\d+)?)/g, ': <span class="config-number">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="config-boolean">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="config-null">$1</span>');
}

function badgeForStep(status) {
  if (status === 'complete') return 'badge-idle';
  if (status === 'warning') return 'badge-warn';
  return 'badge-errored';
}

function parseChatIdsOrUndefined(input) {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const parsed = trimmed.split(',').map(part => Number(part.trim())).filter(id => Number.isFinite(id));
  return parsed.length > 0 ? parsed : undefined;
}

function parseCommaList(input) {
  return String(input || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseJsonArray(input, label) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

function summarizeNotificationDestinations(destinations) {
  const enabled = Object.entries(destinations || {})
    .filter(([, isEnabled]) => !!isEnabled)
    .map(([name]) => name.toUpperCase());
  return enabled.length > 0 ? enabled.join(' + ') : 'No channels';
}

function shortId(id) { return id?.slice(0, 8) || ''; }

function formatDate(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
}

function riskClass(risk) {
  if (risk === 'external_post') return 'badge-critical';
  if (risk === 'mutating') return 'badge-errored';
  if (risk === 'network') return 'badge-warn';
  return 'badge-info';
}

function statusClass(status) {
  if (status === 'succeeded') return 'badge-running';
  if (status === 'pending_approval') return 'badge-warn';
  if (status === 'running') return 'badge-running';
  if (status === 'failed' || status === 'denied') return 'badge-errored';
  return 'badge-idle';
}

// ─── Appearance Tab ─────────────────────────────────────

function renderAppearanceTab(panel) {
  const currentTheme = getSavedTheme();
  let activeFilter = 'all';

  panel.innerHTML = `
    ${renderGuidancePanel({
      kicker: 'Appearance',
      compact: true,
      whatItIs: 'This tab controls the visual theme of the Web UI.',
      whatSeeing: 'You are seeing theme filters and preview cards.',
      whatCanDo: 'Pick a theme and preview how the interface will look before switching.',
      howLinks: 'Appearance only changes presentation. It does not affect monitoring, policy, or workflow behavior.',
    })}
    <div class="theme-filter-bar">
      <button class="theme-filter-btn active" data-filter="all">All</button>
      <button class="theme-filter-btn" data-filter="dark">Dark</button>
      <button class="theme-filter-btn" data-filter="light">Light</button>
    </div>
    <div class="theme-grid"></div>
  `;

  const grid = panel.querySelector('.theme-grid');
  const filterBar = panel.querySelector('.theme-filter-bar');

  function renderCards(filter) {
    grid.innerHTML = '';
    const visible = filter === 'all' ? themes : themes.filter(t => t.category === filter);
    for (const theme of visible) {
      const card = document.createElement('div');
      card.className = 'theme-card' + (theme.id === getSavedTheme() ? ' active' : '');
      card.dataset.themeId = theme.id;

      const v = theme.vars;
      card.innerHTML = `
        <div class="theme-preview" style="background:${v['--bg-primary']}">
          <div class="theme-preview-bar" style="background:${v['--bg-surface']};border-right:1px solid ${v['--border']}"></div>
          <div class="theme-preview-main">
            <div class="theme-preview-accent" style="background:${v['--accent']}"></div>
            <div class="theme-preview-line" style="background:${v['--text-primary']}; opacity:0.4"></div>
            <div class="theme-preview-line" style="background:${v['--text-secondary']}; opacity:0.3"></div>
            <div class="theme-preview-line" style="background:${v['--text-muted']}; opacity:0.25"></div>
          </div>
        </div>
        <div class="theme-card-info">
          <div class="theme-card-name">${esc(theme.name)}<span class="theme-card-badge ${theme.category}">${theme.category}</span></div>
          <div class="theme-card-desc">${esc(theme.description)}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        applyTheme(theme.id);
        grid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
      });

      grid.appendChild(card);
    }
  }

  filterBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-filter-btn');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    filterBar.querySelectorAll('.theme-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderCards(activeFilter);
  });

  renderCards(activeFilter);
}

function createGenericHelpFactory(area) {
  const exact = {
    'Credential Refs': {
      whatItIs: 'This section is the registry for advanced environment-backed credential references used by providers, search, and integrations.',
      whatSeeing: 'You are seeing the current ref list, the selected ref editor, and the environment-variable target each ref points at.',
      whatCanDo: 'Create a new env-backed ref, review an existing one, or delete a ref that is no longer needed.',
      howLinks: 'These refs are consumed by provider, search, Telegram, and other config panels when you do not want to paste secrets directly into the UI.',
    },
    'Local Provider Settings': {
      whatItIs: 'This section is the editor for a local AI provider such as Ollama running on the same machine or network.',
      whatSeeing: 'You are seeing the local provider name, provider type, model selection, base URL, and connection or save actions.',
      whatCanDo: 'Configure a local model runtime, test whether Guardian can reach it, and save that provider into the available profile list.',
      howLinks: 'Local providers become selectable model paths for chat, workflows, and tool-routing decisions elsewhere in the product.',
    },
    'External Provider Settings': {
      whatItIs: 'This section is the editor for a hosted AI provider such as OpenAI, Anthropic, Groq, Google, or another external API family.',
      whatSeeing: 'You are seeing provider identity, model selection, credential inputs or refs, optional base URL override, and test or save actions.',
      whatCanDo: 'Configure a hosted provider, validate connectivity, rotate credentials, and save that provider for chat, fallback, or routing use.',
      howLinks: 'External providers supply the hosted model paths used across assistant responses, automations, and failover behavior.',
    },
    'Cloud Configuration': {
      whatItIs: 'This section is the advanced raw-config editor for `assistant.tools.cloud` rather than the guided Cloud page workflow.',
      whatSeeing: 'You are seeing the global cloud-runtime toggle, security notes about inline secret markers, and provider-specific JSON blocks.',
      whatCanDo: 'Inspect or edit the raw cloud config directly when you need an advanced path that is more flexible than the guided Cloud UI.',
      howLinks: 'This is the advanced configuration counterpart to the Cloud page, which remains the primary guided editing surface.',
    },
    'cPanel / WHM': {
      whatItIs: 'This section contains the raw profile array for cPanel and WHM cloud-tool connections.',
      whatSeeing: 'You are seeing the saved cPanel or WHM profiles as JSON together with the field expectations for host, auth, TLS, and default user settings.',
      whatCanDo: 'Review or edit cPanel and WHM profiles directly when you need a raw-config path.',
      howLinks: 'These profiles are consumed by cPanel and WHM tools and mirror the same connection family shown on the Cloud page.',
    },
    Vercel: {
      whatItIs: 'This section contains the raw profile array for Vercel connections used by the cloud-tool layer.',
      whatSeeing: 'You are seeing saved Vercel profiles as JSON together with the keys expected for token, team, slug, and API base URL.',
      whatCanDo: 'Review or edit Vercel profiles directly when you need to inspect or change raw config.',
      howLinks: 'These profiles back Vercel tool calls and mirror the guided Vercel connection flow on the Cloud page.',
    },
    Cloudflare: {
      whatItIs: 'This section contains the raw profile array for Cloudflare connections used by the cloud-tool layer.',
      whatSeeing: 'You are seeing saved Cloudflare profiles as JSON together with the expected account, zone, token, and API URL fields.',
      whatCanDo: 'Review or edit Cloudflare profiles directly when you need a raw-config path instead of the guided editor.',
      howLinks: 'These profiles back Cloudflare tool execution and correspond to the Cloudflare connection family on the Cloud page.',
    },
    AWS: {
      whatItIs: 'This section contains the raw profile array for AWS connections used by the cloud-tool layer.',
      whatSeeing: 'You are seeing saved AWS profiles as JSON including region, credential-ref fields, optional inline credentials, and endpoint overrides.',
      whatCanDo: 'Review or edit AWS profiles directly when you need to inspect advanced fields or override endpoints.',
      howLinks: 'These profiles are used by AWS tools and correspond to the AWS connection workflow on the Cloud page.',
    },
    GCP: {
      whatItIs: 'This section contains the raw profile array for GCP connections used by the cloud-tool layer.',
      whatSeeing: 'You are seeing saved GCP profiles as JSON including project, location, token or service-account refs, and endpoint overrides.',
      whatCanDo: 'Review or edit GCP profiles directly when you need to inspect or change advanced connection fields.',
      howLinks: 'These profiles back GCP tool execution and mirror the GCP connection family on the Cloud page.',
    },
    Azure: {
      whatItIs: 'This section contains the raw profile array for Azure connections used by the cloud-tool layer.',
      whatSeeing: 'You are seeing saved Azure profiles as JSON including subscription, tenant, credential refs, blob URL, and endpoint overrides.',
      whatCanDo: 'Review or edit Azure profiles directly when you need to work at the raw-config layer.',
      howLinks: 'These profiles back Azure tool execution and correspond to the Azure connection workflow on the Cloud page.',
    },
  };

  return (title) => {
    if (exact[title]) return exact[title];
    if (title === 'Add New Local Provider') return exact['Local Provider Settings'];
    if (title === 'Add New External Provider') return exact['External Provider Settings'];
    if (/^Edit\s+/.test(title)) {
      return {
        whatItIs: 'This section is the editor for the currently selected AI provider profile.',
        whatSeeing: 'You are seeing the saved values for that provider together with the fields allowed for model, endpoint, and credential updates.',
        whatCanDo: 'Adjust the selected provider, rotate credentials if needed, retest connectivity, and save the updated profile.',
        howLinks: 'Changes made here update a provider profile that can be used by chat, automations, fallback, and routing elsewhere in Guardian.',
      };
    }
    return null;
  };
}

// ─── Helpers ────────────────────────────────────────────

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}
