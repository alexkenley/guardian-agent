/**
 * Memory page.
 */

import { api } from '../api.js';
import { renderGuidancePanel, renderInfoButton, activateContextHelp } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';

let currentContainer = null;

const DEFAULT_FILTERS = {
  includeInactive: true,
  includeCodeSessions: true,
  query: '',
  sourceType: '',
  trustLevel: '',
  status: '',
  codeSessionId: '',
  limit: 200,
};

const state = {
  filters: { ...DEFAULT_FILTERS },
  activeTab: 'browse',
  editor: null,
};

const MEMORY_HELP = {
  page: {
    title: 'Memory',
    whatItIs: 'Memory is the durable knowledge surface for Guardian across the global agent scope and any attached code-session scopes.',
    whatSeeing: 'You are seeing compact scope health, filtered memory views, wiki pages, lint findings, and audit-visible maintenance in one place.',
    whatCanDo: 'Use Browse for orientation, Wiki for guarded curation, Entries for raw records, Lint for hygiene review, and Audit for maintenance evidence.',
    howLinks: 'Global pages affect shared retrieval, while code-session pages stay isolated to their own coding scope.',
  },
  overview: {
    title: 'Memory overview',
    whatItIs: 'This is the compact summary strip for the durable memory system.',
    whatSeeing: 'You are seeing the active memory volume, curated wiki coverage, review-only volume, and current lint pressure.',
    whatCanDo: 'Use it to judge whether the system is mostly browse-ready, curation-heavy, or accumulating maintenance debt.',
    howLinks: 'It summarizes the deeper tab surfaces without replacing scope-by-scope review.',
  },
  filters: {
    title: 'Filters',
    whatItIs: 'This filter bar narrows the surfaced memory response before each tab renders.',
    whatSeeing: 'You are filtering the same unified memory dataset that powers the Browse, Wiki, Entries, and Lint tabs.',
    whatCanDo: 'Use query, source, trust, status, scope, and result limit to reduce noise before reviewing or curating.',
    howLinks: 'The filters keep one shared working set so the tabs stay in sync instead of each having separate controls.',
  },
  tabs: {
    browse: {
      title: 'Browse surfaced memory',
      whatItIs: 'Browse is the orientation view for the surfaced durable memory scopes.',
      whatSeeing: 'You are seeing compact scope snapshots plus expandable scope detail instead of raw record tables.',
      whatCanDo: 'Use it to understand which scopes are active, where curated pages exist, and where hygiene work is building up.',
      howLinks: 'It is the fastest entry point before you switch into Wiki, Entries, Lint, or Audit for deeper work.',
    },
    wiki: {
      title: 'Memory wiki',
      whatItIs: 'Wiki is the guarded operator curation surface for durable memory pages.',
      whatSeeing: 'You are seeing derived pages, canonical pages, and operator-curated pages grouped by memory scope.',
      whatCanDo: 'Create, edit, and archive operator-curated pages where the scope is editable.',
      howLinks: 'Curated pages become durable retrieval artifacts while remaining visible to audit and maintenance.',
    },
    entries: {
      title: 'Memory entries',
      whatItIs: 'Entries is the record-level table for the surfaced durable memory store.',
      whatSeeing: 'You are seeing every matching record with category, source class, trust, status, and editability.',
      whatCanDo: 'Use it when the wiki view is too abstract and you need the exact stored artifacts and states.',
      howLinks: 'It is the lowest-friction way to inspect the underlying records behind the wiki surface.',
    },
    lint: {
      title: 'Memory lint',
      whatItIs: 'Lint highlights memory hygiene issues such as weak summaries, duplicate pages, or oversized low-signal content.',
      whatSeeing: 'You are seeing findings grouped by scope so you can separate global debt from code-session debt.',
      whatCanDo: 'Use it to decide which pages should be merged, tightened, archived, or re-authored.',
      howLinks: 'Lint sits between normal browsing and maintenance audit by showing the actionable quality issues directly.',
    },
    audit: {
      title: 'Memory audit and maintenance',
      whatItIs: 'Audit is the evidence surface for memory maintenance runs and wiki mutations.',
      whatSeeing: 'You are seeing bounded maintenance activity plus recent audit-visible memory events.',
      whatCanDo: 'Use it to confirm what changed, when hygiene jobs ran, and whether curation actions were recorded.',
      howLinks: 'It complements the content tabs by showing the operational evidence behind durable memory changes.',
    },
  },
  sections: {
    scopeSnapshot: {
      title: 'Scope snapshot',
      whatItIs: 'This is the compact summary strip for every surfaced memory scope in the current filter window.',
      whatSeeing: 'You are seeing one card per global or code-session scope with key counts and scope posture.',
      whatCanDo: 'Use it to decide which scope deserves attention before opening the detailed scope panels below.',
      howLinks: 'It replaces the previous hash-link sidebar with a simpler read-first view.',
    },
    maintenanceSummary: {
      title: 'Memory maintenance summary',
      whatItIs: 'This section summarizes current maintenance visibility across the durable memory system.',
      whatSeeing: 'You are seeing surfaced scope count, wiki coverage, recent jobs, and recent audit events.',
      whatCanDo: 'Use it to understand whether memory operations are active and inspectable before reading the tables below.',
      howLinks: 'It is the bridge between content review and audit evidence.',
    },
    recentJobs: {
      title: 'Recent memory maintenance jobs',
      whatItIs: 'This table shows recent bounded maintenance or hygiene jobs touching memory artifacts.',
      whatSeeing: 'You are seeing start time, job type, status, scope, target artifact, and short detail.',
      whatCanDo: 'Use it to spot failures, stale maintenance cadence, or repeated hygiene churn.',
      howLinks: 'These jobs explain how lint state and derived content are being refreshed.',
    },
    recentAudit: {
      title: 'Recent memory audit events',
      whatItIs: 'This table is the recent audit ledger for curated memory mutations and related maintenance events.',
      whatSeeing: 'You are seeing when important memory actions occurred, their severity, scope, summary, and actor.',
      whatCanDo: 'Use it to confirm who changed curated pages and whether the expected audit trail exists.',
      howLinks: 'Audit is the evidence layer beneath Wiki, Entries, and Lint.',
    },
    editor: {
      title: 'Curated page editor',
      whatItIs: 'This form creates or updates operator-curated wiki pages in the durable memory store.',
      whatSeeing: 'You are editing retrieval-facing metadata such as title, summary, tags, body, and the reason for the change.',
      whatCanDo: 'Keep titles stable, summaries retrieval-friendly, and reasons explicit so later audit review is clear.',
      howLinks: 'Saved changes become durable memory artifacts and immediately reappear on the Wiki and Entries surfaces.',
    },
  },
};

const MEMORY_INPUT_TOOLTIPS = {
  '[data-memory-filter-form] [name="query"]': 'Search across surfaced memory titles, summaries, tags, and body text.',
  '[data-memory-filter-form] [name="sourceType"]': 'Restrict results by where the memory originated, such as user, tool, operator, or system.',
  '[data-memory-filter-form] [name="trustLevel"]': 'Use trust level to separate operator-reviewed memory from lower-confidence or review-only content.',
  '[data-memory-filter-form] [name="status"]': 'Filter by lifecycle state such as active, archived, quarantined, or rejected.',
  '[data-memory-filter-form] [name="codeSessionId"]': 'Limit the surfaced set to one code-session scope, or leave it broad to compare scopes.',
  '[data-memory-filter-form] [name="limit"]': 'Higher limits show more memory artifacts but make the tables and wiki grids denser.',
  '[data-memory-filter-form] [name="includeInactive"]': 'Include archived and other review-only records in the shared memory view.',
  '[data-memory-filter-form] [name="includeCodeSessions"]': 'Include attached code-session scopes alongside the global durable memory scope.',
  '[data-memory-filter-reset]': 'Restore the default memory filter set.',
  '[data-memory-new-page]': 'Create a new operator-curated page in this memory scope.',
  '[data-memory-edit-page]': 'Open this curated page in the editor.',
  '[data-memory-archive-page]': 'Archive this curated page so it no longer stays active for normal retrieval.',
  '[data-memory-run-cleanup]': 'Run bounded memory hygiene cleanup for this scope using the existing consolidation rules.',
  '[data-memory-hide-inactive]': 'Stop surfacing review-only and archived entries in the current memory filter set.',
  '[data-memory-editor-form] [name="scopeId"]': 'Choose which durable memory scope will own this curated page.',
  '[data-memory-editor-form] [name="title"]': 'Stable page title shown in the wiki and used by retrieval ranking.',
  '[data-memory-editor-form] [name="summary"]': 'Short retrieval-friendly gist. Keep it concise and specific.',
  '[data-memory-editor-form] [name="tags"]': 'Comma-separated tags used for operator browsing and retrieval hints.',
  '[data-memory-editor-form] [name="content"]': 'The durable page body. Keep it factual, scannable, and easy to update later.',
  '[data-memory-editor-form] [name="reason"]': 'Explain why this page exists or what changed so the audit trail remains understandable.',
  '[data-memory-editor-cancel]': 'Close the editor without keeping the current draft in the page state.',
};

export async function renderMemory(container) {
  currentContainer = container;
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const memory = await api.memory(buildMemoryRequestParams());
    const globalScope = memory?.global || emptyScope('global', memory?.principalAgentId || 'default', 'Global Memory');
    const codeSessions = Array.isArray(memory?.codeSessions) ? memory.codeSessions : [];
    const scopeCount = memory?.maintenance?.scopeCount || (1 + codeSessions.length);
    const totalActive = (globalScope.summary?.activeEntries || 0) + codeSessions.reduce((sum, scope) => sum + (scope.summary?.activeEntries || 0), 0);
    const totalReviewOnly = memory?.maintenance?.reviewOnlyCount
      || ((globalScope.summary?.inactiveEntries || 0) + codeSessions.reduce((sum, scope) => sum + (scope.summary?.inactiveEntries || 0), 0));
    const totalOperatorPages = memory?.maintenance?.operatorPageCount
      || ([globalScope, ...codeSessions].reduce((sum, scope) => sum + (scope.wikiPages || []).filter((page) => page.sourceClass === 'operator_curated').length, 0));

    container.innerHTML = `
      ${renderGuide({
        kicker: 'Memory Guide',
        title: 'Durable memory, curation, and hygiene',
        ...MEMORY_HELP.page,
      })}
      ${renderOverview(memory, globalScope, codeSessions, {
        scopeCount,
        totalActive,
        totalReviewOnly,
        totalOperatorPages,
      })}
      ${renderToolbar(memory, globalScope, codeSessions, scopeCount)}
      ${memory?.canEdit === false ? '<div class="guide-note memory-note">Memory curation is currently read-only. Browse, lint review, and audit remain available.</div>' : ''}
    `;

    wireToolbar(container);
    enhanceMemoryUi(container);

    const tabsContainer = document.createElement('div');
    container.appendChild(tabsContainer);
    const response = { ...memory, global: globalScope, codeSessions };
    const tabs = createTabs(tabsContainer, [
      {
        id: 'browse',
        label: 'Browse',
        tooltip: 'Compact scope overview and expandable surfaced-memory detail.',
        render(panel) {
          renderBrowseTab(panel, response);
        },
      },
      {
        id: 'wiki',
        label: 'Wiki',
        tooltip: 'Operator curation plus derived and canonical wiki pages.',
        render(panel) {
          renderWikiTab(panel, response);
        },
      },
      {
        id: 'entries',
        label: 'Entries',
        tooltip: 'Record-level durable memory table across each surfaced scope.',
        render(panel) {
          renderEntriesTab(panel, response);
        },
      },
      {
        id: 'lint',
        label: 'Lint',
        tooltip: 'Memory hygiene findings such as duplicates or oversized low-signal pages.',
        render(panel) {
          renderLintTab(panel, response);
        },
      },
      {
        id: 'audit',
        label: 'Audit',
        tooltip: 'Recent maintenance jobs and audit-visible memory events.',
        render(panel) {
          renderAuditTab(panel, response);
        },
      },
    ], state.activeTab);
    const tabBar = tabsContainer.querySelector('.tab-bar');
    tabBar?.addEventListener('click', (event) => {
      const button = event.target.closest('.tab-btn');
      if (button?.dataset.tabId) {
        state.activeTab = button.dataset.tabId;
      }
    });
    tabs.switchTo(state.activeTab);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<div class="loading">Error: ${esc(message)}</div>`;
  }
}

export function updateMemory() {
  if (currentContainer) {
    void renderMemory(currentContainer);
  }
}

function buildMemoryRequestParams() {
  const params = {
    includeInactive: state.filters.includeInactive,
    includeCodeSessions: state.filters.includeCodeSessions,
    limit: state.filters.limit,
  };
  if (state.filters.query.trim()) params.query = state.filters.query.trim();
  if (state.filters.sourceType) params.sourceType = state.filters.sourceType;
  if (state.filters.trustLevel) params.trustLevel = state.filters.trustLevel;
  if (state.filters.status) params.status = state.filters.status;
  if (state.filters.codeSessionId) params.codeSessionId = state.filters.codeSessionId;
  return params;
}

function renderGuide(config = {}) {
  return renderGuidancePanel({
    collapsible: true,
    collapsed: true,
    compact: true,
    ...config,
  });
}

function renderSectionTitle(title, help) {
  return `
    <div class="section-heading">
      <h3>${esc(title)}</h3>
      ${renderInfoButton(title, help)}
    </div>
  `;
}

function enhanceMemoryUi(root) {
  applyInputTooltips(root, MEMORY_INPUT_TOOLTIPS);
  activateContextHelp(root);
}

function renderOverview(memory, globalScope, codeSessions, summary) {
  return `
    <section class="table-container memory-overview">
      <div class="table-header">
        <div>
          <div class="guide-kicker">Memory Wiki</div>
          <div class="memory-overview-heading">
            <h3>Unified durable memory surface</h3>
            ${renderInfoButton('Memory overview', MEMORY_HELP.overview)}
          </div>
          <div class="table-muted">Global and code-session memory surfaces, guarded curation, lint visibility, and audit evidence in one place.</div>
        </div>
        <div class="memory-filter-meta">
          <span class="badge badge-info">${esc(String(summary.scopeCount))} scope${summary.scopeCount === 1 ? '' : 's'}</span>
          <span class="badge ${memory?.canEdit === false ? 'badge-muted' : 'badge-ok'}">${esc(memory?.canEdit === false ? 'Read only' : 'Curation enabled')}</span>
          <span class="badge badge-muted">${esc(globalScope.title)}</span>
        </div>
      </div>
      <div class="memory-overview-stats">
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(summary.totalActive))}</span>
          <span class="guide-stat-label">Active entries</span>
        </div>
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(summary.totalOperatorPages))}</span>
          <span class="guide-stat-label">Curated pages</span>
        </div>
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(summary.totalReviewOnly))}</span>
          <span class="guide-stat-label">Review-only</span>
        </div>
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(memory?.maintenance?.lintFindingCount || 0))}</span>
          <span class="guide-stat-label">Lint findings</span>
        </div>
      </div>
    </section>
  `;
}

function renderToolbar(memory, globalScope, codeSessions, scopeCount) {
  const scopeOptions = ['<option value="">All code sessions</option>']
    .concat(codeSessions.map((scope) => `<option value="${escAttr(scope.scopeId)}"${state.filters.codeSessionId === scope.scopeId ? ' selected' : ''}>${esc(scope.title)}</option>`))
    .join('');
  return `
    <section class="table-container memory-section">
      <div class="table-header">
        <div>
          ${renderSectionTitle('Filters', MEMORY_HELP.filters)}
          <div class="table-muted">Filter the surfaced memory, wiki pages, and lint findings without leaving the unified view.</div>
        </div>
        <div class="memory-filter-meta">
          <span class="badge badge-info">${esc(String(scopeCount))} scope${scopeCount === 1 ? '' : 's'}</span>
          <span class="badge badge-muted">${esc(globalScope.title)}</span>
          <span class="badge badge-muted">${esc(`${memory?.maintenance?.wikiPageCount || 0} wiki page${(memory?.maintenance?.wikiPageCount || 0) === 1 ? '' : 's'}`)}</span>
        </div>
      </div>
      <form class="memory-toolbar" data-memory-filter-form>
        <div class="memory-toolbar-grid">
          <label class="memory-field">
            <span>Query</span>
            <input type="text" name="query" value="${escAttr(state.filters.query)}" placeholder="search title, summary, content, tags">
          </label>
          <label class="memory-field">
            <span>Source type</span>
            <select name="sourceType">
              ${renderSelectOptions([
                ['', 'All'],
                ['user', 'User'],
                ['local_tool', 'Local tool'],
                ['remote_tool', 'Remote tool'],
                ['system', 'System'],
                ['operator', 'Operator'],
              ], state.filters.sourceType)}
            </select>
          </label>
          <label class="memory-field">
            <span>Trust</span>
            <select name="trustLevel">
              ${renderSelectOptions([
                ['', 'All'],
                ['trusted', 'Trusted'],
                ['reviewed', 'Reviewed'],
                ['untrusted', 'Untrusted'],
              ], state.filters.trustLevel)}
            </select>
          </label>
          <label class="memory-field">
            <span>Status</span>
            <select name="status">
              ${renderSelectOptions([
                ['', 'All'],
                ['active', 'Active'],
                ['quarantined', 'Quarantined'],
                ['expired', 'Expired'],
                ['rejected', 'Rejected'],
                ['archived', 'Archived'],
              ], state.filters.status)}
            </select>
          </label>
          <label class="memory-field">
            <span>Code session</span>
            <select name="codeSessionId">
              ${scopeOptions}
            </select>
          </label>
          <label class="memory-field">
            <span>Result limit</span>
            <input type="number" name="limit" min="1" max="500" value="${escAttr(String(state.filters.limit))}">
          </label>
        </div>
        <div class="memory-toolbar-footer">
          <div class="memory-toolbar-toggles">
            <label class="memory-toggle">
              <input type="checkbox" name="includeInactive"${state.filters.includeInactive ? ' checked' : ''}>
              <span>Include review-only entries</span>
            </label>
            <label class="memory-toggle">
              <input type="checkbox" name="includeCodeSessions"${state.filters.includeCodeSessions ? ' checked' : ''}>
              <span>Include code-session scopes</span>
            </label>
          </div>
          <div class="memory-toolbar-actions">
            <button type="submit" class="btn btn-primary btn-sm">Apply</button>
            <button type="button" class="btn btn-secondary btn-sm" data-memory-filter-reset>Reset</button>
          </div>
        </div>
      </form>
    </section>
  `;
}

function wireToolbar(container) {
  const form = container.querySelector('[data-memory-filter-form]');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    state.filters = {
      includeInactive: formData.get('includeInactive') === 'on',
      includeCodeSessions: formData.get('includeCodeSessions') === 'on',
      query: String(formData.get('query') || ''),
      sourceType: String(formData.get('sourceType') || ''),
      trustLevel: String(formData.get('trustLevel') || ''),
      status: String(formData.get('status') || ''),
      codeSessionId: String(formData.get('codeSessionId') || ''),
      limit: clampNumber(formData.get('limit'), 200, 1, 500),
    };
    await renderMemory(currentContainer);
  });
  container.querySelector('[data-memory-filter-reset]')?.addEventListener('click', async () => {
    state.filters = { ...DEFAULT_FILTERS };
    await renderMemory(currentContainer);
  });
}

function renderBrowseTab(panel, response) {
  const scopes = [response.global, ...(response.codeSessions || [])];
  const editableCount = scopes.filter((scope) => scope.editable).length;

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Browse Guide',
      ...MEMORY_HELP.tabs.browse,
    })}
    <section class="table-container memory-section">
      <div class="table-header">
        <div>
          ${renderSectionTitle('Scope snapshot', MEMORY_HELP.sections.scopeSnapshot)}
          <div class="table-muted">A compact read across every surfaced memory scope in the current filter window.</div>
        </div>
        <div class="memory-filter-meta">
          <span class="badge badge-info">${esc(String(scopes.length))} surfaced</span>
          <span class="badge badge-muted">${esc(String(editableCount))} editable</span>
        </div>
      </div>
      <div class="memory-surface-grid">
        ${scopes.map((scope) => renderScopeSummaryCard(scope)).join('')}
      </div>
    </section>
    <div class="memory-scope-stack">
      ${scopes.map((scope, index) => renderBrowseScopeSection(scope, index === 0)).join('')}
    </div>
  `;

  enhanceMemoryUi(panel);
}

function renderWikiTab(panel, response) {
  const scopes = [response.global, ...(response.codeSessions || [])];

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Wiki Guide',
      ...MEMORY_HELP.tabs.wiki,
    })}
    ${renderEditor(response)}
    ${scopes.map((scope) => renderWikiScopeSection(scope)).join('')}
  `;

  wireMemoryActions(panel, response);
  enhanceMemoryUi(panel);
}

function renderEntriesTab(panel, response) {
  const scopes = [response.global, ...(response.codeSessions || [])];

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Entries Guide',
      ...MEMORY_HELP.tabs.entries,
    })}
    ${scopes.map((scope) => renderEntriesScopeSection(scope)).join('')}
  `;

  wireMemoryActions(panel, response);
  enhanceMemoryUi(panel);
}

function renderLintTab(panel, response) {
  const scopes = [response.global, ...(response.codeSessions || [])];

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Lint Guide',
      ...MEMORY_HELP.tabs.lint,
    })}
    ${scopes.map((scope) => `
      <section class="table-container memory-section">
        <div class="table-header">
          <div>
            ${renderSectionTitle(scope.title, buildScopeHelp(scope, 'lint'))}
            <div class="table-muted">${esc(`${scope.lintFindings.length} hygiene finding${scope.lintFindings.length === 1 ? '' : 's'}`)}</div>
          </div>
          <div class="memory-toolbar-actions">
            ${scope.editable && scope.lintFindings.length > 0 ? `<button class="btn btn-secondary btn-sm" type="button" data-memory-run-cleanup data-scope="${escAttr(scope.scope)}" data-scope-id="${escAttr(scope.scopeId)}">Run cleanup</button>` : ''}
            <span class="badge ${scope.lintFindings.length > 0 ? 'badge-warning' : 'badge-ok'}">${esc(scope.lintFindings.length > 0 ? 'Needs review' : 'Clean')}</span>
          </div>
        </div>
        ${scope.lintFindings.length === 0
          ? '<div class="loading">No current hygiene findings.</div>'
          : `<div class="memory-lint-list">${scope.lintFindings.map((finding) => renderLintFinding(scope, finding)).join('')}</div>`}
      </section>
    `).join('')}
  `;

  wireMemoryActions(panel, response);
  enhanceMemoryUi(panel);
}

function renderAuditTab(panel, response) {
  const jobs = Array.isArray(response.recentJobs) ? response.recentJobs : [];
  const audit = Array.isArray(response.recentAudit) ? response.recentAudit : [];

  panel.innerHTML = `
    ${renderGuide({
      kicker: 'Audit Guide',
      ...MEMORY_HELP.tabs.audit,
    })}
    <section class="table-container memory-section">
      <div class="table-header">
        ${renderSectionTitle('Memory maintenance summary', MEMORY_HELP.sections.maintenanceSummary)}
      </div>
      <div class="memory-audit-grid">
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(response.maintenance?.scopeCount || 0))}</span>
          <span class="guide-stat-label">Surfaced scopes</span>
        </div>
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(response.maintenance?.wikiPageCount || 0))}</span>
          <span class="guide-stat-label">Wiki pages</span>
        </div>
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(response.maintenance?.recentMaintenanceCount || jobs.length))}</span>
          <span class="guide-stat-label">Recent jobs</span>
        </div>
        <div class="guide-stat">
          <span class="guide-stat-value">${esc(String(response.maintenance?.recentAuditCount || audit.length))}</span>
          <span class="guide-stat-label">Recent audit events</span>
        </div>
      </div>
      <div class="memory-audit-note">
        Memory hygiene runs stay bounded and inspectable. Curated page mutations are audit-visible and derived pages remain refreshable and read-only.
      </div>
    </section>

    <section class="table-container memory-section">
      <div class="table-header">
        ${renderSectionTitle('Recent memory maintenance jobs', MEMORY_HELP.sections.recentJobs)}
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Type</th>
              <th>Status</th>
              <th>Scope</th>
              <th>Artifact</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${jobs.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent memory maintenance jobs.</td></tr>'
              : jobs.map((job) => `
                <tr>
                  <td>${esc(formatDateTime(job.startedAt))}</td>
                  <td>${esc(job.type || '-')}</td>
                  <td><span class="badge ${badgeClassForStatus(job.status)}">${esc(job.status || '-')}</span></td>
                  <td>${esc(job.scope || '-')}</td>
                  <td>${esc(job.artifact || '-')}</td>
                  <td>${esc(job.detail || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <section class="table-container memory-section">
      <div class="table-header">
        ${renderSectionTitle('Recent memory audit events', MEMORY_HELP.sections.recentAudit)}
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Severity</th>
              <th>Type</th>
              <th>Scope</th>
              <th>Summary</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            ${audit.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent memory audit events.</td></tr>'
              : audit.map((event) => `
                <tr>
                  <td>${esc(formatDateTime(event.timestamp))}</td>
                  <td><span class="badge ${badgeClassForSeverity(event.severity)}">${esc(event.severity || '-')}</span></td>
                  <td>${esc(event.type || '-')}</td>
                  <td>${esc(event.scopeId || event.scope || '-')}</td>
                  <td>
                    <div>${esc(event.summary || '-')}</div>
                    <div class="table-muted">${esc(event.detail || '')}</div>
                  </td>
                  <td>${esc(event.actor || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;

  enhanceMemoryUi(panel);
}

function renderEditor(response) {
  if (!state.editor) return '';

  const title = state.editor.mode === 'create' ? 'Create curated page' : 'Edit curated page';
  const scopeOptions = [response.global, ...(response.codeSessions || [])]
    .map((scope) => `<option value="${escAttr(scope.scopeId)}"${state.editor.scopeId === scope.scopeId ? ' selected' : ''}>${esc(scope.title)}</option>`)
    .join('');

  return `
    <section class="table-container memory-section">
      <div class="table-header">
        <div>
          ${renderSectionTitle(title, MEMORY_HELP.sections.editor)}
          <div class="table-muted">Operator-authored pages persist in the structured memory store with audit-visible metadata.</div>
        </div>
      </div>
      <form class="memory-editor" data-memory-editor-form>
        <input type="hidden" name="mode" value="${escAttr(state.editor.mode)}">
        <input type="hidden" name="entryId" value="${escAttr(state.editor.entryId || '')}">
        ${state.editor.mode === 'update' ? `<input type="hidden" name="scopeId" value="${escAttr(state.editor.scopeId || '')}">` : ''}
        <label class="memory-field">
          <span>Scope</span>
          <select name="scopeId"${state.editor.mode === 'update' ? ' disabled' : ''}>
            ${scopeOptions}
          </select>
        </label>
        <label class="memory-field">
          <span>Title</span>
          <input type="text" name="title" value="${escAttr(state.editor.title || '')}" placeholder="Standing project notes">
        </label>
        <label class="memory-field">
          <span>Summary</span>
          <input type="text" name="summary" value="${escAttr(state.editor.summary || '')}" placeholder="Short retrieval-friendly gist">
        </label>
        <label class="memory-field">
          <span>Tags</span>
          <input type="text" name="tags" value="${escAttr(state.editor.tags || '')}" placeholder="project, preferences, glossary">
        </label>
        <label class="memory-field memory-editor-full">
          <span>Content</span>
          <textarea name="content" rows="10" placeholder="Enter the curated page body">${esc(state.editor.content || '')}</textarea>
        </label>
        <label class="memory-field memory-editor-full">
          <span>Reason</span>
          <input type="text" name="reason" value="${escAttr(state.editor.reason || '')}" placeholder="Why this page matters or why it changed">
        </label>
        <div class="memory-toolbar-actions memory-editor-actions">
          <button type="submit" class="btn btn-primary btn-sm">${esc(state.editor.mode === 'create' ? 'Create page' : 'Save changes')}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-memory-editor-cancel>Cancel</button>
        </div>
      </form>
    </section>
  `;
}

function renderScopeSummaryCard(scope) {
  const categories = Array.isArray(scope.summary?.categories) && scope.summary.categories.length > 0
    ? scope.summary.categories.slice(0, 3).join(', ')
    : 'No dominant categories';

  return `
    <article class="memory-surface-card">
      <div class="memory-surface-card__eyebrow">${esc(renderScopeTypeLabel(scope.scope))}</div>
      <h4>${esc(scope.title)}</h4>
      <p>${esc(scope.description || 'No scope description available.')}</p>
      <div class="memory-surface-card__stats">
        <span>${esc(`${scope.summary?.activeEntries || 0} active`)}</span>
        <span>${esc(`${(scope.wikiPages || []).length} pages`)}</span>
        <span>${esc(`${(scope.lintFindings || []).length} lint`)}</span>
      </div>
      <div class="memory-surface-card__footer">
        <span class="badge ${scope.editable ? 'badge-ok' : 'badge-muted'}">${esc(scope.editable ? 'Editable' : 'Read only')}</span>
        <span class="memory-surface-card__meta">${esc(categories)}</span>
      </div>
    </article>
  `;
}

function renderBrowseScopeSection(scope, open = false) {
  const categories = Array.isArray(scope.summary?.categories) && scope.summary.categories.length > 0
    ? scope.summary.categories.join(', ')
    : 'None';
  const lastUpdated = scope.summary?.lastCreatedAt ? formatDateTime(scope.summary.lastCreatedAt) : 'Unknown';

  return `
    <details class="security-collapsible memory-scope-details"${open ? ' open' : ''}>
      <summary title="${escAttr(`Open ${scope.title} scope details`)}">
        <span>${esc(scope.title)}</span>
        <span class="security-collapsible__summary-copy">${esc(renderScopeSummary(scope.summary))}</span>
      </summary>
      <div class="security-collapsible__content">
        <div class="memory-scope-detail-grid">
          <div>
            <p class="memory-scope-copy">${esc(scope.description || 'No scope description available.')}</p>
            <div class="guide-note">${esc(scope.editable ? 'Operator-curated pages can be created and maintained here.' : 'This scope is currently surfaced for review only.')}</div>
          </div>
          <div class="memory-scope-facts">
            <span class="badge badge-info">${esc(renderScopeTypeLabel(scope.scope))}</span>
            <span class="badge ${scope.editable ? 'badge-ok' : 'badge-muted'}">${esc(scope.editable ? 'Editable' : 'Read only')}</span>
            ${scope.reviewOnly ? '<span class="badge badge-warning">Review only</span>' : ''}
            <span class="badge badge-muted">${esc(`${scope.summary?.operatorEntries || 0} curated`)}</span>
            <span class="badge badge-muted">${esc(`${scope.summary?.derivedEntries || 0} derived`)}</span>
          </div>
        </div>
        <div class="memory-highlight-grid">
          ${renderHighlightPanel('Key facts', [
            `Last updated content: ${lastUpdated}`,
            `Categories: ${categories}`,
            `Wiki pages matching filters: ${(scope.wikiPages || []).length}`,
            `Lint findings: ${(scope.lintFindings || []).length}`,
          ])}
          ${renderHighlightPanel('Wiki highlights', (scope.wikiPages || []).slice(0, 3).map((page) => `${page.title} (${page.sourceClass}, ${page.status})`), 'No wiki pages match the current filters.')}
          ${renderHighlightPanel('Hygiene highlights', (scope.lintFindings || []).slice(0, 3).map((finding) => `${finding.title}: ${finding.detail}`), 'No hygiene findings for this scope.')}
        </div>
      </div>
    </details>
  `;
}

function renderHighlightPanel(title, items, emptyText = 'Nothing to show.') {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  return `
    <section class="memory-highlight-panel">
      <h5>${esc(title)}</h5>
      ${rows.length === 0
        ? `<div class="memory-highlight-empty">${esc(emptyText)}</div>`
        : `<ul class="memory-highlight-list">${rows.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`}
    </section>
  `;
}

function renderWikiPage(page) {
  const actionNote = renderMemoryActionNotice(
    page.sourceClass === 'operator_curated' ? 'Scope locked' : 'System-managed',
    page.sourceClass === 'operator_curated'
      ? 'This page can only be edited when the owning memory scope is writable.'
      : 'This page is maintained by the durable memory system, not directly edited from the operator wiki surface.',
  );
  return `
    <article class="guide-article memory-page-card">
      <header class="guide-article-header">
        <div>
          <h4>${esc(page.title)}</h4>
          <p class="guide-page-summary">${esc(page.summary || 'No summary')}</p>
        </div>
        <div class="memory-page-badges">
          <span class="badge badge-info">${esc(page.sourceClass)}</span>
          <span class="badge ${badgeClassForStatus(page.status)}">${esc(page.status)}</span>
          ${page.reviewOnly ? '<span class="badge badge-warning">Review only</span>' : ''}
        </div>
      </header>
      <div class="memory-page-meta">
        <span>${esc(page.kind.replace(/_/g, ' '))}</span>
        <span>${esc(formatDateTime(page.createdAt || 'unknown'))}</span>
        ${page.createdByPrincipal ? `<span>${esc(page.createdByPrincipal)}</span>` : ''}
      </div>
      <div class="memory-markdown">${renderMarkdown(page.renderedMarkdown || page.body || '')}</div>
      <div class="memory-toolbar-actions">
        ${page.editable ? `<button class="btn btn-secondary btn-sm" data-memory-edit-page data-entry-id="${escAttr(page.entryId || '')}" data-scope="${escAttr(page.scope)}" data-scope-id="${escAttr(page.scopeId)}">Edit</button>` : ''}
        ${page.editable ? `<button class="btn btn-secondary btn-sm" data-memory-archive-page data-entry-id="${escAttr(page.entryId || '')}" data-scope="${escAttr(page.scope)}" data-scope-id="${escAttr(page.scopeId)}">Archive</button>` : ''}
        ${page.editable ? '' : actionNote}
      </div>
    </article>
  `;
}

function renderEntryRow(scope, entry) {
  const actionNote = renderMemoryActionNotice(
    entry.sourceClass === 'operator_curated' ? 'Scope locked' : 'System-managed',
    entry.sourceClass === 'operator_curated'
      ? 'This entry belongs to a scope that is currently read only, so it cannot be changed here.'
      : 'This memory entry is maintained by memory pipelines or system flows. Only operator-curated memory pages can be edited or archived from the UI.',
  );
  return `
    <tr>
      <td>${esc(formatDateTime(entry.createdAt || '-'))}</td>
      <td>${esc(entry.displayTitle || 'Untitled')}</td>
      <td>${esc(entry.category || 'General')}</td>
      <td>
        <div>${esc(entry.sourceClass)}</div>
        <div class="table-muted">${esc(entry.sourceType || 'user')}</div>
      </td>
      <td><span class="badge ${badgeClassForStatus(entry.status)}">${esc(entry.status || 'active')}</span></td>
      <td>${esc(entry.trustLevel || 'trusted')}</td>
      <td>
        <div>${esc(entry.summary || summarizeContent(entry.content))}</div>
        <div class="table-muted">${esc(entry.reviewOnly ? 'Review only' : entry.editable ? 'Editable when authorized' : 'Read only')}</div>
      </td>
      <td class="config-provider-actions">
        ${entry.editable ? `<button class="btn btn-secondary btn-sm" data-memory-edit-page data-entry-id="${escAttr(entry.id)}" data-scope="${escAttr(scope.scope)}" data-scope-id="${escAttr(scope.scopeId)}">Edit</button>` : ''}
        ${entry.editable ? `<button class="btn btn-secondary btn-sm" data-memory-archive-page data-entry-id="${escAttr(entry.id)}" data-scope="${escAttr(scope.scope)}" data-scope-id="${escAttr(scope.scopeId)}">Archive</button>` : ''}
        ${entry.editable ? '' : actionNote}
      </td>
    </tr>
  `;
}

function renderLintFinding(scope, finding) {
  const relatedEntries = Array.isArray(finding.relatedEntries) ? finding.relatedEntries : [];
  const showHideInactive = finding.kind === 'review_queue' && state.filters.includeInactive;
  const showCleanupAction = scope.editable && (finding.kind === 'duplicate' || finding.kind === 'stale');
  return `
    <article class="memory-lint-card">
      <div class="memory-lint-head">
        <span class="badge ${badgeClassForSeverity(finding.severity)}">${esc(finding.severity)}</span>
        <strong>${esc(finding.title)}</strong>
      </div>
      <div class="table-muted">${esc(finding.kind.replace(/_/g, ' '))}</div>
      <p>${esc(finding.detail)}</p>
      ${showHideInactive || showCleanupAction
        ? `
          <div class="memory-lint-actions">
            ${showCleanupAction ? `<button class="btn btn-secondary btn-sm" type="button" data-memory-run-cleanup data-scope="${escAttr(scope.scope)}" data-scope-id="${escAttr(scope.scopeId)}">Run cleanup</button>` : ''}
            ${showHideInactive ? '<button class="btn btn-secondary btn-sm" type="button" data-memory-hide-inactive="true">Hide review-only</button>' : ''}
          </div>
        `
        : ''}
      ${relatedEntries.length > 0
        ? `
          <div class="memory-lint-entry-list">
            ${relatedEntries.map((entry) => renderLintRelatedEntry(scope, entry)).join('')}
          </div>
        `
        : (Array.isArray(finding.entryIds) && finding.entryIds.length > 0 ? `<div class="table-muted">${esc(`Entries: ${finding.entryIds.join(', ')}`)}</div>` : '')}
    </article>
  `;
}

function renderLintRelatedEntry(scope, entry) {
  return `
    <div class="memory-lint-entry">
      <div class="memory-lint-entry-copy">
        <strong>${esc(entry.title)}</strong>
        <span>${esc(`${entry.sourceClass.replace(/_/g, ' ')} · ${entry.status}${entry.reviewOnly ? ' · review only' : ''}`)}</span>
      </div>
      <div class="memory-toolbar-actions">
        ${entry.editable ? `<button class="btn btn-secondary btn-sm" type="button" data-memory-edit-page data-entry-id="${escAttr(entry.id)}" data-scope="${escAttr(scope.scope)}" data-scope-id="${escAttr(scope.scopeId)}">Edit</button>` : ''}
        ${entry.editable ? `<button class="btn btn-secondary btn-sm" type="button" data-memory-archive-page data-entry-id="${escAttr(entry.id)}" data-scope="${escAttr(scope.scope)}" data-scope-id="${escAttr(scope.scopeId)}">Archive</button>` : ''}
        ${entry.editable ? '' : renderMemoryActionNotice(
          entry.reviewOnly ? 'Review only' : 'System-managed',
          entry.reviewOnly
            ? 'This entry is already inactive. Hide review-only entries if you do not want it surfaced in the current view.'
            : 'This entry is system-managed. Use Run cleanup for bounded duplicate/stale cleanup, or inspect it from Entries if you need more detail.',
        )}
      </div>
    </div>
  `;
}

function renderMemoryActionNotice(label, message) {
  return `<span class="memory-action-note" title="${escAttr(message)}" aria-label="${escAttr(message)}">${esc(label)}</span>`;
}

function renderWikiScopeSection(scope) {
  const editablePages = scope.wikiPages.filter((page) => page.editable);
  const managedPages = scope.wikiPages.filter((page) => !page.editable);

  return `
    <section class="table-container memory-section">
      <div class="table-header">
        <div>
          ${renderSectionTitle(scope.title, buildScopeHelp(scope, 'wiki'))}
          <div class="table-muted">${esc(scope.scope === 'global' ? 'Global durable memory wiki surface' : 'Code-session durable memory wiki surface')}</div>
        </div>
        <div class="memory-toolbar-actions">
          <span class="badge badge-muted">${esc(`${scope.wikiPages.length} page${scope.wikiPages.length === 1 ? '' : 's'}`)}</span>
          ${scope.editable ? `<button class="btn btn-primary btn-sm" data-memory-new-page data-scope="${escAttr(scope.scope)}" data-scope-id="${escAttr(scope.scopeId)}">New curated page</button>` : ''}
          <span class="badge ${scope.editable ? 'badge-info' : 'badge-muted'}">${esc(scope.editable ? 'Editable scope' : 'Read only')}</span>
        </div>
      </div>
      <div class="memory-split-intro">
        Operator-curated pages stay expanded. System-managed surfaces are grouped below so the editable wiki stays readable.
      </div>
      ${editablePages.length === 0
        ? '<div class="loading">No operator-curated pages match the current filters.</div>'
        : `<div class="memory-page-grid">${editablePages.map((page) => renderWikiPage(page)).join('')}</div>`}
      ${managedPages.length > 0
        ? renderMemoryCollapsible(
          'Surfaced system-managed pages',
          `<div class="memory-page-grid">${managedPages.map((page) => renderWikiPage(page)).join('')}</div>`,
          {
            summary: `${managedPages.length} page${managedPages.length === 1 ? '' : 's'} maintained by derived or canonical memory flows`,
          },
        )
        : ''}
    </section>
  `;
}

function renderEntriesScopeSection(scope) {
  const editableEntries = scope.entries.filter((entry) => entry.editable);
  const managedEntries = scope.entries.filter((entry) => !entry.editable);

  return `
    <section class="table-container memory-section">
      <div class="table-header">
        <div>
          ${renderSectionTitle(scope.title, buildScopeHelp(scope, 'entries'))}
          <div class="table-muted">Canonical entries, derived artifacts, operator-curated pages, linked outputs, and review-only records.</div>
        </div>
        <div class="memory-filter-meta">
          <span class="badge badge-muted">${esc(`${scope.entries.length} record${scope.entries.length === 1 ? '' : 's'}`)}</span>
          <span class="badge badge-info">${esc(`${editableEntries.length} curated`)}</span>
        </div>
      </div>
      <div class="memory-split-intro">
        Operator-curated entries stay in the main table. System-managed artifacts are still available, but tucked into a collapsed section.
      </div>
      ${renderEntryTable(scope, editableEntries, 'No operator-curated entries match the current filters.')}
      ${managedEntries.length > 0
        ? renderMemoryCollapsible(
          'Surfaced system-managed artifacts',
          renderEntryTable(scope, managedEntries, 'No system-managed artifacts match the current filters.'),
          {
            summary: `${managedEntries.length} record${managedEntries.length === 1 ? '' : 's'} maintained by the durable memory system`,
          },
        )
        : ''}
    </section>
  `;
}

function renderEntryTable(scope, entries, emptyMessage) {
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Created</th>
            <th>Title</th>
            <th>Category</th>
            <th>Source</th>
            <th>Status</th>
            <th>Trust</th>
            <th>Summary</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${entries.length === 0
            ? `<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">${esc(emptyMessage)}</td></tr>`
            : entries.map((entry) => renderEntryRow(scope, entry)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderMemoryCollapsible(title, content, options = {}) {
  return `
    <details class="security-collapsible memory-collapsible"${options.open ? ' open' : ''}>
      <summary>
        <span>${esc(title)}</span>
        ${options.summary ? `<span class="security-collapsible__summary-copy">${esc(options.summary)}</span>` : ''}
      </summary>
      <div class="security-collapsible__content">${content}</div>
    </details>
  `;
}

function wireMemoryActions(panel, response) {
  panel.querySelectorAll('[data-memory-run-cleanup]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api.memoryMaintenance({
          scope: button.dataset.scope || 'global',
          codeSessionId: button.dataset.scope === 'code_session' ? button.dataset.scopeId : undefined,
          actor: 'web-user',
        });
        await renderMemory(currentContainer);
        if (result?.message) {
          window.alert(String(result.message));
        }
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
      }
    });
  });

  panel.querySelectorAll('[data-memory-hide-inactive]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.filters.includeInactive = false;
      await renderMemory(currentContainer);
    });
  });

  panel.querySelectorAll('[data-memory-new-page]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editor = {
        mode: 'create',
        scope: button.dataset.scope || 'global',
        scopeId: button.dataset.scopeId || response.global.scopeId,
        entryId: '',
        title: '',
        summary: '',
        tags: '',
        content: '',
        reason: '',
      };
      state.activeTab = 'wiki';
      void renderMemory(currentContainer);
    });
  });

  panel.querySelectorAll('[data-memory-edit-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const page = findEditablePage(response, button.dataset.scopeId, button.dataset.entryId);
      if (!page) return;
      state.editor = {
        mode: 'update',
        scope: page.scope,
        scopeId: page.scopeId,
        entryId: page.entryId || '',
        title: page.title || '',
        summary: page.summary || '',
        tags: Array.isArray(page.tags) ? page.tags.join(', ') : '',
        content: page.body || '',
        reason: page.reason || '',
      };
      state.activeTab = 'wiki';
      void renderMemory(currentContainer);
    });
  });

  panel.querySelectorAll('[data-memory-archive-page]').forEach((button) => {
    button.addEventListener('click', async () => {
      const page = findEditablePage(response, button.dataset.scopeId, button.dataset.entryId);
      if (!page || !page.entryId) return;
      if (!window.confirm(`Archive curated page "${page.title}"?`)) return;
      try {
        await api.memoryCurate({
          action: 'archive',
          scope: page.scope,
          codeSessionId: page.scope === 'code_session' ? page.scopeId : undefined,
          entryId: page.entryId,
          reason: state.editor?.entryId === page.entryId ? state.editor.reason : '',
        });
        if (state.editor?.entryId === page.entryId) {
          state.editor = null;
        }
        await renderMemory(currentContainer);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      }
    });
  });

  panel.querySelector('[data-memory-editor-cancel]')?.addEventListener('click', async () => {
    state.editor = null;
    await renderMemory(currentContainer);
  });

  panel.querySelector('[data-memory-editor-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const scopeId = String(formData.get('scopeId') || '');
    const scope = scopeId === response.global.scopeId ? 'global' : 'code_session';
    try {
      await api.memoryCurate({
        action: String(formData.get('mode') || 'create'),
        scope,
        codeSessionId: scope === 'code_session' ? scopeId : undefined,
        entryId: String(formData.get('entryId') || ''),
        title: String(formData.get('title') || ''),
        summary: String(formData.get('summary') || ''),
        content: String(formData.get('content') || ''),
        tags: parseCommaList(String(formData.get('tags') || '')),
        reason: String(formData.get('reason') || ''),
      });
      state.editor = null;
      state.activeTab = 'wiki';
      await renderMemory(currentContainer);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  });
}

function findEditablePage(response, scopeId, entryId) {
  return [response.global, ...(response.codeSessions || [])]
    .flatMap((scope) => scope.wikiPages || [])
    .find((page) => page.scopeId === scopeId && page.entryId === entryId);
}

function buildScopeHelp(scope, surface) {
  const scopeLabel = scope.scope === 'global' ? 'the global durable memory scope' : 'a code-session durable memory scope';
  const surfaceCopy = surface === 'wiki'
    ? `${scope.title} is ${scopeLabel}'s wiki surface.`
    : surface === 'entries'
      ? `${scope.title} is ${scopeLabel}'s record-level memory table.`
      : `${scope.title} is ${scopeLabel}'s hygiene review surface.`;
  const seeingCopy = surface === 'wiki'
    ? `You are seeing ${scope.wikiPages.length} wiki page${scope.wikiPages.length === 1 ? '' : 's'} matching the current filters.`
    : surface === 'entries'
      ? `You are seeing ${scope.entries.length} matching durable memory record${scope.entries.length === 1 ? '' : 's'}.`
      : `You are seeing ${scope.lintFindings.length} hygiene finding${scope.lintFindings.length === 1 ? '' : 's'} for this scope.`;
  const actionCopy = surface === 'wiki'
    ? (scope.editable ? 'Create, edit, or archive operator-curated pages here.' : 'Review surfaced pages only; this scope is not currently editable.')
    : surface === 'entries'
      ? (scope.editable ? 'Use the row actions when you need to jump from raw records back into guarded curation.' : 'Inspect the underlying records and their state without modifying them here.')
      : (scope.editable
        ? 'Use lint findings to run bounded cleanup, archive editable curated pages, or hide already-inactive review items.'
        : 'Use lint findings to decide what should be cleaned up, then review the scope because it is not currently writable.');
  const linkCopy = scope.scope === 'global'
    ? 'Changes here affect the shared durable memory surface used outside individual coding sessions.'
    : 'Changes and findings here stay attached to this code-session memory scope.';

  return {
    title: scope.title,
    whatItIs: surfaceCopy,
    whatSeeing: `${seeingCopy} Summary: ${renderScopeSummary(scope.summary)}.`,
    whatCanDo: actionCopy,
    howLinks: linkCopy,
  };
}

function renderScopeTypeLabel(scope) {
  return scope === 'global' ? 'Global scope' : 'Code session scope';
}

function renderScopeSummary(summary) {
  if (!summary) return 'No summary available.';
  return `${summary.activeEntries || 0} active, ${summary.quarantinedEntries || 0} quarantined, ${summary.operatorEntries || 0} operator-curated, ${summary.derivedEntries || 0} derived`;
}

function summarizeContent(content) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized || 'No content';
}

function renderMarkdown(markdown) {
  return `<pre>${esc(markdown || '')}</pre>`;
}

function badgeClassForStatus(status) {
  switch (status) {
    case 'active': return 'badge-ok';
    case 'quarantined': return 'badge-warning';
    case 'failed':
    case 'rejected': return 'badge-error';
    case 'running': return 'badge-info';
    default: return 'badge-muted';
  }
}

function badgeClassForSeverity(severity) {
  switch (severity) {
    case 'critical': return 'badge-error';
    case 'warn': return 'badge-warning';
    case 'info': return 'badge-info';
    default: return 'badge-muted';
  }
}

function renderSelectOptions(options, selected) {
  return options.map(([value, label]) => `
    <option value="${escAttr(value)}"${selected === value ? ' selected' : ''}>${esc(label)}</option>
  `).join('');
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function parseCommaList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function emptyScope(scope, scopeId, title) {
  return {
    scope,
    scopeId,
    title,
    description: '',
    editable: false,
    reviewOnly: false,
    summary: {
      activeEntries: 0,
      inactiveEntries: 0,
      quarantinedEntries: 0,
      operatorEntries: 0,
      derivedEntries: 0,
      contextFlushEntries: 0,
      categories: [],
      lastCreatedAt: undefined,
    },
    entries: [],
    wikiPages: [],
    lintFindings: [],
    renderedMarkdown: '',
  };
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}
