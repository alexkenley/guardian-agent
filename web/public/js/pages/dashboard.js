/**
 * Dashboard page — overview with status cards, agent table, LLM status, recent events,
 * plus assistant state (sessions, throughput, latency, jobs, cron, policy decisions).
 */

import { api } from '../api.js';
import { createStatusCard, updateStatusCard } from '../components/status-card.js';
import { createAgentTable, updateAgentTable } from '../components/agent-table.js';
import { onSSE, offSSE } from '../app.js';

let cards = {};
let agentTableEl = null;
let llmStatusEl = null;
let metricsHandler = null;
let assistantPollTimer = null;
let currentContainer = null;

export async function renderDashboard(container) {
  currentContainer = container;
  stopAssistantPolling();
  container.innerHTML = '<h2 class="page-title">Dashboard</h2><div class="loading">Loading...</div>';

  try {
    const [agents, summary, providers] = await Promise.all([
      api.agents().catch(() => []),
      api.auditSummary(300000).catch(() => null),
      api.providersStatus().catch(() => api.providers().catch(() => [])),
    ]);
    const readiness = await api.setupStatus().catch(() => null);

    container.innerHTML = '<h2 class="page-title">Dashboard</h2>';

    // Status cards
    const grid = document.createElement('div');
    grid.className = 'cards-grid';

    cards.runtime = createStatusCard('Guardian Core', 'Online', 'System operational', 'success');
    cards.agents = createStatusCard('Agents', agents.length, `${agents.filter(a => a.state === 'idle' || a.state === 'running').length} active`, 'info');
    cards.guardian = createStatusCard('Shield Status', summary ? 'Active' : 'N/A', summary ? `${summary.totalEvents} events (5m)` : 'No data', 'accent');

    // LLM card - show primary provider status
    const primaryProvider = providers[0];
    if (primaryProvider) {
      const connected = primaryProvider.connected !== false;
      const locality = primaryProvider.locality === 'local' ? 'Local' : 'External API';
      cards.llm = createStatusCard(
        'LLM Provider',
        connected ? 'Connected' : 'Disconnected',
        `${primaryProvider.model} (${locality})`,
        connected ? 'success' : 'error'
      );
    } else {
      cards.llm = createStatusCard('LLM Provider', 'None', 'No providers configured', 'warning');
    }

    cards.readiness = createStatusCard(
      'Readiness',
      readiness?.ready ? 'Ready' : 'Needs Review',
      readiness?.completed ? 'Config baseline complete' : 'Complete Config Center',
      readiness?.ready ? 'success' : 'warning',
    );

    // Make cards clickable with navigation targets
    const clickableCards = [
      { card: cards.agents, action: () => agentTableEl?.scrollIntoView({ behavior: 'smooth' }) },
      { card: cards.guardian, action: () => { window.location.hash = '#/security'; } },
      { card: cards.llm, action: () => { window.location.hash = '#/config?tab=providers'; } },
      { card: cards.readiness, action: () => { window.location.hash = '#/config?tab=settings'; } },
    ];
    for (const { card, action } of clickableCards) {
      card.classList.add('status-card-link');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', action);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); }
      });
    }

    grid.append(cards.runtime, cards.agents, cards.guardian, cards.llm, cards.readiness);
    container.appendChild(grid);

    // LLM Provider Status section
    if (providers.length > 0) {
      llmStatusEl = document.createElement('div');
      llmStatusEl.className = 'table-container';
      renderLLMStatus(llmStatusEl, providers);
      container.appendChild(llmStatusEl);
    }

    // Agent table
    agentTableEl = createAgentTable(agents, 'Agent Status');
    container.appendChild(agentTableEl);

    // Recent critical/warn events
    if (summary && (summary.bySeverity.warn > 0 || summary.bySeverity.critical > 0)) {
      const recentEvents = await api.audit({ severity: 'warn', limit: 5 }).catch(() => []);
      const critEvents = await api.audit({ severity: 'critical', limit: 5 }).catch(() => []);
      const allRecent = [...critEvents, ...recentEvents].slice(0, 5);

      if (allRecent.length > 0) {
        const section = document.createElement('div');
        section.className = 'table-container';
        section.innerHTML = `
          <div class="table-header"><h3>Recent Alerts</h3></div>
          <table>
            <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Agent</th><th>Details</th></tr></thead>
            <tbody>${allRecent.map(e => `
              <tr>
                <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
                <td>${esc(e.type)}</td>
                <td><span class="badge badge-${e.severity}">${esc(e.severity)}</span></td>
                <td>${esc(e.agentId)}</td>
                <td>${esc(e.controller || JSON.stringify(e.details).slice(0, 60))}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        `;
        container.appendChild(section);
      }
    }

    // SSE updates
    if (metricsHandler) offSSE('metrics', metricsHandler);
    metricsHandler = (data) => {
      if (agentTableEl && data.agents) {
        updateAgentTable(agentTableEl, data.agents);
        updateStatusCard(cards.agents, data.agents.length,
          `${data.agents.filter(a => a.state === 'idle' || a.state === 'running').length} active`);
      }
    };
    onSSE('metrics', metricsHandler);

    // ─── Assistant State Section ──────────────────────────
    const assistantSection = document.createElement('div');
    assistantSection.id = 'dashboard-assistant-state';
    container.appendChild(assistantSection);

    await renderAssistantState(assistantSection);

    // Poll assistant state every 4s while on dashboard
    assistantPollTimer = setInterval(() => {
      if (window.location.hash && window.location.hash !== '#/' && window.location.hash !== '#') {
        stopAssistantPolling();
        return;
      }
      const el = document.getElementById('dashboard-assistant-state');
      if (el) void renderAssistantState(el);
    }, 4000);

  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Dashboard</h2><div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function stopAssistantPolling() {
  if (assistantPollTimer) {
    clearInterval(assistantPollTimer);
    assistantPollTimer = null;
  }
}

async function renderAssistantState(section) {
  try {
    const state = await api.assistantState();
    const { orchestrator, jobs, lastPolicyDecisions, scheduledJobs } = state;
    const summary = orchestrator.summary;
    const sessions = orchestrator.sessions;

    section.innerHTML = '';

    const header = document.createElement('h3');
    header.className = 'section-header';
    header.textContent = 'Assistant State';
    section.appendChild(header);

    // Assistant cards
    const aCards = document.createElement('div');
    aCards.className = 'cards-grid';
    const sessionsCard = createMiniCard('Sessions', String(summary.sessionCount), `${summary.runningCount} running / ${summary.queuedCount} queued`, 'info');
    const throughputCard = createMiniCard('Throughput', `${summary.completedRequests}/${summary.totalRequests}`, `${summary.failedRequests} failed`, summary.failedRequests > 0 ? 'warning' : 'success');
    const latencyCard = createMiniCard('Latency (E2E)', `${summary.avgEndToEndMs}ms`, 'Queue + execution avg', 'accent');
    const jobsCard = createMiniCard('Jobs', `${jobs.summary.running} running`, `${jobs.summary.failed} failed / ${jobs.summary.total} tracked`, jobs.summary.failed > 0 ? 'warning' : 'success');

    const scrollTo = (id) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    for (const card of [sessionsCard, throughputCard, latencyCard]) {
      card.classList.add('status-card-link');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      const action = scrollTo('dashboard-session-queue');
      card.addEventListener('click', action);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } });
    }
    jobsCard.classList.add('status-card-link');
    jobsCard.setAttribute('role', 'button');
    jobsCard.setAttribute('tabindex', '0');
    const jobAction = scrollTo('dashboard-background-jobs');
    jobsCard.addEventListener('click', jobAction);
    jobsCard.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jobAction(); } });

    aCards.append(sessionsCard, throughputCard, latencyCard, jobsCard);
    section.appendChild(aCards);

    // Session Queue table
    if (sessions.length > 0) {
      const sessionTable = document.createElement('div');
      sessionTable.className = 'table-container';
      sessionTable.id = 'dashboard-session-queue';
      sessionTable.innerHTML = `
        <div class="table-header"><h3>Session Queue</h3></div>
        <table>
          <thead>
            <tr><th>Session</th><th>Status</th><th>Queue</th><th>Requests</th><th>Wait ms</th><th>Exec ms</th></tr>
          </thead>
          <tbody>
            ${sessions.slice(0, 10).map(s => `
              <tr>
                <td>${esc(`${s.channel}:${s.userId}:${s.agentId}`)}</td>
                <td><span class="badge ${s.status === 'running' ? 'badge-running' : s.status === 'queued' ? 'badge-warn' : 'badge-idle'}">${esc(s.status)}</span></td>
                <td>${s.queueDepth}</td>
                <td>${s.totalRequests}</td>
                <td>${s.lastQueueWaitMs ?? '-'}</td>
                <td>${s.lastExecutionMs ?? '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      section.appendChild(sessionTable);
    }

    // Background Jobs table
    if (jobs.jobs.length > 0) {
      const jobTable = document.createElement('div');
      jobTable.className = 'table-container';
      jobTable.id = 'dashboard-background-jobs';
      jobTable.innerHTML = `
        <div class="table-header"><h3>Background Jobs</h3></div>
        <table>
          <thead><tr><th>Type</th><th>Source</th><th>Status</th><th>Duration</th><th>Detail</th></tr></thead>
          <tbody>
            ${jobs.jobs.slice(0, 10).map(j => `
              <tr>
                <td>${esc(j.type)}</td>
                <td>${esc(j.source)}</td>
                <td><span class="badge ${j.status === 'running' ? 'badge-running' : j.status === 'failed' ? 'badge-errored' : 'badge-idle'}">${esc(j.status)}</span></td>
                <td>${j.durationMs !== undefined ? `${j.durationMs}ms` : '-'}</td>
                <td>${esc(j.detail ?? j.error ?? '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      section.appendChild(jobTable);
    }

    // Scheduled Cron
    if (scheduledJobs && scheduledJobs.length > 0) {
      const cronTable = document.createElement('div');
      cronTable.className = 'table-container';
      cronTable.innerHTML = `
        <div class="table-header"><h3>Scheduled Cron Jobs</h3></div>
        <table>
          <thead><tr><th>Agent ID</th><th>Cron</th><th>Next Run</th></tr></thead>
          <tbody>
            ${scheduledJobs.map(j => `
              <tr>
                <td>${esc(j.agentId)}</td>
                <td><code style="background:var(--bg-tertiary);padding:0.2rem 0.4rem;border-radius:4px">${esc(j.cron)}</code></td>
                <td>${j.nextRun ? esc(new Date(j.nextRun).toLocaleString()) : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      section.appendChild(cronTable);
    }

    // Recent Policy Decisions
    if (lastPolicyDecisions.length > 0) {
      const policyTable = document.createElement('div');
      policyTable.className = 'table-container';
      policyTable.innerHTML = `
        <div class="table-header"><h3>Recent Policy Decisions</h3></div>
        <table>
          <thead><tr><th>Type</th><th>Severity</th><th>Agent</th><th>Controller</th><th>Reason</th></tr></thead>
          <tbody>
            ${lastPolicyDecisions.slice(0, 10).map(e => `
              <tr>
                <td>${esc(e.type)}</td>
                <td><span class="badge ${e.severity === 'critical' ? 'badge-critical' : e.severity === 'warn' ? 'badge-warn' : 'badge-info'}">${esc(e.severity)}</span></td>
                <td>${esc(e.agentId)}</td>
                <td>${esc(e.controller ?? '-')}</td>
                <td>${esc(e.reason ?? '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      section.appendChild(policyTable);
    }
  } catch {
    // Silently fail — assistant state is optional enrichment
  }
}

function renderLLMStatus(container, providers) {
  container.innerHTML = `
    <div class="table-header">
      <h3>LLM Providers</h3>
      <button class="btn btn-secondary" id="refresh-llm" style="font-size:0.7rem;padding:0.3rem 0.6rem;">Refresh</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Endpoint</th><th>Status</th><th>Circuit</th><th>Available Models</th></tr></thead>
      <tbody>${providers.map(p => {
        const connected = p.connected !== false;
        const locality = p.locality === 'local' ? 'Local' : 'External API';
        const circuit = p.circuitState || 'closed';
        return `
          <tr>
            <td>${esc(p.name)}</td>
            <td>${esc(p.type)}</td>
            <td><strong>${esc(p.model)}</strong></td>
            <td>${esc(p.baseUrl || locality)}</td>
            <td><span class="badge ${connected ? 'badge-idle' : 'badge-errored'}">${connected ? 'Connected' : 'Disconnected'}</span></td>
            <td><span class="badge badge-${esc(circuit)}">${esc(circuit)}</span></td>
            <td>${p.availableModels ? p.availableModels.slice(0, 5).map(m => esc(m)).join(', ') : '-'}</td>
          </tr>
        `;
      }).join('')}</tbody>
    </table>
  `;

  container.querySelector('#refresh-llm')?.addEventListener('click', async () => {
    try {
      const updated = await api.providersStatus();
      renderLLMStatus(container, updated);

      // Update the LLM card too
      const primary = updated[0];
      if (primary && cards.llm) {
        const connected = primary.connected !== false;
        const locality = primary.locality === 'local' ? 'Local' : 'External API';
        updateStatusCard(cards.llm, connected ? 'Connected' : 'Disconnected', `${primary.model} (${locality})`);
        cards.llm.className = `status-card ${connected ? 'success' : 'error'}`;
      }
    } catch { /* ignore */ }
  });
}

function createMiniCard(title, value, subtitle, tone) {
  const card = document.createElement('div');
  card.className = `status-card ${tone}`;
  card.innerHTML = `
    <div class="card-title">${esc(title)}</div>
    <div class="card-value">${esc(String(value))}</div>
    <div class="card-subtitle">${esc(String(subtitle))}</div>
  `;
  return card;
}

export function updateDashboard() {
  if (currentContainer) {
    void renderDashboard(currentContainer);
  }
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
