/**
 * Assistant State page — queue/orchestration visibility.
 */

import { api } from '../api.js';

let pollTimer = null;

export async function renderAssistant(container) {
  stopPolling();
  container.innerHTML = '<h2 class="page-title">Assistant State</h2><div class="loading">Loading...</div>';

  const refresh = async () => {
    try {
      const state = await api.assistantState();
      renderState(container, state, refresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      container.innerHTML = `<h2 class="page-title">Assistant State</h2><div class="loading">Error: ${esc(message)}</div>`;
    }
  };

  await refresh();

  pollTimer = setInterval(() => {
    if (window.location.hash !== '#/assistant') {
      stopPolling();
      return;
    }
    void refresh();
  }, 4_000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderState(container, state, refresh) {
  const { orchestrator, jobs, lastPolicyDecisions, defaultProvider, guardianEnabled, providers, scheduledJobs } = state;
  const summary = orchestrator.summary;
  const sessions = orchestrator.sessions;
  const traces = orchestrator.traces || [];

  container.innerHTML = '<h2 class="page-title">Assistant State</h2>';

  const intro = document.createElement('div');
  intro.className = 'config-intro';
  intro.textContent = 'Live orchestration state: per-session queue depth and timing so you can distinguish queue delays from model execution time.';
  container.appendChild(intro);

  const cards = document.createElement('div');
  cards.className = 'cards-grid';
  cards.append(
    createCard('Sessions', String(summary.sessionCount), `${summary.runningCount} running / ${summary.queuedCount} queued`, 'info'),
    createCard('Throughput', `${summary.completedRequests}/${summary.totalRequests}`, `${summary.failedRequests} failed`, summary.failedRequests > 0 ? 'warning' : 'success'),
    createCard('Latency (E2E)', `${summary.avgEndToEndMs}ms`, 'Queue + execution average', 'accent'),
    createCard('Latency (Exec)', `${summary.avgExecutionMs}ms`, 'Runtime + provider average', 'info'),
    createCard('Priority Queue', `H:${summary.queuedByPriority?.high ?? 0} N:${summary.queuedByPriority?.normal ?? 0} L:${summary.queuedByPriority?.low ?? 0}`, `${summary.queuedCount} total queued`, 'info'),
    createCard('Jobs', `${jobs.summary.running} running`, `${jobs.summary.failed} failed / ${jobs.summary.total} tracked`, jobs.summary.failed > 0 ? 'warning' : 'success'),
    createCard('Policy Decisions', String(lastPolicyDecisions.length), 'Recent guardian allow/deny decisions', 'info'),
    createCard('Default Provider', defaultProvider, providers.join(', ') || 'No providers', 'info'),
    createCard('Guardian', guardianEnabled ? 'Enabled' : 'Disabled', `Uptime ${formatDuration(summary.uptimeMs)}`, guardianEnabled ? 'success' : 'warning'),
  );
  container.appendChild(cards);

  const table = document.createElement('div');
  table.className = 'table-container';
  table.innerHTML = `
    <div class="table-header">
      <h3>Session Queue State</h3>
      <button class="btn btn-secondary" id="assistant-refresh" style="font-size:0.7rem;padding:0.3rem 0.6rem;">Refresh</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>Session</th>
          <th>Status</th>
          <th>Queue</th>
          <th>Requests</th>
          <th>Wait ms</th>
          <th>Exec ms</th>
          <th>E2E ms</th>
          <th>Last Activity</th>
          <th>Last Error</th>
        </tr>
      </thead>
      <tbody>
        ${sessions.length === 0
          ? '<tr><td colspan="9">No session activity yet</td></tr>'
          : sessions.map((session) => `
              <tr>
                <td title="${esc(session.sessionId)}">${esc(`${session.channel}:${session.userId}:${session.agentId}`)}</td>
                <td><span class="badge ${statusBadge(session.status)}">${esc(session.status)}</span></td>
                <td>${session.queueDepth}</td>
                <td>${session.totalRequests}</td>
                <td>${session.lastQueueWaitMs ?? '-'}</td>
                <td>${session.lastExecutionMs ?? '-'}</td>
                <td>${session.lastEndToEndMs ?? '-'}</td>
                <td>${session.lastCompletedAt ? esc(formatTimeAgo(session.lastCompletedAt)) : '-'}</td>
                <td title="${esc(session.lastError ?? '')}">${esc(session.lastError ?? session.lastResponsePreview ?? '-')}</td>
              </tr>
            `).join('')}
      </tbody>
    </table>
  `;

  table.querySelector('#assistant-refresh')?.addEventListener('click', () => {
    void refresh();
  });

  container.appendChild(table);

  const traceTable = document.createElement('div');
  traceTable.className = 'table-container';
  traceTable.innerHTML = `
    <div class="table-header">
      <h3>Recent Request Traces</h3>
    </div>
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Priority</th>
          <th>Status</th>
          <th>Session</th>
          <th>Queue ms</th>
          <th>Exec ms</th>
          <th>E2E ms</th>
          <th>Last Step</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${traces.length === 0
          ? '<tr><td colspan="9">No traces yet</td></tr>'
          : traces.slice(0, 25).map((trace) => {
              const lastStep = trace.steps && trace.steps.length > 0 ? trace.steps[trace.steps.length - 1] : null;
              return `
                <tr>
                  <td>${esc(trace.requestType)}</td>
                  <td>${esc(trace.priority)}</td>
                  <td><span class="badge ${traceStatusBadge(trace.status)}">${esc(trace.status)}</span></td>
                  <td title="${esc(trace.sessionId)}">${esc(`${trace.channel}:${trace.userId}:${trace.agentId}`)}</td>
                  <td>${trace.queueWaitMs ?? '-'}</td>
                  <td>${trace.executionMs ?? '-'}</td>
                  <td>${trace.endToEndMs ?? '-'}</td>
                  <td>${lastStep ? esc(`${lastStep.name} (${lastStep.status})`) : '-'}</td>
                  <td>${esc(trace.error ?? '-')}</td>
                </tr>
              `;
            }).join('')}
      </tbody>
    </table>
  `;
  container.appendChild(traceTable);

  const jobTable = document.createElement('div');
  jobTable.className = 'table-container';
  jobTable.innerHTML = `
    <div class="table-header">
      <h3>Background Jobs</h3>
    </div>
    <table>
      <thead>
        <tr>
          <th>Job</th>
          <th>Source</th>
          <th>Status</th>
          <th>Started</th>
          <th>Duration</th>
          <th>Detail</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.jobs.length === 0
          ? '<tr><td colspan="7">No jobs yet</td></tr>'
          : jobs.jobs.map((job) => `
              <tr>
                <td title="${esc(job.id)}">${esc(job.type)}</td>
                <td>${esc(job.source)}</td>
                <td><span class="badge ${jobStatusBadge(job.status)}">${esc(job.status)}</span></td>
                <td>${esc(formatTimeAgo(job.startedAt))}</td>
                <td>${job.durationMs !== undefined ? `${job.durationMs}ms` : '-'}</td>
                <td>${esc(job.detail ?? '-')}</td>
                <td>${esc(job.error ?? '-')}</td>
              </tr>
            `).join('')}
      </tbody>
    </table>
  `;
  container.appendChild(jobTable);

  const scheduledTable = document.createElement('div');
  scheduledTable.className = 'table-container';
  scheduledTable.innerHTML = `
    <div class="table-header">
      <h3>Scheduled Cron Jobs</h3>
    </div>
    <table>
      <thead>
        <tr>
          <th>Agent ID</th>
          <th>Cron Expression</th>
          <th>Next Run</th>
        </tr>
      </thead>
      <tbody>
        ${(scheduledJobs || []).length === 0
          ? '<tr><td colspan="3">No scheduled jobs yet</td></tr>'
          : (scheduledJobs || []).map((job) => `
              <tr>
                <td>${esc(job.agentId)}</td>
                <td><code style="background:var(--bg-tertiary);padding:0.2rem 0.4rem;border-radius:4px">${esc(job.cron)}</code></td>
                <td>${job.nextRun ? esc(new Date(job.nextRun).toLocaleString()) : '-'}</td>
              </tr>
            `).join('')}
      </tbody>
    </table>
  `;
  container.appendChild(scheduledTable);

  const decisionTable = document.createElement('div');
  decisionTable.className = 'table-container';
  decisionTable.innerHTML = `
    <div class="table-header">
      <h3>Recent Policy Decisions</h3>
    </div>
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Severity</th>
          <th>Agent</th>
          <th>Controller</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        ${lastPolicyDecisions.length === 0
          ? '<tr><td colspan="6">No recent policy decisions</td></tr>'
          : lastPolicyDecisions.map((event) => `
              <tr>
                <td>${esc(formatTimeAgo(event.timestamp))}</td>
                <td>${esc(event.type)}</td>
                <td><span class="badge ${severityBadge(event.severity)}">${esc(event.severity)}</span></td>
                <td>${esc(event.agentId)}</td>
                <td>${esc(event.controller ?? '-')}</td>
                <td>${esc(event.reason ?? '-')}</td>
              </tr>
            `).join('')}
      </tbody>
    </table>
  `;
  container.appendChild(decisionTable);
}

function statusBadge(status) {
  if (status === 'running') return 'badge-running';
  if (status === 'queued') return 'badge-warn';
  return 'badge-idle';
}

function jobStatusBadge(status) {
  if (status === 'running') return 'badge-running';
  if (status === 'failed') return 'badge-errored';
  return 'badge-idle';
}

function traceStatusBadge(status) {
  if (status === 'running') return 'badge-running';
  if (status === 'queued') return 'badge-warn';
  if (status === 'failed') return 'badge-errored';
  return 'badge-idle';
}

function severityBadge(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'warn') return 'badge-warn';
  return 'badge-info';
}

function createCard(title, value, subtitle, tone) {
  const card = document.createElement('div');
  card.className = `status-card ${tone}`;
  card.innerHTML = `
    <div class="card-title">${esc(title)}</div>
    <div class="card-value">${esc(String(value))}</div>
    <div class="card-subtitle">${esc(String(subtitle))}</div>
  `;
  return card;
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

function formatTimeAgo(timestampMs) {
  const diff = Date.now() - timestampMs;
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}
