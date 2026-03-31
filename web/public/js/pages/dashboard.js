import { api } from '../api.js';
import { createStatusCard, updateStatusCard } from '../components/status-card.js';
import { renderGuidancePanel, renderInfoButton, activateContextHelp, enhanceSectionHelp } from '../components/context-help.js';
import { onSSE, offSSE } from '../app.js';

let cards = {};
let metricsHandler = null;
let currentContainer = null;
const dashboardUiState = {
  routingTraceFilters: {
    continuityKey: '',
    activeExecutionRef: '',
  },
  assistantJobFollowUpResult: null,
};

function normalizeRoutingTraceFilterValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildRoutingTraceQueryParams(limit = 8) {
  const continuityKey = normalizeRoutingTraceFilterValue(dashboardUiState.routingTraceFilters?.continuityKey);
  const activeExecutionRef = normalizeRoutingTraceFilterValue(dashboardUiState.routingTraceFilters?.activeExecutionRef);
  return {
    limit,
    ...(continuityKey ? { continuityKey } : {}),
    ...(activeExecutionRef ? { activeExecutionRef } : {}),
  };
}

async function renderDashboardPreserveScroll(container) {
  const scrollParent = document.getElementById('content') || container.parentElement || document.documentElement;
  const savedScroll = scrollParent.scrollTop;
  await renderDashboard(container);
  requestAnimationFrame(() => { scrollParent.scrollTop = savedScroll; });
}

function resolveActiveLLM(agents = []) {
  const running = agents
    .filter((agent) => agent.state === 'running' && agent.provider && agent.providerModel)
    .sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
  if (running.length > 0) {
    return {
      status: running.length > 1 ? `${running.length} Active` : 'Active',
      subtitle: `${running[0].provider}: ${running[0].providerModel} (${running[0].providerLocality || 'unknown'})`,
      tone: running[0].providerLocality === 'external' ? 'accent' : 'info',
      tooltip: running.length > 1
        ? `Currently active LLM communication is using ${running.length} running agents. Most recent: ${running[0].provider} / ${running[0].providerModel} (${running[0].providerLocality || 'unknown'}).`
        : `Currently active LLM communication is using ${running[0].provider} / ${running[0].providerModel} (${running[0].providerLocality || 'unknown'}).`,
    };
  }

  const queued = agents
    .filter((agent) => agent.state === 'queued' && agent.provider && agent.providerModel)
    .sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
  if (queued.length > 0) {
    return {
      status: queued.length > 1 ? `${queued.length} Queued` : 'Queued',
      subtitle: `${queued[0].provider}: ${queued[0].providerModel} (${queued[0].providerLocality || 'unknown'})`,
      tone: 'warning',
      tooltip: `Queued LLM work is waiting on ${queued[0].provider} / ${queued[0].providerModel} (${queued[0].providerLocality || 'unknown'}).`,
    };
  }

  return {
    status: 'Idle',
    subtitle: 'No active LLM communication',
    tone: 'success',
    tooltip: 'No agent is currently in a running or queued LLM communication state.',
  };
}

export async function renderDashboard(container) {
  currentContainer = container;
  container.innerHTML = '<h2 class="page-title">Dashboard</h2><div class="loading">Loading...</div>';

  try {
    const [agents, summary, providers, readiness, assistantState, recentWarn, recentCritical, routingTrace] = await Promise.all([
      api.agents().catch(() => []),
      api.auditSummary(300000).catch(() => null),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.setupStatus().catch(() => null),
      api.assistantState().catch(() => null),
      api.audit({ severity: 'warn', limit: 6 }).catch(() => []),
      api.audit({ severity: 'critical', limit: 6 }).catch(() => []),
      api.routingTrace(buildRoutingTraceQueryParams(8)).catch(() => ({ entries: [] })),
    ]);

    const defaultProviderName = assistantState?.defaultProvider || null;
    const primaryProvider = defaultProviderName
      ? providers.find((provider) => provider.name === defaultProviderName) || providers[0]
      : providers[0];
    const attentionItems = [...(recentCritical || []), ...(recentWarn || [])]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 8);
    const orchestratorSummary = assistantState?.orchestrator?.summary || {};
    const jobsSummary = assistantState?.jobs?.summary || {};
    const readinessLoaded = !!readiness;
    const warnCount = summary?.bySeverity?.warn || 0;
    const criticalCount = summary?.bySeverity?.critical || 0;
    const totalActiveAlerts = warnCount + criticalCount;
    const runtimeLoaded = !!assistantState;
    const activeLLM = resolveActiveLLM(agents);

    container.innerHTML = `
      <h2 class="page-title">Dashboard</h2>
      ${renderGuidancePanel({
        kicker: 'Orientation',
        title: 'Dashboard at a glance',
        compact: true,
        whatItIs: 'Dashboard is the summary landing page for the whole product. It is meant to tell you whether Guardian is healthy, whether anything urgent is happening, and which owner page you should open next.',
        whatSeeing: 'You are seeing system-health cards, a recent attention queue, agent/runtime metrics, and shortcut links into Security, Cloud, Automations, and Configuration.',
        whatCanDo: 'Use it to orient yourself quickly, spot urgent issues without opening every page, and jump straight into the page that owns the real work.',
        howLinks: 'Dashboard is intentionally summary-only. Investigation, editing, approvals, and workflow changes still happen on the owning pages.',
      })}
    `;

    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'cards-grid';

    cards.runtime = createStatusCard(
      'Guardian Core',
      runtimeLoaded ? 'Online' : 'Degraded',
      runtimeLoaded
        ? `${orchestratorSummary.runningCount || 0} running / ${orchestratorSummary.queuedCount || 0} queued`
        : 'Assistant runtime state unavailable',
      runtimeLoaded ? 'success' : 'warning',
    );
    setCardTooltip(cards.runtime, 'Guardian core runtime status. Shows whether the main system is up and serving requests.');
    cards.readiness = createStatusCard(
      'Readiness',
      !readinessLoaded ? 'Unknown' : readiness.ready ? 'Ready' : 'Needs Review',
      !readinessLoaded
        ? 'Readiness state unavailable'
        : readiness.completed
        ? 'Config baseline complete'
        : 'Complete system configuration',
      readinessLoaded && readiness.ready ? 'success' : 'warning',
    );
    setCardTooltip(cards.readiness, 'Configuration readiness summary. Opens Configuration > System.');
    cards.alerts = createStatusCard(
      'Active Alerts',
      totalActiveAlerts,
      summary ? `${criticalCount} critical / ${warnCount} warn in last 5m` : 'No recent audit summary',
      criticalCount > 0 ? 'error' : totalActiveAlerts > 0 ? 'warning' : 'success',
    );
    setCardTooltip(cards.alerts, 'Count of current warning and critical security events. Opens Security > Security Log.');
    cards.llm = createStatusCard(
      'Primary Provider',
      primaryProvider ? (primaryProvider.connected !== false ? 'Connected' : 'Disconnected') : 'None',
      primaryProvider
        ? `${primaryProvider.name}: ${primaryProvider.model} (${primaryProvider.locality === 'local' ? 'Local' : 'External'})`
        : 'Configure AI & Search',
      primaryProvider ? (primaryProvider.connected !== false ? 'success' : 'warning') : 'warning',
    );
    setCardTooltip(cards.llm, 'Current global default AI provider status and model. Opens Configuration > AI & Search.');
    cards.liveLlm = createStatusCard(
      'Live LLM',
      activeLLM.status,
      activeLLM.subtitle,
      activeLLM.tone,
    );
    setCardTooltip(cards.liveLlm, activeLLM.tooltip);
    cards.agents = createStatusCard(
      'Agents',
      agents.length,
      `${agents.filter((agent) => agent.state === 'running' || agent.state === 'idle').length} available`,
      agents.length > 0 ? 'info' : 'warning',
    );
    setCardTooltip(cards.agents, 'High-level agent count and availability. Opens Automations.');

    bindCard(cards.alerts, '#/security?tab=security-log');
    bindCard(cards.llm, '#/config?tab=ai-search');
    bindCard(cards.readiness, '#/config?tab=system');
    bindCard(cards.agents, '#/automations');
    bindCard(cards.liveLlm, '#/dashboard');

    summaryGrid.append(cards.runtime, cards.readiness, cards.alerts, cards.llm, cards.liveLlm, cards.agents);

    const summarySection = document.createElement('div');
    summarySection.className = 'table-container';
    summarySection.innerHTML = `
      <div class="table-header">
        <div class="section-heading">
          <h3>System Summary</h3>
          ${renderInfoButton('System Summary', {
            whatItIs: 'This strip is the top-level status board for the major Guardian control planes: core runtime, setup readiness, alert pressure, AI provider health, and agent availability.',
            whatSeeing: 'You are seeing one compact card per domain, each showing the current status plus a short subtitle that tells you what is driving that status.',
            whatCanDo: 'Use these cards to confirm whether the platform is basically healthy and click straight into the owner page when one area needs attention.',
            howLinks: 'Each card is only a summary and navigation entry point. It does not replace the actual page that owns configuration or investigation for that domain.',
          })}
        </div>
      </div>
    `;
    summarySection.appendChild(summaryGrid);
    container.appendChild(summarySection);

    container.appendChild(createAttentionSection(attentionItems));
    container.appendChild(createRuntimeSection({ orchestratorSummary, jobsSummary, agents, summary, assistantState }));
    container.appendChild(createRoutingTraceSection({
      traceStatus: assistantState?.intentRoutingTrace || null,
      entries: Array.isArray(routingTrace?.entries) ? routingTrace.entries : [],
    }));
    container.appendChild(createQuickLinksSection());
    enhanceSectionHelp(container, {
      'Needs Attention': {
        whatItIs: 'This section is the short-form attention queue for the most recent warning and critical events that may need operator review.',
        whatSeeing: 'You are seeing a mixed feed of recent high-severity items pulled from audit, monitoring, and automation activity, including their source and short detail text.',
        whatCanDo: 'Use it to spot what is hot right now, then open Security > Security Log when you need acknowledgement, triage, or a fuller incident view.',
        howLinks: 'It is a dashboard preview of urgent activity. The actual incident queue and acknowledgement workflow remain in Security.',
      },
      'Agent Runtime': {
        whatItIs: 'This section summarizes whether the agent layer and job system are healthy enough to keep up with work.',
        whatSeeing: 'You are seeing compact metrics for orchestrator load, queued or recent jobs, and shortcut links into the pages that own the underlying runtime detail.',
        whatCanDo: 'Use it to determine whether Guardian is falling behind, stuck, or healthy, then jump into Automations, Security Log, Cloud, or Configuration for the relevant fix.',
        howLinks: 'It is a runtime summary and navigation surface, not a replacement for the deeper operational tables on the owner pages.',
      },
      'Routing Trace': {
        whatItIs: 'This section is a compact inspector for the durable intent-routing trace log.',
        whatSeeing: 'You are seeing recent gateway and tier-routing decisions, plus optional continuity and active-execution context when that request belonged to an existing thread.',
        whatCanDo: 'Use it to debug why a request was classified, routed, resumed, or answered the way it was without tailing the JSONL log by hand.',
        howLinks: 'It complements the global execution timeline: the routing trace explains classification and routing decisions, while the execution timeline explains what the selected path then did.',
      },
      'Quick Links': {
        whatItIs: 'This section is a shortcut launcher for the pages operators most often need after checking dashboard status.',
        whatSeeing: 'You are seeing direct-entry cards for the alert queue, cloud hub, automation workspace, and AI/search configuration.',
        whatCanDo: 'Use these when you already know the next task and want one click into the correct page without working through the left nav.',
        howLinks: 'Each card opens the canonical owner page or tab for that workflow rather than creating a duplicate mini-workflow inside Dashboard.',
      },
    });
    activateContextHelp(container);
    bindDashboardEvents(container);

    if (metricsHandler) offSSE('metrics', metricsHandler);
    metricsHandler = (data) => {
      if (!data?.agents) return;
      const nextActiveLLM = resolveActiveLLM(data.agents);
      updateStatusCard(
        cards.agents,
        data.agents.length,
        `${data.agents.filter((agent) => agent.state === 'running' || agent.state === 'idle').length} available`,
      );
      cards.agents.className = `status-card ${data.agents.length > 0 ? 'info' : 'warning'} status-card-link`;
      updateStatusCard(cards.liveLlm, nextActiveLLM.status, nextActiveLLM.subtitle);
      cards.liveLlm.className = `status-card ${nextActiveLLM.tone} status-card-link`;
      setCardTooltip(cards.liveLlm, nextActiveLLM.tooltip);
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
      <a class="btn btn-secondary btn-sm" href="#/security?tab=security-log">Open Security Log</a>
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

function createRuntimeSection({ orchestratorSummary, jobsSummary, agents, summary, assistantState }) {
  const sessions = Array.isArray(assistantState?.orchestrator?.sessions) ? assistantState.orchestrator.sessions : [];
  const jobs = Array.isArray(assistantState?.jobs?.jobs) ? assistantState.jobs.jobs.slice(0, 6) : [];
  const agentMap = new Map((agents || []).map((agent) => [agent.id, agent]));
  const activeSessions = sessions
    .filter((session) => session.status === 'running' || session.status === 'queued')
    .sort((a, b) => {
      const aTime = a.lastStartedAt || a.lastQueuedAt || 0;
      const bTime = b.lastStartedAt || b.lastQueuedAt || 0;
      return bTime - aTime;
    })
    .slice(0, 8);
  const recentSessions = activeSessions.length > 0
    ? activeSessions
    : sessions
      .slice()
      .sort((a, b) => (b.lastCompletedAt || b.lastStartedAt || b.lastQueuedAt || 0) - (a.lastCompletedAt || a.lastStartedAt || a.lastQueuedAt || 0))
      .slice(0, 5);

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
        <tr><td>Security</td><td>${summary ? summary.totalEvents : 0} audit events in the last 5 minutes</td><td><a href="#/security?tab=security-log">Open Security Log</a></td></tr>
        <tr><td>Cloud</td><td>Connections, activity, and cloud automations live in the dedicated Cloud hub</td><td><a href="#/cloud">Open Cloud</a></td></tr>
        <tr><td>Configuration</td><td>Provider setup, integrations, system policy, and appearance live in Config</td><td><a href="#/config">Open Config</a></td></tr>
      </tbody>
    </table>
    <table style="margin-top:1rem;">
      <thead><tr><th>Session</th><th>Status</th><th>Agent</th><th>Provider</th><th>Model</th><th>Last Activity</th></tr></thead>
      <tbody>
        ${recentSessions.length === 0
          ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active agent sessions.</td></tr>'
          : recentSessions.map((session) => {
            const agent = agentMap.get(session.agentId);
            const statusBadgeClass = session.status === 'running'
              ? 'badge-running'
              : session.status === 'queued'
              ? 'badge-queued'
              : 'badge-idle';
            const providerSummary = agent?.provider
              ? `${esc(agent.provider)}${agent.providerType ? ` (${esc(agent.providerType)})` : ''}`
              : '-';
            const modelSummary = agent?.providerModel
              ? `${esc(agent.providerModel)}${agent.providerLocality ? ` • ${esc(agent.providerLocality)}` : ''}`
              : '-';
            const activityTs = session.lastStartedAt || session.lastQueuedAt || session.lastCompletedAt;
            return `
              <tr>
                <td title="${escAttr(`${session.channel}:${session.userId}:${session.agentId}`)}">${esc(session.channel)}:${esc(session.userId)}</td>
                <td><span class="badge ${statusBadgeClass}">${esc(session.status)}</span></td>
                <td>${esc(agent?.name || session.agentId)}</td>
                <td>${providerSummary}</td>
                <td>${modelSummary}</td>
                <td>${activityTs ? esc(formatTime(activityTs)) : '-'}</td>
              </tr>
            `;
          }).join('')}
      </tbody>
    </table>
    <table style="margin-top:1rem;">
      <thead><tr><th>Job</th><th>Status</th><th>Origin</th><th>Outcome</th><th>Started</th><th>Actions</th></tr></thead>
      <tbody>
        ${jobs.length === 0
          ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent background or delegated jobs.</td></tr>'
          : jobs.map((job) => `
              <tr>
                <td>${esc(job.type || '-')}</td>
                <td><span class="badge ${job.status === 'failed' ? 'badge-warn' : job.status === 'running' ? 'badge-running' : 'badge-info'}">${esc(job.status || '-')}</span></td>
                <td>${esc(summarizeAssistantJobOrigin(job))}</td>
                <td>${esc(summarizeAssistantJobOutcome(job))}</td>
                <td>${job.startedAt ? esc(formatTime(job.startedAt)) : '-'}</td>
                <td>${renderAssistantJobActions(job)}</td>
              </tr>
            `).join('')}
      </tbody>
    </table>
    ${renderAssistantJobFollowUpResult()}
  `;
  return section;
}

function readDelegationJobMetadata(job) {
  const delegation = job?.metadata?.delegation;
  return delegation && typeof delegation === 'object' ? delegation : null;
}

function summarizeAssistantJobOrigin(job) {
  if (job?.display?.originSummary) {
    return job.display.originSummary;
  }
  const delegation = readDelegationJobMetadata(job);
  if (delegation) {
    const parts = [
      typeof delegation.originChannel === 'string' ? delegation.originChannel : '',
      typeof delegation.codeSessionId === 'string' ? `code ${delegation.codeSessionId}` : '',
      typeof delegation.continuityKey === 'string' ? `continuity ${delegation.continuityKey}` : '',
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' • ');
  }
  return job?.source || '-';
}

function summarizeAssistantJobOutcome(job) {
  if (job?.display?.outcomeSummary) {
    const parts = [
      job.display.outcomeSummary,
      job.display.followUp?.label,
      job.display.followUp?.nextAction,
    ].filter(Boolean);
    return parts.join(' • ');
  }
  const delegation = readDelegationJobMetadata(job);
  const handoff = delegation?.handoff && typeof delegation.handoff === 'object' ? delegation.handoff : null;
  const parts = [
    typeof handoff?.summary === 'string' ? handoff.summary : '',
    typeof handoff?.unresolvedBlockerKind === 'string' ? `blocker ${handoff.unresolvedBlockerKind}` : '',
  ].filter(Boolean);
  return parts.join(' • ') || job?.detail || job?.error || '-';
}

function renderAssistantJobActions(job) {
  const actions = Array.isArray(job?.display?.followUp?.actions) ? job.display.followUp.actions : [];
  if (actions.length === 0) {
    return '<span class="ops-task-sub">-</span>';
  }
  return `
    <div style="display:flex;gap:0.35rem;flex-wrap:wrap">
      ${actions.includes('replay')
        ? `<button class="btn btn-secondary btn-sm" type="button" data-assistant-job-action="replay" data-assistant-job-id="${escAttr(job.id || '')}">Replay</button>`
        : ''}
      ${actions.includes('keep_held')
        ? `<button class="btn btn-secondary btn-sm" type="button" data-assistant-job-action="keep_held" data-assistant-job-id="${escAttr(job.id || '')}">Keep Held</button>`
        : ''}
      ${actions.includes('dismiss')
        ? `<button class="btn btn-secondary btn-sm" type="button" data-assistant-job-action="dismiss" data-assistant-job-id="${escAttr(job.id || '')}">Dismiss</button>`
        : ''}
    </div>
  `;
}

function renderAssistantJobFollowUpResult() {
  const result = dashboardUiState.assistantJobFollowUpResult;
  if (!result || typeof result !== 'object') return '';
  const tone = result.success ? 'var(--success)' : 'var(--warning)';
  const content = typeof result.content === 'string' && result.content.trim().length > 0
    ? `<pre style="margin:0.65rem 0 0;white-space:pre-wrap;background:var(--bg-elevated);padding:0.75rem;border-radius:8px;border:1px solid var(--border-color)">${esc(result.content)}</pre>`
    : '';
  return `
    <div style="padding:0.85rem 1rem 0;color:${tone}">
      <div style="font-weight:600">${esc(result.message || '')}</div>
      ${content}
    </div>
  `;
}

function createQuickLinksSection() {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header"><h3>Quick Links</h3></div>
    <div class="cards-grid" style="padding:1rem;">
      ${renderQuickLink('Security Log', 'Unified alert queue, triage, and audit evidence', '#/security?tab=security-log', 'warning', 'Open Security > Security Log for triage, acknowledgement, source filtering, and audit review.')}
      ${renderQuickLink('Cloud Hub', 'Connections, activity, and cloud-focused automations', '#/cloud', 'info', 'Open Cloud for provider connections, activity, and cloud automation entry points.')}
      ${renderQuickLink('Automations', 'Workflows, schedules, runs, and output routing', '#/automations', 'accent', 'Open Automations for workflow editing, scheduling, run history, and output routing.')}
      ${renderQuickLink('AI & Search', 'Provider setup, embeddings, and retrieval settings', '#/config?tab=ai-search', 'success', 'Open Configuration > AI & Search for provider, search, and retrieval setup.')}
    </div>
  `;
  return section;
}

function createRoutingTraceSection({ traceStatus, entries }) {
  const continuityKey = normalizeRoutingTraceFilterValue(dashboardUiState.routingTraceFilters?.continuityKey);
  const activeExecutionRef = normalizeRoutingTraceFilterValue(dashboardUiState.routingTraceFilters?.activeExecutionRef);
  const filtersActive = Boolean(continuityKey || activeExecutionRef);
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Routing Trace</h3>
      <div class="ops-task-sub">${traceStatus?.enabled ? esc(traceStatus.filePath || '') : 'Routing trace disabled'}</div>
    </div>
    <form id="dashboard-routing-trace-filter-form" style="padding:0 1rem 1rem;display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end">
      <div class="cfg-field" style="flex:1 1 16rem;min-width:14rem;margin:0">
        <label for="dashboard-routing-continuity-key">Continuity Key</label>
        <input id="dashboard-routing-continuity-key" type="text" placeholder="shared-tier:owner" value="${escAttr(continuityKey)}">
      </div>
      <div class="cfg-field" style="flex:1 1 16rem;min-width:14rem;margin:0">
        <label for="dashboard-routing-active-exec-ref">Active Execution Ref</label>
        <input id="dashboard-routing-active-exec-ref" type="text" placeholder="code_session:Repo Fix" value="${escAttr(activeExecutionRef)}">
      </div>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
        <button class="btn btn-secondary btn-sm" type="button" id="dashboard-routing-trace-filter-clear">Clear</button>
      </div>
    </form>
    <table>
      <thead><tr><th>Time</th><th>Stage</th><th>Session</th><th>Agent</th><th>Preview</th><th>Detail</th><th>Run</th></tr></thead>
      <tbody>
        ${renderRoutingTraceRows(entries, filtersActive)}
      </tbody>
    </table>
    ${traceStatus?.lastError ? `<div style="padding:0.75rem 1rem;color:var(--warning)">Last trace write error: ${esc(traceStatus.lastError)}</div>` : ''}
  `;
  return section;
}

function renderRoutingTraceRows(entries, filtersActive) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return `<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">${
      filtersActive
        ? 'No routing trace entries matched the current filters.'
        : 'No recent routing trace entries.'
    }</td></tr>`;
  }
  return entries.map((entry) => `
    <tr>
      <td>${formatTime(entry.timestamp)}</td>
      <td>${esc(entry.stage || '-')}</td>
      <td title="${escAttr(`${entry.channel || '-'}:${entry.userId || '-'}`)}">${esc(entry.channel || '-')}:${esc(entry.userId || '-')}</td>
      <td>${esc(entry.agentId || '-')}</td>
      <td title="${escAttr(entry.contentPreview || '')}">${esc(entry.contentPreview || '-')}</td>
      <td title="${escAttr(formatRoutingTraceDetail(entry))}">${esc(formatRoutingTraceDetail(entry))}</td>
      <td>${renderRoutingTraceRunCell(entry)}</td>
    </tr>
  `).join('');
}

function renderRoutingTraceRunCell(entry) {
  if (entry?.matchedRun?.href) {
    return `
      <div style="display:flex;flex-direction:column;gap:0.35rem;min-width:13rem">
        <div style="font-weight:600">${esc(entry.matchedRun.title || entry.matchedRun.runId || 'Run')}</div>
        <div style="display:flex;gap:0.35rem;flex-wrap:wrap;align-items:center">
          <span class="badge badge-info">${esc(entry.matchedRun.kind || 'run')}</span>
          <span class="ops-task-sub">${esc(entry.matchedRun.status || 'unknown')}</span>
        </div>
        <div class="ops-task-sub">${esc(entry.matchedRun.runId || '')}</div>
        ${entry.matchedRun.codeSessionId ? `<div class="ops-task-sub">session ${esc(entry.matchedRun.codeSessionId)}</div>` : ''}
        ${entry.matchedRun.focusItemTitle ? `<div class="ops-task-sub">event ${esc(entry.matchedRun.focusItemTitle)}</div>` : ''}
        <div style="display:flex;gap:0.4rem;flex-wrap:wrap">
          <a class="btn btn-secondary btn-sm" href="${escAttr(entry.matchedRun.href)}" title="${escAttr(entry.matchedRun.title || entry.matchedRun.runId)}">Open Run</a>
          ${entry.matchedRun.focusItemHref
            ? `<a class="btn btn-secondary btn-sm" href="${escAttr(entry.matchedRun.focusItemHref)}" title="${escAttr(entry.matchedRun.focusItemTitle || 'Timeline event')}">Open Event</a>`
            : ''}
          ${entry.matchedRun.codeSessionHref
            ? `<a class="btn btn-secondary btn-sm" href="${escAttr(entry.matchedRun.codeSessionHref)}" title="${escAttr(entry.matchedRun.focusItemTitle || entry.matchedRun.codeSessionId || 'Coding session')}">${entry.matchedRun.focusItemTitle ? 'Open Session Event' : 'Open Session'}</a>`
            : ''}
        </div>
      </div>
    `;
  }
  return `<span class="ops-task-sub">${esc(entry?.requestId || '-')}</span>`;
}

function formatRoutingTraceDetail(entry) {
  const details = entry?.details && typeof entry.details === 'object' ? entry.details : {};
  const parts = [
    typeof details.route === 'string' ? `route ${details.route}` : '',
    typeof details.tier === 'string' ? `tier ${details.tier}` : '',
    typeof details.reason === 'string' ? details.reason : '',
    typeof details.continuityKey === 'string' ? `continuity ${details.continuityKey}` : '',
    Array.isArray(details.activeExecutionRefs) && details.activeExecutionRefs.length > 0
      ? `exec ${(details.activeExecutionRefs || []).slice(0, 2).join(' | ')}`
      : '',
    typeof details.contextAssemblySummary === 'string' ? details.contextAssemblySummary : '',
  ].filter(Boolean);
  return parts.join(' | ') || '-';
}

function bindDashboardEvents(container) {
  container.querySelectorAll('[data-assistant-job-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobId = button.getAttribute('data-assistant-job-id') || '';
      const action = button.getAttribute('data-assistant-job-action') || '';
      if (!jobId || !action) return;
      button.disabled = true;
      try {
        const result = await api.assistantJobFollowUp({ jobId, action });
        dashboardUiState.assistantJobFollowUpResult = {
          success: result?.success !== false,
          message: result?.message || 'Updated delegated job follow-up state.',
          content: typeof result?.details?.content === 'string' ? result.details.content : '',
        };
      } catch (err) {
        dashboardUiState.assistantJobFollowUpResult = {
          success: false,
          message: err instanceof Error ? err.message : String(err),
          content: '',
        };
      } finally {
        button.disabled = false;
        void renderDashboardPreserveScroll(container);
      }
    });
  });

  const routingTraceForm = container.querySelector('#dashboard-routing-trace-filter-form');
  routingTraceForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    dashboardUiState.routingTraceFilters = {
      continuityKey: normalizeRoutingTraceFilterValue(container.querySelector('#dashboard-routing-continuity-key')?.value),
      activeExecutionRef: normalizeRoutingTraceFilterValue(container.querySelector('#dashboard-routing-active-exec-ref')?.value),
    };
    void renderDashboardPreserveScroll(container);
  });

  container.querySelector('#dashboard-routing-trace-filter-clear')?.addEventListener('click', () => {
    dashboardUiState.routingTraceFilters = {
      continuityKey: '',
      activeExecutionRef: '',
    };
    const continuityInput = container.querySelector('#dashboard-routing-continuity-key');
    const activeExecutionInput = container.querySelector('#dashboard-routing-active-exec-ref');
    if (continuityInput) continuityInput.value = '';
    if (activeExecutionInput) activeExecutionInput.value = '';
    void renderDashboardPreserveScroll(container);
  });
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
