/**
 * Tools page — tool catalog, policy config, approvals, and job history.
 */

import { api } from '../api.js';
import { applyInputTooltips } from '../tooltip.js';

export async function renderTools(container) {
  container.innerHTML = '<h2 class="page-title">Tools</h2><div class="loading">Loading...</div>';

  try {
    const state = await api.toolsState(80);
    const tools = state.tools || [];
    const policy = state.policy || { mode: 'approve_by_policy', toolPolicies: {}, sandbox: { allowedPaths: [], allowedCommands: [], allowedDomains: [] } };
    const approvals = state.approvals || [];
    const jobs = state.jobs || [];

    container.innerHTML = `
      <h2 class="page-title">Tools</h2>

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
          <div class="card-title">Pending Approvals</div>
          <div class="card-value">${approvals.filter((a) => a.status === 'pending').length}</div>
          <div class="card-subtitle">Manual decisions required</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Recent Jobs</div>
          <div class="card-value">${jobs.length}</div>
          <div class="card-subtitle">Execution history</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Policy & Sandbox Register</h3></div>
        <div class="intel-controls" style="pointer-events: none; opacity: 0.8;">
          <div class="intel-control-row">
            <label>Mode</label>
            <span class="intel-inline">${esc(policy.mode)}</span>
          </div>
          <div class="intel-control-row">
            <label>Allowed Paths</label>
            <span class="intel-inline">${esc((policy.sandbox?.allowedPaths || []).join(', ') || 'None')}</span>
          </div>
          <div class="intel-control-row">
            <label>Allowed Commands</label>
            <span class="intel-inline">${esc((policy.sandbox?.allowedCommands || []).join(', ') || 'None')}</span>
          </div>
          <div class="intel-control-row">
            <label>Allowed Domains</label>
            <span class="intel-inline">${esc((policy.sandbox?.allowedDomains || []).join(', ') || 'None')}</span>
          </div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Tool Catalog</h3>
          <button class="btn btn-secondary" id="tools-refresh" style="font-size:0.75rem;padding:0.35rem 0.65rem;">Refresh</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Risk</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            ${tools.length === 0
              ? '<tr><td colspan="3">No tools registered.</td></tr>'
              : tools.map((tool) => `
                <tr>
                  <td>${esc(tool.name)}</td>
                  <td><span class="badge ${riskClass(tool.risk)}">${esc(tool.risk)}</span></td>
                  <td>${esc(tool.description)}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Pending Approvals</h3></div>
        <table>
          <thead>
            <tr>
              <th>Approval</th>
              <th>Tool</th>
              <th>Risk</th>
              <th>Origin</th>
              <th>Created</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            ${approvals.length === 0
              ? '<tr><td colspan="6">No approvals.</td></tr>'
              : approvals.map((approval) => `
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
          <thead>
            <tr>
              <th>Job</th>
              <th>Tool</th>
              <th>Status</th>
              <th>Origin</th>
              <th>Created</th>
              <th>Duration</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${jobs.length === 0
              ? '<tr><td colspan="7">No tool jobs yet.</td></tr>'
              : jobs.map((job) => `
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

    container.querySelector('#tools-refresh')?.addEventListener('click', () => renderTools(container));

    container.querySelectorAll('.tool-approve').forEach((button) => {
      button.addEventListener('click', async () => {
        const approvalId = button.getAttribute('data-approval-id');
        const decision = button.getAttribute('data-decision');
        if (!approvalId || !decision) return;
        try {
          const result = await api.decideToolApproval({
            approvalId,
            decision,
            actor: 'web-user',
          });
          if (!result.success) {
            alert(result.message || 'Failed to update approval.');
          }
          await renderTools(container);
        } catch (err) {
          alert(err.message || 'Failed to update approval.');
        }
      });
    });

    applyInputTooltips(container);
  } catch (err) {
    container.innerHTML = `<h2 class="page-title">Tools</h2><div class="loading">Error: ${esc(err.message || String(err))}</div>`;
  }
}

function splitCsv(raw) {
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function shortId(id) {
  return id?.slice(0, 8) || '';
}

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

function esc(value) {
  const d = document.createElement('div');
  d.textContent = value == null ? '' : String(value);
  return d.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}
