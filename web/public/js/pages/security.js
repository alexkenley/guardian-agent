/**
 * Security page — overview, unified alerts, audit, and threat intel.
 */

import { api } from '../api.js';
import { createStatusCard } from '../components/status-card.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createEventLog, appendEvent } from '../components/event-log.js';
import { createTabs } from '../components/tabs.js';
import { onSSE, offSSE } from '../app.js';
import { applyInputTooltips } from '../tooltip.js';

let auditHandler = null;
let monAuditHandler = null;
let monMetricsHandler = null;
let monSecurityAlertHandler = null;
let monSecurityTriageHandler = null;
let currentContainer = null;
let intelUiState = {
  notice: null,
  lastScan: null,
};

const SECURITY_HELP = {
  overview: {
    'Security Domains': {
      whatItIs: 'This section maps the major security responsibilities across Guardian so you can see which page owns the next action.',
      whatSeeing: 'You are seeing a compact ownership matrix for alerts, cloud work, network operations, and threat-intel activity together with direct links into the right destination.',
      whatCanDo: 'Use it to decide whether the next step belongs in Security itself, or whether you should jump into Cloud or Network.',
      howLinks: 'It ties the security-related pages together without duplicating their full control planes inside one view.',
    },
    'Recent Security Activity': {
      whatItIs: 'This section is the recent high-signal event feed for security-relevant activity across the product.',
      whatSeeing: 'You are seeing notable recent audit events such as denials, anomalies, host alerts, gateway alerts, and promoted automation findings.',
      whatCanDo: 'Scan for change quickly, then move to Alerts when you need action or Audit when you need the fuller historical record.',
      howLinks: 'It bridges the overview summary with the deeper operator queues in Alerts and Audit.',
    },
  },
  alerts: {
    'Unified Alert Queue': {
      whatItIs: 'This is the main operator queue for actionable security issues that need triage, acknowledgement, or follow-up.',
      whatSeeing: 'You are seeing normalized alerts from network, host, gateway, cloud, policy, and automation sources in one combined queue.',
      whatCanDo: 'Filter by severity or source, acknowledge supported alerts, and open linked runs or owner pages when you need more detail.',
      howLinks: 'Alerts is the action surface for live issues, while full evidence and history still live in Audit and the originating owner pages.',
    },
  },
  activity: {
    'Agentic Security Log': {
      whatItIs: 'This is the persisted running log for the dedicated security agents and their triage workflow.',
      whatSeeing: 'You are seeing dispatch starts, cooldown skips, completed investigations, and failures as a live feed backed by stored history.',
      whatCanDo: 'Use it to understand why the agent woke up, what it decided, and whether it stayed quiet because an event was deduped or considered low priority.',
      howLinks: 'This sits between Alerts and Audit: it shows the agentic investigation loop itself, while Alerts stays operator-facing and Audit remains the tamper-evident ledger.',
    },
  },
  audit: {
    'Audit Chain Integrity': {
      whatItIs: 'This section verifies the tamper-evident integrity of the stored audit ledger.',
      whatSeeing: 'You are seeing the manual verification control for the audit chain rather than the event rows themselves.',
      whatCanDo: 'Run an integrity check when you need confidence that the event history used in an investigation has not been altered.',
      howLinks: 'This underpins trust in the Audit tab and in any downstream investigation based on those events.',
    },
    'Audit Log': {
      whatItIs: 'This is the canonical historical ledger for security, policy, approval, and operational events across Guardian.',
      whatSeeing: 'You are seeing a filterable event table with timestamps, event types, controller context, severity, and expandable detail payloads.',
      whatCanDo: 'Filter by event type, severity, or agent and expand rows when you need the full context behind a decision or incident.',
      howLinks: 'Audit complements Alerts by preserving the complete historical record, including events that never became an active alert.',
    },
    'Top Denied Agents': {
      whatItIs: 'This section summarizes which agents or automation paths are being denied by policy most often.',
      whatSeeing: 'You are seeing the highest-denial agents over the current summary window rather than the full event-by-event ledger.',
      whatCanDo: 'Use it to spot noisy automations, bad routing, or agent behavior that is repeatedly colliding with policy.',
      howLinks: 'It helps explain patterns that then show up in the full Audit log and policy-related alerts.',
    },
  },
  intel: {
    'Automation Configuration': {
      whatItIs: 'This section controls how the threat-intel workflow runs day to day, including response mode, source availability, and whether an automation preset already exists.',
      whatSeeing: 'You are seeing the current response mode, darkweb-scan posture, connector coverage, last-scan timing, and a shortcut into Automations.',
      whatCanDo: 'Adjust the operating mode, confirm whether the right scan sources are available, refresh the posture view, and jump into Automations when you want recurring runs.',
      howLinks: 'It sets the operating context for the manual scan, watchlist, findings, and drafted-action sections that follow.',
    },
    'Run Intelligence Scan': {
      whatItIs: 'This is the manual execution surface for one-off threat-intel collection and investigation.',
      whatSeeing: 'You are seeing an optional single-use query, source selectors, darkweb controls when available, and the summary of the latest scan run.',
      whatCanDo: 'Run targeted searches for identity abuse, impersonation, fraud, leaks, or related threats and review the resulting findings here in Security.',
      howLinks: 'Manual scans feed the Findings table directly, and high-risk results can also be promoted into the wider security signal path.',
    },
    Watchlist: {
      whatItIs: 'This section is the persistent set of monitored targets used for ongoing threat-intel work.',
      whatSeeing: 'You are seeing the people, aliases, handles, brands, domains, or phrases currently under watch together with controls to add or remove them.',
      whatCanDo: 'Maintain the list of monitored identity targets without leaving the Security page.',
      howLinks: 'Watchlist entries feed manual scans, scheduled scans, findings, and drafted response actions.',
    },
    'Active Findings': {
      whatItIs: 'This section contains the current threat-intel findings produced by watchlist or manual scans.',
      whatSeeing: 'You are seeing findings with severity, confidence, status, source context, and shortcuts for follow-up action.',
      whatCanDo: 'Triage findings, update their status, and create or review follow-up actions from the same page.',
      howLinks: 'Findings are the bridge between collection and response, driving drafted actions and the broader operating plan.',
    },
    'Drafted Intelligence Actions': {
      whatItIs: 'This section is the queue of drafted follow-up actions generated from threat-intel findings.',
      whatSeeing: 'You are seeing proposed response, reporting, or takedown actions together with their approval posture.',
      whatCanDo: 'Review the drafted actions, decide whether they are sensible, and determine whether they need approval or further editing.',
      howLinks: 'These actions are downstream of findings and should be evaluated against the operating plan before execution.',
    },
    'Latest Scan Result': {
      whatItIs: 'This section is the most recent threat-intel scan summary, shown only when a manual or watchlist-driven scan has already run.',
      whatSeeing: 'You are seeing whether the last scan succeeded, the message returned by the run, when it completed, and a short preview of any findings it created.',
      whatCanDo: 'Use it to confirm the last scan actually ran and quickly gauge whether it produced useful findings before moving into the full findings table.',
      howLinks: 'It is a compact recap of the last run, while the durable outcome of that run lives in Active Findings and any drafted actions below.',
    },
    'Operating Plan': {
      whatItIs: 'This section outlines the phased operating plan for how threat-intel work should progress from collection to response.',
      whatSeeing: 'You are seeing the current plan title, objectives, and phase-by-phase deliverables for the threat-intel workflow.',
      whatCanDo: 'Use it to keep triage, investigation, and response work aligned with the intended sequence rather than treating each finding in isolation.',
      howLinks: 'It provides the strategic context for how watchlist items, findings, and drafted actions should be handled.',
    },
  },
};

function cleanupSSE() {
  if (auditHandler) { offSSE('audit', auditHandler); auditHandler = null; }
  if (monAuditHandler) { offSSE('audit', monAuditHandler); monAuditHandler = null; }
  if (monMetricsHandler) { offSSE('metrics', monMetricsHandler); monMetricsHandler = null; }
  if (monSecurityAlertHandler) { offSSE('security.alert', monSecurityAlertHandler); monSecurityAlertHandler = null; }
  if (monSecurityTriageHandler) { offSSE('security.triage', monSecurityTriageHandler); monSecurityTriageHandler = null; }
}

export async function renderSecurity(container, options = {}) {
  currentContainer = container;
  cleanupSSE();
  container.innerHTML = `
    <h2 class="page-title">Security</h2>
    ${renderGuidancePanel({
      kicker: 'Security Guide',
      title: 'Investigation, triage, and evidence',
      whatItIs: 'Security is the canonical home for live alert triage, historical audit review, and threat-intel investigation and response planning.',
      whatSeeing: 'You are seeing tabs for posture, the active alert queue, the live agentic security workflow log, the historical audit ledger, and the threat-intel workspace.',
      whatCanDo: 'Use Overview for posture, Alerts for action now, Agentic Security Log for live agent workflow, Audit for full history, and Threat Intel for identity-abuse monitoring and response planning.',
      howLinks: 'Security receives normalized signals from Network, Cloud, policy, and automations, while deep domain-specific edits still stay on the owner pages.',
    })}
  `;

  createTabs(container, [
    { id: 'overview', label: 'Overview', tooltip: 'Posture summary across local security domains and the current recommended operating mode.', render: renderOverviewTab },
    { id: 'alerts', label: 'Alerts', tooltip: 'Action-now queue for actionable security alerts across host, network, gateway, native protection, and promoted findings.', render: renderAlertsTab },
    { id: 'activity', label: 'Agentic Security Log', tooltip: 'Live agent workflow log showing investigations, skips, failures, and triage decisions with persisted history.', render: renderActivityTab },
    { id: 'audit', label: 'Audit', tooltip: 'Full historical ledger for security, policy, approval, and automation events.', render: renderAuditTab },
    { id: 'intel', label: 'Threat Intel', tooltip: 'Longer-running threat-intel monitoring, watchlist management, findings, and drafted follow-up actions.', render: renderIntelTab },
  ], normalizeSecurityTab(options?.tab));
}

export async function updateSecurity() {
  if (!currentContainer) return;
  const activeTab = currentContainer.dataset.activeTab;
  await renderSecurity(currentContainer, activeTab ? { tab: activeTab } : {});
}

function normalizeSecurityTab(tab) {
  if (tab === 'monitoring') return 'overview';
  if (tab === 'cloud') return 'overview';
  return tab || 'overview';
}

async function renderOverviewTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [securityAlerts, posture, containment, windowsDefender, config, auditEvents] = await Promise.all([
      api.securityAlerts({ limit: 50 }).catch(() => defaultSecurityAlertsResponse()),
      api.securityPosture().catch(() => defaultSecurityPostureResponse()),
      api.securityContainment().catch(() => defaultSecurityContainmentResponse()),
      api.windowsDefenderStatus().catch(() => defaultWindowsDefenderResponse()),
      api.config().catch(() => ({})),
      api.audit({ limit: 100 }).catch(() => []),
    ]);

    const cloud = config?.assistant?.tools?.cloud || { profileCounts: { total: 0 }, enabled: false };
    const securityDefaults = readConfiguredSecuritySettings(config);
    const cloudEvents = (auditEvents || []).filter(isCloudAuditEvent);
    const notableAudit = (auditEvents || [])
      .filter((event) => ['action_denied', 'secret_detected', 'anomaly_detected', 'host_alert', 'gateway_alert', 'automation_finding'].includes(event.type))
      .slice(0, 12);

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Overview',
        compact: true,
        whatItIs: 'Overview is the posture summary for the major security domains.',
        whatSeeing: 'You are seeing high-level counts for network, host, gateway, and cloud-adjacent activity plus a short security activity feed.',
        whatCanDo: 'Use it to judge posture quickly before moving into Alerts for action now, Agentic Security Log for live agent workflow, or Audit for full history.',
        howLinks: 'This tab summarizes domain state without replacing the owner queues in Alerts, the agentic activity log, or the owner pages in Cloud and Network.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card ${posture.shouldEscalate ? 'warning' : 'success'}">
          <div class="card-title">Recommended Mode</div>
          <div class="card-value">${esc(formatSecurityMode(posture.recommendedMode))}</div>
          <div class="card-subtitle">${posture.shouldEscalate ? `Current ${formatSecurityMode(posture.currentMode)}` : 'Stay in monitor'}</div>
        </div>
        <div class="status-card ${containment.effectiveMode !== containment.currentMode ? 'warning' : 'info'}">
          <div class="card-title">Effective Mode</div>
          <div class="card-value">${esc(formatSecurityMode(containment.effectiveMode))}</div>
          <div class="card-subtitle">${containment.autoElevated ? 'Temporary guarded controls' : `Configured ${formatSecurityMode(containment.currentMode)}`}</div>
        </div>
        <div class="status-card ${securityAlerts.totalMatches > 0 ? 'warning' : 'success'}">
          <div class="card-title">Active Alerts</div>
          <div class="card-value">${securityAlerts.totalMatches || 0}</div>
          <div class="card-subtitle">${securityAlerts.bySeverity?.critical || 0} critical · ${securityAlerts.bySeverity?.high || 0} high</div>
        </div>
        <div class="status-card ${(securityAlerts.bySource?.network || 0) > 0 ? 'warning' : 'success'}">
          <div class="card-title">Network Alerts</div>
          <div class="card-value">${securityAlerts.bySource?.network || 0}</div>
          <div class="card-subtitle">${securityAlerts.searchedSources?.includes('network') ? 'Unified queue source' : 'Source unavailable'}</div>
        </div>
        <div class="status-card ${(securityAlerts.bySource?.host || 0) > 0 ? 'warning' : 'success'}">
          <div class="card-title">Host Alerts</div>
          <div class="card-value">${securityAlerts.bySource?.host || 0}</div>
          <div class="card-subtitle">${securityAlerts.searchedSources?.includes('host') ? 'Unified queue source' : 'Source unavailable'}</div>
        </div>
        <div class="status-card ${(securityAlerts.bySource?.gateway || 0) > 0 ? 'warning' : 'success'}">
          <div class="card-title">Gateway Alerts</div>
          <div class="card-value">${securityAlerts.bySource?.gateway || 0}</div>
          <div class="card-subtitle">${securityAlerts.searchedSources?.includes('gateway') ? 'Unified queue source' : 'Source unavailable'}</div>
        </div>
        <div class="status-card ${(securityAlerts.bySource?.native || 0) > 0 ? 'warning' : 'success'}">
          <div class="card-title">Native Alerts</div>
          <div class="card-value">${securityAlerts.bySource?.native || 0}</div>
          <div class="card-subtitle">${windowsDefender?.status?.supported ? 'Native security provider' : 'No native provider'}</div>
        </div>
        <div class="status-card ${cloudEvents.length > 0 ? 'info' : 'accent'}">
          <div class="card-title">Cloud Activity</div>
          <div class="card-value">${cloudEvents.length}</div>
          <div class="card-subtitle">${cloud.profileCounts?.total || 0} cloud profiles</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recommended Operating Mode</h3></div>
        <div style="padding:0.85rem 1rem;">
          <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
            <span class="badge ${modeBadgeClass(posture.recommendedMode)}">${esc(formatSecurityMode(posture.recommendedMode))}</span>
            <span>${esc(posture.summary)}</span>
          </div>
          ${Array.isArray(posture.reasons) && posture.reasons.length > 0
            ? `<div style="margin-top:0.55rem;color:var(--text-secondary);">${posture.reasons.slice(0, 2).map((reason) => esc(reason)).join(' ')}</div>`
            : ''}
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Containment State</h3></div>
        <div style="padding:0.85rem 1rem;">
          <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
            <span class="badge ${modeBadgeClass(containment.effectiveMode)}">${esc(formatSecurityMode(containment.effectiveMode))}</span>
            <span>${containment.autoElevated ? 'A conservative temporary guarded posture is active.' : 'Containment follows the configured operating mode.'}</span>
          </div>
          ${Array.isArray(containment.activeActions) && containment.activeActions.length > 0
            ? `<div style="margin-top:0.65rem;color:var(--text-secondary);">${containment.activeActions.slice(0, 3).map((item) => `${esc(item.title)}: ${esc(item.reason)}`).join(' ')}</div>`
            : `<div style="margin-top:0.65rem;color:var(--text-secondary);">No bounded containment actions are currently active.</div>`}
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Native Host Protection</h3></div>
        <div style="padding:0.85rem 1rem;">
          <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
            <span class="badge ${windowsDefender.status?.available ? 'badge-success' : 'badge-info'}">${esc(windowsDefender.status?.provider === 'windows_defender' ? 'Windows Defender' : 'Native provider')}</span>
            <span>${esc(windowsDefender.status?.summary || 'Native host protection status is unavailable.')}</span>
          </div>
          <div style="margin-top:0.55rem;color:var(--text-secondary);">
            ${windowsDefender.status?.supported
              ? `${windowsDefender.status?.activeAlertCount || 0} native alerts · signatures ${formatNullableNumber(windowsDefender.status?.signatureAgeHours, 'h old')}`
              : 'Native Defender integration is only available on Windows hosts.'}
          </div>
          <div style="margin-top:0.8rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button class="btn btn-secondary" id="windows-defender-refresh">Refresh Native Status</button>
            <button class="btn btn-secondary" id="windows-defender-quick-scan" ${windowsDefender.status?.supported ? '' : 'disabled'}>Quick Scan</button>
            <button class="btn btn-secondary" id="windows-defender-update-signatures" ${windowsDefender.status?.supported ? '' : 'disabled'}>Update Signatures</button>
          </div>
          <div id="windows-defender-message" style="margin-top:0.55rem;color:var(--text-secondary);font-size:0.82rem;">
            Native-provider actions stay bounded to Defender status refresh, scan requests, and signature updates.
          </div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Security Defaults</h3></div>
        <div class="filters">
          <label>Profile:</label>
          <select id="security-profile-select">
            ${renderSecurityProfileOptions(securityDefaults.deploymentProfile)}
          </select>
          <label>Mode:</label>
          <select id="security-mode-select">
            ${renderSecurityModeOptions(securityDefaults.operatingMode)}
          </select>
          <label>Triage Provider:</label>
          <select id="security-triage-provider-select">
            ${renderSecurityTriageProviderOptions(securityDefaults.triageLlmProvider)}
          </select>
          <button class="btn btn-primary" id="security-settings-save">Save</button>
          <button class="btn btn-secondary" id="security-settings-refresh">Refresh</button>
        </div>
        <div id="security-settings-message" style="padding:0 1rem 0.85rem;color:var(--text-secondary);font-size:0.82rem;">
          Saved defaults set the local deployment profile, the current operating mode, and whether agentic triage stays local-first or can use an external provider.
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Security Domains</h3></div>
        <table>
          <thead><tr><th>Domain</th><th>Current State</th><th>Owner</th><th>Next Action</th></tr></thead>
          <tbody>
            <tr><td>Alerts</td><td>${securityAlerts.totalMatches || 0} active</td><td>Security</td><td><a href="#/security?tab=alerts">Open unified alert queue</a></td></tr>
            <tr><td>Cloud</td><td>${cloud.enabled ? 'Enabled' : 'Disabled'} · ${cloud.profileCounts?.total || 0} profiles</td><td>Cloud</td><td><a href="#/cloud">Open cloud hub</a></td></tr>
            <tr><td>Network Operations</td><td>${securityAlerts.bySource?.network || 0} alerts</td><td>Network</td><td><a href="#/network">Open network tools</a></td></tr>
            <tr><td>Threat Intel</td><td>Watchlist and findings available</td><td>Security</td><td><a href="#/security?tab=intel">Open threat intel</a></td></tr>
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Security Activity</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Source</th><th>Detail</th></tr></thead>
          <tbody>
            ${notableAudit.length === 0
              ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No recent security activity.</td></tr>'
              : notableAudit.map((event) => `
                <tr>
                  <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
                  <td>${esc(event.type)}</td>
                  <td><span class="badge ${auditSeverityClass(event.severity)}">${esc(event.severity)}</span></td>
                  <td>${esc(event.details?.source || event.details?.toolName || event.controller || '-')}</td>
                  <td>${esc(event.details?.description || event.details?.reason || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
    const profileEl = panel.querySelector('#security-profile-select');
    const modeEl = panel.querySelector('#security-mode-select');
    const triageProviderEl = panel.querySelector('#security-triage-provider-select');
    const messageEl = panel.querySelector('#security-settings-message');
    panel.querySelector('#security-settings-save')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (
        !(button instanceof HTMLButtonElement)
        || !(profileEl instanceof HTMLSelectElement)
        || !(modeEl instanceof HTMLSelectElement)
        || !(triageProviderEl instanceof HTMLSelectElement)
      ) return;
      button.disabled = true;
      if (messageEl instanceof HTMLElement) {
        messageEl.textContent = 'Saving security defaults...';
        messageEl.style.color = 'var(--text-secondary)';
      }
      try {
        const result = await api.updateConfig({
          assistant: {
            security: {
              deploymentProfile: profileEl.value,
              operatingMode: modeEl.value,
              triageLlmProvider: triageProviderEl.value,
            },
          },
        });
        if (messageEl instanceof HTMLElement) {
          messageEl.textContent = result?.message || 'Security defaults saved.';
          messageEl.style.color = 'var(--success)';
        }
        await updateSecurity();
      } catch (err) {
        if (messageEl instanceof HTMLElement) {
          messageEl.textContent = err instanceof Error ? err.message : String(err);
          messageEl.style.color = 'var(--error)';
        }
        button.disabled = false;
      }
    });
    panel.querySelector('#security-settings-refresh')?.addEventListener('click', () => {
      void renderOverviewTab(panel);
    });
    const nativeMessageEl = panel.querySelector('#windows-defender-message');
    panel.querySelector('#windows-defender-refresh')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      if (nativeMessageEl instanceof HTMLElement) {
        nativeMessageEl.textContent = 'Refreshing native status...';
        nativeMessageEl.style.color = 'var(--text-secondary)';
      }
      try {
        await api.windowsDefenderRefresh();
        await renderOverviewTab(panel);
      } catch (err) {
        if (nativeMessageEl instanceof HTMLElement) {
          nativeMessageEl.textContent = err instanceof Error ? err.message : String(err);
          nativeMessageEl.style.color = 'var(--error)';
        }
        button.disabled = false;
      }
    });
    panel.querySelector('#windows-defender-quick-scan')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      if (nativeMessageEl instanceof HTMLElement) {
        nativeMessageEl.textContent = 'Requesting quick scan...';
        nativeMessageEl.style.color = 'var(--text-secondary)';
      }
      try {
        const result = await api.windowsDefenderScan('quick');
        if (nativeMessageEl instanceof HTMLElement) {
          nativeMessageEl.textContent = result?.message || 'Quick scan requested.';
          nativeMessageEl.style.color = 'var(--success)';
        }
      } catch (err) {
        if (nativeMessageEl instanceof HTMLElement) {
          nativeMessageEl.textContent = err instanceof Error ? err.message : String(err);
          nativeMessageEl.style.color = 'var(--error)';
        }
      } finally {
        button.disabled = false;
      }
    });
    panel.querySelector('#windows-defender-update-signatures')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      if (nativeMessageEl instanceof HTMLElement) {
        nativeMessageEl.textContent = 'Requesting signature update...';
        nativeMessageEl.style.color = 'var(--text-secondary)';
      }
      try {
        const result = await api.windowsDefenderUpdateSignatures();
        if (nativeMessageEl instanceof HTMLElement) {
          nativeMessageEl.textContent = result?.message || 'Signature update requested.';
          nativeMessageEl.style.color = 'var(--success)';
        }
      } catch (err) {
        if (nativeMessageEl instanceof HTMLElement) {
          nativeMessageEl.textContent = err instanceof Error ? err.message : String(err);
          nativeMessageEl.style.color = 'var(--error)';
        }
      } finally {
        button.disabled = false;
      }
    });
    applyInputTooltips(panel);
    enhanceSectionHelp(panel, SECURITY_HELP.overview, createGenericHelpFactory('Security Overview'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderAlertsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [securityAlerts, posture, auditEvents] = await Promise.all([
      api.securityAlerts({ limit: 100, includeAcknowledged: true, includeInactive: true }).catch(() => defaultSecurityAlertsResponse()),
      api.securityPosture().catch(() => defaultSecurityPostureResponse()),
      api.audit({ limit: 200 }).catch(() => []),
    ]);

    const rows = [
      ...(securityAlerts.alerts || []).map((alert) => ({
        id: alert.id,
        source: alert.source,
        timestamp: alert.lastSeenAt || alert.timestamp || Date.now(),
        severity: mapNetworkSeverityToAudit(alert.severity),
        severityKey: alert.severity,
        severityLabel: formatSeverityLabel(alert.severity),
        status: alert.status || (alert.acknowledged ? 'acknowledged' : 'active'),
        title: alert.type,
        subject: describeUnifiedSecurityAlert(alert),
        detail: alert.description || '-',
        ackSource: alert.source,
        isLocalAlert: true,
      })),
      ...(auditEvents || [])
        .filter((event) => isCloudAuditEvent(event))
        .map((event) => ({
          id: `cloud-${event.timestamp}-${event.type}`,
          source: 'cloud',
          timestamp: event.timestamp,
          severity: event.severity || 'info',
          severityKey: event.severity || 'info',
          severityLabel: formatSeverityLabel(event.severity || 'info'),
          status: '',
          title: event.type,
          subject: event.details?.toolName || '-',
          detail: event.details?.reason || event.details?.source || '-',
          ackSource: '',
        })),
      ...(auditEvents || [])
        .filter((event) => ['action_denied', 'secret_detected', 'policy_changed', 'anomaly_detected'].includes(event.type))
        .map((event) => ({
          id: `policy-${event.timestamp}-${event.type}`,
          source: 'tool/policy',
          timestamp: event.timestamp,
          severity: event.severity || 'info',
          severityKey: event.severity || 'info',
          severityLabel: formatSeverityLabel(event.severity || 'info'),
          status: '',
          title: event.type,
          subject: event.details?.toolName || event.agentId || '-',
          detail: event.details?.reason || event.details?.description || '-',
          ackSource: '',
        })),
      ...(auditEvents || [])
        .filter((event) => isAutomationAuditEvent(event))
        .map((event) => ({
          id: event.id || `automation-${event.timestamp}`,
          source: 'automation',
          timestamp: event.timestamp,
          severity: event.severity || 'info',
          severityKey: event.severity || 'info',
          severityLabel: formatSeverityLabel(event.severity || 'info'),
          status: '',
          title: event.details?.title || 'Automation finding',
          subject: event.details?.automationName || event.details?.automationId || '-',
          detail: event.details?.description || '-',
          ackSource: '',
          href: event.details?.runLink || '',
          actionLabel: 'Open run',
        })),
    ]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 200);

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Alerts',
        compact: true,
        whatItIs: 'Alerts is the active queue for security items that may need operator action.',
        whatSeeing: 'You are seeing normalized alert rows from multiple sources with shared filtering.',
        whatCanDo: 'Use it for action now: filter, acknowledge supported alerts, and follow linked rows back to the originating run or owner system.',
        howLinks: 'This is the action queue, while Audit remains the durable ledger of everything that happened.',
      })}
      <div class="table-container">
        <div class="table-header"><h3>Local Security Posture</h3></div>
        <div style="padding:0.85rem 1rem;">
          <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
            <span class="badge ${modeBadgeClass(posture.recommendedMode)}">${esc(formatSecurityMode(posture.recommendedMode))}</span>
            <span>${esc(posture.summary)}</span>
          </div>
          <div style="margin-top:0.55rem;color:var(--text-secondary);">
            ${securityAlerts.totalMatches || 0} local alerts across host, network, gateway, and native sources.
          </div>
        </div>
      </div>
      <div class="filters">
        <label>Source:</label>
        <select id="security-alert-source">
          <option value="">All</option>
          <option value="network">Network</option>
          <option value="host">Host</option>
          <option value="gateway">Gateway</option>
          <option value="native">Native</option>
          <option value="cloud">Cloud</option>
          <option value="tool/policy">Tool/Policy</option>
          <option value="automation">Automation</option>
        </select>
        <label>Severity:</label>
        <select id="security-alert-severity">
          <option value="">All</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
        </select>
        <label>Status:</label>
        <select id="security-alert-status">
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="suppressed">Suppressed</option>
        </select>
        <button class="btn btn-secondary" id="security-alert-refresh">Refresh</button>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Unified Alert Queue</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Source</th><th>Title</th><th>Severity</th><th>Status</th><th>Subject</th><th>Detail</th><th>Action</th></tr></thead>
          <tbody id="security-alerts-body"></tbody>
        </table>
      </div>
    `;

    const bodyEl = panel.querySelector('#security-alerts-body');
    const sourceEl = panel.querySelector('#security-alert-source');
    const severityEl = panel.querySelector('#security-alert-severity');
    const statusEl = panel.querySelector('#security-alert-status');

    const renderRows = () => {
      const source = sourceEl?.value || '';
      const severity = severityEl?.value || '';
      const status = statusEl?.value || '';
      const filtered = rows.filter((row) => (
        (!source || row.source === source)
        && (!severity || row.severityKey === severity)
        && (!status || row.status === status)
      ));
      bodyEl.innerHTML = filtered.length === 0
        ? '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">No alerts match the current filters.</td></tr>'
        : filtered.map((row) => `
          <tr>
            <td>${new Date(row.timestamp).toLocaleTimeString()}</td>
            <td>${esc(row.source)}</td>
            <td>${esc(row.title)}</td>
            <td><span class="badge ${auditSeverityClass(row.severity)}">${esc(row.severityLabel)}</span></td>
            <td>${row.status ? `<span class="badge ${alertStatusBadgeClass(row.status)}">${esc(formatAlertStatus(row.status))}</span>` : '<span style="color:var(--text-muted)">-</span>'}</td>
            <td>${esc(row.subject)}</td>
            <td title="${escAttr(row.detail)}">${esc(row.detail)}</td>
            <td>
              ${row.ackSource
                ? renderSecurityAlertActions(row)
                : row.href
                  ? `<a class="btn btn-secondary btn-sm" href="${escAttr(row.href)}">${esc(row.actionLabel || 'Open')}</a>`
                : '<span style="color:var(--text-muted)">Audit only</span>'}
            </td>
          </tr>
        `).join('');
    };

    renderRows();

    sourceEl?.addEventListener('change', renderRows);
    severityEl?.addEventListener('change', renderRows);
    statusEl?.addEventListener('change', renderRows);
    panel.querySelector('#security-alert-refresh')?.addEventListener('click', () => renderAlertsTab(panel));
    applyInputTooltips(panel);
    enhanceSectionHelp(panel, SECURITY_HELP.alerts, createGenericHelpFactory('Security Alerts'));
    activateContextHelp(panel);

    bodyEl.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.security-alert-action');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      const ackSource = button.getAttribute('data-alert-source');
      const action = button.getAttribute('data-action');
      if (!alertId || !ackSource || !action) return;
      button.setAttribute('disabled', 'true');
      try {
        if (action === 'ack') {
          await api.acknowledgeSecurityAlert(alertId, ackSource);
        } else if (action === 'resolve') {
          await api.resolveSecurityAlert(alertId, ackSource);
        } else if (action === 'suppress') {
          await api.suppressSecurityAlert(alertId, ackSource, Date.now() + (24 * 60 * 60 * 1000), 'Suppressed from Security page for 24 hours.');
        }
        await renderAlertsTab(panel);
      } catch {
        button.removeAttribute('disabled');
      }
    });
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderActivityTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const activity = await api.securityActivity({ limit: 200 }).catch(() => defaultSecurityActivityResponse());
    const entries = Array.isArray(activity.entries) ? [...activity.entries] : [];

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Agentic Security Log',
        compact: true,
        whatItIs: 'This tab is the persisted running log for the dedicated security agents and their triage workflow.',
        whatSeeing: 'You are seeing a live agent activity feed plus a stored decision history covering investigations, cooldown skips, completions, and failures.',
        whatCanDo: 'Use it to understand why the security agents woke up, what they investigated, what they decided, and when they stayed quiet on repeated events.',
        howLinks: 'This complements Alerts and Audit by showing the agentic security loop itself rather than just the operator queue or the final ledger.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">Persisted Entries</div>
          <div class="card-value" id="security-activity-total">${activity.totalMatches || entries.length}</div>
          <div class="card-subtitle">Recent security-agent workflow history</div>
        </div>
        <div class="status-card success">
          <div class="card-title">Completed</div>
          <div class="card-value" id="security-activity-completed">${activity.byStatus?.completed || 0}</div>
          <div class="card-subtitle">Finished investigations and decisions</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">Skipped</div>
          <div class="card-value" id="security-activity-skipped">${activity.byStatus?.skipped || 0}</div>
          <div class="card-subtitle">Cooldown or bounded no-op decisions</div>
        </div>
        <div class="status-card ${(activity.byStatus?.failed || 0) > 0 ? 'error' : 'accent'}">
          <div class="card-title">Failures</div>
          <div class="card-value" id="security-activity-failed">${activity.byStatus?.failed || 0}</div>
          <div class="card-subtitle">Investigations that need review</div>
        </div>
      </div>

      <div class="filters">
        <label>Status:</label>
        <select id="security-activity-status">
          <option value="">All</option>
          <option value="started">Started</option>
          <option value="completed">Completed</option>
          <option value="skipped">Skipped</option>
          <option value="failed">Failed</option>
        </select>
        <label>Agent:</label>
        <select id="security-activity-agent">
          <option value="">All</option>
          ${buildSecurityActivityAgentOptions(entries)}
        </select>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Agentic Security Log</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Agent</th><th>Status</th><th>Trigger</th><th>Decision</th></tr></thead>
          <tbody id="security-activity-body"></tbody>
        </table>
      </div>
    `;

    const eventLogEl = createEventLog('Live Security Agent Activity');
    panel.appendChild(eventLogEl);

    const bodyEl = panel.querySelector('#security-activity-body');
    const statusEl = panel.querySelector('#security-activity-status');
    const agentEl = panel.querySelector('#security-activity-agent');
    const totalEl = panel.querySelector('#security-activity-total');
    const completedEl = panel.querySelector('#security-activity-completed');
    const skippedEl = panel.querySelector('#security-activity-skipped');
    const failedEl = panel.querySelector('#security-activity-failed');

    const renderSummary = () => {
      const counts = summarizeSecurityActivity(entries);
      if (totalEl) totalEl.textContent = String(entries.length);
      if (completedEl) completedEl.textContent = String(counts.completed);
      if (skippedEl) skippedEl.textContent = String(counts.skipped);
      if (failedEl) failedEl.textContent = String(counts.failed);
    };

    const renderRows = () => {
      const filtered = filterSecurityActivityEntries(entries, {
        status: statusEl?.value || '',
        agentId: agentEl?.value || '',
      });
      bodyEl.innerHTML = filtered.length === 0
        ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No security-agent activity matches the current filters.</td></tr>'
        : filtered.map((entry) => `
          <tr>
            <td>${new Date(entry.timestamp).toLocaleTimeString()}</td>
            <td>${esc(entry.agentId)}${entry.targetAgentId ? ` <span style="color:var(--text-muted)">→ ${esc(entry.targetAgentId)}</span>` : ''}</td>
            <td><span class="badge ${securityActivityStatusBadgeClass(entry.status)}">${esc(formatSecurityActivityStatus(entry.status))}</span></td>
            <td>${esc(formatSecurityActivityTrigger(entry))}</td>
            <td title="${escAttr(entry.summary)}">${esc(entry.summary)}</td>
          </tr>
        `).join('');
    };

    renderSummary();
    renderRows();

    [...entries].reverse().forEach((entry) => appendEvent(eventLogEl, toSecurityActivityEvent(entry)));

    statusEl?.addEventListener('change', renderRows);
    agentEl?.addEventListener('change', renderRows);

    monSecurityTriageHandler = (entry) => {
      entries.unshift(entry);
      renderSummary();
      renderRows();
      appendEvent(eventLogEl, toSecurityActivityEvent(entry));
    };
    onSSE('security.triage', monSecurityTriageHandler);

    applyInputTooltips(panel);
    enhanceSectionHelp(panel, SECURITY_HELP.activity, createGenericHelpFactory('Security Activity'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

// ─── Audit Tab ────────────────────────────────────────────

async function renderAuditTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const summary = await api.auditSummary(300000);
    panel.innerHTML = renderGuidancePanel({
      kicker: 'Audit',
      compact: true,
      whatItIs: 'Audit is the full historical ledger for security, policy, and promoted automation events.',
      whatSeeing: 'You are seeing summary cards, chain verification, a filterable event log, and denial summaries.',
      whatCanDo: 'Use it for full history: verify integrity, investigate what happened, and review the evidence behind alerts or policy decisions.',
      howLinks: 'Audit preserves full context for current alerts and for events that never surfaced in the active alert queue.',
    });

    // Summary cards
    const grid = document.createElement('div');
    grid.className = 'cards-grid';
    grid.appendChild(createStatusCard('Total Events', summary.totalEvents, 'Last 5 minutes', 'info'));
    grid.appendChild(createStatusCard('Denials', summary.byType.action_denied || 0, 'Actions blocked', summary.byType.action_denied ? 'warning' : 'success'));
    grid.appendChild(createStatusCard('Secrets Detected', summary.byType.secret_detected || 0, 'Credential leaks caught', summary.byType.secret_detected ? 'error' : 'success'));
    grid.appendChild(createStatusCard('Anomalies', summary.byType.anomaly_detected || 0, 'Anomaly alerts', summary.byType.anomaly_detected ? 'error' : 'success'));
    panel.appendChild(grid);

    // Audit Chain Verification
    const verifySection = document.createElement('div');
    verifySection.className = 'table-container';
    verifySection.innerHTML = `
      <div class="table-header">
        <h3>Audit Chain Integrity</h3>
        <button class="btn btn-primary" id="verify-chain" style="font-size:0.7rem;padding:0.3rem 0.6rem;">Verify Audit Chain</button>
      </div>
      <div id="chain-result" style="padding:0.75rem 1rem;font-size:0.8rem;color:var(--text-secondary);">
        Click "Verify Audit Chain" to check tamper-evident hash chain integrity.
      </div>
    `;
    panel.appendChild(verifySection);

    verifySection.querySelector('#verify-chain')?.addEventListener('click', async () => {
      const resultEl = verifySection.querySelector('#chain-result');
      resultEl.textContent = 'Verifying chain...';
      resultEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.verifyAuditChain();
        if (result.valid) {
          resultEl.textContent = `Chain valid. ${result.totalEntries} entries verified.`;
          resultEl.style.color = 'var(--success)';
        } else {
          resultEl.textContent = `Chain BROKEN at entry ${result.brokenAt} of ${result.totalEntries}. Possible tampering detected.`;
          resultEl.style.color = 'var(--error)';
        }
      } catch (err) {
        resultEl.textContent = `Verification failed: ${err.message || String(err)}`;
        resultEl.style.color = 'var(--error)';
      }
    });

    // Filters
    const filters = document.createElement('div');
    filters.className = 'filters';
    filters.innerHTML = `
      <label>Type:</label>
      <select id="filter-type">
        <option value="">All</option>
        <option value="action_denied">action_denied</option>
        <option value="action_allowed">action_allowed</option>
        <option value="secret_detected">secret_detected</option>
        <option value="output_blocked">output_blocked</option>
        <option value="output_redacted">output_redacted</option>
        <option value="event_blocked">event_blocked</option>
        <option value="input_sanitized">input_sanitized</option>
        <option value="rate_limited">rate_limited</option>
        <option value="capability_probe">capability_probe</option>
        <option value="policy_changed">policy_changed</option>
        <option value="anomaly_detected">anomaly_detected</option>
        <option value="host_alert">host_alert</option>
        <option value="gateway_alert">gateway_alert</option>
        <option value="agent_error">agent_error</option>
        <option value="agent_stalled">agent_stalled</option>
        <option value="automation_finding">automation_finding</option>
      </select>
      <label>Severity:</label>
      <select id="filter-severity">
        <option value="">All</option>
        <option value="critical">Critical</option>
        <option value="warn">Warning</option>
        <option value="info">Info</option>
      </select>
      <label>Agent:</label>
      <input type="text" id="filter-agent" placeholder="Agent ID" style="width:120px;">
      <label>Limit:</label>
      <input type="number" id="filter-limit" value="50" min="1" max="500" style="width:60px;">
      <button class="btn btn-primary" id="filter-apply">Apply</button>
    `;
    panel.appendChild(filters);

    // Audit table
    const tableContainer = document.createElement('div');
    tableContainer.className = 'table-container';
    tableContainer.innerHTML = `
      <div class="table-header"><h3>Audit Log</h3></div>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Agent</th><th>Controller</th><th>Details</th></tr></thead>
        <tbody id="audit-table-body"></tbody>
      </table>
    `;
    panel.appendChild(tableContainer);

    const auditTableBody = tableContainer.querySelector('#audit-table-body');

    // Load initial data
    async function loadAuditEvents() {
      const type = panel.querySelector('#filter-type')?.value;
      const severity = panel.querySelector('#filter-severity')?.value;
      const agentId = panel.querySelector('#filter-agent')?.value;
      const limit = panel.querySelector('#filter-limit')?.value;
      try {
        const events = await api.audit({ type, severity, agentId, limit });
        auditTableBody.innerHTML = '';
        for (const event of events.reverse()) {
          auditTableBody.appendChild(createAuditRow(event));
        }
      } catch { /* keep existing data */ }
    }

    await loadAuditEvents();
    panel.querySelector('#filter-apply')?.addEventListener('click', loadAuditEvents);
    applyInputTooltips(panel);
    enhanceSectionHelp(panel, SECURITY_HELP.audit, createGenericHelpFactory('Security Audit'));
    activateContextHelp(panel);

    // Top denied agents
    if (summary.topDeniedAgents.length > 0) {
      const deniedSection = document.createElement('div');
      deniedSection.className = 'table-container';
      deniedSection.innerHTML = `
        <div class="table-header"><h3>Top Denied Agents</h3></div>
        <table>
          <thead><tr><th>Agent ID</th><th>Denial Count</th></tr></thead>
          <tbody>${summary.topDeniedAgents.map(a => `
            <tr><td>${esc(a.agentId)}</td><td>${a.count}</td></tr>
          `).join('')}</tbody>
        </table>
      `;
      panel.appendChild(deniedSection);
    }

    // SSE: append new audit events
    auditHandler = (event) => {
      if (!auditTableBody) return;
      auditTableBody.insertBefore(createAuditRow(event), auditTableBody.firstChild);
      while (auditTableBody.children.length > 100) {
        auditTableBody.removeChild(auditTableBody.lastChild);
      }
    };
    onSSE('audit', auditHandler);

  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function createAuditRow(event) {
  const tr = document.createElement('tr');
  const preview = summarize(event.details);
  const fullDetails = formatAuditDetails(event.details);
  tr.innerHTML = `
    <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
    <td>${esc(event.type)}</td>
    <td><span class="badge badge-${event.severity}">${esc(event.severity)}</span></td>
    <td>${esc(event.agentId)}</td>
    <td>${esc(event.controller || '-')}</td>
    <td>
      <details class="audit-details">
        <summary>${esc(preview)}</summary>
        <pre>${esc(fullDetails)}</pre>
      </details>
    </td>
  `;
  return tr;
}

function summarize(details) {
  if (!details) return '-';
  if (details.reason) return String(details.reason);
  if (details.error) return String(details.error);
  if (details.description) return String(details.description);
  const json = JSON.stringify(details);
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}

function formatAuditDetails(details) {
  if (!details) return '-';
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

// ─── Monitoring Tab ──────────────────────────────────────

async function renderMonitoringTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [agents, budget, analytics, baseline, threatState, hostStatus, hostAlerts, gatewayStatus, gatewayAlerts] = await Promise.all([
      api.agents().catch(() => []),
      api.budget().catch(() => ({ agents: [], recentOverruns: [] })),
      api.analyticsSummary(3600000).catch(() => null),
      api.networkBaseline().catch(() => null),
      api.networkThreats({ limit: 50 }).catch(() => null),
      api.hostMonitorStatus().catch(() => null),
      api.hostMonitorAlerts({ limit: 50 }).catch(() => null),
      api.gatewayMonitorStatus().catch(() => null),
      api.gatewayMonitorAlerts({ limit: 50 }).catch(() => null),
    ]);

    panel.innerHTML = '';

    const safeBaseline = baseline || {
      snapshotCount: 0,
      minSnapshotsForBaseline: 3,
      baselineReady: false,
      lastUpdatedAt: 0,
      knownDevices: [],
    };
    const safeThreatState = threatState || {
      alerts: [],
      activeAlertCount: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
      baselineReady: safeBaseline.baselineReady,
      snapshotCount: safeBaseline.snapshotCount,
    };
    const safeHostStatus = hostStatus || {
      platform: 'unknown',
      enabled: false,
      baselineReady: false,
      lastUpdatedAt: 0,
      snapshot: {
        processCount: 0,
        suspiciousProcesses: [],
        persistenceEntryCount: 0,
        watchedPathCount: 0,
        knownExternalDestinationCount: 0,
        listeningPortCount: 0,
        firewallBackend: 'unavailable',
        firewallEnabled: null,
        firewallRuleCount: 0,
      },
      activeAlertCount: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    };
    const safeHostAlerts = hostAlerts || {
      alerts: [],
      activeAlertCount: 0,
      bySeverity: safeHostStatus.bySeverity,
      baselineReady: safeHostStatus.baselineReady,
      lastUpdatedAt: safeHostStatus.lastUpdatedAt,
    };
    const safeGatewayStatus = gatewayStatus || {
      enabled: false,
      baselineReady: false,
      lastUpdatedAt: 0,
      monitorCount: 0,
      availableGatewayCount: 0,
      gateways: [],
      activeAlertCount: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    };
    const safeGatewayAlerts = gatewayAlerts || {
      alerts: [],
      activeAlertCount: 0,
      bySeverity: safeGatewayStatus.bySeverity,
      baselineReady: safeGatewayStatus.baselineReady,
      lastUpdatedAt: safeGatewayStatus.lastUpdatedAt,
    };

    const threatSectionHeader = document.createElement('h3');
    threatSectionHeader.className = 'section-header';
    threatSectionHeader.textContent = 'Network Threat Posture';
    panel.appendChild(threatSectionHeader);

    const threatGrid = document.createElement('div');
    threatGrid.className = 'cards-grid';
    panel.appendChild(threatGrid);

    const threatContainer = document.createElement('div');
    threatContainer.className = 'table-container';
    threatContainer.innerHTML = `
      <div class="table-header">
        <h3>Active Network Alerts</h3>
        <div>
          <span id="net-threat-meta" style="font-size:0.8rem;color:var(--text-muted);margin-right:0.75rem;"></span>
          <button class="btn btn-secondary" id="net-threat-refresh">Refresh</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Host</th><th>Details</th><th>Action</th></tr></thead>
        <tbody id="net-threat-table-body"></tbody>
      </table>
    `;
    panel.appendChild(threatContainer);

    const threatMetaEl = threatContainer.querySelector('#net-threat-meta');
    const threatTableBody = threatContainer.querySelector('#net-threat-table-body');

    const renderThreatCards = (baselineState, currentThreatState) => {
      threatGrid.innerHTML = '';
      threatGrid.appendChild(createStatusCard(
        'Baseline',
        baselineState.baselineReady ? 'Ready' : 'Learning',
        `${baselineState.snapshotCount}/${baselineState.minSnapshotsForBaseline} snapshots`,
        baselineState.baselineReady ? 'success' : 'warning',
      ));
      threatGrid.appendChild(createStatusCard(
        'Known Devices',
        baselineState.knownDevices.length,
        baselineState.lastUpdatedAt ? `Updated ${new Date(baselineState.lastUpdatedAt).toLocaleTimeString()}` : 'No snapshots yet',
        'info',
      ));
      threatGrid.appendChild(createStatusCard(
        'Active Alerts',
        currentThreatState.activeAlertCount || 0,
        `${currentThreatState.bySeverity?.critical ?? 0} critical`,
        (currentThreatState.bySeverity?.high ?? 0) > 0 || (currentThreatState.bySeverity?.critical ?? 0) > 0 ? 'error' : 'accent',
      ));
      threatGrid.appendChild(createStatusCard(
        'High + Critical',
        (currentThreatState.bySeverity?.high ?? 0) + (currentThreatState.bySeverity?.critical ?? 0),
        `Medium ${currentThreatState.bySeverity?.medium ?? 0} / Low ${currentThreatState.bySeverity?.low ?? 0}`,
        (currentThreatState.bySeverity?.high ?? 0) + (currentThreatState.bySeverity?.critical ?? 0) > 0 ? 'warning' : 'success',
      ));
    };

    const renderThreatRows = (alerts) => {
      if (!threatTableBody) return;
      if (!alerts || alerts.length === 0) {
        threatTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active network alerts.</td></tr>';
        return;
      }
      threatTableBody.innerHTML = alerts.map((alert) => `
        <tr>
          <td>${new Date(alert.lastSeenAt || alert.timestamp || Date.now()).toLocaleTimeString()}</td>
          <td><span class="badge ${severityClass(alert.severity)}">${esc(alert.severity)}</span></td>
          <td>${esc(alert.type)}</td>
          <td>${esc(alert.ip || alert.mac || '-')}</td>
          <td title="${escAttr(alert.description || '')}">${esc(alert.description || '-')}</td>
          <td><button class="btn btn-secondary net-alert-ack" data-alert-id="${escAttr(alert.id)}">Acknowledge</button></td>
        </tr>
      `).join('');
    };

    const applyThreatState = (baselineState, currentThreatState) => {
      renderThreatCards(baselineState, currentThreatState);
      renderThreatRows(currentThreatState.alerts || []);
      if (threatMetaEl) {
        threatMetaEl.textContent = `Snapshots: ${baselineState.snapshotCount} • Baseline: ${baselineState.baselineReady ? 'ready' : 'learning'}`;
      }
    };

    const loadThreatState = async () => {
      const [latestBaseline, latestThreats] = await Promise.all([
        api.networkBaseline().catch(() => safeBaseline),
        api.networkThreats({ limit: 50 }).catch(() => safeThreatState),
      ]);
      applyThreatState(latestBaseline, latestThreats);
    };

    applyThreatState(safeBaseline, safeThreatState);

    threatContainer.querySelector('#net-threat-refresh')?.addEventListener('click', () => {
      loadThreatState().catch(() => {});
    });

    threatContainer.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.net-alert-ack');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      if (!alertId) return;
      button.setAttribute('disabled', 'true');
      try {
        await api.acknowledgeNetworkThreat(alertId);
        await loadThreatState();
      } catch {
        button.removeAttribute('disabled');
      }
    });

    const hostSectionHeader = document.createElement('h3');
    hostSectionHeader.className = 'section-header';
    hostSectionHeader.textContent = 'Host Monitor Posture';
    panel.appendChild(hostSectionHeader);

    const hostGrid = document.createElement('div');
    hostGrid.className = 'cards-grid';
    panel.appendChild(hostGrid);

    const hostContainer = document.createElement('div');
    hostContainer.className = 'table-container';
    hostContainer.innerHTML = `
      <div class="table-header">
        <h3>Active Host Alerts</h3>
        <div>
          <span id="host-monitor-meta" style="font-size:0.8rem;color:var(--text-muted);margin-right:0.75rem;"></span>
          <button class="btn btn-secondary" id="host-monitor-refresh">Refresh</button>
          <button class="btn btn-primary" id="host-monitor-check">Run Check</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Evidence</th><th>Details</th><th>Action</th></tr></thead>
        <tbody id="host-monitor-table-body"></tbody>
      </table>
    `;
    panel.appendChild(hostContainer);

    const hostMetaEl = hostContainer.querySelector('#host-monitor-meta');
    const hostTableBody = hostContainer.querySelector('#host-monitor-table-body');

    const renderHostCards = (status, alertState) => {
      hostGrid.innerHTML = '';
      hostGrid.appendChild(createStatusCard(
        'Host Monitor',
        status.enabled ? 'Enabled' : 'Disabled',
        `${String(status.platform).toUpperCase()} • ${status.baselineReady ? 'baseline ready' : 'learning'}`,
        status.enabled ? 'success' : 'warning',
      ));
      hostGrid.appendChild(createStatusCard(
        'Active Host Alerts',
        alertState.activeAlertCount || 0,
        `${alertState.bySeverity?.critical ?? 0} critical / ${alertState.bySeverity?.high ?? 0} high`,
        (alertState.bySeverity?.critical ?? 0) > 0 ? 'error' : (alertState.bySeverity?.high ?? 0) > 0 ? 'warning' : 'success',
      ));
      hostGrid.appendChild(createStatusCard(
        'Suspicious Processes',
        status.snapshot?.suspiciousProcesses?.length || 0,
        `${status.snapshot?.processCount || 0} total processes sampled`,
        (status.snapshot?.suspiciousProcesses?.length || 0) > 0 ? 'warning' : 'info',
      ));
      hostGrid.appendChild(createStatusCard(
        'Watched Paths',
        status.snapshot?.watchedPathCount || 0,
        `${status.snapshot?.persistenceEntryCount || 0} persistence entries • ${status.snapshot?.knownExternalDestinationCount || 0} remotes`,
        'info',
      ));
      hostGrid.appendChild(createStatusCard(
        'Host Firewall',
        status.snapshot?.firewallEnabled === true ? 'Enabled' : status.snapshot?.firewallEnabled === false ? 'Alert' : 'Unknown',
        `${status.snapshot?.firewallBackend || 'unavailable'} • ${status.snapshot?.firewallRuleCount || 0} rules`,
        status.snapshot?.firewallEnabled === false ? 'error' : status.snapshot?.firewallEnabled === true ? 'success' : 'warning',
      ));
    };

    const summarizeHostEvidence = (alert) => {
      if (!alert?.evidence) return '-';
      if (typeof alert.evidence.path === 'string') return alert.evidence.path;
      if (typeof alert.evidence.entry === 'string') return alert.evidence.entry;
      if (typeof alert.evidence.remoteAddress === 'string') return alert.evidence.remoteAddress;
      if (typeof alert.evidence.port === 'number') return `port ${alert.evidence.port}`;
      if (typeof alert.evidence.name === 'string') return alert.evidence.name;
      if (typeof alert.evidence.backend === 'string') return `${alert.evidence.backend}`;
      if (typeof alert.evidence.summary === 'string') return alert.evidence.summary;
      return '-';
    };

    const renderHostRows = (alerts) => {
      if (!hostTableBody) return;
      if (!alerts || alerts.length === 0) {
        hostTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active host alerts.</td></tr>';
        return;
      }
      hostTableBody.innerHTML = alerts.map((alert) => `
        <tr>
          <td>${new Date(alert.lastSeenAt || alert.timestamp || Date.now()).toLocaleTimeString()}</td>
          <td><span class="badge ${severityClass(alert.severity)}">${esc(alert.severity)}</span></td>
          <td>${esc(alert.type)}</td>
          <td title="${escAttr(JSON.stringify(alert.evidence || {}))}">${esc(summarizeHostEvidence(alert))}</td>
          <td title="${escAttr(alert.description || '')}">${esc(alert.description || '-')}</td>
          <td><button class="btn btn-secondary host-alert-ack" data-alert-id="${escAttr(alert.id)}">Acknowledge</button></td>
        </tr>
      `).join('');
    };

    const applyHostState = (status, alertState) => {
      renderHostCards(status, alertState);
      renderHostRows(alertState.alerts || []);
      if (hostMetaEl) {
        const updated = alertState.lastUpdatedAt || status.lastUpdatedAt;
        hostMetaEl.textContent = `Baseline: ${status.baselineReady ? 'ready' : 'learning'} • Updated: ${updated ? new Date(updated).toLocaleTimeString() : 'never'}`;
      }
    };

    const loadHostState = async () => {
      const [latestStatus, latestAlerts] = await Promise.all([
        api.hostMonitorStatus().catch(() => safeHostStatus),
        api.hostMonitorAlerts({ limit: 50 }).catch(() => safeHostAlerts),
      ]);
      applyHostState(latestStatus, latestAlerts);
    };

    applyHostState(safeHostStatus, safeHostAlerts);

    hostContainer.querySelector('#host-monitor-refresh')?.addEventListener('click', () => {
      loadHostState().catch(() => {});
    });

    hostContainer.querySelector('#host-monitor-check')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      try {
        await api.runHostMonitorCheck();
        await loadHostState();
      } catch {
        button.disabled = false;
        return;
      }
      button.disabled = false;
    });

    hostContainer.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.host-alert-ack');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      if (!alertId) return;
      button.setAttribute('disabled', 'true');
      try {
        await api.acknowledgeHostMonitorAlert(alertId);
        await loadHostState();
      } catch {
        button.removeAttribute('disabled');
      }
    });

    const gatewaySectionHeader = document.createElement('h3');
    gatewaySectionHeader.className = 'section-header';
    gatewaySectionHeader.textContent = 'Gateway Firewall Posture';
    panel.appendChild(gatewaySectionHeader);

    const gatewayGrid = document.createElement('div');
    gatewayGrid.className = 'cards-grid';
    panel.appendChild(gatewayGrid);

    const gatewayContainer = document.createElement('div');
    gatewayContainer.className = 'table-container';
    gatewayContainer.innerHTML = `
      <div class="table-header">
        <h3>Active Gateway Alerts</h3>
        <div>
          <span id="gateway-monitor-meta" style="font-size:0.8rem;color:var(--text-muted);margin-right:0.75rem;"></span>
          <button class="btn btn-secondary" id="gateway-monitor-refresh">Refresh</button>
          <button class="btn btn-primary" id="gateway-monitor-check">Run Check</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Severity</th><th>Gateway</th><th>Type</th><th>Details</th><th>Action</th></tr></thead>
        <tbody id="gateway-monitor-table-body"></tbody>
      </table>
    `;
    panel.appendChild(gatewayContainer);

    const gatewayMetaEl = gatewayContainer.querySelector('#gateway-monitor-meta');
    const gatewayTableBody = gatewayContainer.querySelector('#gateway-monitor-table-body');

    const renderGatewayCards = (status, alertState) => {
      gatewayGrid.innerHTML = '';
      gatewayGrid.appendChild(createStatusCard(
        'Gateway Monitors',
        status.monitorCount || 0,
        `${status.availableGatewayCount || 0} reachable`,
        (status.availableGatewayCount || 0) > 0 ? 'info' : 'warning',
      ));
      gatewayGrid.appendChild(createStatusCard(
        'Gateway Alerts',
        alertState.activeAlertCount || 0,
        `${alertState.bySeverity?.critical ?? 0} critical / ${alertState.bySeverity?.high ?? 0} high`,
        (alertState.bySeverity?.critical ?? 0) > 0 ? 'error' : (alertState.bySeverity?.high ?? 0) > 0 ? 'warning' : 'success',
      ));
      const firstGateway = status.gateways?.[0];
      gatewayGrid.appendChild(createStatusCard(
        'Primary WAN Policy',
        firstGateway?.wanDefaultAction || 'unknown',
        firstGateway ? `${firstGateway.displayName} • ${firstGateway.provider}` : 'No gateway snapshot',
        firstGateway?.wanDefaultAction === 'allow' ? 'warning' : 'info',
      ));
      gatewayGrid.appendChild(createStatusCard(
        'Port Forwards',
        status.gateways?.reduce((sum, gateway) => sum + (gateway.portForwardCount || 0), 0) || 0,
        status.gateways?.map((gateway) => `${gateway.displayName}: ${gateway.portForwardCount || 0}`).join(' • ') || 'No gateway snapshot',
        'info',
      ));
    };

    const summarizeGatewayAlert = (alert) => {
      if (typeof alert?.evidence?.gatewayName === 'string') return alert.evidence.gatewayName;
      if (typeof alert?.evidence?.gatewayId === 'string') return alert.evidence.gatewayId;
      if (typeof alert?.targetName === 'string') return alert.targetName;
      return '-';
    };

    const renderGatewayRows = (alerts) => {
      if (!gatewayTableBody) return;
      if (!alerts || alerts.length === 0) {
        gatewayTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No active gateway alerts.</td></tr>';
        return;
      }
      gatewayTableBody.innerHTML = alerts.map((alert) => `
        <tr>
          <td>${new Date(alert.lastSeenAt || alert.timestamp || Date.now()).toLocaleTimeString()}</td>
          <td><span class="badge ${severityClass(alert.severity)}">${esc(alert.severity)}</span></td>
          <td>${esc(summarizeGatewayAlert(alert))}</td>
          <td>${esc(alert.type)}</td>
          <td title="${escAttr(alert.description || '')}">${esc(alert.description || '-')}</td>
          <td><button class="btn btn-secondary gateway-alert-ack" data-alert-id="${escAttr(alert.id)}">Acknowledge</button></td>
        </tr>
      `).join('');
    };

    const applyGatewayState = (status, alertState) => {
      renderGatewayCards(status, alertState);
      renderGatewayRows(alertState.alerts || []);
      if (gatewayMetaEl) {
        gatewayMetaEl.textContent = `Baseline: ${status.baselineReady ? 'ready' : 'learning'} • Updated: ${status.lastUpdatedAt ? new Date(status.lastUpdatedAt).toLocaleTimeString() : 'never'}`;
      }
    };

    const loadGatewayState = async () => {
      const [latestStatus, latestAlerts] = await Promise.all([
        api.gatewayMonitorStatus().catch(() => safeGatewayStatus),
        api.gatewayMonitorAlerts({ limit: 50 }).catch(() => safeGatewayAlerts),
      ]);
      applyGatewayState(latestStatus, latestAlerts);
    };

    applyGatewayState(safeGatewayStatus, safeGatewayAlerts);

    gatewayContainer.querySelector('#gateway-monitor-refresh')?.addEventListener('click', () => {
      loadGatewayState().catch(() => {});
    });

    gatewayContainer.querySelector('#gateway-monitor-check')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      try {
        await api.runGatewayMonitorCheck();
        await loadGatewayState();
      } catch {
        button.disabled = false;
        return;
      }
      button.disabled = false;
    });

    gatewayContainer.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('.gateway-alert-ack');
      if (!(button instanceof HTMLElement)) return;
      const alertId = button.getAttribute('data-alert-id');
      if (!alertId) return;
      button.setAttribute('disabled', 'true');
      try {
        await api.acknowledgeGatewayMonitorAlert(alertId);
        await loadGatewayState();
      } catch {
        button.removeAttribute('disabled');
      }
    });

    // Live event stream
    const sectionHeader1 = document.createElement('h3');
    sectionHeader1.className = 'section-header';
    sectionHeader1.textContent = 'Live Event Stream';
    panel.appendChild(sectionHeader1);

    const eventLogEl = createEventLog('Audit Events');
    panel.appendChild(eventLogEl);

    // Agent state grid
    const sectionHeader2 = document.createElement('h3');
    sectionHeader2.className = 'section-header';
    sectionHeader2.textContent = 'Agent States';
    panel.appendChild(sectionHeader2);

    const agentGridEl = document.createElement('div');
    agentGridEl.className = 'agent-grid';
    renderAgentGrid(agentGridEl, agents);
    panel.appendChild(agentGridEl);

    // Resource usage
    const sectionHeader3 = document.createElement('h3');
    sectionHeader3.className = 'section-header';
    sectionHeader3.textContent = 'Resource Usage';
    panel.appendChild(sectionHeader3);

    const budgetContainer = document.createElement('div');
    budgetContainer.className = 'table-container';
    budgetContainer.innerHTML = `
      <div class="table-header">
        <h3>Budget & Resources</h3>
        <span id="mon-pending-count" style="font-size:0.75rem;color:var(--text-muted);">EventBus pending: 0</span>
      </div>
      <table>
        <thead><tr><th>Agent</th><th>Tokens/min</th><th>Concurrent</th><th>Overruns</th></tr></thead>
        <tbody id="mon-budget-table-body"></tbody>
      </table>
    `;
    panel.appendChild(budgetContainer);

    const budgetTableBody = budgetContainer.querySelector('#mon-budget-table-body');
    const pendingCountEl = budgetContainer.querySelector('#mon-pending-count');
    budgetTableBody.innerHTML = budget.agents.map(a => `
      <tr>
        <td>${esc(a.agentId)}</td>
        <td>${a.tokensPerMinute}</td>
        <td>${a.concurrentInvocations}</td>
        <td>${a.overrunCount}</td>
      </tr>
    `).join('');

    if (analytics) {
      const analyticsSection = document.createElement('div');
      analyticsSection.className = 'table-container';
      analyticsSection.innerHTML = `
        <div class="table-header"><h3>Interaction Analytics (60m)</h3></div>
        <table>
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Total events</td><td>${analytics.totalEvents}</td></tr>
            <tr><td>Channels</td><td>${Object.entries(analytics.byChannel).map(([name, count]) => `${esc(name)}: ${count}`).join(', ') || '-'}</td></tr>
            <tr><td>Top agents</td><td>${analytics.topAgents.map(a => `${esc(a.agentId)} (${a.count})`).join(', ') || '-'}</td></tr>
            <tr><td>Top commands</td><td>${analytics.commandUsage.map(c => `/${esc(c.command)} (${c.count})`).join(', ') || '-'}</td></tr>
          </tbody>
        </table>
      `;
      panel.appendChild(analyticsSection);
    }

    // Overruns
    if (budget.recentOverruns.length > 0) {
      const overrunContainer = document.createElement('div');
      overrunContainer.className = 'table-container';
      overrunContainer.innerHTML = `
        <div class="table-header"><h3>Recent Budget Overruns</h3></div>
        <table>
          <thead><tr><th>Agent</th><th>Type</th><th>Budget (ms)</th><th>Used (ms)</th></tr></thead>
          <tbody>${budget.recentOverruns.slice(-10).map(o => `
            <tr>
              <td>${esc(o.agentId)}</td>
              <td>${esc(o.invocationType)}</td>
              <td>${Math.round(o.budgetMs)}</td>
              <td>${Math.round(o.usedMs)}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
      panel.appendChild(overrunContainer);
    }

    // SSE: live audit events
    monAuditHandler = (event) => {
      if (eventLogEl) appendEvent(eventLogEl, event);
    };
    onSSE('audit', monAuditHandler);

    monSecurityAlertHandler = async (alert) => {
      const description = alert?.description || alert?.details?.reason || 'Security alert detected';
      const severity = alert?.severity || 'warn';
      if (eventLogEl) {
        appendEvent(eventLogEl, {
          timestamp: alert?.timestamp || Date.now(),
          type: 'security_alert',
          severity: mapNetworkSeverityToAudit(severity),
          agentId: alert?.agentId || 'security-monitor',
          details: {
            reason: description,
          },
        });
      }
      await Promise.all([
        loadThreatState(),
        loadHostState(),
        loadGatewayState(),
      ]);
    };
    onSSE('security.alert', monSecurityAlertHandler);

    // SSE: metrics updates
    monMetricsHandler = (data) => {
      if (agentGridEl && data.agents) {
        renderAgentGrid(agentGridEl, data.agents);
      }
      if (pendingCountEl) {
        pendingCountEl.textContent = `EventBus pending: ${data.eventBusPending || 0}`;
      }
    };
    onSSE('metrics', monMetricsHandler);

  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function renderAgentGrid(gridEl, agents) {
  gridEl.innerHTML = agents.map(a => `
    <div class="agent-tile">
      <div class="tile-name">${esc(a.name)}</div>
      <div class="tile-id">${esc(a.id)}</div>
      <span class="badge badge-${a.state}">${esc(a.state)}</span>
    </div>
  `).join('');
}

// ─── Cloud Tab ──────────────────────────────────────────

async function renderCloudTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [config, auditEvents] = await Promise.all([
      api.config(),
      api.audit({ limit: 200 }).catch(() => []),
    ]);
    const cloud = config.assistant?.tools?.cloud || {
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

    const providerRows = [
      {
        provider: 'cPanel / WHM',
        count: cloud.cpanelProfiles.length,
        inline: cloud.cpanelProfiles.filter((profile) => profile.apiTokenConfigured).length,
        refs: cloud.cpanelProfiles.filter((profile) => !!profile.credentialRef).length,
        customEndpoints: 0,
        notes: cloud.cpanelProfiles.filter((profile) => profile.allowSelfSigned).length
          ? `${cloud.cpanelProfiles.filter((profile) => profile.allowSelfSigned).length} self-signed`
          : '-',
      },
      {
        provider: 'Vercel',
        count: cloud.vercelProfiles.length,
        inline: cloud.vercelProfiles.filter((profile) => profile.apiTokenConfigured).length,
        refs: cloud.vercelProfiles.filter((profile) => !!profile.credentialRef).length,
        customEndpoints: cloud.vercelProfiles.filter((profile) => !!profile.apiBaseUrl).length,
        notes: '-',
      },
      {
        provider: 'Cloudflare',
        count: cloud.cloudflareProfiles.length,
        inline: cloud.cloudflareProfiles.filter((profile) => profile.apiTokenConfigured).length,
        refs: cloud.cloudflareProfiles.filter((profile) => !!profile.credentialRef).length,
        customEndpoints: cloud.cloudflareProfiles.filter((profile) => !!profile.apiBaseUrl).length,
        notes: '-',
      },
      {
        provider: 'AWS',
        count: cloud.awsProfiles.length,
        inline: cloud.awsProfiles.filter((profile) => profile.accessKeyIdConfigured || profile.secretAccessKeyConfigured || profile.sessionTokenConfigured).length,
        refs: cloud.awsProfiles.filter((profile) => !!profile.accessKeyIdCredentialRef || !!profile.secretAccessKeyCredentialRef || !!profile.sessionTokenCredentialRef).length,
        customEndpoints: cloud.awsProfiles.filter((profile) => profile.endpoints && Object.keys(profile.endpoints).length > 0).length,
        notes: '-',
      },
      {
        provider: 'GCP',
        count: cloud.gcpProfiles.length,
        inline: cloud.gcpProfiles.filter((profile) => profile.accessTokenConfigured || profile.serviceAccountConfigured).length,
        refs: cloud.gcpProfiles.filter((profile) => !!profile.accessTokenCredentialRef || !!profile.serviceAccountCredentialRef).length,
        customEndpoints: cloud.gcpProfiles.filter((profile) => profile.endpoints && Object.keys(profile.endpoints).length > 0).length,
        notes: '-',
      },
      {
        provider: 'Azure',
        count: cloud.azureProfiles.length,
        inline: cloud.azureProfiles.filter((profile) => profile.accessTokenConfigured || profile.clientIdConfigured || profile.clientSecretConfigured).length,
        refs: cloud.azureProfiles.filter((profile) => !!profile.accessTokenCredentialRef || !!profile.clientIdCredentialRef || !!profile.clientSecretCredentialRef).length,
        customEndpoints: cloud.azureProfiles.filter((profile) => (profile.endpoints && Object.keys(profile.endpoints).length > 0) || !!profile.blobBaseUrl).length,
        notes: '-',
      },
    ];
    const activeProviders = providerRows.filter((row) => row.count > 0).length;
    const cloudEvents = (auditEvents || []).filter(isCloudAuditEvent).slice(0, 40);
    const deniedCount = cloudEvents.filter((event) => event.type === 'action_denied').length;

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Threat Intel',
        compact: true,
        whatItIs: 'Threat Intel is the monitored-target and response-planning workspace.',
        whatSeeing: 'You are seeing watch targets, findings, drafted actions, and the current operating plan.',
        whatCanDo: 'Review monitored targets, update finding status, and generate follow-up actions from detections.',
        howLinks: 'This tab is separate from the alert queue because it handles longer-running monitoring and response workflows.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card ${cloud.enabled ? 'success' : 'error'}">
          <div class="card-title">Cloud Controls</div>
          <div class="card-value">${cloud.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">${activeProviders} provider families configured</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Profiles</div>
          <div class="card-value">${cloud.profileCounts?.total || 0}</div>
          <div class="card-subtitle">Across cPanel, Vercel, Cloudflare, AWS, GCP, and Azure</div>
        </div>
        <div class="status-card ${cloud.security?.inlineSecretProfileCount ? 'warning' : 'success'}">
          <div class="card-title">Inline Secret Usage</div>
          <div class="card-value">${cloud.security?.inlineSecretProfileCount || 0}</div>
          <div class="card-subtitle">${cloud.security?.credentialRefCount || 0} credential refs configured</div>
        </div>
        <div class="status-card ${cloud.security?.selfSignedProfileCount ? 'warning' : 'accent'}">
          <div class="card-title">TLS Exceptions</div>
          <div class="card-value">${cloud.security?.selfSignedProfileCount || 0}</div>
          <div class="card-subtitle">Profiles accepting self-signed certs</div>
        </div>
        <div class="status-card ${deniedCount > 0 ? 'warning' : 'info'}">
          <div class="card-title">Recent Cloud Denials</div>
          <div class="card-value">${deniedCount}</div>
          <div class="card-subtitle">${cloudEvents.length} recent cloud-related audit events</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Provider Posture</h3></div>
        <table>
          <thead><tr><th>Provider</th><th>Profiles</th><th>Inline Secrets</th><th>Credential Refs</th><th>Custom Endpoints</th><th>Notes</th></tr></thead>
          <tbody>
            ${providerRows.map((row) => `
              <tr>
                <td>${esc(row.provider)}</td>
                <td>${row.count}</td>
                <td>${row.inline}</td>
                <td>${row.refs}</td>
                <td>${row.customEndpoints}</td>
                <td>${esc(row.notes)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Cloud Security Guidance</h3></div>
        <div style="padding:0.95rem 1rem;font-size:0.8rem;color:var(--text-secondary);line-height:1.55;">
          Prefer <code>credentialRef</code>-backed auth over inline secrets, especially for AWS/GCP/Azure credentials.<br>
          Review any cPanel/WHM profile with <code>allowSelfSigned: true</code> and remove custom endpoint overrides unless you intentionally target emulators, proxies, or sovereign clouds.<br>
          Cloud tool approval behavior still follows the existing Guardian/tool policy stack; this page summarizes posture and recent decisions, not just static config.
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Cloud Audit Activity</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Tool</th><th>Controller</th><th>Reason</th></tr></thead>
          <tbody>
            ${cloudEvents.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent cloud-related audit events.</td></tr>'
              : cloudEvents.map((event) => `
                <tr>
                  <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
                  <td>${esc(event.type)}</td>
                  <td><span class="badge ${auditSeverityClass(event.severity)}">${esc(event.severity)}</span></td>
                  <td>${esc(event.details?.toolName || '-')}</td>
                  <td>${esc(event.controller || '-')}</td>
                  <td title="${escAttr(event.details?.reason || '')}">${esc(event.details?.reason || event.details?.source || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

// ─── Threat Intel Tab ────────────────────────────────────

async function renderIntelTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [summary, plan, watchlistResponse, findings, actions, presets] = await Promise.all([
      api.threatIntelSummary(),
      api.threatIntelPlan(),
      api.threatIntelWatchlist(),
      api.threatIntelFindings({ limit: 30 }),
      api.threatIntelActions(30),
      api.scheduledTaskPresets().catch(() => []),
    ]);

    const watchlist = watchlistResponse.targets ?? [];
    const connectorText = (summary.forumConnectors || [])
      .map(c => `${c.id}:${c.enabled ? 'on' : 'off'}:${c.mode}${c.hostile ? ':hostile' : ''}`)
      .join(', ');
    const scanPreset = (presets || []).find((preset) => preset.id === 'threat-intel-scan' || preset.target === 'intel_scan');
    const notice = intelUiState.notice;
    const lastScan = intelUiState.lastScan;

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Threat Intel',
        compact: true,
        whatItIs: 'Threat Intel is the monitored-target and response-planning workspace for longer-running identity-abuse and impersonation work.',
        whatSeeing: 'You are seeing watch targets, recent findings, drafted actions, scan controls, and the current operating plan.',
        whatCanDo: 'Run one-off scans, maintain the watchlist, update finding status, and review drafted follow-up actions from the same page.',
        howLinks: 'This tab complements live Alerts by handling slower investigative monitoring and response planning rather than the immediate operator queue.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card ${summary.enabled ? 'success' : 'error'}">
          <div class="card-title">Monitoring</div>
          <div class="card-value">${summary.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">Auto-scan active when watchlist is configured</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Watchlist</div>
          <div class="card-value">${summary.watchlistCount}</div>
          <div class="card-subtitle">Tracked people, handles, domains, keywords</div>
        </div>
        <div class="status-card warning">
          <div class="card-title">New Findings</div>
          <div class="card-value">${summary.findings.new}</div>
          <div class="card-subtitle">${summary.findings.total} total findings</div>
        </div>
        <div class="status-card ${summary.findings.highOrCritical > 0 ? 'error' : 'accent'}">
          <div class="card-title">High Risk</div>
          <div class="card-value">${summary.findings.highOrCritical}</div>
          <div class="card-subtitle">High/Critical severity detections</div>
        </div>
      </div>

      ${notice ? `
        <div class="table-container" style="border-color: ${notice.tone === 'error' ? 'var(--error)' : notice.tone === 'warning' ? 'var(--warning)' : 'var(--success)'}; background: rgba(0,0,0,0.2);">
          <div style="padding:0.8rem 1rem; color:${notice.tone === 'error' ? 'var(--error)' : notice.tone === 'warning' ? 'var(--warning)' : 'var(--success)'}; font-size: 0.85rem; display: flex; align-items: center; justify-content: space-between;">
            <span>${esc(notice.message)}</span>
            <button class="btn btn-secondary btn-sm" id="intel-notice-dismiss" style="padding: 0.2rem 0.5rem;">Dismiss</button>
          </div>
        </div>
      ` : ''}

      <div class="cfg-form-grid" style="align-items: start; margin-bottom: 1.5rem;">
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <div class="table-container" style="margin-bottom:0;">
            <div class="table-header">
              <h3>Automation Configuration</h3>
              <button class="btn btn-secondary" id="intel-refresh" style="font-size:0.7rem;padding:0.25rem 0.5rem;">Refresh</button>
            </div>
            <div class="intel-controls" style="padding: 1rem; display: grid; gap: 1rem;">
              <div class="intel-control-row" style="grid-template-columns: 1fr auto; gap: 1rem; display: grid; align-items: center;">
                <label style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase;">Response Mode</label>
                <select id="intel-mode" style="width: 120px; padding: 0.3rem; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-primary); border-radius: 4px;">
                  ${['manual', 'assisted', 'autonomous'].map((mode) => `
                    <option value="${mode}" ${summary.responseMode === mode ? 'selected' : ''}>${mode}</option>
                  `).join('')}
                </select>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-muted); display: grid; gap: 0.4rem; background: var(--bg-input); padding: 0.75rem; border-radius: var(--radius); border: 1px solid var(--border);">
                <div style="display: flex; justify-content: space-between;"><span>Darkweb Scans</span> <span style="color: ${summary.darkwebEnabled ? 'var(--success)' : 'var(--text-muted)'}">${summary.darkwebEnabled ? 'Enabled' : 'Disabled'}</span></div>
                <div style="display: flex; justify-content: space-between;"><span>Connectors</span> <span style="color: var(--text-secondary)">${esc(connectorText || 'None')}</span></div>
                <div style="display: flex; justify-content: space-between; margin-top: 0.25rem; border-top: 1px solid var(--border); padding-top: 0.4rem;"><span>Last Scan</span> <span>${summary.lastScanAt ? new Date(summary.lastScanAt).toLocaleString() : 'Never'}</span></div>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
                <span class="intel-muted" style="flex: 1; font-size: 0.7rem;">${scanPreset ? `Preset: ${esc(scanPreset.name)}` : 'No automation preset found.'}</span>
                <a href="#/automations" class="btn btn-secondary btn-sm" style="white-space: nowrap;">Open Automations</a>
              </div>
            </div>
          </div>

          <div class="table-container" style="margin-bottom:0;">
            <div class="table-header"><h3>Watchlist</h3></div>
            <div class="intel-watchlist-panel" style="padding: 1rem;">
              <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
                <input id="intel-watch-target" type="text" placeholder="person, handle, domain, brand..." style="flex: 1; min-width: 0; padding: 0.4rem; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-primary); border-radius: 4px;">
                <button class="btn btn-primary btn-sm" id="intel-watch-add" type="button">Add</button>
              </div>
              <div class="intel-watch-items" style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                ${watchlist.length === 0
                  ? '<span class="intel-muted">No watch targets configured.</span>'
                  : watchlist.map(target => `
                    <span class="intel-chip" style="background: var(--bg-surface); border: 1px solid var(--border); padding: 0.2rem 0.5rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.75rem;">
                      ${esc(target)}
                      <button class="intel-watch-remove" data-target="${escAttr(target)}" type="button" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0; font-size: 1.2rem; line-height: 1;">&times;</button>
                    </span>
                  `).join('')}
              </div>
            </div>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <div class="table-container" style="margin-bottom:0;">
            <div class="table-header"><h3>Run Intelligence Scan</h3></div>
            <div style="padding:1rem; display:grid; gap:1.2rem;">
              <div class="cfg-field" style="display: grid; gap: 0.3rem;">
                <label style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase;">One-Off Target Query</label>
                <input id="intel-scan-query" type="text" placeholder="name, handle, domain, brand, fraud phrase" style="padding: 0.4rem; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-primary); border-radius: 4px;">
              </div>
              
              <div style="background: var(--bg-input); padding: 0.75rem; border-radius: var(--radius); border: 1px solid var(--border);">
                <label style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; display: block; margin-bottom: 0.6rem;">Scan Sources</label>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 0.6rem;">
                  ${['web', 'news', 'social', 'forum', 'darkweb'].map((source) => `
                    <label style="display:flex;align-items:center;gap:0.4rem; font-size: 0.75rem; cursor: pointer;">
                      <input class="intel-source" type="checkbox" value="${source}" ${source === 'darkweb' && !summary.darkwebEnabled ? 'disabled' : ''} ${source !== 'darkweb' ? 'checked' : ''}>
                      <span>${source}</span>
                    </label>
                  `).join('')}
                </div>
              </div>

              <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
                <label style="display:flex;align-items:center;gap:0.5rem; font-size: 0.75rem; cursor: pointer;">
                  <input id="intel-scan-darkweb" type="checkbox" ${summary.darkwebEnabled ? '' : 'disabled'}>
                  <span>Include Deep/Dark Web</span>
                </label>
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                  <span id="intel-scan-status" class="cfg-save-status" style="font-size: 0.7rem;"></span>
                  <button class="btn btn-primary" id="intel-scan-run" type="button" style="padding: 0.5rem 1.5rem;">Run Scan</button>
                </div>
              </div>
            </div>
          </div>

          ${lastScan ? `
            <div class="table-container" style="margin-bottom:0; border-left: 3px solid ${lastScan.success ? 'var(--success)' : 'var(--warning)'};">
              <div class="table-header">
                <h3 style="display: flex; align-items: center; gap: 0.5rem;">
                  Latest Scan Result
                  <span class="badge ${lastScan.success ? 'badge-running' : 'badge-queued'}" style="font-size: 0.6rem; padding: 0.1rem 0.4rem;">${lastScan.success ? 'completed' : 'failed'}</span>
                </h3>
              </div>
              <div style="padding:1rem;">
                <div style="font-size: 0.8rem; margin-bottom: 0.6rem; color: var(--text-primary); line-height: 1.4;">${esc(lastScan.message)}</div>
                <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: var(--text-muted);">
                  <span>Created <strong>${lastScan.findings?.length || 0}</strong> finding(s)</span>
                  <span>${esc(new Date(lastScan.at).toLocaleString())}</span>
                </div>
                ${Array.isArray(lastScan.findings) && lastScan.findings.length > 0 ? `
                  <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.4rem;">
                    ${lastScan.findings.slice(0, 4).map((finding) => `
                      <span style="font-size: 0.65rem; background: var(--bg-elevated); padding: 0.1rem 0.4rem; border-radius: 3px; border: 1px solid var(--border);">
                        ${esc(finding.target)} <span style="color: var(--text-muted)">(${finding.sourceType})</span>
                      </span>
                    `).join('')}
                    ${lastScan.findings.length > 4 ? `<span style="font-size: 0.65rem; color: var(--text-muted); padding: 0.1rem;">+${lastScan.findings.length - 4} more</span>` : ''}
                  </div>
                ` : ''}
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Active Findings</h3></div>
        <div style="overflow-x: auto;">
          <table style="min-width: 900px;">
            <thead>
              <tr><th>ID</th><th>Target</th><th>Source</th><th>Severity</th><th>Confidence</th><th>Status</th><th>Summary</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${findings.length === 0 ? '<tr><td colspan="8" style="text-align: center; padding: 2rem; color: var(--text-muted);">No findings yet. Run a scan to populate results.</td></tr>' : findings.map(finding => `
                <tr>
                  <td title="${esc(finding.id)}"><code style="font-size: 0.7rem; color: var(--accent);">${esc(shortId(finding.id))}</code></td>
                  <td style="font-weight: 600;">${esc(finding.target)}</td>
                  <td><span style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-secondary);">${esc(finding.sourceType)}</span></td>
                  <td><span class="badge ${severityClass(finding.severity)}">${esc(finding.severity)}</span></td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 0.4rem;">
                      <div style="width: 40px; height: 4px; background: var(--bg-input); border-radius: 2px; overflow: hidden;">
                        <div style="width: ${Math.round((finding.confidence ?? 0) * 100)}%; height: 100%; background: var(--accent);"></div>
                      </div>
                      <span style="font-size: 0.7rem;">${Math.round((finding.confidence ?? 0) * 100)}%</span>
                    </div>
                  </td>
                  <td>
                    <select data-finding-status="${escAttr(finding.id)}" style="font-size: 0.75rem; padding: 0.2rem; border-radius: 4px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-primary);">
                      ${['new', 'triaged', 'actioned', 'dismissed'].map(status => `
                        <option value="${status}" ${finding.status === status ? 'selected' : ''}>${status}</option>
                      `).join('')}
                    </select>
                  </td>
                  <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escAttr(finding.summary)}">${esc(finding.summary)}</td>
                  <td>
                    <div class="intel-actions" style="display: flex; gap: 0.3rem;">
                      <button class="btn btn-secondary btn-sm intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="report" title="Generate Report">Report</button>
                      <button class="btn btn-secondary btn-sm intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="request_takedown" title="Request Takedown">Takedown</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Drafted Intelligence Actions</h3></div>
        <div style="overflow-x: auto;">
          <table style="min-width: 800px;">
            <thead>
              <tr><th>Action ID</th><th>Finding</th><th>Type</th><th>Status</th><th>Approval</th><th>Rationale</th></tr>
            </thead>
            <tbody>
              ${actions.length === 0 ? '<tr><td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-muted);">No drafted actions yet.</td></tr>' : actions.map(action => `
                <tr>
                  <td title="${esc(action.id)}"><code style="font-size: 0.7rem; color: var(--accent);">${esc(shortId(action.id))}</code></td>
                  <td title="${esc(action.findingId)}"><code style="font-size: 0.7rem;">${esc(shortId(action.findingId))}</code></td>
                  <td><span style="font-size: 0.7rem; text-transform: uppercase;">${esc(action.type)}</span></td>
                  <td><span class="badge ${action.status === 'completed' ? 'badge-running' : 'badge-queued'}">${esc(action.status)}</span></td>
                  <td><span style="font-size: 0.7rem; color: ${action.requiresApproval ? 'var(--warning)' : 'var(--text-muted)'}">${action.requiresApproval ? 'Required' : 'Optional'}</span></td>
                  <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escAttr(action.rationale)}">${esc(action.rationale)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Operating Plan</h3></div>
        <div class="intel-plan" style="padding: 1rem;">
          <p class="intel-muted" style="margin-bottom: 1rem; border-left: 2px solid var(--accent); padding-left: 0.75rem; font-size: 0.8rem;">${esc(plan.title)}</p>
          <div class="intel-plan-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem;">
            ${plan.phases.map(phase => `
              <div class="intel-plan-card" style="background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem;">
                <h4 style="color: var(--accent); font-size: 0.8rem; text-transform: uppercase; margin-bottom: 0.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem;">${esc(phase.phase)}</h4>
                <p style="font-size: 0.75rem; margin-bottom: 0.75rem; color: var(--text-secondary); line-height: 1.4;">${esc(phase.objective)}</p>
                <ul style="margin: 0; padding-left: 1.2rem; font-size: 0.7rem; color: var(--text-muted); display: grid; gap: 0.25rem;">
                  ${phase.deliverables.map(d => `<li>${esc(d)}</li>`).join('')}
                </ul>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    // Event listeners
    panel.querySelector('#intel-refresh')?.addEventListener('click', () => renderIntelTab(panel));
    panel.querySelector('#intel-notice-dismiss')?.addEventListener('click', () => {
      intelUiState.notice = null;
      renderIntelTab(panel);
    });

    panel.querySelector('#intel-mode')?.addEventListener('change', async (event) => {
      const mode = event.target?.value;
      if (!mode) return;
      try {
        const result = await api.threatIntelSetResponseMode(mode);
        intelUiState.notice = {
          tone: result.success ? 'success' : 'warning',
          message: result.message,
        };
        await renderIntelTab(panel);
      } catch (err) {
        intelUiState.notice = {
          tone: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
        await renderIntelTab(panel);
      }
    });

    panel.querySelector('#intel-watch-add')?.addEventListener('click', async () => {
      const input = panel.querySelector('#intel-watch-target');
      const target = input?.value?.trim();
      if (!target) {
        intelUiState.notice = { tone: 'warning', message: 'Enter a target before adding it to the watchlist.' };
        await renderIntelTab(panel);
        return;
      }
      try {
        const result = await api.threatIntelWatch(target, 'add');
        intelUiState.notice = {
          tone: result.success ? 'success' : 'warning',
          message: result.message,
        };
        await renderIntelTab(panel);
      } catch (err) {
        intelUiState.notice = {
          tone: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
        await renderIntelTab(panel);
      }
    });

    panel.querySelectorAll('.intel-watch-remove').forEach((button) => {
      button.addEventListener('click', async () => {
        const target = button.getAttribute('data-target');
        if (!target) return;
        try {
          const result = await api.threatIntelWatch(target, 'remove');
          intelUiState.notice = {
            tone: result.success ? 'success' : 'warning',
            message: result.message,
          };
          await renderIntelTab(panel);
        } catch (err) {
          intelUiState.notice = {
            tone: 'error',
            message: err instanceof Error ? err.message : String(err),
          };
          await renderIntelTab(panel);
        }
      });
    });

    panel.querySelector('#intel-scan-run')?.addEventListener('click', async () => {
      const statusEl = panel.querySelector('#intel-scan-status');
      const query = panel.querySelector('#intel-scan-query')?.value?.trim() || undefined;
      const includeDarkWeb = !!panel.querySelector('#intel-scan-darkweb')?.checked;
      const sources = Array.from(panel.querySelectorAll('.intel-source:checked'))
        .map((input) => input.value)
        .filter(Boolean);
      statusEl.textContent = 'Running scan...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.threatIntelScan({
          query,
          includeDarkWeb,
          sources,
        });
        intelUiState.lastScan = {
          ...result,
          at: Date.now(),
        };
        intelUiState.notice = {
          tone: result.success ? 'success' : 'warning',
          message: result.message,
        };
        await renderIntelTab(panel);
      } catch (err) {
        intelUiState.notice = {
          tone: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
        await renderIntelTab(panel);
      }
    });

    panel.querySelectorAll('[data-finding-status]').forEach(select => {
      select.addEventListener('change', async () => {
        const findingId = select.getAttribute('data-finding-status');
        if (!findingId) return;
        try {
          const result = await api.threatIntelSetFindingStatus(findingId, select.value);
          intelUiState.notice = {
            tone: result.success ? 'success' : 'warning',
            message: result.message,
          };
          await renderIntelTab(panel);
        } catch (err) {
          intelUiState.notice = {
            tone: 'error',
            message: err instanceof Error ? err.message : String(err),
          };
          await renderIntelTab(panel);
        }
      });
    });

    panel.querySelectorAll('.intel-action-btn').forEach(button => {
      button.addEventListener('click', async () => {
        const findingId = button.getAttribute('data-finding');
        const type = button.getAttribute('data-action');
        if (!findingId || !type) return;
        try {
          const result = await api.threatIntelDraftAction(findingId, type);
          intelUiState.notice = {
            tone: result.success ? 'success' : 'warning',
            message: result.message,
          };
          await renderIntelTab(panel);
        } catch (err) {
          intelUiState.notice = {
            tone: 'error',
            message: err instanceof Error ? err.message : String(err),
          };
          await renderIntelTab(panel);
        }
      });
    });

    applyInputTooltips(panel);
    enhanceSectionHelp(panel, SECURITY_HELP.intel, createGenericHelpFactory('Threat Intel'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

// ─── Utilities ───────────────────────────────────────────

function shortId(id) {
  return id?.slice(0, 8) || '';
}

function severityClass(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'high') return 'badge-errored';
  if (severity === 'medium') return 'badge-warn';
  return 'badge-info';
}

function createGenericHelpFactory(area) {
  const exact = {
    'Provider Posture': {
      whatItIs: 'This section summarizes the security posture of the configured cloud provider profiles rather than letting you edit them directly.',
      whatSeeing: 'You are seeing per-provider counts for profiles, inline secrets, credential refs, custom endpoints, and any notable exceptions such as self-signed TLS.',
      whatCanDo: 'Use it to spot risky cloud auth patterns or connection sprawl quickly before switching to the Cloud page for detailed editing.',
      howLinks: 'It is a security-facing summary of cloud posture, while the authoritative connection editor remains on the Cloud page.',
    },
    'Cloud Security Guidance': {
      whatItIs: 'This section is a short operator checklist for the cloud risks surfaced by the posture and audit sections around it.',
      whatSeeing: 'You are seeing plain-language guidance about credential refs, self-signed TLS exceptions, custom endpoints, and how cloud-tool approvals still flow through policy.',
      whatCanDo: 'Use it as a review checklist when you are deciding whether the current cloud posture looks intentionally configured or needs cleanup.',
      howLinks: 'It interprets the posture and audit data nearby instead of replacing the Cloud connection editor or the main Audit ledger.',
    },
    'Recent Cloud Audit Activity': {
      whatItIs: 'This section is the recent security-relevant audit trail for cloud actions, denials, and controller decisions.',
      whatSeeing: 'You are seeing recent cloud-related events with timestamps, severity, tool names, controllers, and the reason or source attached to each event.',
      whatCanDo: 'Use it to understand what cloud activity just happened and whether policy or approvals intervened.',
      howLinks: 'It is the cloud-focused slice of the wider audit stream, with the full historical ledger still living on the Audit tab.',
    },
    'Network Threat Posture': {
      whatItIs: 'This section is the summary strip for network-baseline readiness and current network-alert pressure.',
      whatSeeing: 'You are seeing baseline readiness, known-device counts, active network-alert counts, and severity distribution cards.',
      whatCanDo: 'Use it to decide whether the monitored network is still learning, broadly healthy, or currently generating suspicious activity that needs review.',
      howLinks: 'It frames the Active Network Alerts table immediately below and feeds the broader security posture shown elsewhere on the page.',
    },
    'Active Network Alerts': {
      whatItIs: 'This section is the live table of network-origin alerts promoted into Security for acknowledgement and review.',
      whatSeeing: 'You are seeing timestamps, severity, alert type, affected host identity, descriptive detail, and acknowledgement controls.',
      whatCanDo: 'Refresh the alert list, acknowledge handled items, and review the hosts or patterns that are currently driving network risk.',
      howLinks: 'It is the actionable table behind the Network Threat Posture summary above and complements the deeper Network page.',
    },
    'Host Monitor Posture': {
      whatItIs: 'This section summarizes the state of the local host monitor and the kinds of host-side signals it is collecting.',
      whatSeeing: 'You are seeing cards for monitor enablement, active host-alert counts, suspicious processes, watched paths, and firewall posture.',
      whatCanDo: 'Use it to check whether host monitoring is functioning and what broad classes of host evidence are currently contributing to alerts.',
      howLinks: 'It provides the summary context for the Active Host Alerts table beneath it and for host-monitor findings that feed Security.',
    },
    'Active Host Alerts': {
      whatItIs: 'This section is the live alert table for host-monitor detections such as suspicious processes, persistence, or network anomalies on the local machine.',
      whatSeeing: 'You are seeing alert timestamps, severity, type, summarized evidence, descriptive detail, and acknowledgement controls.',
      whatCanDo: 'Refresh host-monitor state, run a fresh host check, and acknowledge host alerts after reviewing the evidence.',
      howLinks: 'It turns the host-monitor posture summary into an operator action queue inside Security.',
    },
    'Gateway Firewall Posture': {
      whatItIs: 'This section summarizes the monitored gateway and firewall estate rather than showing every individual gateway detail row.',
      whatSeeing: 'You are seeing cards for reachable monitors, active gateway-alert counts, default WAN policy, and port-forward exposure.',
      whatCanDo: 'Use it to understand whether gateway monitoring is healthy and whether the current perimeter posture looks permissive or risky.',
      howLinks: 'It provides context for the Active Gateway Alerts table beneath it and for firewall-related findings promoted into Security.',
    },
    'Active Gateway Alerts': {
      whatItIs: 'This section is the live table of gateway and firewall alerts that need review or acknowledgement.',
      whatSeeing: 'You are seeing timestamps, severity, gateway identity, alert type, descriptive detail, and acknowledgement controls.',
      whatCanDo: 'Refresh the gateway view, run a new check, and acknowledge gateway alerts once the issue is understood or handled.',
      howLinks: 'It is the operational table that sits underneath Gateway Firewall Posture and complements the Cloud and Network pages.',
    },
    'Live Event Stream': {
      whatItIs: 'This section is the live append-only stream of incoming audit events while you stay on the page.',
      whatSeeing: 'You are seeing new audit events arrive in near real time rather than only a static snapshot.',
      whatCanDo: 'Use it when you want to watch changes happen live during testing, investigation, or policy tuning.',
      howLinks: 'It is a live monitoring surface, while the durable searchable record still belongs to the Audit tab.',
    },
    'Agent States': {
      whatItIs: 'This section is the current state board for the running agents known to the runtime.',
      whatSeeing: 'You are seeing each agent\'s current lifecycle state and the compact runtime metadata associated with it.',
      whatCanDo: 'Use it to confirm whether agents are idle, running, or stuck while you correlate that with alerts or budget pressure.',
      howLinks: 'It complements the runtime and budget sections by showing the current agent-level state directly.',
    },
    'Resource Usage': {
      whatItIs: 'This section groups the runtime-capacity and budget subsections used to understand whether the agent system is staying within bounds.',
      whatSeeing: 'You are seeing budget tables, pending EventBus count, and optional analytics or overrun sections related to runtime load.',
      whatCanDo: 'Use it to judge whether alerts or slowdowns may be caused by capacity pressure rather than only by security conditions.',
      howLinks: 'It ties live agent behavior back to the budget and analytics panels that quantify runtime pressure.',
    },
    'Budget & Resources': {
      whatItIs: 'This section is the per-agent resource and overrun summary for runtime budget enforcement.',
      whatSeeing: 'You are seeing token-rate, concurrency, overrun counts, and the current EventBus pending count.',
      whatCanDo: 'Use it to spot which agents are consuming the most capacity or repeatedly exceeding their runtime budgets.',
      howLinks: 'It provides the numeric foundation for the wider Resource Usage view and helps explain degraded runtime behavior.',
    },
    'Interaction Analytics (60m)': {
      whatItIs: 'This section is the last-hour analytics snapshot for cross-channel activity reaching the runtime.',
      whatSeeing: 'You are seeing total event counts plus top channels, agents, and commands over the recent 60-minute window.',
      whatCanDo: 'Use it to understand where demand is coming from and whether a particular channel or command is driving current system behavior.',
      howLinks: 'It complements the budget tables by showing activity shape, not just capacity consumption.',
    },
    'Recent Budget Overruns': {
      whatItIs: 'This section is the recent ledger of runs that exceeded their allocated budget window.',
      whatSeeing: 'You are seeing which agent overran, what invocation type it was, and how much budget versus actual time it used.',
      whatCanDo: 'Use it to identify expensive flows that may need prompt changes, routing changes, or tighter policy limits.',
      howLinks: 'It is the historical evidence behind the overrun counts shown in the budget summary.',
    },
  };
  return (title) => exact[title] || null;
}

function defaultSecurityAlertsResponse() {
  return {
    alerts: [],
    totalMatches: 0,
    returned: 0,
    searchedSources: [],
    includeAcknowledged: false,
    includeInactive: false,
    bySource: { host: 0, network: 0, gateway: 0, native: 0 },
    bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
  };
}

function defaultSecurityActivityResponse() {
  return {
    entries: [],
    totalMatches: 0,
    returned: 0,
    byStatus: {
      started: 0,
      skipped: 0,
      completed: 0,
      failed: 0,
    },
  };
}

function defaultSecurityPostureResponse() {
  return {
    profile: 'personal',
    currentMode: 'monitor',
    recommendedMode: 'monitor',
    shouldEscalate: false,
    summary: "Profile 'personal' has no active alerts. Stay in 'monitor'.",
    reasons: ['No active alerts currently justify tighter controls.'],
    counts: { total: 0, low: 0, medium: 0, high: 0, critical: 0 },
    bySource: { host: 0, network: 0, gateway: 0, native: 0 },
    availableSources: [],
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

function defaultWindowsDefenderResponse() {
  return {
    status: {
      platform: '',
      supported: false,
      available: false,
      provider: 'windows_defender',
      lastUpdatedAt: 0,
      antivirusEnabled: null,
      realtimeProtectionEnabled: null,
      behaviorMonitorEnabled: null,
      controlledFolderAccessEnabled: null,
      firewallEnabled: null,
      activeAlertCount: 0,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
      summary: 'Windows Defender integration is unavailable.',
    },
    alerts: [],
  };
}

function buildSecurityActivityAgentOptions(entries) {
  const ids = [...new Set(entries.flatMap((entry) => [entry.agentId, entry.targetAgentId].filter(Boolean)))].sort();
  return ids
    .map((id) => `<option value="${escAttr(id)}">${esc(id)}</option>`)
    .join('');
}

function summarizeSecurityActivity(entries) {
  return entries.reduce((counts, entry) => {
    if (entry.status === 'started') counts.started += 1;
    if (entry.status === 'skipped') counts.skipped += 1;
    if (entry.status === 'completed') counts.completed += 1;
    if (entry.status === 'failed') counts.failed += 1;
    return counts;
  }, { started: 0, skipped: 0, completed: 0, failed: 0 });
}

function filterSecurityActivityEntries(entries, filters) {
  return entries.filter((entry) => {
    if (filters.status && entry.status !== filters.status) return false;
    if (filters.agentId && entry.agentId !== filters.agentId && entry.targetAgentId !== filters.agentId) return false;
    return true;
  });
}

function readConfiguredSecuritySettings(config) {
  return {
    deploymentProfile: config?.assistant?.security?.deploymentProfile || 'personal',
    operatingMode: config?.assistant?.security?.operatingMode || 'monitor',
    triageLlmProvider: config?.assistant?.security?.triageLlmProvider || 'auto',
  };
}

function renderSecurityProfileOptions(selected) {
  return ['personal', 'home', 'organization']
    .map((profile) => `<option value="${escAttr(profile)}"${profile === selected ? ' selected' : ''}>${esc(formatProfileLabel(profile))}</option>`)
    .join('');
}

function renderSecurityModeOptions(selected) {
  return ['monitor', 'guarded', 'lockdown', 'ir_assist']
    .map((mode) => `<option value="${escAttr(mode)}"${mode === selected ? ' selected' : ''}>${esc(formatSecurityMode(mode))}</option>`)
    .join('');
}

function renderSecurityTriageProviderOptions(selected) {
  const labels = {
    auto: 'Auto (Local First)',
    local: 'Local Only',
    external: 'External Only',
  };
  return ['auto', 'local', 'external']
    .map((provider) => `<option value="${escAttr(provider)}"${provider === selected ? ' selected' : ''}>${esc(labels[provider] || provider)}</option>`)
    .join('');
}

function formatProfileLabel(profile) {
  if (!profile) return 'Personal';
  return String(profile)
    .split('_')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : '')
    .join(' ');
}

function describeUnifiedSecurityAlert(alert) {
  if (alert?.subject) return alert.subject;
  const evidence = alert?.evidence || {};
  return evidence.path
    || evidence.name
    || evidence.remoteAddress
    || evidence.targetName
    || evidence.targetId
    || evidence.ip
    || evidence.mac
    || '-';
}

function formatSecurityMode(mode) {
  if (mode === 'ir_assist') return 'IR Assist';
  if (!mode) return 'Monitor';
  return String(mode)
    .split('_')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : '')
    .join(' ');
}

function formatSecurityActivityStatus(status) {
  switch (status) {
    case 'started': return 'Started';
    case 'completed': return 'Completed';
    case 'skipped': return 'Skipped';
    case 'failed': return 'Failed';
    default: return status || 'Unknown';
  }
}

function formatNullableNumber(value, suffix = '') {
  return Number.isFinite(value) ? `${Math.round(Number(value))}${suffix}` : 'unknown';
}

function formatAlertStatus(status) {
  if (!status) return '';
  return String(status)
    .split('_')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : '')
    .join(' ');
}

function alertStatusBadgeClass(status) {
  if (status === 'active') return 'badge-critical';
  if (status === 'acknowledged') return 'badge-warn';
  if (status === 'suppressed') return 'badge-info';
  if (status === 'resolved') return 'badge-success';
  return 'badge-info';
}

function renderSecurityAlertActions(row) {
  if (!row?.isLocalAlert || !row?.ackSource) {
    return '<span style="color:var(--text-muted)">Audit only</span>';
  }
  if (row.status === 'resolved' || row.status === 'suppressed') {
    return '<span style="color:var(--text-muted)">No action</span>';
  }
  return [
    `<button class="btn btn-secondary btn-sm security-alert-action" data-action="ack" data-alert-id="${escAttr(row.id)}" data-alert-source="${escAttr(row.ackSource)}">Acknowledge</button>`,
    `<button class="btn btn-secondary btn-sm security-alert-action" data-action="resolve" data-alert-id="${escAttr(row.id)}" data-alert-source="${escAttr(row.ackSource)}">Resolve</button>`,
    `<button class="btn btn-secondary btn-sm security-alert-action" data-action="suppress" data-alert-id="${escAttr(row.id)}" data-alert-source="${escAttr(row.ackSource)}">Suppress 24h</button>`,
  ].join(' ');
}

function modeBadgeClass(mode) {
  if (mode === 'lockdown') return 'badge-critical';
  if (mode === 'guarded' || mode === 'ir_assist') return 'badge-warn';
  return 'badge-info';
}

function securityActivityStatusBadgeClass(status) {
  if (status === 'started') return 'badge-info';
  if (status === 'completed') return 'badge-success';
  if (status === 'skipped') return 'badge-warn';
  if (status === 'failed') return 'badge-critical';
  return 'badge-info';
}

function formatSeverityLabel(severity) {
  if (!severity) return 'Info';
  return String(severity)
    .split('_')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : '')
    .join(' ');
}

function mapNetworkSeverityToAudit(severity) {
  if (severity === 'critical') return 'critical';
  if (severity === 'high' || severity === 'medium' || severity === 'warn') return 'warn';
  return 'info';
}

function auditSeverityClass(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'warn') return 'badge-warn';
  return 'badge-info';
}

function formatSecurityActivityTrigger(entry) {
  const parts = [entry.triggerEventType, entry.triggerDetailType].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '-';
}

function toSecurityActivityEvent(entry) {
  return {
    timestamp: entry.timestamp,
    type: `triage_${entry.status}`,
    severity: entry.severity || 'info',
    agentId: entry.agentId,
    details: {
      reason: `${entry.title}: ${entry.summary}`,
    },
  };
}

function isCloudToolName(toolName) {
  return /^(cpanel_|whm_|vercel_|cf_|aws_|gcp_|azure_)/.test(String(toolName || ''));
}

function isCloudAuditEvent(event) {
  const toolName = event?.details?.toolName;
  if (isCloudToolName(toolName)) return true;
  const source = String(event?.details?.source || '');
  return source.includes('tool:cf_')
    || source.includes('tool:aws_')
    || source.includes('tool:gcp_')
    || source.includes('tool:azure_')
    || source.includes('tool:vercel_')
    || source.includes('tool:cpanel_')
    || source.includes('tool:whm_');
}

function isAutomationAuditEvent(event) {
  if (event?.type !== 'automation_finding') return false;
  return event?.details?.automationDisposition?.sendToSecurity === true;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(input) {
  return esc(input).replace(/"/g, '&quot;');
}
