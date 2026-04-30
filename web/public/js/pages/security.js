/**
 * Security page — overview, Assistant Security, threat intel, and unified security log.
 */

import { api } from '../api.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';

let currentContainer = null;

const SECURITY_HELP = {
  overview: {
    'Security Overview': {
      whatItIs: 'This is the top-level security posture summary for Guardian.',
      whatSeeing: 'You are seeing the current operating mode, active alert pressure, Assistant Security posture, and threat-intel load in one place.',
      whatCanDo: 'Use it to decide whether to stay here for a quick posture read or move into Security Log, Assistant Security, or Threat Intel for deeper work.',
      howLinks: 'It gives the shared summary across the deeper security workspaces without replacing them.',
    },
    'Mode Recommendation': {
      whatItIs: 'This section explains the current posture recommendation and any temporary containment state.',
      whatSeeing: 'You are seeing the recommendation summary, configured versus effective mode, and the top reasons behind it.',
      whatCanDo: 'Use it to judge whether Guardian is seeing real incident pressure, conservative posture debt, or only low-confidence noise.',
      howLinks: 'It condenses posture and containment into one decision surface before you jump into the deeper queues.',
    },
    'Needs Attention': {
      whatItIs: 'This section is the short actionable queue for security work that still deserves operator review right now.',
      whatSeeing: 'You are seeing the highest-signal alert rows and any Assistant Security or threat-intel review queues that are still open.',
      whatCanDo: 'Use it to decide whether you should stay in Security Overview for a quick read or jump directly into Security Log, Assistant Security, or Threat Intel.',
      howLinks: 'This is the fast handoff into the owner queue. Security Log remains the canonical action-and-evidence surface for the shared alert queue.',
    },
    'Top Active Signals': {
      whatItIs: 'This section highlights the strongest currently active signals across the main security surfaces.',
      whatSeeing: 'You are seeing the highest-priority active alerts plus any Assistant Security or threat-intel queues that still need review.',
      whatCanDo: 'Use it to decide which tab deserves attention first instead of scanning every table manually.',
      howLinks: 'It is the bridge from posture into the source-specific surfaces on the other tabs.',
    },
  },
  log: {
    'Security Log Summary': {
      whatItIs: 'This is the shared summary strip for the combined Security Log surface.',
      whatSeeing: 'You are seeing current alert counts, audit volume, and the latest recommended mode side by side.',
      whatCanDo: 'Use it to understand whether you are dealing with a live queue problem, a historical review task, or both.',
      howLinks: 'It keeps alert triage and audit evidence on one page without collapsing them into the same data model.',
    },
    'Unified Alert Queue': {
      whatItIs: 'This is the actionable alert queue across host, network, gateway, native protection, and promoted cross-cutting Assistant Security findings.',
      whatSeeing: 'You are seeing active or acknowledged issues that can be acknowledged, resolved, or suppressed where supported, plus expandable deterministic investigation guidance for each row.',
      whatCanDo: 'Filter aggressively, triage the highest-risk items first, and update alert state when you have enough evidence.',
      howLinks: 'This is the action-now surface; the audit history below keeps the durable evidence trail.',
    },
    'Audit History': {
      whatItIs: 'This is the tamper-evident historical ledger for security and policy events.',
      whatSeeing: 'You are seeing recent audit events, including promoted anomalies and security workflow output, with expandable deterministic context and raw details.',
      whatCanDo: 'Use it to inspect evidence, chronology, and investigation context after you have identified an issue in the queue.',
      howLinks: 'Audit is the durable evidence layer that complements the stateful alert queue above it.',
    },
  },
  assistant: {
    'Posture & Monitoring': {
      whatItIs: 'This is the primary control surface for Assistant Security posture and managed background monitoring.',
      whatSeeing: 'You are seeing current confidence, high-finding pressure, target coverage, managed schedule state, and manual scan controls in one place.',
      whatCanDo: 'Use it to decide whether Assistant Security needs a manual scan, whether the background schedule is healthy, and whether results are bounded enough to trust.',
      howLinks: 'It replaces separate summary-only strips so you can review posture and act from the same section.',
    },
    'Assistant Security Findings': {
      whatItIs: 'This is the current queue of Assistant Security findings.',
      whatSeeing: 'You are seeing posture, workspace, browser, MCP, and trust-boundary findings with triage state.',
      whatCanDo: 'Update finding status, focus on the highest-risk rows, and use this as the source-specific queue for posture debt plus any cross-cutting incident candidates.',
      howLinks: 'This is the detailed finding surface, while Security Log only carries the promoted incident-candidate subset.',
    },
    'Recent Assistant Security Runs': {
      whatItIs: 'This section shows recent Assistant Security scan executions.',
      whatSeeing: 'You are seeing run profile, source, completion time, and how many findings each run produced.',
      whatCanDo: 'Use it to spot regressions, repeated failures, or stale scan coverage.',
      howLinks: 'Runs explain how the current finding queue was produced and when it was last refreshed.',
    },
    'Assistant Security Activity': {
      whatItIs: 'This is the persisted activity trail for scan execution and automation workflow around Assistant Security.',
      whatSeeing: 'You are seeing started, completed, skipped, and failed activity entries from the security workflow.',
      whatCanDo: 'Use it to confirm when scans ran, who requested them, and whether any workflow path failed silently.',
      howLinks: 'It complements the findings and runs tables by showing the surrounding workflow history.',
    },
  },
  intel: {
    'Threat Intel Summary': {
      whatItIs: 'This is the current operating summary for the threat-intel workflow.',
      whatSeeing: 'You are seeing watchlist volume, response mode, darkweb posture, and high-signal finding counts.',
      whatCanDo: 'Use it to decide whether the threat-intel side needs active attention or can stay in background monitoring.',
      howLinks: 'It frames the watchlist, findings, response actions, and operating plan below.',
    },
    Watchlist: {
      whatItIs: 'This is the persistent set of monitored targets for threat-intel work.',
      whatSeeing: 'You are seeing the current watchlist and controls to add or remove targets.',
      whatCanDo: 'Maintain the monitored targets without leaving Security.',
      howLinks: 'Watchlist entries feed scans, findings, and drafted actions.',
    },
    'Threat Intel Findings': {
      whatItIs: 'This is the active finding queue for threat-intel results.',
      whatSeeing: 'You are seeing severity, confidence, source type, and current triage state for recent findings.',
      whatCanDo: 'Triage, dismiss, or action findings and use them to drive follow-up work.',
      howLinks: 'Findings connect collection to drafted response actions and the operating plan.',
    },
  },
};

function esc(value) {
  const element = document.createElement('div');
  element.textContent = value == null ? '' : String(value);
  return element.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function renderGuide(config = {}) {
  return renderGuidancePanel({
    collapsible: true,
    collapsed: true,
    ...config,
  });
}

export async function renderSecurity(container, options = {}) {
  currentContainer = container;
  container.innerHTML = `
    ${renderGuide({
      kicker: 'Security Guide',
      title: 'Investigation, posture, and response',
      whatItIs: 'Security is the main operator surface for posture review, Security Log triage, Assistant Security scans, and threat-intel response planning.',
      whatSeeing: 'You are seeing the merged Security Log, the Assistant Security command center, and the threat-intel workspace on one page.',
      whatCanDo: 'Use Overview for the fast read, Security Log for alerts and evidence, Assistant Security for runtime and workspace scan work, and Threat Intel for identity-abuse monitoring.',
      howLinks: 'Security unifies the defensive surfaces without replacing Cloud, Network, or Configuration as owners of their deeper controls.',
    })}
  `;

  createTabs(container, [
    { id: 'overview', label: 'Overview', tooltip: 'Shared posture summary across Security surfaces.', render: renderOverviewTab },
    { id: 'ai-security', label: 'Assistant Security', tooltip: 'Assistant/runtime posture scans, findings, runs, and workflow history.', render: (panel) => renderAssistantSecurityTab(panel) },
    { id: 'intel', label: 'Threat Intel', tooltip: 'Watchlist monitoring, findings, and drafted actions.', render: (panel) => renderThreatIntelTab(panel) },
    { id: 'security-log', label: 'Security Log', tooltip: 'Unified alert queue plus audit evidence and review.', render: (panel) => renderSecurityLogTab(panel) },
  ], normalizeSecurityTab(options?.tab));
}

export async function updateSecurity() {
  if (!currentContainer) return;
  const activeTab = currentContainer.dataset.activeTab;
  await renderSecurity(currentContainer, activeTab ? { tab: activeTab } : {});
}

function normalizeSecurityTab(tab) {
  if (tab === 'alerts' || tab === 'audit' || tab === 'log') return 'security-log';
  if (tab === 'activity' || tab === 'agentic-security') return 'ai-security';
  return tab || 'overview';
}

async function renderOverviewTab(panel) {
  panel.innerHTML = '<div class="loading">Loading security overview…</div>';
  const [alerts, posture, containment, assistantSummary, intelSummary] = await Promise.all([
    api.securityAlerts({ limit: 50 }).catch(() => defaultSecurityAlertsResponse()),
    api.securityPosture().catch(() => defaultSecurityPostureResponse()),
    api.securityContainment().catch(() => defaultSecurityContainmentResponse()),
    api.aiSecuritySummary().catch(() => defaultAiSecuritySummaryResponse()),
    api.threatIntelSummary().catch(() => defaultThreatIntelSummaryResponse()),
  ]);

  const overviewCards = [
    statusCard('Active Alerts', alerts.totalMatches || 0, `${alerts.bySeverity?.critical || 0} critical · ${alerts.bySeverity?.high || 0} high`, (alerts.totalMatches || 0) > 0 ? 'warning' : 'success'),
    statusCard('Recommended Mode', formatSecurityMode(posture.recommendedMode), containment.autoElevated ? `Effective ${formatSecurityMode(containment.effectiveMode)}` : posture.shouldEscalate ? `Current ${formatSecurityMode(posture.currentMode)}` : 'No escalation advised', posture.shouldEscalate || containment.autoElevated ? 'warning' : 'success'),
    statusCard('Assistant Findings', assistantSummary.findings?.highOrCritical || 0, `${assistantSummary.findings?.total || 0} total · ${assistantSummary.posture?.confidence || 'reduced'} confidence`, (assistantSummary.findings?.highOrCritical || 0) > 0 ? 'warning' : 'success'),
    statusCard('Threat Intel', intelSummary.findings?.highOrCritical || 0, `${intelSummary.watchlistCount || 0} watched · ${formatRelativeTime(intelSummary.lastScanAt)}`, (intelSummary.findings?.highOrCritical || 0) > 0 ? 'warning' : 'info'),
  ];

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Overview',
      compact: true,
      title: 'Security Overview',
      whatItIs: 'This tab is the shared posture snapshot for the merged Security surfaces.',
      whatSeeing: 'You are seeing current alert pressure, operating mode guidance, Assistant Security state, and threat-intel load.',
      whatCanDo: 'Use it to decide where to drill in next instead of hunting across tabs first.',
      howLinks: 'It summarizes the deeper state of Security Log, Assistant Security, and Threat Intel without duplicating their full queues.',
    })}
    <div class="status-card-grid">${overviewCards.join('')}</div>
    <div class="security-focus-grid">
      <section class="table-section">
        <div class="table-header"><h3>Mode Recommendation</h3></div>
        ${renderModeRecommendation(posture, containment)}
      </section>
      <section class="table-section">
        <div class="table-header">
          <h3>Needs Attention</h3>
          <a class="btn btn-secondary btn-sm" href="#/security?tab=security-log">Open Security Log</a>
        </div>
        ${renderNeedsAttention(alerts.alerts || [], assistantSummary, intelSummary)}
      </section>
    </div>
    <section class="table-section">
      <div class="table-header"><h3>Top Active Signals</h3></div>
      ${renderTopActiveSignals(posture.topAlerts, assistantSummary, intelSummary)}
    </section>
  `;

  enhanceSectionHelp(panel, SECURITY_HELP.overview);
}

async function renderSecurityLogTab(panel, state = {}) {
  panel.innerHTML = '<div class="loading">Loading security log…</div>';

  const query = typeof state.query === 'string' ? state.query : '';
  const source = typeof state.source === 'string' ? state.source : '';
  const severity = typeof state.severity === 'string' ? state.severity : '';
  const status = typeof state.status === 'string' ? state.status : '';
  const includeAcknowledged = state.includeAcknowledged === true;
  const includeInactive = state.includeInactive === true;

  const [alerts, auditSummary, auditEvents, auditVerify, posture, containment] = await Promise.all([
    api.securityAlerts({
      limit: 100,
      query: query || undefined,
      source: source || undefined,
      severity: severity || undefined,
      status: status || undefined,
      includeAcknowledged,
      includeInactive,
    }).catch(() => defaultSecurityAlertsResponse()),
    api.auditSummary().catch(() => defaultAuditSummaryResponse()),
    api.audit({ limit: 100 }).catch(() => []),
    api.verifyAuditChain().catch(() => defaultAuditChainStatusResponse()),
    api.securityPosture().catch(() => defaultSecurityPostureResponse()),
    api.securityContainment().catch(() => defaultSecurityContainmentResponse()),
  ]);

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Security Log',
      compact: true,
      title: 'Security Log',
      whatItIs: 'Security Log is the combined operator surface for live alert triage and durable evidence review.',
      whatSeeing: 'You are seeing the stateful alert queue and the underlying audit history together on one page.',
      whatCanDo: 'Filter the queue, update alert state, and inspect audit history without bouncing between separate alert and audit tabs.',
      howLinks: 'It simplifies the operator workflow while keeping alerts and audit as separate backend responsibilities.',
    })}
    <section class="table-section">
      <div class="table-header">
        <h3>Unified Alert Queue</h3>
        <span class="cfg-header-note">${alerts.totalMatches || 0} matching ${pluralize(alerts.totalMatches || 0, 'alert')}</span>
      </div>
      <div class="security-inline-summary">${esc(renderSecurityLogContext(alerts, posture, containment, auditSummary))}</div>
      <div class="intel-toolbar">
        <input id="security-log-query" class="input" type="text" value="${escAttr(query)}" placeholder="Search alerts">
        <select id="security-log-source" class="input">
          ${renderOptions([
            ['', 'All sources'],
            ['host', 'Host'],
            ['network', 'Network'],
            ['gateway', 'Gateway'],
            ['native', 'Native'],
            ['assistant', 'Assistant'],
          ], source)}
        </select>
        <select id="security-log-severity" class="input">
          ${renderOptions([
            ['', 'All severities'],
            ['critical', 'Critical'],
            ['high', 'High'],
            ['medium', 'Medium'],
            ['low', 'Low'],
          ], severity)}
        </select>
        <select id="security-log-status" class="input">
          ${renderOptions([
            ['', 'Active only'],
            ['acknowledged', 'Acknowledged'],
            ['resolved', 'Resolved'],
            ['suppressed', 'Suppressed'],
          ], status)}
        </select>
        <label class="checkbox-inline"><input id="security-log-ack" type="checkbox"${includeAcknowledged ? ' checked' : ''}> Include acknowledged</label>
        <label class="checkbox-inline"><input id="security-log-inactive" type="checkbox"${includeInactive ? ' checked' : ''}> Include inactive</label>
        <button class="btn btn-secondary" id="security-log-refresh">Refresh</button>
      </div>
      ${renderAlertQueue(alerts.alerts || [])}
    </section>
    ${renderCollapsibleSection('Audit History', `
      ${renderAuditChainStatus(auditVerify)}
      ${renderAuditHistory(auditEvents)}
    `, {
      summary: `${auditSummary.totalEvents || 0} ${pluralize(auditSummary.totalEvents || 0, 'event')} in the current window · ${formatAuditChainStatusForDisplay(auditVerify)}`,
    })}
  `;

  bindSecurityLogInteractions(panel, state);
  enhanceSectionHelp(panel, SECURITY_HELP.log);
}

function bindSecurityLogInteractions(panel, state) {
  panel.querySelector('#security-log-refresh')?.addEventListener('click', () => {
    renderSecurityLogTab(panel, readSecurityLogState(panel));
  });
  panel.querySelector('#security-log-verify-audit')?.addEventListener('click', () => {
    renderSecurityLogTab(panel, readSecurityLogState(panel));
  });
  panel.querySelectorAll('#security-log-query, #security-log-source, #security-log-severity, #security-log-status, #security-log-ack, #security-log-inactive')
    .forEach((node) => {
      node.addEventListener(node.id === 'security-log-query' ? 'change' : 'input', () => {
        renderSecurityLogTab(panel, readSecurityLogState(panel));
      });
    });
  panel.querySelectorAll('[data-security-alert-action]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const target = event.currentTarget;
      const alertId = target.getAttribute('data-alert-id') || '';
      const source = target.getAttribute('data-alert-source') || undefined;
      const action = target.getAttribute('data-security-alert-action') || '';
      if (!alertId || !action) return;
      if (action === 'ack') await api.acknowledgeSecurityAlert(alertId, source).catch(() => null);
      if (action === 'resolve') await api.resolveSecurityAlert(alertId, source, 'Resolved from Security Log').catch(() => null);
      if (action === 'suppress') await api.suppressSecurityAlert(alertId, source, Date.now() + (60 * 60 * 1000), 'Suppressed from Security Log').catch(() => null);
      await renderSecurityLogTab(panel, readSecurityLogState(panel));
    });
  });
}

function readSecurityLogState(panel) {
  return {
    query: panel.querySelector('#security-log-query')?.value || '',
    source: panel.querySelector('#security-log-source')?.value || '',
    severity: panel.querySelector('#security-log-severity')?.value || '',
    status: panel.querySelector('#security-log-status')?.value || '',
    includeAcknowledged: panel.querySelector('#security-log-ack')?.checked === true,
    includeInactive: panel.querySelector('#security-log-inactive')?.checked === true,
  };
}

async function renderAssistantSecurityTab(panel, state = {}) {
  panel.innerHTML = '<div class="loading">Loading Assistant Security…</div>';

  const findingStatus = typeof state.findingStatus === 'string' ? state.findingStatus : '';
  const findingSeverity = typeof state.findingSeverity === 'string' ? state.findingSeverity : '';

  const [summary, profiles, targets, runs, findings, activity, config, scheduledTasks] = await Promise.all([
    api.aiSecuritySummary().catch(() => defaultAiSecuritySummaryResponse()),
    api.aiSecurityProfiles().catch(() => []),
    api.aiSecurityTargets().catch(() => []),
    api.aiSecurityRuns(20).catch(() => []),
    api.aiSecurityFindings({ limit: 100, status: findingStatus || undefined }).catch(() => []),
    api.securityActivity({ agentId: 'assistant-security', limit: 30 }).catch(() => ({ entries: [] })),
    api.config().catch(() => null),
    api.scheduledTasks().catch(() => []),
  ]);

  const filteredFindings = (findings || []).filter((finding) => !findingSeverity || finding.severity === findingSeverity);
  const selectedProfile = typeof state.profileId === 'string' && state.profileId
    ? state.profileId
    : (profiles[0]?.id || 'quick');
  const monitoring = deriveAssistantSecurityMonitoring(config, scheduledTasks, profiles);

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Assistant Security',
      compact: true,
      title: 'Assistant Security',
      whatItIs: 'Assistant Security is the command center for runtime and workspace posture scanning, findings, and workflow review.',
      whatSeeing: 'You are seeing scan controls, current findings, recent runs, and the persisted activity trail for the security workflow.',
      whatCanDo: 'Run scans manually, triage findings, and use this surface as the detailed source queue behind any promoted Security Log issues.',
      howLinks: 'Only incident-candidate findings promote into Security Log; broader posture findings stay here, and session-local results are also written into Code checks.',
    })}
    <section class="table-section">
      <div class="table-header"><h3>Posture & Monitoring</h3></div>
      <div class="status-card-grid">
        ${statusCard('Monitoring', monitoring.enabled ? 'Enabled' : 'Disabled', monitoring.enabled ? monitoring.profileLabel : 'Managed background scan disabled', monitoring.enabled ? 'success' : 'info')}
        ${statusCard('Confidence', summary.posture?.confidence || 'reduced', `${summary.posture?.availability || 'unknown'} sandbox`, summary.posture?.confidence === 'bounded' ? 'success' : 'warning')}
        ${statusCard('High Findings', summary.findings?.highOrCritical || 0, `${summary.findings?.total || 0} total`, (summary.findings?.highOrCritical || 0) > 0 ? 'warning' : 'success')}
        ${statusCard('Targets', `${summary.readyTargetCount || 0}/${summary.targetCount || 0}`, 'ready for scan', 'info')}
        ${statusCard('Last Run', formatRelativeTime(summary.lastRunAt || monitoring.lastRunAt), (summary.lastRunAt || monitoring.lastRunAt) ? formatTimestamp(summary.lastRunAt || monitoring.lastRunAt) : 'No runs yet', monitoring.lastRunTone)}
      </div>
      <div class="security-inline-summary">
        ${esc(monitoring.enabled
          ? `Managed profile ${monitoring.profileLabel} runs on ${monitoring.profileSubtitle}. Task state: ${monitoring.taskState}${monitoring.taskDetail ? ` (${monitoring.taskDetail})` : ''}.`
          : 'Managed Assistant Security monitoring is disabled.')}
        ${monitoring.autoPausedReason ? ` Current task note: ${monitoring.autoPausedReason}` : ''}
      </div>
      <div class="intel-toolbar">
        <select id="assistant-security-profile" class="input">
          ${profiles.map((profile) => `<option value="${escAttr(profile.id)}"${profile.id === selectedProfile ? ' selected' : ''}>${esc(profile.label)}</option>`).join('')}
        </select>
        <button class="btn btn-primary" id="assistant-security-run">Run Scan</button>
        <button class="btn btn-secondary" id="assistant-security-refresh">Refresh</button>
      </div>
      <div id="assistant-security-run-message" class="form-hint">${esc(state.runMessage || 'Select a profile and run a manual scan.')}</div>
    </section>
    <section class="table-section">
      <div class="table-header"><h3>Assistant Security Findings</h3></div>
      <div class="intel-toolbar">
        <select id="assistant-security-finding-status" class="input">
          ${renderOptions([
            ['', 'All statuses'],
            ['new', 'New'],
            ['triaged', 'Triaged'],
            ['resolved', 'Resolved'],
            ['suppressed', 'Suppressed'],
          ], findingStatus)}
        </select>
        <select id="assistant-security-finding-severity" class="input">
          ${renderOptions([
            ['', 'All severities'],
            ['critical', 'Critical'],
            ['high', 'High'],
            ['medium', 'Medium'],
            ['low', 'Low'],
          ], findingSeverity)}
        </select>
      </div>
      ${renderAssistantFindingsTable(filteredFindings)}
    </section>
    ${renderCollapsibleSection('Targets & Coverage', renderTargetsTable(targets), {
      summary: `${summary.readyTargetCount || 0}/${summary.targetCount || 0} ready`,
    })}
    ${renderCollapsibleSection('Recent Assistant Security Runs', renderRunsTable(runs), {
      summary: `${runs.length || 0} recent ${pluralize(runs.length || 0, 'run')}`,
    })}
    ${renderCollapsibleSection('Assistant Security Activity', renderSecurityActivity(activity.entries || []), {
      summary: `${(activity.entries || []).length || 0} recent ${pluralize((activity.entries || []).length || 0, 'entry')}`,
    })}
  `;

  panel.querySelector('#assistant-security-refresh')?.addEventListener('click', () => {
    renderAssistantSecurityTab(panel, readAssistantSecurityState(panel));
  });
  panel.querySelector('#assistant-security-run')?.addEventListener('click', async () => {
    const profileId = panel.querySelector('#assistant-security-profile')?.value || 'quick';
    const result = await api.aiSecurityScan({ profileId, source: 'manual' }).catch((error) => ({ success: false, message: error.message }));
    await renderAssistantSecurityTab(panel, {
      ...readAssistantSecurityState(panel),
      profileId,
      runMessage: result?.message || 'Assistant Security scan completed.',
    });
  });
  panel.querySelectorAll('#assistant-security-finding-status, #assistant-security-finding-severity').forEach((node) => {
    node.addEventListener('input', () => renderAssistantSecurityTab(panel, readAssistantSecurityState(panel)));
  });
  panel.querySelectorAll('[data-assistant-finding-action]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const target = event.currentTarget;
      const findingId = target.getAttribute('data-finding-id') || '';
      const nextStatus = target.getAttribute('data-assistant-finding-action') || '';
      if (!findingId || !nextStatus) return;
      await api.aiSecuritySetFindingStatus(findingId, nextStatus).catch(() => null);
      await renderAssistantSecurityTab(panel, readAssistantSecurityState(panel));
    });
  });

  enhanceSectionHelp(panel, SECURITY_HELP.assistant);
}

function readAssistantSecurityState(panel) {
  return {
    profileId: panel.querySelector('#assistant-security-profile')?.value || '',
    findingStatus: panel.querySelector('#assistant-security-finding-status')?.value || '',
    findingSeverity: panel.querySelector('#assistant-security-finding-severity')?.value || '',
    runMessage: panel.querySelector('#assistant-security-run-message')?.textContent || '',
  };
}

function deriveAssistantSecurityMonitoring(config, tasks, profiles) {
  const security = config?.assistant?.security || {};
  const monitoring = security.continuousMonitoring || {};
  const enabled = monitoring.enabled !== false;
  const profileId = monitoring.profileId || 'quick';
  const profileLabel = profiles.find((profile) => profile.id === profileId)?.label || profileId;
  const cron = monitoring.cron || '15 */12 * * *';
  const managedTask = Array.isArray(tasks)
    ? tasks.find((task) => task.presetId === 'assistant-security-scan' || (task.target === 'assistant_security_scan' && task.name === 'Assistant Security Scan'))
    : null;

  let taskState = 'Missing';
  let taskDetail = `Expected cadence ${cron}`;
  let taskTone = enabled ? 'warning' : 'info';
  if (managedTask) {
    taskState = managedTask.enabled ? 'Active' : 'Paused';
    taskDetail = managedTask.cron || cron;
    taskTone = managedTask.enabled ? 'success' : 'warning';
  } else if (!enabled) {
    taskState = 'Disabled';
    taskDetail = 'No managed task required';
    taskTone = 'info';
  }

  return {
    enabled,
    profileLabel,
    profileSubtitle: `Scheduler-driven · ${cron}`,
    taskState,
    taskDetail,
    taskTone,
    lastRunAt: managedTask?.lastRunAt,
    lastRunStatus: managedTask?.lastRunStatus,
    lastRunTone: managedTask?.lastRunAt ? (managedTask.lastRunStatus === 'failed' ? 'warning' : 'success') : 'info',
    autoPausedReason: managedTask?.autoPausedReason,
  };
}

async function renderThreatIntelTab(panel, state = {}) {
  panel.innerHTML = '<div class="loading">Loading threat intel…</div>';

  const findingStatus = typeof state.findingStatus === 'string' ? state.findingStatus : '';
  const [summary, plan, watchlist, findings, actions] = await Promise.all([
    api.threatIntelSummary().catch(() => defaultThreatIntelSummaryResponse()),
    api.threatIntelPlan().catch(() => defaultThreatIntelPlanResponse()),
    api.threatIntelWatchlist().catch(() => []),
    api.threatIntelFindings({ limit: 50, status: findingStatus || undefined }).catch(() => []),
    api.threatIntelActions(20).catch(() => []),
  ]);

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Threat Intel',
      compact: true,
      title: 'Threat Intel',
      whatItIs: 'Threat Intel is the monitoring and response-planning surface for identity abuse and related external threats.',
      whatSeeing: 'You are seeing watchlist configuration, findings, drafted actions, and the phased operating plan.',
      whatCanDo: 'Run a scan, maintain the watchlist, triage findings, and draft follow-up actions.',
      howLinks: 'Threat Intel remains separate from Security Log because it is slower-moving intelligence work rather than immediate local-control triage.',
    })}
    <section class="table-section">
      <div class="table-header"><h3>Threat Intel Summary</h3></div>
      <div class="status-card-grid">
        ${statusCard('Watchlist', summary.watchlistCount || 0, `${summary.findings?.total || 0} findings`, 'info')}
        ${statusCard('Response Mode', summary.responseMode || 'manual', summary.darkwebEnabled ? 'Darkweb enabled' : 'Darkweb disabled', 'info')}
        ${statusCard('High Findings', summary.findings?.highOrCritical || 0, `${summary.findings?.new || 0} new`, (summary.findings?.highOrCritical || 0) > 0 ? 'warning' : 'success')}
        ${statusCard('Last Scan', formatRelativeTime(summary.lastScanAt), summary.lastScanAt ? formatTimestamp(summary.lastScanAt) : 'No scans yet', 'info')}
      </div>
      <div class="intel-toolbar">
        <select id="threat-intel-response-mode" class="input">
          ${renderOptions([
            ['manual', 'Manual'],
            ['assisted', 'Assisted'],
            ['autonomous', 'Autonomous'],
          ], summary.responseMode || 'manual')}
        </select>
        <button class="btn btn-secondary" id="threat-intel-response-save">Save Mode</button>
        <button class="btn btn-primary" id="threat-intel-scan">Run Scan</button>
      </div>
      <div id="threat-intel-message" class="form-hint">${esc(state.notice || 'Threat-intel scans search the current watchlist by default.')}</div>
    </section>
    <section class="table-section">
      <div class="table-header"><h3>Watchlist</h3></div>
      <div class="intel-toolbar">
        <input id="threat-intel-watch-target" class="input" type="text" placeholder="Add target">
        <button class="btn btn-secondary" id="threat-intel-watch-add">Add</button>
      </div>
      ${renderWatchlist(watchlist)}
    </section>
    <section class="table-section">
      <div class="table-header"><h3>Threat Intel Findings</h3></div>
      <div class="intel-toolbar">
        <select id="threat-intel-finding-status" class="input">
          ${renderOptions([
            ['', 'All statuses'],
            ['new', 'New'],
            ['triaged', 'Triaged'],
            ['actioned', 'Actioned'],
            ['dismissed', 'Dismissed'],
          ], findingStatus)}
        </select>
      </div>
      ${renderThreatIntelFindings(findings)}
    </section>
    ${renderCollapsibleSection('Drafted Threat Intel Actions', renderThreatIntelActions(actions), {
      summary: `${actions.length || 0} drafted ${pluralize(actions.length || 0, 'action')}`,
    })}
    ${renderCollapsibleSection('Operating Plan', renderThreatIntelPlan(plan), {
      summary: `${(plan.phases || []).length || 0} plan ${pluralize((plan.phases || []).length || 0, 'phase')}`,
    })}
  `;

  panel.querySelector('#threat-intel-response-save')?.addEventListener('click', async () => {
    const mode = panel.querySelector('#threat-intel-response-mode')?.value || 'manual';
    await api.threatIntelSetResponseMode(mode).catch(() => null);
    await renderThreatIntelTab(panel, { ...readThreatIntelState(panel), notice: `Response mode set to ${mode}.` });
  });
  panel.querySelector('#threat-intel-scan')?.addEventListener('click', async () => {
    const result = await api.threatIntelScan({}).catch((error) => ({ message: error.message }));
    await renderThreatIntelTab(panel, { ...readThreatIntelState(panel), notice: result?.message || 'Threat-intel scan completed.' });
  });
  panel.querySelector('#threat-intel-watch-add')?.addEventListener('click', async () => {
    const target = panel.querySelector('#threat-intel-watch-target')?.value?.trim() || '';
    if (!target) return;
    await api.threatIntelWatch(target, 'add').catch(() => null);
    await renderThreatIntelTab(panel, { ...readThreatIntelState(panel), notice: `Added '${target}' to watchlist.` });
  });
  panel.querySelector('#threat-intel-finding-status')?.addEventListener('input', () => renderThreatIntelTab(panel, readThreatIntelState(panel)));
  panel.querySelectorAll('[data-watch-remove]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const target = event.currentTarget.getAttribute('data-watch-remove') || '';
      if (!target) return;
      await api.threatIntelWatch(target, 'remove').catch(() => null);
      await renderThreatIntelTab(panel, { ...readThreatIntelState(panel), notice: `Removed '${target}' from watchlist.` });
    });
  });
  panel.querySelectorAll('[data-threat-finding-status]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const findingId = event.currentTarget.getAttribute('data-finding-id') || '';
      const nextStatus = event.currentTarget.getAttribute('data-threat-finding-status') || '';
      if (!findingId || !nextStatus) return;
      await api.threatIntelSetFindingStatus(findingId, nextStatus).catch(() => null);
      await renderThreatIntelTab(panel, readThreatIntelState(panel));
    });
  });
  panel.querySelectorAll('[data-threat-action-draft]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const findingId = event.currentTarget.getAttribute('data-finding-id') || '';
      const actionType = event.currentTarget.getAttribute('data-threat-action-draft') || '';
      if (!findingId || !actionType) return;
      await api.threatIntelDraftAction(findingId, actionType).catch(() => null);
      await renderThreatIntelTab(panel, { ...readThreatIntelState(panel), notice: 'Drafted follow-up action.' });
    });
  });

  enhanceSectionHelp(panel, SECURITY_HELP.intel);
}

function readThreatIntelState(panel) {
  return {
    findingStatus: panel.querySelector('#threat-intel-finding-status')?.value || '',
    notice: panel.querySelector('#threat-intel-message')?.textContent || '',
  };
}

function renderModeRecommendation(posture, containment) {
  const recommendedTone = containment.autoElevated
    ? 'status-warning'
    : posture.recommendedMode === 'lockdown'
      ? 'status-error'
      : posture.recommendedMode === 'ir_assist' || posture.recommendedMode === 'guarded'
        ? 'status-warning'
        : 'status-success';

  return `
    <div class="stack-card security-mode-panel">
      <div class="security-focus-item__top">
        <span class="status-badge ${recommendedTone}">${esc(containment.autoElevated ? 'Temporary containment active' : (posture.shouldEscalate ? 'Escalation advised' : 'Current posture acceptable'))}</span>
        <div class="security-focus-item__title">${esc(posture.summary)}</div>
      </div>
      <div class="security-mode-panel__meta">
        <div class="security-mode-panel__meta-item">
          <div class="card-title">Configured</div>
          <div class="security-focus-item__title">${esc(formatSecurityMode(posture.currentMode))}</div>
        </div>
        <div class="security-mode-panel__meta-item">
          <div class="card-title">Recommended</div>
          <div class="security-focus-item__title">${esc(formatSecurityMode(posture.recommendedMode))}</div>
        </div>
        <div class="security-mode-panel__meta-item">
          <div class="card-title">Effective</div>
          <div class="security-focus-item__title">${esc(formatSecurityMode(containment.effectiveMode))}</div>
        </div>
        <div class="security-mode-panel__meta-item">
          <div class="card-title">Active Alerts</div>
          <div class="security-focus-item__title">${esc(posture.counts?.total || 0)}</div>
        </div>
      </div>
    </div>
    ${renderReasonList(posture.reasons, containment.activeActions)}
  `;
}

function renderTopActiveSignals(topAlerts, assistantSummary, intelSummary) {
  const items = [];

  for (const alert of (topAlerts || []).slice(0, 4)) {
    items.push(renderFocusItem({
      badgeLabel: alert.severity,
      badgeClass: `status-${alert.severity}`,
      title: alert.subject || `${formatSecuritySource(alert.source)} signal`,
      detail: alert.description,
      meta: `${formatSecuritySource(alert.source)} · ${formatRelativeTime(alert.timestamp || alert.lastSeenAt)}`,
    }));
  }

  if ((assistantSummary.findings?.highOrCritical || 0) > 0) {
    items.push(renderFocusItem({
      badgeLabel: 'assistant',
      badgeClass: 'status-warning',
      title: 'Assistant Security findings need review',
      detail: `${assistantSummary.findings.highOrCritical} high or critical posture ${pluralize(assistantSummary.findings.highOrCritical, 'finding')} remain open.`,
      meta: `Use Assistant Security for runtime and workspace posture triage.`,
    }));
  }

  if ((intelSummary.findings?.highOrCritical || 0) > 0) {
    items.push(renderFocusItem({
      badgeLabel: 'intel',
      badgeClass: 'status-warning',
      title: 'Threat-intel findings are waiting',
      detail: `${intelSummary.findings.highOrCritical} high-signal ${pluralize(intelSummary.findings.highOrCritical, 'finding')} need review.`,
      meta: `Use Threat Intel for watchlist-driven external monitoring.`,
    }));
  }

  if (items.length === 0) {
    return '<div class="empty-state">No high-priority signals currently need focused triage.</div>';
  }

  return `<div class="security-focus-list">${items.join('')}</div>`;
}

function renderNeedsAttention(alerts, assistantSummary, intelSummary) {
  const items = [];

  for (const alert of (alerts || []).slice(0, 5)) {
    items.push(renderFocusItem({
      badgeLabel: alert.severity || 'alert',
      badgeClass: `status-${alert.severity || 'warning'}`,
      title: alert.subject || alert.type || 'Security alert',
      detail: alert.description || 'Open Security Log for the full alert detail and actions.',
      meta: `${formatSecuritySource(alert.source)} · ${formatRelativeTime(alert.lastSeenAt || alert.timestamp)} · ${alert.status || 'active'}`,
    }));
  }

  if ((assistantSummary.findings?.highOrCritical || 0) > 0) {
    items.push(renderFocusItem({
      badgeLabel: 'assistant',
      badgeClass: 'status-warning',
      title: 'Assistant Security findings are still open',
      detail: `${assistantSummary.findings.highOrCritical} high or critical ${pluralize(assistantSummary.findings.highOrCritical, 'finding')} still need review.`,
      meta: 'Open Assistant Security for source-specific posture triage.',
    }));
  }

  if ((intelSummary.findings?.highOrCritical || 0) > 0) {
    items.push(renderFocusItem({
      badgeLabel: 'intel',
      badgeClass: 'status-warning',
      title: 'Threat-intel review is waiting',
      detail: `${intelSummary.findings.highOrCritical} high-signal ${pluralize(intelSummary.findings.highOrCritical, 'finding')} still need a decision.`,
      meta: 'Open Threat Intel for watchlist-driven review and drafted response actions.',
    }));
  }

  if (items.length === 0) {
    return '<div class="empty-state">Nothing in the current security queues needs immediate attention.</div>';
  }

  return `<div class="security-focus-list">${items.join('')}</div>`;
}

function renderFocusItem(input) {
  return `
    <div class="security-focus-item">
      <div class="security-focus-item__top">
        <span class="status-badge ${escAttr(input.badgeClass)}">${esc(input.badgeLabel)}</span>
        <div class="security-focus-item__title">${esc(input.title)}</div>
      </div>
      <div>${esc(input.detail)}</div>
      ${input.meta ? `<div class="table-muted">${esc(input.meta)}</div>` : ''}
    </div>
  `;
}

function renderSecurityLogContext(alerts, posture, containment, auditSummary) {
  const bits = [
    `${alerts.totalMatches || 0} matching ${pluralize(alerts.totalMatches || 0, 'alert')}`,
    posture.shouldEscalate
      ? `recommended mode ${formatSecurityMode(posture.recommendedMode)}`
      : `recommended mode remains ${formatSecurityMode(posture.recommendedMode)}`,
  ];
  if (containment.autoElevated) {
    bits.push(`temporary containment is enforcing ${formatSecurityMode(containment.effectiveMode)}`);
  }
  bits.push(`${auditSummary.totalEvents || 0} audit ${pluralize(auditSummary.totalEvents || 0, 'event')} in the current window`);
  return bits.join(' · ');
}

function renderCollapsibleSection(title, content, options = {}) {
  return `
    <details class="security-collapsible"${options.open ? ' open' : ''}>
      <summary>
        <span>${esc(title)}</span>
        ${options.summary ? `<span class="security-collapsible__summary-copy">${esc(options.summary)}</span>` : ''}
      </summary>
      <div class="security-collapsible__content">${content}</div>
    </details>
  `;
}

function renderAlertQueue(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return '<div class="empty-state">No security alerts match the current filters.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Severity</th><th>Source</th><th>Type</th><th>Description</th><th>Seen</th><th>State</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${alerts.map((alert) => `
            <tr>
              <td><span class="status-badge status-${escAttr(alert.severity)}">${esc(alert.severity)}</span></td>
              <td>${esc(formatSecuritySource(alert.source))}</td>
              <td>${esc(alert.type)}</td>
              <td>
                <div>${esc(alert.description)}</div>
                <div class="table-muted">${esc(alert.subject || '')}</div>
                ${renderAlertInvestigationDetails(alert)}
              </td>
              <td>
                <div>${esc(formatRelativeTime(alert.lastSeenAt))}</div>
                <div class="table-muted">${esc(formatTimestamp(alert.lastSeenAt))}</div>
              </td>
              <td>${esc(alert.status || 'active')}</td>
              <td>
                ${alert.status === 'active' ? `<button class="btn btn-secondary btn-sm" data-security-alert-action="ack" data-alert-id="${escAttr(alert.id)}" data-alert-source="${escAttr(alert.source)}">Acknowledge</button>` : ''}
                ${alert.status !== 'resolved' ? `<button class="btn btn-secondary btn-sm" data-security-alert-action="resolve" data-alert-id="${escAttr(alert.id)}" data-alert-source="${escAttr(alert.source)}">Resolve</button>` : ''}
                ${alert.status !== 'suppressed' ? `<button class="btn btn-secondary btn-sm" data-security-alert-action="suppress" data-alert-id="${escAttr(alert.id)}" data-alert-source="${escAttr(alert.source)}">Suppress</button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderAuditHistory(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return '<div class="empty-state">No audit history is available.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Time</th><th>Severity</th><th>Type</th><th>Agent</th><th>Details</th></tr>
        </thead>
        <tbody>
          ${events.map((event) => `
            <tr>
              <td>${esc(formatTimestamp(event.timestamp))}</td>
              <td><span class="status-badge status-${escAttr(event.severity)}">${esc(event.severity)}</span></td>
              <td>${esc(event.type)}</td>
              <td>${esc(event.agentId || 'system')}</td>
              <td>
                <div>${esc(shortDescriptionFromAudit(event))}</div>
                ${renderAuditInvestigationDetails(event)}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderAuditChainStatus(result) {
  const tone = result?.valid === false ? 'critical' : result?.available === false ? 'warning' : 'success';
  return `
    <div class="security-inline-summary security-inline-summary--${escAttr(tone)}">
      <span>${esc(formatAuditChainStatusForDisplay(result))}</span>
      <button class="btn btn-secondary btn-sm" id="security-log-verify-audit" type="button">Verify Audit Chain</button>
    </div>
  `;
}

export function formatAuditChainStatusForDisplay(result) {
  if (result?.valid === true) {
    const total = Number(result.totalEntries || 0);
    return `Audit chain verified (${total} ${total === 1 ? 'entry' : 'entries'})`;
  }
  if (result?.valid === false) {
    const brokenAt = Number.isFinite(Number(result.brokenAt)) ? ` at entry ${Number(result.brokenAt)}` : '';
    return `Audit chain verification failed${brokenAt}`;
  }
  return 'Audit chain verification unavailable';
}

function renderAlertInvestigationDetails(alert) {
  const sightings = Number.isFinite(Number(alert.occurrenceCount)) ? Number(alert.occurrenceCount) : 1;
  return renderInvestigationDetailsPanel({
    summary: `${sightings} ${pluralize(sightings, 'sighting')} · last seen ${formatRelativeTime(alert.lastSeenAt)}`,
    narrative: buildAlertNarrative(alert),
    nextSteps: buildAlertInvestigationSteps(alert),
    contextFacts: buildAlertContextFacts(alert),
    evidenceFacts: collectEvidenceFacts(alert.evidence),
    rawLabel: 'Raw alert JSON',
    rawValue: alert,
  });
}

function renderAuditInvestigationDetails(event) {
  return renderInvestigationDetailsPanel({
    summary: `${formatAuditEventType(event.type)} · ${event.controller || event.agentId || 'system'}`,
    narrative: buildAuditNarrative(event),
    nextSteps: buildAuditInvestigationSteps(event),
    contextFacts: buildAuditContextFacts(event),
    evidenceFacts: collectEvidenceFacts(event.details),
    rawLabel: 'Raw audit JSON',
    rawValue: event,
  });
}

function renderInvestigationDetailsPanel(input) {
  return `
    <details class="security-entry-details">
      <summary>
        <span>Details &amp; guidance</span>
        ${input.summary ? `<span class="security-entry-details__summary">${esc(input.summary)}</span>` : ''}
      </summary>
      <div class="security-entry-details__body">
        ${input.narrative ? renderInvestigationTextSection('Why this matters', [input.narrative]) : ''}
        ${renderInvestigationTextSection('Investigate next', input.nextSteps)}
        ${renderInvestigationFactSection('Observed context', input.contextFacts)}
        ${renderInvestigationFactSection('Evidence snapshot', input.evidenceFacts)}
        <details class="security-entry-details__raw">
          <summary>${esc(input.rawLabel || 'Raw JSON')}</summary>
          <pre class="json-preview">${esc(safeJson(input.rawValue))}</pre>
        </details>
      </div>
    </details>
  `;
}

function renderInvestigationTextSection(title, items) {
  const values = normalizeInvestigationItems(items);
  if (values.length === 0) return '';
  return `
    <section class="security-entry-details__section">
      <h4>${esc(title)}</h4>
      <ul class="security-entry-details__list">
        ${values.map((item) => `<li>${esc(item)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function renderInvestigationFactSection(title, facts) {
  const values = normalizeFactItems(facts);
  if (values.length === 0) return '';
  return `
    <section class="security-entry-details__section">
      <h4>${esc(title)}</h4>
      <div class="security-entry-details__facts">
        ${values.map((item) => `
          <div class="security-entry-details__fact">
            <div class="security-entry-details__fact-label">${esc(item.label)}</div>
            <div class="security-entry-details__fact-value">${esc(item.value)}</div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function normalizeInvestigationItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
}

function normalizeFactItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item
      && typeof item.label === 'string'
      && item.label.trim()
      && typeof item.value === 'string'
      && item.value.trim()
      && item.value.trim() !== 'Unknown'
      && item.value.trim() !== 'the affected target')
    .map((item) => ({
      label: item.label.trim(),
      value: item.value.trim(),
    }));
}

function buildAlertNarrative(alert) {
  const subject = resolveInvestigationSubject(alert.subject, `${formatSecuritySource(alert.source)} asset`);
  const signal = formatIdentifierLabel(alert.type);

  switch (alert.type) {
    case 'suspicious_process':
      return `Host monitoring flagged a suspicious process on ${subject}. Treat this as possible malicious execution until the binary, parent process, and recent operator activity explain it.`;
    case 'firewall_disabled':
    case 'gateway_firewall_disabled':
      return `${formatSecuritySource(alert.source)} reports that firewall protection is disabled for ${subject}. This weakens a core boundary and should be treated as intentional only if it matches a documented maintenance window.`;
    case 'persistence_change':
      return `A persistence mechanism changed on ${subject}. Validate the new autorun, service, or scheduled task path before assuming it is benign.`;
    case 'sensitive_path_change':
      return `A sensitive path changed on ${subject}. Confirm whether the modified path is part of an expected upgrade or whether it widens the local trust boundary.`;
    case 'new_external_destination':
      return `A new external destination was observed for ${subject}. This is lower-confidence drift, but it still deserves source-process and destination review if it repeats or lines up with higher-risk signals.`;
    case 'new_listening_port':
    case 'port_change':
    case 'mass_port_open':
      return `Network exposure changed for ${subject}. Determine which process or device opened the port surface and whether the new exposure was expected.`;
    case 'firewall_change':
    case 'gateway_firewall_change':
    case 'gateway_port_forward_change':
      return `Security policy exposure changed for ${subject}. Review the exact rule or port-forward delta and confirm who made it and why.`;
    case 'gateway_admin_change':
      return `Gateway administrative state changed for ${subject}. Confirm that the admin action was authorized and that no broader perimeter changes came with it.`;
    case 'arp_conflict':
      return `A critical ARP conflict was detected for ${subject}. This can be benign DHCP churn, but it can also indicate spoofing or address collision and should be corroborated quickly.`;
    case 'new_device':
    case 'device_gone':
      return `Network inventory changed around ${subject}. Confirm whether the asset state change is expected before dismissing it as baseline drift.`;
    case 'unusual_service':
      return `An unusual network service was detected on ${subject}. Validate what is listening and whether that service belongs on this host or device.`;
    case 'defender_threat_detected':
      return `Native protection detected a threat affecting ${subject}. Treat this as real until Defender history, remediation state, and the affected resource path say otherwise.`;
    case 'defender_realtime_protection_disabled':
    case 'defender_antivirus_disabled':
    case 'defender_firewall_profile_disabled':
      return `Windows Defender reports a protection boundary is disabled for ${subject}. Confirm whether the control was turned off intentionally and whether compensating controls exist.`;
    case 'defender_signatures_stale':
    case 'defender_status_unavailable':
      return `Windows Defender health is degraded for ${subject}. Detection visibility may be incomplete until provider state is restored.`;
    case 'defender_controlled_folder_access_disabled':
      return `A host protection hardening feature is disabled for ${subject}. This is often configuration drift, but it still widens exposure and should be reviewed if it persists.`;
    default:
      if (alert.source === 'assistant' || alert.type.startsWith('assistant_security_')) {
        const category = alert.type.replace(/^assistant_security_/, '') || 'assistant';
        return `Assistant Security promoted a high-signal ${formatIdentifierLabel(category)} finding for ${subject}. Confirm whether the evidence points to a real incident candidate or whether the issue is already explained by reviewed posture debt.`;
      }
      return `${formatSecuritySource(alert.source)} reported ${signal} for ${subject}. Confirm the signal is still current, explain what changed, and look for corroborating evidence before resolving it.`;
  }
}

function buildAlertInvestigationSteps(alert) {
  const subject = resolveInvestigationSubject(alert.subject, `${formatSecuritySource(alert.source)} asset`);

  switch (alert.type) {
    case 'suspicious_process':
      return [
        `Identify the executable path, signer, hash, and parent process for ${subject}.`,
        'Review recent outbound connections, persistence changes, and any matching Defender detections on the same host.',
        'Decide whether the process aligns with a legitimate install or update window before acknowledging it.',
      ];
    case 'firewall_disabled':
    case 'gateway_firewall_disabled':
      return [
        `Verify the current firewall state live on ${subject}; do not rely on the last snapshot alone.`,
        'Check recent admin or policy changes to see who disabled the protection and whether it was planned.',
        'Look for new listening ports, exposed services, or correlated network alerts while the boundary is down.',
      ];
    case 'persistence_change':
      return [
        'Inspect the new autorun, scheduled task, service, or registry entry and capture the referenced binary path.',
        'Verify signer, file path, and recent file modifications for the persistence target.',
        'Correlate with suspicious process or threat-detection alerts before deciding it is expected.',
      ];
    case 'sensitive_path_change':
      return [
        'Inspect which file or directory changed and whether the path is part of Guardian config, policy, or another trust-sensitive area.',
        'Check whether the change lines up with a documented config edit, upgrade, or package install.',
        'Review adjacent audit events for policy changes, denied actions, or integrity-related findings.',
      ];
    case 'new_external_destination':
      return [
        'Identify the process, service, or browser action that opened the new connection.',
        'Classify the destination domain or IP and check whether it belongs to an approved vendor or workflow.',
        'Escalate attention only if the destination repeats, appears risky, or lines up with other alerts.',
      ];
    case 'new_listening_port':
    case 'port_change':
    case 'mass_port_open':
      return [
        'Find the process or device responsible for the listening service or changed port exposure.',
        'Confirm whether the new ports match an intended service rollout or a temporary diagnostics window.',
        'Review firewall rules and external reachability while the exposure is present.',
      ];
    case 'firewall_change':
    case 'gateway_firewall_change':
    case 'gateway_port_forward_change':
      return [
        'Capture the exact rule, profile, or port-forward delta that changed.',
        'Identify the operator, automation, or device action that applied the change.',
        'Confirm whether the new exposure broadens inbound or outbound reach in a way that now needs rollback.',
      ];
    case 'gateway_admin_change':
      return [
        'Review the gateway audit trail to identify the account or integration that made the change.',
        'Check for paired firewall or port-forward changes in the same time window.',
        'Confirm whether the action matches a planned perimeter change or maintenance ticket.',
      ];
    case 'arp_conflict':
      return [
        'Validate the current IP-to-MAC mapping on the gateway or switch and compare it with recent baseline history.',
        'Check DHCP lease churn, host sleep/resume activity, and duplicate static IP assignments before assuming spoofing.',
        'Correlate with suspicious process, beaconing, or gateway alerts if the conflict persists.',
      ];
    case 'new_device':
    case 'device_gone':
      return [
        'Identify the device by hostname, vendor, MAC, and switch or gateway context if available.',
        'Confirm whether the asset belongs on the network and whether the timing matches normal user activity.',
        'Look for unusual services, port changes, or admin activity associated with the same device.',
      ];
    case 'unusual_service':
      return [
        'Determine what protocol or service is exposed and which process or device owns it.',
        'Check whether the service is expected on this network segment or host class.',
        'Review recent admin, firewall, and process alerts around the same subject.',
      ];
    case 'defender_threat_detected':
      return [
        'Review the Defender detection name, affected resources, and remediation status.',
        'Confirm whether the file, process, or resource is still present or already quarantined.',
        'Look for matching workspace-trust, suspicious-process, or persistence alerts that describe the same artifact.',
      ];
    case 'defender_realtime_protection_disabled':
    case 'defender_antivirus_disabled':
    case 'defender_firewall_profile_disabled':
    case 'defender_signatures_stale':
    case 'defender_status_unavailable':
    case 'defender_controlled_folder_access_disabled':
      return [
        'Refresh provider status to confirm the condition is still present.',
        'Inspect local policy, exclusions, and recent administrative changes that could explain the state.',
        'Treat other host findings as higher risk until native protection health is restored.',
      ];
    default:
      if (alert.source === 'assistant' || alert.type.startsWith('assistant_security_')) {
        return [
          'Review the finding target, category, and confidence to decide whether the posture change is intentional.',
          'Inspect the related Guardian configuration or trust surface for recent widening.',
          'Correlate with current containment state before deciding whether this finding still needs operator action.',
        ];
      }
      return [
        `Confirm that ${subject} still shows the same condition in the latest snapshot.`,
        'Explain what changed between first seen and last seen, including any maintenance or rollout context.',
        'Look for corroborating alerts or audit events before resolving the issue.',
      ];
  }
}

function buildAlertContextFacts(alert) {
  const subject = typeof alert.subject === 'string' && alert.subject.trim() && alert.subject.trim() !== '-'
    ? alert.subject.trim()
    : '';
  return normalizeFactItems([
    { label: 'Alert ID', value: String(alert.id || '') },
    { label: 'Source', value: formatSecuritySource(alert.source) },
    { label: 'Signal Type', value: formatIdentifierLabel(alert.type) },
    { label: 'Subject', value: subject },
    { label: 'Severity', value: formatIdentifierLabel(alert.severity) },
    { label: 'Confidence', value: formatSecurityConfidence(alert.confidence) },
    { label: 'Recommended Action', value: typeof alert.recommendedAction === 'string' ? alert.recommendedAction : '' },
    { label: 'State', value: formatIdentifierLabel(alert.status || 'active') },
    { label: 'Occurrences', value: String(alert.occurrenceCount ?? 1) },
    { label: 'First Seen', value: formatTimestamp(alert.firstSeenAt) },
    { label: 'Last Seen', value: formatTimestamp(alert.lastSeenAt) },
    { label: 'Last State Change', value: formatTimestamp(alert.lastStateChangedAt) },
    { label: 'Suppressed Until', value: formatTimestamp(alert.suppressedUntil) },
    { label: 'Suppression Reason', value: typeof alert.suppressionReason === 'string' ? alert.suppressionReason : '' },
    { label: 'Resolved At', value: formatTimestamp(alert.resolvedAt) },
    { label: 'Resolution Reason', value: typeof alert.resolutionReason === 'string' ? alert.resolutionReason : '' },
    { label: 'Dedupe Key', value: String(alert.dedupeKey || '') },
  ]);
}

function buildAuditNarrative(event) {
  const details = isPlainObject(event.details) ? event.details : {};
  const action = describeAuditAction(details);
  const trigger = readDetailString(details, ['triggerDetailType', 'anomalyType', 'alertType', 'type', 'reason']);

  switch (event.type) {
    case 'action_denied':
      if (details.source === 'containment_service') {
        return `Guardian blocked ${action || 'an action'} because containment controls are active. Treat this as expected until the current effective mode and the matched control no longer justify the restriction.`;
      }
      return `A controller denied ${action || 'an action'}. Determine whether the block reflects intended policy enforcement or an operator-visible false positive.`;
    case 'action_allowed':
      return `Guardian allowed ${action || 'an action'} under current policy. Review this when the action seems surprising or risk acceptance may have widened too far.`;
    case 'secret_detected':
      return 'Guardian detected content that looked like a secret. Confirm whether sensitive material was actually exposed and whether rotation or cleanup is required.';
    case 'anomaly_detected':
      return `Guardian recorded an anomaly${trigger ? ` (${formatIdentifierLabel(trigger)})` : ''}. Treat it as a cue to inspect corroborating alerts and surrounding audit activity.`;
    case 'host_alert':
    case 'gateway_alert':
      return `A source-specific security alert was promoted into audit visibility. Use this row to correlate the durable event trail with the live Security Log queue entry.`;
    case 'automation_finding':
      return 'An automation completed a deterministic or assisted security workflow. Validate the trigger, the evidence it referenced, and whether any follow-up action is still pending.';
    case 'auth_failure':
      return 'An authentication flow failed. Confirm whether this is an expired token, a revoked integration, or a sign of repeated unauthorized access attempts.';
    case 'agent_error':
    case 'agent_stalled':
    case 'worker_crash':
      return 'A runtime component failed or stalled. Confirm whether the failure created a monitoring blind spot or interrupted a security workflow.';
    case 'policy_changed':
    case 'policy_mode_changed':
    case 'policy_shadow_mismatch':
    case 'security_baseline_enforced':
    case 'security_baseline_overridden':
      return 'Security policy state changed. Confirm who changed it, whether the scope was intended, and whether compensating controls are still appropriate.';
    default:
      return `Guardian recorded ${formatAuditEventType(event.type)}. Use the structured details to determine whether this is an expected guardrail event, a real security signal, or routine background activity.`;
  }
}

function buildAuditInvestigationSteps(event) {
  const details = isPlainObject(event.details) ? event.details : {};
  const action = describeAuditAction(details);

  switch (event.type) {
    case 'action_denied':
      if (details.source === 'containment_service') {
        return [
          'Check current, recommended, and effective security modes before treating the denial as a bug.',
          `Review the blocked request${action ? ` (${action})` : ''} and the matched containment action to see which control fired.`,
          'Correlate with active alerts and posture reasons to decide whether the restriction is still warranted.',
        ];
      }
      return [
        `Review the blocked request${action ? ` (${action})` : ''} and the controller that denied it.`,
        'Confirm whether the request was expected or whether it suggests prompt injection, policy drift, or a misconfigured workflow.',
        'Check for repeated denials from the same agent, source, or tool to spot noisy automation.',
      ];
    case 'action_allowed':
      return [
        `Review why ${action || 'the action'} was permitted under current policy.`,
        'Check adjacent audit events for warnings, reduced-trust hints, or operator overrides.',
        'Decide whether the current allow path is still appropriate for the affected workflow.',
      ];
    case 'secret_detected':
      return [
        'Identify where the secret-like value appeared and whether it reached any external sink or persisted output.',
        'Determine whether the value is a real credential, a test fixture, or a false positive.',
        'Rotate or revoke the material if it is live and review why it was present in the first place.',
      ];
    case 'anomaly_detected':
      return [
        'Identify the anomaly subtype, affected surface, and the agent or controller that surfaced it.',
        'Correlate the anomaly with the live alert queue, security posture reasons, and nearby audit events.',
        'Decide whether the anomaly is isolated drift, a misconfiguration, or evidence of a broader incident.',
      ];
    case 'host_alert':
    case 'gateway_alert':
      return [
        'Find the matching live alert in Security Log and review its current state and evidence.',
        'Check whether the alert has repeated, been acknowledged, or been suppressed since this audit entry was written.',
        'Correlate adjacent audit events to understand what changed before and after the source alert fired.',
      ];
    case 'automation_finding':
      return [
        'Identify the automation that produced the finding and what trigger detail started it.',
        'Verify whether the finding still maps to an active queue item or whether the underlying condition has already cleared.',
        'Use the summary as guidance, but rely on the attached structured evidence and current runtime state before acting.',
      ];
    case 'auth_failure':
      return [
        'Identify the failing provider, connector, or account path and whether the failure is interactive or background refresh.',
        'Check whether the failure repeats across multiple attempts or agents.',
        'Decide whether the problem is expired credentials, revoked access, misconfiguration, or possible unauthorized use.',
      ];
    case 'agent_error':
    case 'agent_stalled':
    case 'worker_crash':
      return [
        'Inspect the failing agent, controller, and surrounding runtime events to understand what stopped.',
        'Determine whether the failure interrupted monitoring, triage, or another security-sensitive workflow.',
        'Verify that coverage resumed and that no important evidence was missed during the failure window.',
      ];
    case 'policy_changed':
    case 'policy_mode_changed':
    case 'policy_shadow_mismatch':
    case 'security_baseline_enforced':
    case 'security_baseline_overridden':
      return [
        'Identify who or what changed the policy state and capture the before-and-after scope.',
        'Check whether the change had an approval path or documented maintenance context.',
        'Review adjacent denials, alerts, and containment state to see what behavior changed after the policy move.',
      ];
    default:
      return [
        'Review the structured context and determine whether the event was expected for the current workflow.',
        'Correlate the event with nearby alerts, posture changes, and related audit records.',
        'Escalate only if the event broadens exposure, repeats unexpectedly, or lines up with stronger corroborating signals.',
      ];
  }
}

function buildAuditContextFacts(event) {
  const details = isPlainObject(event.details) ? event.details : {};
  return normalizeFactItems([
    { label: 'Audit ID', value: String(event.id || '') },
    { label: 'Event Type', value: formatAuditEventType(event.type) },
    { label: 'Severity', value: formatIdentifierLabel(event.severity) },
    { label: 'Agent', value: String(event.agentId || '') },
    { label: 'Controller', value: String(event.controller || '') },
    { label: 'Channel', value: String(event.channel || '') },
    { label: 'User', value: String(event.userId || '') },
    { label: 'Recorded', value: formatTimestamp(event.timestamp) },
    { label: 'Source', value: readDetailString(details, ['source']) },
    { label: 'Action', value: readDetailString(details, ['actionType']) },
    { label: 'Tool', value: readDetailString(details, ['toolName']) },
    { label: 'Matched Control', value: readDetailString(details, ['matchedAction']) },
    { label: 'Trigger Event', value: readDetailString(details, ['triggerEventType']) },
    { label: 'Trigger Detail', value: readDetailString(details, ['triggerDetailType', 'anomalyType', 'alertType']) },
    { label: 'Automation', value: readDetailString(details, ['automationName', 'automationId']) },
    { label: 'Risk Level', value: readDetailString(details, ['riskLevel']) },
    { label: 'Dedupe Key', value: readDetailString(details, ['dedupeKey']) },
  ]);
}

function collectEvidenceFacts(value, prefix = '', facts = [], depth = 0, maxFacts = 12) {
  if (facts.length >= maxFacts || depth > 3 || value == null) {
    return facts;
  }

  if (Array.isArray(value)) {
    if (!prefix || value.length === 0) return facts;
    const scalarValues = value.filter((item) => isDisplayScalar(item)).map((item) => formatScalarForDisplay(item)).filter(Boolean);
    if (scalarValues.length === value.length) {
      const preview = scalarValues.slice(0, 4).join(', ');
      const suffix = scalarValues.length > 4 ? ` (+${scalarValues.length - 4} more)` : '';
      facts.push({ label: formatIdentifierLabel(prefix), value: `${preview}${suffix}` });
      return facts;
    }
    facts.push({ label: formatIdentifierLabel(prefix), value: `${value.length} ${pluralize(value.length, 'item')}` });
    return facts;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (facts.length >= maxFacts) break;
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      collectEvidenceFacts(nested, nextPrefix, facts, depth + 1, maxFacts);
    }
    return facts;
  }

  if (prefix) {
    const displayValue = formatScalarForDisplay(value);
    if (displayValue) {
      facts.push({ label: formatIdentifierLabel(prefix), value: displayValue });
    }
  }
  return facts;
}

function renderTargetsTable(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return '<div class="empty-state">No Assistant Security targets are available.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Target</th><th>Type</th><th>Risk</th><th>Ready</th><th>Description</th></tr>
        </thead>
        <tbody>
          ${targets.map((target) => `
            <tr>
              <td>${esc(target.label)}</td>
              <td>${esc(target.type)}</td>
              <td>${esc(target.riskLevel)}</td>
              <td>${target.ready ? 'Yes' : 'No'}</td>
              <td>${esc(target.description)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderAssistantFindingsTable(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return '<div class="empty-state">No Assistant Security findings match the current filters.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Severity</th><th>Category</th><th>Target</th><th>Summary</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${findings.map((finding) => `
            <tr>
              <td><span class="status-badge status-${escAttr(finding.severity)}">${esc(finding.severity)}</span></td>
              <td>${esc(finding.category)}</td>
              <td>${esc(finding.targetLabel)}</td>
              <td>
                <div><strong>${esc(finding.title)}</strong></div>
                <div class="table-muted">${esc(finding.summary)}</div>
              </td>
              <td>${esc(finding.status)}</td>
              <td>
                ${finding.status !== 'triaged' ? `<button class="btn btn-secondary btn-sm" data-assistant-finding-action="triaged" data-finding-id="${escAttr(finding.id)}">Triage</button>` : ''}
                ${finding.status !== 'resolved' ? `<button class="btn btn-secondary btn-sm" data-assistant-finding-action="resolved" data-finding-id="${escAttr(finding.id)}">Resolve</button>` : ''}
                ${finding.status !== 'suppressed' ? `<button class="btn btn-secondary btn-sm" data-assistant-finding-action="suppressed" data-finding-id="${escAttr(finding.id)}">Suppress</button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderRunsTable(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return '<div class="empty-state">No Assistant Security scans have run yet.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Completed</th><th>Profile</th><th>Source</th><th>Targets</th><th>Findings</th><th>Message</th></tr>
        </thead>
        <tbody>
          ${runs.map((run) => `
            <tr>
              <td>${esc(formatTimestamp(run.completedAt))}</td>
              <td>${esc(run.profileLabel)}</td>
              <td>${esc(run.source)}</td>
              <td>${esc(run.targetCount)}</td>
              <td>${esc(run.findingCount)} (${esc(run.highOrCriticalCount)} high)</td>
              <td>${esc(run.message)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSecurityActivity(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '<div class="empty-state">No Assistant Security activity has been recorded yet.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Time</th><th>Status</th><th>Severity</th><th>Title</th><th>Summary</th></tr>
        </thead>
        <tbody>
          ${entries.map((entry) => `
            <tr>
              <td>${esc(formatTimestamp(entry.timestamp))}</td>
              <td>${esc(formatSecurityActivityStatusForDisplay(entry))}</td>
              <td>${esc(entry.severity)}</td>
              <td>${esc(entry.title)}</td>
              <td>${esc(entry.summary)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

export function formatSecurityActivityStatusForDisplay(entry) {
  const status = entry?.status;
  switch (status) {
    case 'started':
      return 'AI triage running';
    case 'completed':
      return 'AI triage completed';
    case 'failed':
      return 'AI triage failed';
    case 'skipped': {
      const reason = typeof entry?.details?.reason === 'string' ? entry.details.reason : '';
      return reason
        ? `No AI triage (${formatSecurityActivitySkipReason(reason)})`
        : 'No AI triage';
    }
    default:
      return formatIdentifierLabel(status || 'unknown');
  }
}

function formatSecurityActivitySkipReason(reason) {
  switch (reason) {
    case 'informational':
      return 'informational event';
    case 'low_confidence':
      return 'low-confidence signal';
    case 'low_severity':
      return 'low-severity signal';
    case 'cooldown':
      return 'cooldown window';
    default:
      return formatIdentifierLabel(reason);
  }
}

function renderWatchlist(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="empty-state">Threat-intel watchlist is empty.</div>';
  }
  return `
    <div class="chip-list">
      ${items.map((item) => `
        <span class="chip">
          ${esc(item)}
          <button class="chip-remove" type="button" data-watch-remove="${escAttr(item)}" aria-label="Remove ${escAttr(item)}">&times;</button>
        </span>
      `).join('')}
    </div>
  `;
}

function renderThreatIntelFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return '<div class="empty-state">No threat-intel findings match the current filters.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Severity</th><th>Target</th><th>Source</th><th>Summary</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${findings.map((finding) => `
            <tr>
              <td><span class="status-badge status-${escAttr(finding.severity)}">${esc(finding.severity)}</span></td>
              <td>${esc(finding.target)}</td>
              <td>${esc(finding.sourceType)}</td>
              <td>${esc(finding.summary)}</td>
              <td>${esc(finding.status)}</td>
              <td>
                ${finding.status !== 'triaged' ? `<button class="btn btn-secondary btn-sm" data-threat-finding-status="triaged" data-finding-id="${escAttr(finding.id)}">Triage</button>` : ''}
                ${finding.status !== 'dismissed' ? `<button class="btn btn-secondary btn-sm" data-threat-finding-status="dismissed" data-finding-id="${escAttr(finding.id)}">Dismiss</button>` : ''}
                <button class="btn btn-secondary btn-sm" data-threat-action-draft="draft_response" data-finding-id="${escAttr(finding.id)}">Draft Response</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderThreatIntelActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return '<div class="empty-state">No drafted threat-intel actions are available.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Type</th><th>Status</th><th>Approval</th><th>Rationale</th></tr>
        </thead>
        <tbody>
          ${actions.map((action) => `
            <tr>
              <td>${esc(action.type)}</td>
              <td>${esc(action.status)}</td>
              <td>${action.requiresApproval ? 'Required' : 'Not required'}</td>
              <td>${esc(action.rationale || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderThreatIntelPlan(plan) {
  if (!plan?.phases) {
    return '<div class="empty-state">No threat-intel operating plan is available.</div>';
  }
  return `
    <div class="stack-list">
      <div><strong>${esc(plan.title || 'Threat Intel Plan')}</strong></div>
      ${(plan.principles || []).length > 0 ? `<ul>${plan.principles.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
      ${(plan.phases || []).map((phase) => `
        <div class="stack-card">
          <div><strong>${esc(phase.phase)}</strong></div>
          <div class="table-muted">${esc(phase.objective || '')}</div>
          ${(phase.deliverables || []).length > 0 ? `<ul>${phase.deliverables.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderReasonList(postureReasons, containmentActions) {
  const items = [
    ...(Array.isArray(postureReasons) ? postureReasons.map((reason) => ({ title: 'Reason', detail: reason })) : []),
    ...(Array.isArray(containmentActions) ? containmentActions.map((action) => ({
      title: action.title,
      detail: action.reason,
      restrictedActions: action.restrictedActions,
      recovery: action.recovery,
    })) : []),
  ];
  if (items.length === 0) {
    return '<div class="empty-state">No posture or containment reasons are active right now.</div>';
  }
  return `
    <div class="stack-list">
      ${items.map((item) => `
        <div class="stack-card">
          <div><strong>${esc(item.title)}</strong></div>
          <div>${esc(item.detail)}</div>
          ${Array.isArray(item.restrictedActions) && item.restrictedActions.length > 0 ? `
            <div class="table-muted"><strong>Restricted:</strong> ${esc(item.restrictedActions.join('; '))}</div>
          ` : ''}
          ${item.recovery ? `<div class="table-muted"><strong>Recovery:</strong> ${esc(item.recovery)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function statusCard(title, value, subtitle, tone = 'info') {
  return `
    <div class="status-card ${escAttr(tone)}">
      <div class="card-title">${esc(title)}</div>
      <div class="card-value">${esc(value)}</div>
      <div class="card-subtitle">${esc(subtitle)}</div>
    </div>
  `;
}

function renderOptions(options, selected) {
  return options.map(([value, label]) => `<option value="${escAttr(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

function formatSecurityMode(mode) {
  if (!mode) return 'Unknown';
  return String(mode).replaceAll('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function formatSecuritySource(source) {
  if (!source) return 'Unknown';
  if (source === 'assistant') return 'Assistant';
  return String(source).replace(/\b\w/g, (value) => value.toUpperCase());
}

function formatSecurityConfidence(confidence) {
  const numeric = Number(confidence);
  if (!Number.isFinite(numeric)) return '';
  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%`;
}

function formatAuditEventType(type) {
  return formatIdentifierLabel(type || 'unknown');
}

function formatIdentifierLabel(value) {
  if (!value) return 'Unknown';
  return String(value)
    .replace(/\./g, ' / ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (part) => part.toUpperCase());
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const delta = Date.now() - Number(timestamp);
  if (!Number.isFinite(delta)) return 'Unknown';
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Unknown';
  try {
    return new Date(Number(timestamp)).toLocaleString();
  } catch {
    return 'Unknown';
  }
}

function shortDescriptionFromAudit(event) {
  if (typeof event?.details?.description === 'string' && event.details.description.trim()) return event.details.description.trim();
  if (typeof event?.details?.reason === 'string' && event.details.reason.trim()) return event.details.reason.trim();
  return event?.type || 'Audit event';
}

function safeJson(value) {
  try {
    return JSON.stringify(redactSecurityJsonForDisplay(value ?? {}), null, 2);
  } catch {
    return redactSecurityTextForDisplay(String(value ?? ''));
  }
}

export function redactSecurityJsonForDisplay(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return redactSecurityTextForDisplay(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecurityJsonForDisplay(item, seen));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    isSensitiveDisplayKey(key) ? '[REDACTED]' : redactSecurityJsonForDisplay(nested, seen),
  ]));
}

function isSensitiveDisplayKey(key) {
  return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|client[_-]?secret|credential|cookie|password|passwd|secret|token)/i.test(String(key || ''));
}

function redactSecurityTextForDisplay(value) {
  return String(value || '')
    .replace(/\b(authorization)\s*[:=]\s*(?:Bearer\s+)?["']?[^"',;\s)}\]]{4,}/gi, '$1: [REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|password|passwd|secret|token)\s*[:=]\s*["']?[^"',;\s)}\]]{4,}/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]')
    .replace(/\bghp_[A-Za-z0-9_]{12,}/g, 'ghp_[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}/gi, 'xox[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]');
}

function resolveInvestigationSubject(value, fallback) {
  if (typeof value === 'string' && value.trim() && value.trim() !== '-') {
    return value.trim();
  }
  return fallback || 'the affected target';
}

function readDetailString(details, keys) {
  for (const key of (Array.isArray(keys) ? keys : [])) {
    const value = details?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function describeAuditAction(details) {
  const actionType = readDetailString(details, ['actionType']);
  const toolName = readDetailString(details, ['toolName']);
  if (toolName && actionType) return `${toolName} (${actionType})`;
  if (toolName) return toolName;
  if (actionType) return actionType;
  return '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDisplayScalar(value) {
  return typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function formatScalarForDisplay(value) {
  if (typeof value === 'string') return redactSecurityTextForDisplay(value).trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return '';
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function defaultSecurityAlertsResponse() {
  return {
    alerts: [],
    totalMatches: 0,
    returned: 0,
    searchedSources: ['host', 'network', 'gateway', 'native', 'assistant'],
    includeAcknowledged: false,
    includeInactive: false,
    bySource: { host: 0, network: 0, gateway: 0, native: 0, assistant: 0 },
    bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
  };
}

function defaultSecurityPostureResponse() {
  return {
    profile: 'personal',
    currentMode: 'monitor',
    recommendedMode: 'monitor',
    shouldEscalate: false,
    summary: 'No active alerts currently justify tighter controls.',
    reasons: [],
    counts: { total: 0, low: 0, medium: 0, high: 0, critical: 0 },
    bySource: { host: 0, network: 0, gateway: 0, native: 0, assistant: 0 },
    availableSources: ['host', 'network', 'gateway', 'native', 'assistant'],
    topAlerts: [],
  };
}

function defaultSecurityContainmentResponse() {
  return {
    profile: 'personal',
    currentMode: 'monitor',
    effectiveMode: 'monitor',
    recommendedMode: 'monitor',
    autoElevated: false,
    shouldEscalate: false,
    activeAlertCount: 0,
    activeActions: [],
  };
}

function defaultAiSecuritySummaryResponse() {
  return {
    enabled: false,
    profileCount: 0,
    targetCount: 0,
    readyTargetCount: 0,
    findings: { total: 0, new: 0, highOrCritical: 0 },
    posture: {
      availability: 'unknown',
      enforcementMode: 'strict',
      degradedFallbackActive: false,
      confidence: 'reduced',
    },
  };
}

function defaultThreatIntelSummaryResponse() {
  return {
    enabled: false,
    watchlistCount: 0,
    darkwebEnabled: false,
    responseMode: 'manual',
    findings: { total: 0, new: 0, highOrCritical: 0 },
  };
}

function defaultThreatIntelPlanResponse() {
  return {
    title: 'Threat Intel Plan',
    principles: [],
    phases: [],
  };
}

function defaultAuditSummaryResponse() {
  return {
    totalEvents: 0,
    byType: {},
    bySeverity: { info: 0, warn: 0, critical: 0 },
    topDeniedAgents: [],
    topControllers: [],
    windowStart: 0,
    windowEnd: 0,
  };
}

function defaultAuditChainStatusResponse() {
  return {
    valid: undefined,
    available: false,
    totalEntries: 0,
  };
}

activateContextHelp(document);
