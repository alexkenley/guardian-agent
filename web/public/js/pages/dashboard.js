import { api } from '../api.js';
import { createStatusCard, updateStatusCard } from '../components/status-card.js';
import { renderGuidancePanel, renderInfoButton, activateContextHelp, enhanceSectionHelp } from '../components/context-help.js';
import { onSSE, offSSE } from '../app.js';

let cards = {};
let metricsHandler = null;
let currentContainer = null;

export async function renderDashboard(container) {
  currentContainer = container;
  container.innerHTML = '<h2 class="page-title">Dashboard</h2><div class="loading">Loading...</div>';

  try {
    const [agents, summary, providers, readiness, assistantState, recentWarn, recentCritical] = await Promise.all([
      api.agents().catch(() => []),
      api.auditSummary(300000).catch(() => null),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.setupStatus().catch(() => null),
      api.assistantState().catch(() => null),
      api.audit({ severity: 'warn', limit: 6 }).catch(() => []),
      api.audit({ severity: 'critical', limit: 6 }).catch(() => []),
    ]);

    const primaryProvider = providers[0];
    const attentionItems = [...(recentCritical || []), ...(recentWarn || [])]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 8);
    const orchestratorSummary = assistantState?.orchestrator?.summary || {};
    const jobsSummary = assistantState?.jobs?.summary || {};

    container.innerHTML = `
      <h2 class="page-title">Dashboard</h2>
      ${renderGuidancePanel({
        kicker: 'Orientation',
        title: 'Dashboard at a glance',
        compact: true,
        whatItIs: 'This is the landing page for quick health checks and cross-app orientation.',
        whatSeeing: 'You are seeing compact status across runtime, readiness, alerts, providers, and the fastest links into each owner page.',
        whatCanDo: 'Use it to spot attention items, confirm the system is healthy, and jump into Security, Cloud, Automations, or Configuration.',
        howLinks: 'Dashboard summarizes multiple domains, but deep investigation and editing always happen on the owning page.',
      })}
    `;

    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'cards-grid';

    cards.runtime = createStatusCard('Guardian Core', 'Online', 'System operational', 'success');
    setCardTooltip(cards.runtime, 'Guardian core runtime status. Shows whether the main system is up and serving requests.');
    cards.readiness = createStatusCard(
      'Readiness',
      readiness?.ready ? 'Ready' : 'Needs Review',
      readiness?.completed ? 'Config baseline complete' : 'Complete system configuration',
      readiness?.ready ? 'success' : 'warning',
    );
    setCardTooltip(cards.readiness, 'Configuration readiness summary. Opens Configuration > System.');
    cards.alerts = createStatusCard(
      'Active Alerts',
      summary ? (summary.bySeverity.warn + summary.bySeverity.critical) : 0,
      summary ? `${summary.bySeverity.critical} critical in last 5m` : 'No recent audit summary',
      summary && summary.bySeverity.critical > 0 ? 'error' : 'warning',
    );
    setCardTooltip(cards.alerts, 'Count of current warning and critical security events. Opens Security > Alerts.');
    cards.llm = createStatusCard(
      'Primary Provider',
      primaryProvider ? (primaryProvider.connected !== false ? 'Connected' : 'Disconnected') : 'None',
      primaryProvider ? `${primaryProvider.model} (${primaryProvider.locality === 'local' ? 'Local' : 'External'})` : 'Configure AI & Search',
      primaryProvider ? (primaryProvider.connected !== false ? 'success' : 'warning') : 'warning',
    );
    setCardTooltip(cards.llm, 'Current primary AI provider status and model. Opens Configuration > AI & Search.');
    cards.agents = createStatusCard(
      'Agents',
      agents.length,
      `${agents.filter((agent) => agent.state === 'running' || agent.state === 'idle').length} available`,
      'info',
    );
    setCardTooltip(cards.agents, 'High-level agent count and availability. Opens Automations.');

    bindCard(cards.alerts, '#/security?tab=alerts');
    bindCard(cards.llm, '#/config?tab=ai-search');
    bindCard(cards.readiness, '#/config?tab=system');
    bindCard(cards.agents, '#/automations');

    summaryGrid.append(cards.runtime, cards.readiness, cards.alerts, cards.llm, cards.agents);

    const summarySection = document.createElement('div');
    summarySection.className = 'table-container';
    summarySection.innerHTML = `
      <div class="table-header">
        <div class="section-heading">
          <h3>System Summary</h3>
          ${renderInfoButton('System Summary', {
            whatItIs: 'This is the dashboard summary strip for the major product domains.',
            whatSeeing: 'You are seeing compact cards for Guardian core health, setup readiness, active alerts, the current provider, and agent availability.',
            whatCanDo: 'Use these cards to confirm health quickly and jump straight into the owning page for follow-up work.',
            howLinks: 'Each linked card routes into the canonical owner page instead of opening a duplicate control plane inside Dashboard.',
          })}
        </div>
      </div>
    `;
    summarySection.appendChild(summaryGrid);
    container.appendChild(summarySection);

    container.appendChild(createAttentionSection(attentionItems));
    container.appendChild(createRuntimeSection({ orchestratorSummary, jobsSummary, agents, summary }));
    container.appendChild(createQuickLinksSection());
    enhanceSectionHelp(container, {
      'Needs Attention': {
        whatItIs: 'This is the compact attention queue for the most recent warning and critical events.',
        whatSeeing: 'You are seeing a mixed list of recent issues from audit, automation, and monitoring sources.',
        whatCanDo: 'Review the highest-priority items here, then open Security > Alerts for full triage and acknowledgement.',
        howLinks: 'This list points toward Security for action, while Dashboard stays summary-only.',
      },
      'Agent Runtime': {
        whatItIs: 'This section summarizes request volume, queue health, jobs, and where to go for deeper runtime work.',
        whatSeeing: 'You are seeing compact runtime metrics plus direct links into Automations, Audit, Cloud, and Configuration.',
        whatCanDo: 'Use it to tell whether the system is keeping up with work and to navigate into the operational surface that owns the detail.',
        howLinks: 'It links outward to the owner pages instead of reproducing their full tables here.',
      },
      'Quick Links': {
        whatItIs: 'This is a fast-launch set of high-value destinations for common operator tasks.',
        whatSeeing: 'You are seeing cards for the alert queue, cloud hub, automations, and AI/search configuration.',
        whatCanDo: 'Use these links when you know the task you want and do not need to scan the left navigation first.',
        howLinks: 'Each card opens the canonical owner page or tab for that workflow.',
      },
    });
    activateContextHelp(container);

    if (metricsHandler) offSSE('metrics', metricsHandler);
    metricsHandler = (data) => {
      if (!data?.agents) return;
      updateStatusCard(
        cards.agents,
        data.agents.length,
        `${data.agents.filter((agent) => agent.state === 'running' || agent.state === 'idle').length} available`,
      );
    };
    onSSE('metrics', metricsHandler);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Dashboard</h2><div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

export function updateDashboard() {
  if (currentContainer) {
    void renderDashboard(currentContainer);
  }
}

function createAttentionSection(items) {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Needs Attention</h3>
      <a class="btn btn-secondary btn-sm" href="#/security?tab=alerts">Open Alerts</a>
    </div>
    <table>
      <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Source</th><th>Detail</th></tr></thead>
      <tbody>
        ${items.length === 0
          ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Nothing urgent right now.</td></tr>'
          : items.map((item) => `
            <tr>
              <td>${formatTime(item.timestamp)}</td>
              <td>${esc(item.type)}</td>
              <td><span class="badge badge-${esc(item.severity)}">${esc(item.severity)}</span></td>
              <td>${esc(item.details?.automationName || item.details?.source || item.agentId || '-')}</td>
              <td title="${escAttr(item.details?.description || item.details?.reason || '')}">${esc(item.details?.description || item.details?.reason || '-')}</td>
            </tr>
          `).join('')}
      </tbody>
    </table>
  `;
  return section;
}

function createRuntimeSection({ orchestratorSummary, jobsSummary, agents, summary }) {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header"><h3>Agent Runtime</h3></div>
    <div class="cards-grid" style="padding:1rem;">
      ${renderMiniCard('Sessions', orchestratorSummary.sessionCount || 0, `${orchestratorSummary.runningCount || 0} running / ${orchestratorSummary.queuedCount || 0} queued`, 'info', 'Assistant session volume and queue depth across active conversations.')}
      ${renderMiniCard('Requests', orchestratorSummary.totalRequests || 0, `${orchestratorSummary.failedRequests || 0} failed`, (orchestratorSummary.failedRequests || 0) > 0 ? 'warning' : 'success', 'Total assistant requests processed, including failures.')}
      ${renderMiniCard('Latency', `${orchestratorSummary.avgEndToEndMs || 0}ms`, 'Average end-to-end', 'accent', 'Average end-to-end request time through routing, tool use, and response delivery.')}
      ${renderMiniCard('Jobs', jobsSummary.total || 0, `${jobsSummary.running || 0} running / ${jobsSummary.failed || 0} failed`, (jobsSummary.failed || 0) > 0 ? 'warning' : 'success', 'Background job summary for async and deferred work.')}
    </div>
    <table>
      <thead><tr><th>Area</th><th>Summary</th><th>Destination</th></tr></thead>
      <tbody>
        <tr><td>Agents</td><td>${agents.length} total • ${agents.filter((agent) => agent.state === 'running').length} running • ${agents.filter((agent) => agent.state === 'idle').length} idle</td><td><a href="#/automations">Open Automations</a></td></tr>
        <tr><td>Security</td><td>${summary ? summary.totalEvents : 0} audit events in the last 5 minutes</td><td><a href="#/security?tab=audit">Open Audit</a></td></tr>
        <tr><td>Cloud</td><td>Connections, activity, and cloud automations live in the dedicated Cloud hub</td><td><a href="#/cloud">Open Cloud</a></td></tr>
        <tr><td>Configuration</td><td>Provider setup, integrations, system policy, and appearance live in Config</td><td><a href="#/config">Open Config</a></td></tr>
      </tbody>
    </table>
  `;
  return section;
}

function createQuickLinksSection() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header"><h3>Quick Links</h3></div>
    <div class="cards-grid" style="padding:1rem;">
      ${renderQuickLink('Security Alerts', 'Unified alert queue and triage', '#/security?tab=alerts', 'warning', 'Open Security > Alerts for triage, acknowledgement, and source filtering.')}
      ${renderQuickLink('Cloud Hub', 'Connections, activity, and cloud-focused automations', '#/cloud', 'info', 'Open Cloud for provider connections, activity, and cloud automation entry points.')}
      ${renderQuickLink('Automations', 'Workflows, schedules, runs, and output routing', '#/automations', 'accent', 'Open Automations for workflow editing, scheduling, run history, and output routing.')}
      ${renderQuickLink('AI & Search', 'Provider setup, embeddings, and retrieval settings', '#/config?tab=ai-search', 'success', 'Open Configuration > AI & Search for provider, search, and retrieval setup.')}
    </div>
  `;
  return section;
}

function renderMiniCard(title, value, subtitle, tone, tooltip) {
  return `
    <div class="status-card ${tone}" title="${escAttr(tooltip || subtitle)}" aria-label="${escAttr(tooltip || subtitle)}">
      <div class="card-title">${esc(title)}</div>
      <div class="card-value">${esc(String(value))}</div>
      <div class="card-subtitle">${esc(String(subtitle))}</div>
    </div>
  `;
}

function renderQuickLink(title, subtitle, href, tone, tooltip) {
  return `
    <a class="status-card ${tone} status-card-link" href="${escAttr(href)}" style="text-decoration:none" title="${escAttr(tooltip || subtitle)}" aria-label="${escAttr(tooltip || subtitle)}">
      <div class="card-title">${esc(title)}</div>
      <div class="card-value">Open</div>
      <div class="card-subtitle">${esc(subtitle)}</div>
    </a>
  `;
}

function bindCard(card, href) {
  card.classList.add('status-card-link');
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  if (!card.getAttribute('title')) {
    card.setAttribute('title', `Open ${href.replace(/^#\//, '')}`);
  }
  if (!card.getAttribute('aria-label')) {
    card.setAttribute('aria-label', card.getAttribute('title'));
  }
  const action = () => { window.location.hash = href; };
  card.addEventListener('click', action);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  });
}

function setCardTooltip(card, text) {
  card.setAttribute('title', text);
  card.setAttribute('aria-label', text);
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleTimeString();
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(str) {
  return esc(str).replace(/"/g, '&quot;');
}
