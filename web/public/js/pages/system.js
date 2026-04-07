import { api } from '../api.js';
import { createStatusCard, updateStatusCard } from '../components/status-card.js';
import { renderGuidancePanel, renderInfoButton, activateContextHelp, enhanceSectionHelp } from '../components/context-help.js';
import { onSSE, offSSE } from '../app.js';

let cards = {};
let metricsHandler = null;
let currentContainer = null;
const systemUiState = {
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
  const continuityKey = normalizeRoutingTraceFilterValue(systemUiState.routingTraceFilters?.continuityKey);
  const activeExecutionRef = normalizeRoutingTraceFilterValue(systemUiState.routingTraceFilters?.activeExecutionRef);
  return {
    limit,
    ...(continuityKey ? { continuityKey } : {}),
    ...(activeExecutionRef ? { activeExecutionRef } : {}),
  };
}

async function renderSystemPreserveScroll(container) {
  const scrollParent = document.getElementById('content') || container.parentElement || document.documentElement;
  const savedScroll = scrollParent.scrollTop;
  await renderSystem(container);
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

function resolvePerformanceSummary(status) {
  const snapshot = status?.snapshot ?? {};
  const cpu = Number.isFinite(snapshot.cpuPercent) ? Math.round(snapshot.cpuPercent) : null;
  const memory = Number.isFinite(snapshot.memoryPercent) ? Math.round(snapshot.memoryPercent) : null;
  const severity = cpu != null && cpu >= 85
    ? 'error'
    : cpu != null && cpu >= 65
    ? 'warning'
    : memory != null && memory >= 85
    ? 'error'
    : memory != null && memory >= 70
    ? 'warning'
    : 'success';

  return {
    value: status?.activeProfile || 'Unknown',
    subtitle: cpu != null || memory != null
      ? `${cpu != null ? `${cpu}% CPU` : 'CPU unknown'}${memory != null ? ` • ${memory}% memory` : ''}`
      : 'Host summary unavailable',
    tone: severity,
    tooltip: 'Active performance profile plus the latest host-pressure sample from the Performance page.',
  };
}

function resolveSecuritySummary(posture, alerts, assistantSummary, intelSummary) {
  const alertCount = Number(alerts?.totalMatches || 0);
  const criticalCount = Number(alerts?.bySeverity?.critical || 0);
  const highCount = Number(alerts?.bySeverity?.high || 0);
  const assistantFindings = Number(assistantSummary?.findings?.highOrCritical || 0);
  const intelFindings = Number(intelSummary?.findings?.highOrCritical || 0);
  const mode = formatSecurityMode(posture?.recommendedMode || posture?.currentMode || 'unknown');
  const tone = criticalCount > 0
    ? 'error'
    : highCount > 0 || alertCount > 0 || posture?.shouldEscalate
      ? 'warning'
      : assistantFindings > 0 || intelFindings > 0
        ? 'info'
        : 'success';
  return {
    value: mode,
    subtitle: `${alertCount} alerts • ${assistantFindings} assistant • ${intelFindings} intel`,
    tone,
    tooltip: 'Shared security posture summary from Security Overview, including active alert pressure and the current open review queues.',
    alertCount,
    assistantFindings,
    intelFindings,
  };
}

function resolveAutomationSummary(state) {
  const summary = state?.summary || {};
  const enabled = summary.enabled === true;
  const playbookCount = Number(summary.playbookCount || 0);
  const enabledPlaybookCount = Number(summary.enabledPlaybookCount || 0);
  const runCount = Number(summary.runCount || 0);
  return {
    value: enabled ? 'Enabled' : 'Disabled',
    subtitle: `${enabledPlaybookCount}/${playbookCount} playbooks • ${runCount} tracked runs`,
    tone: enabled ? 'success' : 'warning',
    tooltip: 'Automation engine status, enabled playbook count, and tracked execution history from the Automations page.',
    playbookCount,
    enabledPlaybookCount,
    runCount,
  };
}

function resolveCodeWorkspaceSummary(codeSessionsPayload) {
  const sessions = Array.isArray(codeSessionsPayload?.sessions) ? codeSessionsPayload.sessions : [];
  const currentSessionId = typeof codeSessionsPayload?.currentSessionId === 'string'
    ? codeSessionsPayload.currentSessionId
    : null;
  const currentSession = currentSessionId
    ? sessions.find((session) => session.id === currentSessionId) || null
    : null;
  const activeCount = sessions.filter((session) => session.status === 'running' || session.status === 'queued').length;
  if (currentSession) {
    const tone = currentSession.status === 'running'
      ? 'accent'
      : currentSession.status === 'queued'
        ? 'warning'
        : 'info';
    return {
      value: currentSession.status === 'running'
        ? 'Running'
        : currentSession.status === 'queued'
          ? 'Queued'
          : 'Attached',
      subtitle: `${currentSession.title || 'Coding session'} • ${sessions.length} total`,
      tone,
      tooltip: 'The currently attached shared coding workspace plus the overall workspace count from the Code page.',
      currentSession,
      sessions,
      activeCount,
    };
  }
  if (sessions.length > 0) {
    return {
      value: `${sessions.length} Ready`,
      subtitle: `${activeCount} active • attach one in Code`,
      tone: activeCount > 0 ? 'accent' : 'info',
      tooltip: 'Code workspaces are available, but no shared workspace is currently attached for the main Guardian chat surface.',
      currentSession: null,
      sessions,
      activeCount,
    };
  }
  return {
    value: 'None',
    subtitle: 'Create or attach a workspace in Code',
    tone: 'warning',
    tooltip: 'No coding workspaces are currently available for this operator.',
    currentSession: null,
    sessions,
    activeCount: 0,
  };
}

function resolveSearchSummary(searchStatus, config) {
  const runtimeAvailable = searchStatus?.available === true;
  const installed = searchStatus?.installed === true;
  const collections = Array.isArray(searchStatus?.collections) ? searchStatus.collections : [];
  const configuredSources = Array.isArray(searchStatus?.configuredSources)
    ? searchStatus.configuredSources
    : Array.isArray(config?.assistant?.tools?.search?.sources)
      ? config.assistant.tools.search.sources
      : [];
  const sourceCount = configuredSources.length;
  return {
    value: runtimeAvailable ? 'Available' : installed ? 'Configured' : 'Unavailable',
    subtitle: `${collections.length} collections • ${sourceCount} sources`,
    tone: runtimeAvailable ? 'success' : sourceCount > 0 ? 'warning' : 'info',
    tooltip: 'Document Search runtime availability plus indexed collection and configured source counts.',
    collections,
    configuredSources,
  };
}

function getCloudConfig(config) {
  return config?.assistant?.tools?.cloud || {
    enabled: false,
    profileCounts: { total: 0 },
    security: {
      inlineSecretProfileCount: 0,
      credentialRefCount: 0,
      selfSignedProfileCount: 0,
      customEndpointProfileCount: 0,
    },
  };
}

function resolveCloudSummary(config) {
  const cloud = getCloudConfig(config);
  const profileTotal = Number(cloud?.profileCounts?.total || 0);
  const inlineSecretCount = Number(cloud?.security?.inlineSecretProfileCount || 0);
  const selfSignedCount = Number(cloud?.security?.selfSignedProfileCount || 0);
  const riskCount = inlineSecretCount + selfSignedCount;
  const tone = cloud.enabled
    ? riskCount > 0
      ? 'warning'
      : 'success'
    : profileTotal > 0
      ? 'warning'
      : 'info';
  return {
    value: cloud.enabled ? 'Enabled' : 'Disabled',
    subtitle: `${profileTotal} profiles • ${Number(cloud?.security?.credentialRefCount || 0)} credential refs`,
    tone,
    tooltip: 'Cloud runtime status plus saved profile posture from the Cloud page.',
    profileTotal,
    riskCount,
  };
}

function resolveNetworkSummary(deviceData, baseline, threatState) {
  const devices = Array.isArray(deviceData?.devices) ? deviceData.devices : [];
  const activeAlertCount = Number(threatState?.activeAlertCount || 0);
  const baselineReady = baseline?.baselineReady === true;
  const snapshotCount = Number(baseline?.snapshotCount || 0);
  const minSnapshotsForBaseline = Number(baseline?.minSnapshotsForBaseline || 3);
  return {
    value: activeAlertCount > 0 ? `${activeAlertCount} Alerts` : baselineReady ? 'Ready' : 'Learning',
    subtitle: `${devices.length} devices • ${baselineReady ? 'baseline ready' : `${snapshotCount}/${minSnapshotsForBaseline} snapshots`}`,
    tone: activeAlertCount > 0 ? 'warning' : baselineReady ? 'success' : 'info',
    tooltip: 'Network inventory size, baseline readiness, and active network-alert pressure from the Network page.',
    devices,
    activeAlertCount,
    baselineReady,
  };
}

export async function renderSystem(container) {
  currentContainer = container;
  cards = {};
  container.innerHTML = '<h2 class="page-title">System</h2><div class="loading">Loading...</div>';

  try {
    const [
      agents,
      providers,
      readiness,
      assistantState,
      performanceStatus,
      securityPosture,
      securityAlerts,
      assistantSecurity,
      threatIntel,
      connectorsState,
      codeSessions,
      searchStatus,
      networkDevices,
      networkBaseline,
      networkThreats,
      config,
      routingTrace,
    ] = await Promise.all([
      api.agents().catch(() => []),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
      api.setupStatus().catch(() => null),
      api.assistantState().catch(() => null),
      api.performanceStatus().catch(() => null),
      api.securityPosture().catch(() => null),
      api.securityAlerts({ limit: 12 }).catch(() => ({ totalMatches: 0, bySeverity: {}, alerts: [] })),
      api.aiSecuritySummary().catch(() => ({ findings: { highOrCritical: 0, total: 0 }, posture: {} })),
      api.threatIntelSummary().catch(() => ({ findings: { highOrCritical: 0, total: 0 }, watchlistCount: 0 })),
      api.connectorsState(12).catch(() => ({ summary: {} })),
      api.codeSessions().catch(() => ({ sessions: [], currentSessionId: null })),
      api.searchStatus().catch(() => null),
      api.networkDevices().catch(() => ({ devices: [] })),
      api.networkBaseline().catch(() => null),
      api.networkThreats({ limit: 20 }).catch(() => ({ activeAlertCount: 0 })),
      api.config().catch(() => null),
      api.routingTrace(buildRoutingTraceQueryParams(8)).catch(() => ({ entries: [] })),
    ]);

    const defaultProviderName = assistantState?.defaultProvider || null;
    const primaryProvider = defaultProviderName
      ? providers.find((provider) => provider.name === defaultProviderName) || providers[0]
      : providers[0];
    const orchestratorSummary = assistantState?.orchestrator?.summary || {};
    const jobsSummary = assistantState?.jobs?.summary || {};
    const readinessLoaded = !!readiness;
    const runtimeLoaded = !!assistantState;
    const activeLLM = resolveActiveLLM(agents);
    const performanceSummary = resolvePerformanceSummary(performanceStatus);
    const securitySummary = resolveSecuritySummary(securityPosture, securityAlerts, assistantSecurity, threatIntel);
    const automationSummary = resolveAutomationSummary(connectorsState);
    const codeSummary = resolveCodeWorkspaceSummary(codeSessions);
    const searchSummary = resolveSearchSummary(searchStatus, config);
    const networkSummary = resolveNetworkSummary(networkDevices, networkBaseline, networkThreats);
    const cloudSummary = resolveCloudSummary(config);

    container.innerHTML = `
      <h2 class="page-title">System</h2>
      ${renderGuidancePanel({
        kicker: 'System',
        title: 'Operations overview',
        compact: true,
        whatItIs: 'System is the cross-product operations overview for Guardian. It brings together runtime health, owner-surface status, and recent assistant activity without turning into a duplicate workflow page.',
        whatSeeing: 'You are seeing the shared control-plane summary, linked status cards for the main operational surfaces, current assistant runtime activity, and the routing-trace inspector.',
        whatCanDo: 'Use it to confirm what is healthy, spot which owner surface needs attention next, and open the deeper page that actually owns the work.',
        howLinks: 'System is not the alert queue, configuration editor, or workflow builder. Security owns incident attention, Configuration owns setup, and Automations owns repeatable workflows.',
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
    bindCard(cards.runtime, '#/system');

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
    setCardTooltip(cards.readiness, 'Configuration readiness summary. Opens Configuration.');

    cards.provider = createStatusCard(
      'Default AI',
      primaryProvider ? primaryProvider.name : 'None',
      primaryProvider
        ? `${primaryProvider.connected !== false ? 'Connected' : 'Disconnected'} • ${primaryProvider.model || 'No model'} (${primaryProvider.locality === 'local' ? 'Local' : 'External'})`
        : 'Configure AI Providers',
      primaryProvider ? (primaryProvider.connected !== false ? 'success' : 'warning') : 'warning',
    );
    setCardTooltip(cards.provider, 'Current global default AI provider and model. Opens Configuration > AI Providers.');

    cards.security = createStatusCard(
      'Security Posture',
      securitySummary.value,
      securitySummary.subtitle,
      securitySummary.tone,
    );
    setCardTooltip(cards.security, securitySummary.tooltip);

    cards.liveLlm = createStatusCard(
      'Live LLM',
      activeLLM.status,
      activeLLM.subtitle,
      activeLLM.tone,
    );
    setCardTooltip(cards.liveLlm, activeLLM.tooltip);

    cards.performance = createStatusCard(
      'Performance',
      performanceSummary.value,
      performanceSummary.subtitle,
      performanceSummary.tone,
    );
    setCardTooltip(cards.performance, performanceSummary.tooltip);

    cards.automations = createStatusCard(
      'Automations',
      automationSummary.value,
      automationSummary.subtitle,
      automationSummary.tone,
    );
    setCardTooltip(cards.automations, automationSummary.tooltip);

    cards.code = createStatusCard(
      'Code Workspaces',
      codeSummary.value,
      codeSummary.subtitle,
      codeSummary.tone,
    );
    setCardTooltip(cards.code, codeSummary.tooltip);

    bindCard(cards.provider, '#/config?tab=ai-providers');
    bindCard(cards.readiness, '#/config?tab=integration-system');
    bindCard(cards.security, '#/security');
    bindCard(cards.liveLlm, '#/system');
    bindCard(cards.performance, '#/performance');
    bindCard(cards.automations, '#/automations');
    bindCard(cards.code, '#/code');

    summaryGrid.append(
      cards.runtime,
      cards.readiness,
      cards.provider,
      cards.liveLlm,
      cards.security,
      cards.performance,
      cards.automations,
      cards.code,
    );

    const summarySection = document.createElement('div');
    summarySection.className = 'table-container';
    summarySection.innerHTML = `
      <div class="table-header">
        <div class="section-heading">
          <h3>System Summary</h3>
          ${renderInfoButton('System Summary', {
            whatItIs: 'This strip is the top-level status board for the major Guardian control planes: core runtime, setup readiness, provider health, live LLM activity, security posture, workstation pressure, automation state, and code workspace availability.',
            whatSeeing: 'You are seeing one compact card per high-signal control-plane area, each showing the shared state and the short detail that currently explains it.',
            whatCanDo: 'Use these cards to confirm platform health fast and jump straight into the owner page when one area looks degraded or busy.',
            howLinks: 'These cards summarize the owner surfaces. Security still owns alert triage, Configuration still owns setup, and Code still owns workspace detail.',
          })}
        </div>
      </div>
    `;
    summarySection.appendChild(summaryGrid);
    container.appendChild(summarySection);

    container.appendChild(createOperationalSurfacesSection({
      securitySummary,
      automationSummary,
      codeSummary,
      searchSummary,
      networkSummary,
      cloudSummary,
    }));
    container.appendChild(createRuntimeSection({ orchestratorSummary, jobsSummary, agents, assistantState }));
    container.appendChild(createRoutingTraceSection({
      traceStatus: assistantState?.intentRoutingTrace || null,
      entries: Array.isArray(routingTrace?.entries) ? routingTrace.entries : [],
    }));

    enhanceSectionHelp(container, {
      'Agent Runtime': {
        whatItIs: 'This section is the assistant runtime monitor for current sessions, queue pressure, and recent delegated or background work.',
        whatSeeing: 'You are seeing compact request and job metrics, the currently active or most recent assistant sessions, and the recent job queue with any held follow-up actions.',
        whatCanDo: 'Use it to determine whether Guardian is busy, stuck, or waiting on operator input, then jump into the owner surface that owns the deeper workflow.',
        howLinks: 'System keeps only the bounded operational summary here. Full workflow history still lives in Automations, Code, and Security.',
      },
      'Routing Trace': {
        whatItIs: 'This section is a compact inspector for the durable intent-routing trace log.',
        whatSeeing: 'You are seeing recent gateway and tier-routing decisions, plus optional continuity and active-execution context when that request belonged to an existing thread.',
        whatCanDo: 'Use it to debug why a request was classified, routed, resumed, or answered the way it was without tailing the JSONL log by hand.',
        howLinks: 'It complements the execution timeline and owner pages: the routing trace explains classification and routing decisions, while the owner pages explain what the chosen path then did.',
      },
      'Operational Surfaces': {
        whatItIs: 'This section is the linked status strip for the major owner surfaces that operators routinely need after checking the global summary.',
        whatSeeing: 'You are seeing one compact linked card per surface, each carrying the most useful current signal from that page instead of just a generic shortcut.',
        whatCanDo: 'Use these cards when you want to know which page is worth opening next without scanning every nav tab manually.',
        howLinks: 'These cards intentionally stop at the highest-value summary. They hand you off into the page that actually owns edits, triage, or workflow actions.',
      },
    });
    activateContextHelp(container);
    bindSystemEvents(container);

    if (metricsHandler) offSSE('metrics', metricsHandler);
    metricsHandler = (data) => {
      if (!data?.agents) return;
      const nextActiveLLM = resolveActiveLLM(data.agents);
      if (cards.liveLlm) {
        updateStatusCard(cards.liveLlm, nextActiveLLM.status, nextActiveLLM.subtitle);
        cards.liveLlm.className = `status-card ${nextActiveLLM.tone} status-card-link`;
        setCardTooltip(cards.liveLlm, nextActiveLLM.tooltip);
      }
    };
    onSSE('metrics', metricsHandler);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">System</h2><div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

export function updateSystem() {
  if (currentContainer) {
    void renderSystem(currentContainer);
  }
}

function createOperationalSurfacesSection({ securitySummary, automationSummary, codeSummary, searchSummary, networkSummary, cloudSummary }) {
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <div class="section-heading">
        <h3>Operational Surfaces</h3>
        ${renderInfoButton('Operational Surfaces', {
          whatItIs: 'This strip is the linked summary of the major operational pages that currently matter most after the shared System summary.',
          whatSeeing: 'You are seeing one card per owner surface, each carrying the most useful current state pulled from that page or capability rather than a generic shortcut.',
          whatCanDo: 'Use it to decide which owner page deserves attention next and jump directly there.',
          howLinks: 'These cards do not duplicate the full owner pages. They are bounded previews that hand off into the real workspace for that task.',
        })}
      </div>
    </div>
    <div class="cards-grid" style="padding:1rem 1rem 0;">
      ${renderLinkedStatusCard('Security', `${securitySummary.alertCount} Alert${securitySummary.alertCount === 1 ? '' : 's'}`, `Mode ${securitySummary.value} • ${securitySummary.assistantFindings} assistant • ${securitySummary.intelFindings} intel`, '#/security', securitySummary.tone, 'Open Security for the actionable queue, posture review, and evidence.')}
      ${renderLinkedStatusCard('Automations', `${automationSummary.playbookCount} Playbook${automationSummary.playbookCount === 1 ? '' : 's'}`, `${automationSummary.enabledPlaybookCount} enabled • ${automationSummary.runCount} tracked runs`, '#/automations', automationSummary.tone, 'Open Automations for workflow definitions, schedules, output, and execution history.')}
      ${renderLinkedStatusCard('Code', `${codeSummary.sessions.length} Session${codeSummary.sessions.length === 1 ? '' : 's'}`, codeSummary.currentSession ? `${codeSummary.currentSession.title || 'Attached workspace'} • ${codeSummary.activeCount} active` : codeSummary.subtitle, '#/code', codeSummary.tone, 'Open Code for workspace attachment, repo work, approvals, and coding-session detail.')}
      ${renderLinkedStatusCard('Network', `${networkSummary.devices.length} Device${networkSummary.devices.length === 1 ? '' : 's'}`, `${networkSummary.baselineReady ? 'baseline ready' : 'baseline learning'} • ${networkSummary.activeAlertCount} alerts`, '#/network', networkSummary.tone, 'Open Network for device inventory, diagnostics, and network-specific history.')}
      ${renderLinkedStatusCard('Search', searchSummary.value, `${searchSummary.collections.length} collections • ${searchSummary.configuredSources.length} sources`, '#/config?tab=search', searchSummary.tone, 'Open Configuration > Search for document-search sources, indexing status, and reindex controls.')}
      ${renderLinkedStatusCard('Cloud', cloudSummary.value, `${cloudSummary.profileTotal} profiles • ${cloudSummary.riskCount} risk flags`, '#/cloud', cloudSummary.tone, 'Open Cloud for connection posture, activity review, and cloud automation handoff.')}
    </div>
  `;
  return section;
}

function createRuntimeSection({ orchestratorSummary, jobsSummary, agents, assistantState }) {
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
  const result = systemUiState.assistantJobFollowUpResult;
  if (!result || typeof result !== 'object') return '';
  const tone = result.success ? 'var(--success)' : 'var(--warning)';
  const content = typeof result.content === 'string' && result.content.trim().length > 0
    ? `<pre style="margin:0.65rem 0 0;white-space:pre-wrap;background:var(--bg-elevated);padding:0.75rem;border-radius:0;border:1px solid var(--border-color)">${esc(result.content)}</pre>`
    : '';
  return `
    <div style="padding:0.85rem 1rem 0;color:${tone}">
      <div style="font-weight:600">${esc(result.message || '')}</div>
      ${content}
    </div>
  `;
}

function createRoutingTraceSection({ traceStatus, entries }) {
  const continuityKey = normalizeRoutingTraceFilterValue(systemUiState.routingTraceFilters?.continuityKey);
  const activeExecutionRef = normalizeRoutingTraceFilterValue(systemUiState.routingTraceFilters?.activeExecutionRef);
  const filtersActive = Boolean(continuityKey || activeExecutionRef);
  const section = document.createElement('div');
  section.className = 'table-container';
  section.innerHTML = `
    <div class="table-header">
      <h3>Routing Trace</h3>
      <div class="ops-task-sub">${traceStatus?.enabled ? esc(traceStatus.filePath || '') : 'Routing trace disabled'}</div>
    </div>
    <form id="system-routing-trace-filter-form" style="padding:0 1rem 1rem;display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end">
      <div class="cfg-field" style="flex:1 1 16rem;min-width:14rem;margin:0">
        <label for="system-routing-continuity-key">Continuity Key</label>
        <input id="system-routing-continuity-key" type="text" placeholder="shared-tier:owner" value="${escAttr(continuityKey)}">
      </div>
      <div class="cfg-field" style="flex:1 1 16rem;min-width:14rem;margin:0">
        <label for="system-routing-active-exec-ref">Active Execution Ref</label>
        <input id="system-routing-active-exec-ref" type="text" placeholder="code_session:Repo Fix" value="${escAttr(activeExecutionRef)}">
      </div>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
        <button class="btn btn-secondary btn-sm" type="button" id="system-routing-trace-filter-clear">Clear</button>
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

function bindSystemEvents(container) {
  container.querySelectorAll('[data-assistant-job-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobId = button.getAttribute('data-assistant-job-id') || '';
      const action = button.getAttribute('data-assistant-job-action') || '';
      if (!jobId || !action) return;
      button.disabled = true;
      try {
        const result = await api.assistantJobFollowUp({ jobId, action });
        systemUiState.assistantJobFollowUpResult = {
          success: result?.success !== false,
          message: result?.message || 'Updated delegated job follow-up state.',
          content: typeof result?.details?.content === 'string' ? result.details.content : '',
        };
      } catch (err) {
        systemUiState.assistantJobFollowUpResult = {
          success: false,
          message: err instanceof Error ? err.message : String(err),
          content: '',
        };
      } finally {
        button.disabled = false;
        void renderSystemPreserveScroll(container);
      }
    });
  });

  const routingTraceForm = container.querySelector('#system-routing-trace-filter-form');
  routingTraceForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    systemUiState.routingTraceFilters = {
      continuityKey: normalizeRoutingTraceFilterValue(container.querySelector('#system-routing-continuity-key')?.value),
      activeExecutionRef: normalizeRoutingTraceFilterValue(container.querySelector('#system-routing-active-exec-ref')?.value),
    };
    void renderSystemPreserveScroll(container);
  });

  container.querySelector('#system-routing-trace-filter-clear')?.addEventListener('click', () => {
    systemUiState.routingTraceFilters = {
      continuityKey: '',
      activeExecutionRef: '',
    };
    const continuityInput = container.querySelector('#system-routing-continuity-key');
    const activeExecutionInput = container.querySelector('#system-routing-active-exec-ref');
    if (continuityInput) continuityInput.value = '';
    if (activeExecutionInput) activeExecutionInput.value = '';
    void renderSystemPreserveScroll(container);
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

function renderLinkedStatusCard(title, value, subtitle, href, tone, tooltip) {
  return `
    <a class="status-card ${tone} status-card-link" href="${escAttr(href)}" style="text-decoration:none" title="${escAttr(tooltip || subtitle)}" aria-label="${escAttr(tooltip || subtitle)}">
      <div class="card-title">${esc(title)}</div>
      <div class="card-value">${esc(String(value))}</div>
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

function formatSecurityMode(mode) {
  if (!mode) return 'Unknown';
  return String(mode).replaceAll('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
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
