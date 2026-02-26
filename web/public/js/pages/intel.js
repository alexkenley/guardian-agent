/**
 * Threat Intel page — watchlist, scans, findings, and action drafts.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

export async function renderIntel(container) {
  container.innerHTML = '<h2 class="page-title">Threat Intel</h2><div class="loading">Loading...</div>';

  try {
    const [summary, plan, watchlistResponse, findings, actions] = await Promise.all([
      api.threatIntelSummary(),
      api.threatIntelPlan(),
      api.threatIntelWatchlist(),
      api.threatIntelFindings({ limit: 30 }),
      api.threatIntelActions(30),
    ]);

    const watchlist = watchlistResponse.targets ?? [];
    const connectorText = (summary.forumConnectors || [])
      .map((connector) => `${connector.id}:${connector.enabled ? 'on' : 'off'}:${connector.mode}${connector.hostile ? ':hostile' : ''}`)
      .join(', ');

    container.innerHTML = `
      <h2 class="page-title">Threat Intel</h2>

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

      <div class="table-container">
        <div class="table-header">
          <h3>Operations Configuration</h3>
          <button class="btn btn-secondary" id="intel-refresh" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Refresh</button>
        </div>
        <div class="intel-controls" style="pointer-events: none; opacity: 0.8;">
          <div class="intel-control-row">
            <label>Response Mode</label>
            <span class="intel-inline">${esc(summary.responseMode)}</span>
            <span class="intel-muted">Darkweb scans: ${summary.darkwebEnabled ? 'enabled' : 'disabled'}</span>
            <span class="intel-muted">Forum connectors: ${esc(connectorText || 'none')}</span>
          </div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Watchlist</h3></div>
        <div class="intel-watchlist-panel">
          <div class="intel-watch-items">
            ${watchlist.length === 0
              ? '<span class="intel-muted">No watch targets configured.</span>'
              : watchlist.map((target) => `
                <span class="intel-chip">
                  ${esc(target)}
                </span>
              `).join('')}
          </div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Findings</h3></div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Target</th>
              <th>Source</th>
              <th>Severity</th>
              <th>Confidence</th>
              <th>Status</th>
              <th>Summary</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${findings.length === 0 ? `
              <tr><td colspan="8">No findings yet. Run a scan to populate results.</td></tr>
            ` : findings.map((finding) => `
              <tr>
                <td title="${esc(finding.id)}">${esc(shortId(finding.id))}</td>
                <td>${esc(finding.target)}</td>
                <td>${esc(finding.sourceType)}</td>
                <td><span class="badge ${severityClass(finding.severity)}">${esc(finding.severity)}</span></td>
                <td>${Math.round((finding.confidence ?? 0) * 100)}%</td>
                <td>
                  <select data-finding-status="${escAttr(finding.id)}">
                    ${['new', 'triaged', 'actioned', 'dismissed'].map((status) => `
                      <option value="${status}" ${finding.status === status ? 'selected' : ''}>${status}</option>
                    `).join('')}
                  </select>
                </td>
                <td>${esc(finding.summary)}</td>
                <td>
                  <div class="intel-actions">
                    <button class="btn btn-secondary intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="report">Report</button>
                    <button class="btn btn-secondary intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="request_takedown">Takedown</button>
                    <button class="btn btn-secondary intel-action-btn" data-finding="${escAttr(finding.id)}" data-action="draft_response">Draft Reply</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Drafted Actions</h3></div>
        <table>
          <thead>
            <tr>
              <th>Action ID</th>
              <th>Finding</th>
              <th>Type</th>
              <th>Status</th>
              <th>Approval</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            ${actions.length === 0 ? `
              <tr><td colspan="6">No drafted actions yet.</td></tr>
            ` : actions.map((action) => `
              <tr>
                <td title="${esc(action.id)}">${esc(shortId(action.id))}</td>
                <td title="${esc(action.findingId)}">${esc(shortId(action.findingId))}</td>
                <td>${esc(action.type)}</td>
                <td>${esc(action.status)}</td>
                <td>${action.requiresApproval ? 'required' : 'optional'}</td>
                <td>${esc(action.rationale)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Operating Plan</h3></div>
        <div class="intel-plan">
          <p class="intel-muted">${esc(plan.title)}</p>
          <div class="intel-plan-grid">
            ${plan.phases.map((phase) => `
              <div class="intel-plan-card">
                <h4>${esc(phase.phase)}</h4>
                <p>${esc(phase.objective)}</p>
                <ul>
                  ${phase.deliverables.map((deliverable) => `<li>${esc(deliverable)}</li>`).join('')}
                </ul>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    container.querySelector('#intel-refresh')?.addEventListener('click', () => renderIntel(container));

    container.querySelectorAll('[data-finding-status]').forEach((select) => {
      select.addEventListener('change', async () => {
        const findingId = select.getAttribute('data-finding-status');
        if (!findingId) return;
        try {
          const result = await api.threatIntelSetFindingStatus(findingId, select.value);
          setStatus(result.message, result.success ? 'var(--success)' : 'var(--warning)');
        } catch (err) {
          setStatus((err.message || 'Failed to update finding status.'), 'var(--error)');
        }
      });
    });

    container.querySelectorAll('.intel-action-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        const findingId = button.getAttribute('data-finding');
        const type = button.getAttribute('data-action');
        if (!findingId || !type) return;
        try {
          const result = await api.threatIntelDraftAction(findingId, type);
          setStatus(result.message, result.success ? 'var(--success)' : 'var(--warning)');
          if (result.success) await renderIntel(container);
        } catch (err) {
          setStatus((err.message || 'Failed to draft action.'), 'var(--error)');
        }
      });
    });
    applyInputTooltips(container);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Threat Intel</h2><div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

function shortId(id) {
  return id?.slice(0, 8) || '';
}

function severityClass(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'high') return 'badge-errored';
  if (severity === 'medium') return 'badge-warn';
  return 'badge-info';
}

function esc(input) {
  const div = document.createElement('div');
  div.textContent = input == null ? '' : String(input);
  return div.innerHTML;
}

function escAttr(input) {
  return esc(input).replace(/"/g, '&quot;');
}
