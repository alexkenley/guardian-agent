/**
 * Automations page — unified view for saved automations and starter examples.
 *
 * Every row represents one automation definition: a step-based automation,
 * an assistant automation, or a built-in starter example that can be used as
 * the basis for a saved automation.
 */

import { api } from '../api.js';
import { onSSE, offSSE } from '../app.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { normalizeRunTimelineContextAssembly, renderRunTimelineContextAssembly } from '../components/run-timeline-context.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';

let currentContainer = null;
let runTimelineHandler = null;
let runTimelineRefreshTimer = null;
let automationsRenderSequence = 0;
const automationUiState = {
  placement: null,
  activeTab: 'catalog',
  tabs: null,
  timelineFilters: {
    continuityKey: '',
    activeExecutionRef: '',
  },
};

const AUTOMATION_HELP = {
  'Automation Catalog': {
    whatItIs: 'This section is the system of record for saved automations, schedules, and built-in starter examples.',
    whatSeeing: 'You are seeing one row per automation, including its type, linked tools or steps, schedule state, enablement, and the actions available for editing, copying, running, or deleting it.',
    whatCanDo: 'Create a new automation, edit an existing one, use a starter example, run it immediately, or review whether it already has a schedule attached.',
    howLinks: 'Other pages can deep-link here, but this catalog is still the canonical place where automation definitions and schedule ownership live.',
  },
  Output: {
    whatItIs: 'This section is the operator-facing output view for recent automation runs.',
    whatSeeing: 'You are seeing each recent run with a readable run-result summary first, followed by expandable per-step output and any promoted findings.',
    whatCanDo: 'Use it to answer what the automation actually found or produced without digging through raw step JSON unless you need deeper inspection.',
    howLinks: 'This is the detailed evidence side of automation execution; the adjacent history and timeline tab keeps the chronological execution story.',
  },
  'History & Timeline': {
    whatItIs: 'This tab combines the chronological automation run ledger with the automation execution timeline.',
    whatSeeing: 'You are seeing recent automation runs as a compact history table plus the automation execution timeline that reconstructs what happened during each workflow run.',
    whatCanDo: 'Use it when you want the operational story of an automation run first, then drill into Output for the detailed result payload.',
    howLinks: 'History shows when and how automation runs finished; Output shows what those runs actually produced. System owns the broader assistant and routine execution detail outside automation runs.',
  },
  'Engine Settings': {
    whatItIs: 'This section contains the runtime-level controls for the automation engine itself rather than one specific automation.',
    whatSeeing: 'You are seeing the collapsible engine configuration area for execution mode, studio behavior, and engine-wide operating settings.',
    whatCanDo: 'Change how the automation engine behaves globally without editing every automation individually.',
    howLinks: 'These settings affect how automations run in general, while the catalog above still owns the definition of each specific automation.',
  },
};

function normalizeOutputHandling(outputHandling) {
  return {
    notify: outputHandling?.notify || 'off',
    sendToSecurity: outputHandling?.sendToSecurity || 'off',
    persistArtifacts: outputHandling?.persistArtifacts || 'run_history_plus_memory',
  };
}

function getRequestedRunId() {
  const raw = window.location.hash || '';
  const [, query = ''] = raw.split('?');
  return new URLSearchParams(query).get('runId') || '';
}

function getRequestedAssistantRunId() {
  const raw = window.location.hash || '';
  const [, query = ''] = raw.split('?');
  return new URLSearchParams(query).get('assistantRunId') || '';
}

function getRequestedAssistantRunItemId() {
  const raw = window.location.hash || '';
  const [, query = ''] = raw.split('?');
  return new URLSearchParams(query).get('assistantRunItemId') || '';
}

function normalizeAutomationTab(tab) {
  return tab === 'catalog' || tab === 'output' || tab === 'history'
    ? tab
    : 'catalog';
}

function normalizeTimelineFilterValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildAssistantRunQueryParams(limit = 15) {
  const continuityKey = normalizeTimelineFilterValue(automationUiState.timelineFilters?.continuityKey);
  const activeExecutionRef = normalizeTimelineFilterValue(automationUiState.timelineFilters?.activeExecutionRef);
  return {
    limit,
    kind: 'automation_run',
    ...(continuityKey ? { continuityKey } : {}),
    ...(activeExecutionRef ? { activeExecutionRef } : {}),
  };
}

// ─── Public API ───────────────────────────────────────────

async function renderAutomationsPreserveScroll(container) {
  const scrollParent = document.getElementById('content') || container.parentElement || document.documentElement;
  const savedScroll = scrollParent.scrollTop;
  await renderAutomations(container, { preserveExisting: true });
  requestAnimationFrame(() => { scrollParent.scrollTop = savedScroll; });
}

function setAutomationActionStatus(container, message, tone = 'info') {
  const statusEl = container.querySelector('#auto-create-status');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.style.color = tone === 'error'
    ? 'var(--error)'
    : tone === 'success'
      ? 'var(--success)'
      : tone === 'warning'
        ? 'var(--warning)'
        : 'var(--text-muted)';
}

function requireAutomationMutationSuccess(result, fallbackMessage) {
  if (result && typeof result.success === 'boolean' && result.success === false) {
    throw new Error(result.message || fallbackMessage);
  }
  return result;
}

export async function renderAutomations(container, options = {}) {
  currentContainer = container;
  const preserveExisting = options?.preserveExisting === true;
  const renderSequence = ++automationsRenderSequence;
  if (!preserveExisting || !container.hasChildNodes()) {
    container.innerHTML = '<div class="loading">Loading...</div>';
  } else {
    container.setAttribute('aria-busy', 'true');
    container.dataset.liveRefreshing = 'true';
  }

  try {
    const [connState, toolsState, automationCatalog, automationHistory, agentsState, assistantRuns] = await Promise.all([
      api.connectorsState(40),
      api.toolsState(500).catch(() => ({ tools: [] })),
      api.automationsCatalog().catch(() => []),
      api.automationRunHistory().catch(() => []),
      api.agents().catch(() => []),
      api.assistantRuns(buildAssistantRunQueryParams(15)).catch(() => ({ runs: [] })),
    ]);

    const summary = connState.summary || {};
    const packs = connState.packs || [];
    const workflowConfig = connState.playbooksConfig || {};
    const studio = connState.studio || {};
    const tools = Array.isArray(toolsState?.tools) ? toolsState.tools : [];
    const agents = Array.isArray(agentsState) ? agentsState : [];

    const automations = reorderAutomationsForUi(
      normalizeAutomationViews(Array.isArray(automationCatalog) ? automationCatalog : []),
    );
    const allCategories = [...new Set(automations.map((a) => a.category))].sort();
    const totalScheduled = automations.filter((a) => a.cron).length;
    const totalRuns = Number(summary.runCount || 0) + automations.reduce((sum, automation) => sum + (automation.runCount || 0), 0);

    const requestedRunId = getRequestedRunId();
    const requestedAssistantRunId = getRequestedAssistantRunId();
    const requestedAssistantRun = requestedAssistantRunId
      ? await api.assistantRun(requestedAssistantRunId).catch(() => null)
      : null;
    const recentAssistantRuns = normalizeAssistantRuns(
      Array.isArray(assistantRuns?.runs) ? assistantRuns.runs : [],
      requestedAssistantRun,
    );
    const defaultTab = requestedRunId
      ? 'output'
      : requestedAssistantRunId
        ? 'history'
      : normalizeAutomationTab(automationUiState.activeTab);

    if (renderSequence !== automationsRenderSequence || currentContainer !== container) {
      return;
    }

    container.innerHTML = '<div id="auto-tabs-host"></div>';

    const tabsHost = container.querySelector('#auto-tabs-host');
    const tabDefs = [
      {
        id: 'catalog',
        label: 'Automation Catalog',
        tooltip: 'Create, edit, schedule, run, and manage saved automations and starter examples.',
        render: (panel) => {
          panel.innerHTML = renderCatalogTabContent({
            automations,
            allCategories,
            tools,
            packs,
            agents,
            summary,
            workflowConfig,
            studio,
            totalScheduled,
            totalRuns,
          });
        },
      },
      {
        id: 'output',
        label: 'Output',
        tooltip: 'See the actual results and step output from recent automation runs.',
        render: (panel) => {
          panel.innerHTML = renderOutputTabContent(automationHistory);
        },
      },
      {
        id: 'history',
        label: 'History & Timeline',
        tooltip: 'Review the chronological run ledger and the execution timeline.',
        render: (panel) => {
          panel.innerHTML = renderHistoryTabContent(automationHistory, recentAssistantRuns);
        },
      },
    ];

    if (tabsHost) {
      automationUiState.tabs = createTabs(tabsHost, tabDefs, defaultTab);
      for (const tab of tabDefs) {
        automationUiState.tabs.switchTo(tab.id);
      }
      automationUiState.tabs.switchTo(defaultTab);
      automationUiState.activeTab = defaultTab;
      tabsHost.addEventListener('click', () => {
        window.setTimeout(() => {
          automationUiState.activeTab = normalizeAutomationTab(tabsHost.dataset.activeTab);
        }, 0);
      });
    }

    bindEvents(container, { automations, tools, packs, workflowConfig, summary, studio, agents });
    bindRunTimelineUpdates();
    focusRequestedRun(container);
    applyInputTooltips(container);
    enhanceSectionHelp(container, AUTOMATION_HELP, createGenericHelpFactory('Automations'));
    activateContextHelp(container);
  } catch (err) {
    if (renderSequence !== automationsRenderSequence || currentContainer !== container) {
      return;
    }
    if (preserveExisting && container.hasChildNodes()) {
      console.warn('Failed to refresh Automations page live view:', err);
      return;
    }
    container.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  } finally {
    if (renderSequence === automationsRenderSequence && currentContainer === container) {
      container.removeAttribute('aria-busy');
      delete container.dataset.liveRefreshing;
    }
  }
}

export async function updateAutomations(container = currentContainer, options = {}) {
  const target = container || currentContainer;
  if (target) await renderAutomations(target, { ...options, preserveExisting: true });
}

function renderCatalogTabContent({
  automations,
  allCategories,
  tools,
  packs,
  agents,
  summary,
  workflowConfig,
  studio,
  totalScheduled,
  totalRuns,
}) {
  return `
    ${renderAutomationPageGuide()}
    <div class="intel-summary-grid">
      <div class="status-card ${summary.enabled ? 'success' : 'warning'}">
        <div class="card-title">Engine Status</div>
        <div class="card-value">${summary.enabled ? 'Enabled' : 'Disabled'}</div>
        <div class="card-subtitle">Mode: ${esc(summary.executionMode || 'plan_then_execute')}</div>
      </div>
      <div class="status-card info">
        <div class="card-title">Total Automations</div>
        <div class="card-value">${automations.length}</div>
        <div class="card-subtitle">${automations.filter((a) => a.enabled).length} enabled</div>
      </div>
      <div class="status-card accent">
        <div class="card-title">Scheduled</div>
        <div class="card-value">${totalScheduled}</div>
        <div class="card-subtitle">${totalScheduled} with cron</div>
      </div>
      <div class="status-card warning">
        <div class="card-title">Total Runs</div>
        <div class="card-value">${totalRuns}</div>
      </div>
    </div>
    <div class="table-container">
      <div class="table-header">
        <h3>Automation Catalog</h3>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <button class="btn btn-primary" id="auto-create-toggle">Create Automation</button>
          <button class="btn btn-secondary" id="auto-refresh">Refresh</button>
        </div>
      </div>

      ${allCategories.length > 1 ? `
      <div class="wf-category-bar" id="auto-category-filter">
        <button class="wf-category-chip active" data-category="all">All</button>
        ${allCategories.map((cat) => {
          const count = automations.filter((a) => a.category === cat).length;
          return `<button class="wf-category-chip" data-category="${escAttr(cat)}">${esc(cat)} <span class="wf-category-count">${count}</span></button>`;
        }).join('')}
      </div>
      ` : ''}

      <div style="padding:0.5rem 1rem;">
        <input type="text" id="auto-catalog-search" placeholder="Search automations..." style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-input);border:1px solid var(--border);border-radius:0;color:var(--text-primary);font-size:0.8rem;">
      </div>

      <div class="cfg-center-body" id="auto-create-form" style="display:none">
        ${renderCreateForm(tools, packs, agents)}
      </div>

      <table id="auto-catalog-table">
        <thead><tr>
          <th class="auto-sortable" data-sort="name" style="cursor:pointer;">Name <span class="auto-sort-arrow"></span></th>
          <th class="auto-sortable" data-sort="type" style="cursor:pointer;">Type <span class="auto-sort-arrow"></span></th>
          <th>Tools</th>
          <th class="auto-sortable" data-sort="schedule" style="cursor:pointer;">Schedule <span class="auto-sort-arrow"></span></th>
          <th class="auto-sortable" data-sort="status" style="cursor:pointer;">Status <span class="auto-sort-arrow"></span></th>
          <th>Actions</th>
        </tr></thead>
        <tbody>
          ${automations.length === 0
            ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No automations configured.</td></tr>'
            : automations.map((auto) => renderAutomationRow(auto, tools, packs)).join('')
          }
        </tbody>
      </table>
    </div>

    <div class="table-container">
      <div class="table-header" style="cursor:pointer" id="auto-engine-toggle">
        <h3>Engine Settings</h3>
        <span id="auto-engine-arrow" style="font-size:0.85rem;color:var(--text-muted)">&#9654; Show</span>
      </div>
      <div id="auto-engine-panel" style="display:none">
        ${renderEngineSettings(summary, workflowConfig, studio, packs)}
      </div>
    </div>
  `;
}

function renderOutputTabContent(history) {
  return `
    ${renderAutomationTabGuide('Output', AUTOMATION_HELP.Output)}
    <div class="table-container">
      <div class="table-header"><h3>Output</h3></div>
      <div id="auto-run-results" style="padding:0 1rem 1rem"></div>
      <table id="auto-output-table">
        <thead><tr><th>Time</th><th>Automation</th><th>Source</th><th>Status</th><th>Duration</th><th>Output</th></tr></thead>
        <tbody>
          ${renderRunHistory(history)}
        </tbody>
      </table>
    </div>
  `;
}

function renderHistoryTabContent(history, recentAssistantRuns) {
  const continuityKey = normalizeTimelineFilterValue(automationUiState.timelineFilters?.continuityKey);
  const activeExecutionRef = normalizeTimelineFilterValue(automationUiState.timelineFilters?.activeExecutionRef);
  return `
    ${renderAutomationTabGuide('History & Timeline', AUTOMATION_HELP['History & Timeline'])}
    <div class="table-container">
      <div class="table-header"><h3>History & Timeline</h3></div>
      <table id="auto-history-table">
        <thead><tr><th>Time</th><th>Automation</th><th>Source</th><th>Status</th><th>Duration</th><th>Summary</th></tr></thead>
        <tbody>
          ${renderCompactRunHistory(history)}
        </tbody>
      </table>
    </div>

    <div class="table-container">
      <div class="table-header">
        <h3>Automation Execution</h3>
        <div class="ops-task-sub">Filter automation runs by continuity thread or active execution ref.</div>
      </div>
      <form id="auto-execution-filter-form" style="padding:0 1rem 1rem;display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end">
        <div class="cfg-field" style="flex:1 1 16rem;min-width:14rem;margin:0">
          <label for="auto-timeline-continuity-key">Continuity Key</label>
          <input id="auto-timeline-continuity-key" type="text" placeholder="continuity-123" value="${escAttr(continuityKey)}">
        </div>
        <div class="cfg-field" style="flex:1 1 16rem;min-width:14rem;margin:0">
          <label for="auto-timeline-active-exec-ref">Active Execution Ref</label>
          <input id="auto-timeline-active-exec-ref" type="text" placeholder="code_session:Repo Fix" value="${escAttr(activeExecutionRef)}">
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
          <button class="btn btn-secondary btn-sm" type="button" id="auto-execution-filter-clear">Clear</button>
        </div>
      </form>
      <table id="auto-execution-timeline-table">
        <thead><tr><th>Time</th><th>Run</th><th>Kind</th><th>Status</th><th>Owner</th><th>Timeline</th></tr></thead>
        <tbody>
          ${renderExecutionTimeline(recentAssistantRuns)}
        </tbody>
      </table>
    </div>
  `;
}

function renderAutomationPageGuide() {
  return renderGuidancePanel({
    kicker: 'Automation Guide',
    compact: true,
    title: 'Automations, output, history, and automation execution',
    whatItIs: 'Automations is the page where Guardian automations are defined, scheduled, executed, and reviewed.',
    whatSeeing: 'You are seeing the saved automation catalog, a dedicated output view for recent runs, a history and automation execution tab, engine-level settings, and the controls for creating or updating automations.',
    whatCanDo: 'Build new automations, use starter examples, attach schedules, run them on demand, inspect prior output, and reconstruct execution history without leaving this page.',
    howLinks: 'Other pages can point you here for cloud, network, or threat-intel automations, but this page remains the owner of automation definition, run output, and automation execution history. System owns the broader assistant and routine runtime timeline.',
  });
}

function renderAutomationTabGuide(kicker, help = {}) {
  return renderGuidancePanel({
    kicker,
    compact: true,
    whatItIs: help.whatItIs,
    whatSeeing: help.whatSeeing,
    whatCanDo: help.whatCanDo,
    howLinks: help.howLinks,
  });
}

function bindRunTimelineUpdates() {
  if (runTimelineHandler) {
    offSSE('run.timeline', runTimelineHandler);
  }
  runTimelineHandler = () => {
    if (!currentContainer || !window.location.hash.startsWith('#/automations')) return;
    if (runTimelineRefreshTimer) {
      window.clearTimeout(runTimelineRefreshTimer);
    }
    runTimelineRefreshTimer = window.setTimeout(() => {
      runTimelineRefreshTimer = null;
      void renderAutomationsPreserveScroll(currentContainer);
    }, 400);
  };
  onSSE('run.timeline', runTimelineHandler);
}

function focusRequestedRun(container) {
  const runId = getRequestedRunId();
  if (runId) {
    automationUiState.tabs?.switchTo('output');
    automationUiState.activeTab = 'output';
    const row = container.querySelector(`#auto-run-detail-${CSS.escape(runId)}`);
    const trigger = container.querySelector(`.auto-run-details[data-run-id="${CSS.escape(runId)}"]`);
    if ((row instanceof HTMLElement) && (trigger instanceof HTMLElement)) {
      row.style.display = '';
      trigger.textContent = 'Hide Output';
      trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }

  const assistantRunId = getRequestedAssistantRunId();
  if (!assistantRunId) return;
  automationUiState.tabs?.switchTo('history');
  automationUiState.activeTab = 'history';
  const assistantRunItemId = getRequestedAssistantRunItemId();
  if (assistantRunItemId) {
    const itemEl = container.querySelector(`#auto-execution-item-${CSS.escape(assistantRunItemId)}`);
    if (itemEl instanceof HTMLElement) {
      itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
  const timelineRow = container.querySelector(`#auto-execution-run-${CSS.escape(assistantRunId)}`);
  if (timelineRow instanceof HTMLElement) {
    timelineRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function reorderAutomationsForUi(automations) {
  const placement = automationUiState.placement;
  if (!placement) return automations;

  if (!placement.anchorId) return automations;
  const cloneIndex = automations.findIndex((auto) => auto.id === placement.automationId);
  const anchorIndex = automations.findIndex((auto) => auto.id === placement.anchorId);
  if (cloneIndex === -1 || anchorIndex === -1) return automations;

  const reordered = automations.slice();
  const [cloned] = reordered.splice(cloneIndex, 1);
  const nextAnchorIndex = reordered.findIndex((auto) => auto.id === placement.anchorId);
  reordered.splice(nextAnchorIndex + 1, 0, cloned);
  return reordered;
}

function createGenericHelpFactory(area) {
  return () => null;
}

// ─── Data Model — backend-owned automation catalog view ──────

function normalizeAutomationViews(entries) {
  return (entries || []).map((entry) => ({
    ...entry,
    category: entry.category || 'uncategorized',
    kind: entry.kind || 'single',
    mode: entry.mode || 'sequential',
    steps: Array.isArray(entry.steps) ? entry.steps : [],
    enabled: entry.enabled !== false,
    cron: entry.cron || null,
    runOnce: entry.runOnce === true,
    emitEvent: entry.emitEvent || '',
    outputHandling: normalizeOutputHandling(entry.outputHandling),
    scheduleEnabled: entry.scheduleEnabled === true,
    taskId: entry.taskId || null,
    lastRunAt: typeof entry.lastRunAt === 'number' ? entry.lastRunAt : null,
    lastRunStatus: typeof entry.lastRunStatus === 'string' ? entry.lastRunStatus : null,
    runCount: typeof entry.runCount === 'number' ? entry.runCount : 0,
    sourceKind: entry.sourceKind || 'task',
    builtin: entry.builtin === true,
    workflow: entry.workflow || null,
    task: entry.task || null,
    agentPrompt: entry.agentPrompt || '',
    agentChannel: entry.agentChannel || 'scheduled',
    agentDeliver: entry.agentDeliver !== false,
  }));
}

// ─── Rendering helpers ──────────────────────────────────

function renderAutomationRow(auto, tools, packs) {
  const isBuiltin = auto.builtin === true;
  const steps = auto.steps || [];
  const isAssistant = auto.kind === 'assistant';
  const kindLabel = isAssistant ? 'Assistant' : auto.kind === 'pipeline' ? 'Pipeline' : 'Single';
  const modeLabel = auto.kind === 'pipeline' ? auto.mode : '';
  const scheduleLabel = auto.cron ? cronToHuman(auto.cron, auto.runOnce === true) : 'Manual';
  const statusLabel = isBuiltin ? 'Example' : (auto.enabled ? 'Enabled' : 'Disabled');
  const toggleDisabled = isBuiltin ? 'disabled' : '';
  const runDisabled = (!auto.enabled || isBuiltin) ? 'disabled' : '';
  const runTitle = isBuiltin
    ? 'Use this starter example first to create a runnable automation.'
    : (!auto.enabled ? 'Enable first' : '');
  const dryRunDisabled = isBuiltin || isAssistant ? 'disabled' : '';
  const dryRunTitle = isAssistant ? 'Assistant automations do not support dry-run mode.' : (isBuiltin ? 'Use this starter example first' : '');
  const editDisabled = isBuiltin ? 'disabled title="Create a copy of this starter example first"' : '';
  const deleteDisabled = isBuiltin ? 'disabled title="Built-in catalog item"' : '';
  const secondaryActionLabel = isBuiltin ? 'Use Example' : 'Create Copy';
  const toolsCell = isAssistant
    ? `
        <div class="wf-catalog-tools">
          <span class="wf-tool-chip"><span class="wf-tool-chip-num">A</span>${esc(auto.task?.target || 'default')}</span>
        </div>
        <div class="ops-task-sub">Channel: ${esc(auto.agentChannel || 'scheduled')} · Delivery: ${auto.agentDeliver ? 'on' : 'off'}</div>
      `
    : `
        <div class="wf-catalog-tools">
          ${steps.length === 0
            ? '<span style="color:var(--text-muted);font-size:0.75rem">No steps</span>'
            : steps.map((step, si) => {
                const sep = auto.mode === 'parallel'
                  ? (si < steps.length - 1 ? '<span class="wf-tool-parallel-bar">||</span>' : '')
                  : (si < steps.length - 1 ? '<span class="wf-tool-arrow">&#9654;</span>' : '');
                return `<span class="wf-tool-chip"><span class="wf-tool-chip-num">${si + 1}</span>${esc(step.toolName)}</span>${sep}`;
              }).join('')
          }
        </div>
        ${steps.length > 0 && auto.kind === 'pipeline' ? `
          <div class="auto-pipeline-toggle-wrap">
            <button class="wf-expand-btn auto-pipeline-toggle" data-auto-id="${escAttr(auto.id)}">
              <span class="wf-expand-icon">&#9654;</span>
              <span>Show Pipeline Details</span>
            </button>
          </div>
        ` : ''}
      `;

  return `
    <tr class="auto-catalog-row" data-category="${escAttr(auto.category)}" data-auto-id="${escAttr(auto.id)}">
      <td>
        <div class="ops-task-title">${esc(auto.name)}</div>
        <div class="ops-task-sub" title="${escAttr(auto.description || auto.id)}">${esc(auto.description || auto.id)}</div>
        <span class="wf-category-tag">${esc(auto.category)}</span>
        ${isBuiltin ? '<span class="badge badge-info" style="margin-left:0.4rem">Starter Example</span>' : ''}
      </td>
      <td>
        <span class="auto-kind-badge ${auto.kind}">${esc(kindLabel)}</span>
        ${modeLabel ? `<span class="wf-pipeline-mode-badge ${auto.mode}" style="margin-left:0.3rem">${esc(modeLabel)}</span>` : ''}
      </td>
      <td>${toolsCell}</td>
      <td class="auto-schedule-cell">
        <div class="ops-task-title">${esc(scheduleLabel)}</div>
        ${auto.cron ? `<div class="ops-task-sub">${esc(auto.cron)}</div>` : ''}
        ${auto.runOnce ? '<div class="ops-task-sub">Single shot: disables itself after the first run.</div>' : ''}
        ${auto.emitEvent ? `<div class="ops-task-sub">Output event: <code>${esc(auto.emitEvent)}</code></div>` : ''}
        <div class="ops-task-sub">${renderOutputHandlingBadges(auto.outputHandling)}</div>
      </td>
      <td>
        <div class="ops-state-cell">
          <span class="badge ${isBuiltin ? 'badge-info' : (auto.enabled ? 'badge-ready' : 'badge-dead')}">${statusLabel}</span>
          <label class="toggle-switch" style="margin:0;">
            <input type="checkbox" class="auto-toggle" data-auto-id="${escAttr(auto.id)}" ${auto.enabled ? 'checked' : ''} ${toggleDisabled}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </td>
      <td>
        <div class="ops-action-buttons">
          <button class="btn btn-primary btn-sm auto-run" data-auto-id="${escAttr(auto.id)}" ${runDisabled} ${runTitle ? `title="${escAttr(runTitle)}"` : ''}>Run</button>
          <button class="btn btn-secondary btn-sm auto-dryrun" data-auto-id="${escAttr(auto.id)}" ${dryRunDisabled} ${dryRunTitle ? `title="${escAttr(dryRunTitle)}"` : ''}>Dry Run</button>
          <button class="btn btn-secondary btn-sm auto-edit" data-auto-id="${escAttr(auto.id)}" ${editDisabled}>Edit</button>
          <button class="btn btn-secondary btn-sm auto-create-copy" data-auto-id="${escAttr(auto.id)}">${esc(secondaryActionLabel)}</button>
          <button class="btn btn-secondary btn-sm auto-delete" data-auto-id="${escAttr(auto.id)}" data-label="${escAttr(auto.name)}" ${deleteDisabled}>Delete</button>
        </div>
      </td>
    </tr>
    ${auto.kind === 'pipeline' ? `
    <tr class="wf-pipeline-row auto-catalog-row" data-category="${escAttr(auto.category)}" id="auto-pipeline-${escAttr(auto.id)}">
      <td colspan="6" class="wf-pipeline-cell">
        ${renderPipelineView(auto, tools, packs)}
      </td>
    </tr>
    ` : ''}
  `;
}

function renderPipelineView(auto, toolLookup, packs) {
  const steps = auto.steps || [];
  if (steps.length === 0) return '<div style="padding:1rem;color:var(--text-muted)">No steps defined.</div>';
  const findTool = (name) => toolLookup.find((t) => t.name === name);

  const header = `
    <div class="wf-pipeline-header">
      <div class="wf-pipeline-title">
        <span>${esc(auto.name)}</span>
        <span class="wf-pipeline-mode-badge ${auto.mode}">${esc(auto.mode)}</span>
      </div>
      <div class="wf-pipeline-step-count">${steps.length} step${steps.length !== 1 ? 's' : ''}</div>
    </div>
  `;

  let pipelineBody;
  if (auto.mode === 'parallel') {
    const lanes = steps.map((step, i) => {
      const tool = findTool(step.toolName);
      const cat = tool?.category || '';
      const argKeys = Object.keys(step.args || {});
      const argSummary = argKeys.length > 0 ? argKeys.join(', ') : '';
      const settings = [];
      if (step.timeoutMs) settings.push(`<span class="wf-pipeline-setting-tag timeout">${step.timeoutMs}ms</span>`);
      if (step.continueOnError) settings.push(`<span class="wf-pipeline-setting-tag continue-on-error">continue-on-error</span>`);
      return `
        <div class="wf-pipeline-parallel-lane">
          <span class="wf-pipeline-lane-num">${i + 1}</span>
          <span class="wf-pipeline-lane-tool">${esc(step.toolName)}</span>
          ${cat ? `<span class="wf-pipeline-lane-category">${esc(cat)}</span>` : ''}
          ${argSummary ? `<span class="wf-pipeline-lane-args" title="${escAttr(JSON.stringify(step.args, null, 2))}">${esc(argSummary)}</span>` : ''}
          <div class="wf-pipeline-lane-settings">${settings.join('')}</div>
        </div>
      `;
    }).join('');
    pipelineBody = `
      <div class="wf-pipeline-parallel">
        <div class="wf-pipeline-parallel-header">
          <span class="wf-pipeline-parallel-icon">&#9781;</span>
          <span class="wf-pipeline-parallel-label">All steps execute concurrently</span>
        </div>
        <div class="wf-pipeline-parallel-tracks">${lanes}</div>
      </div>`;
  } else {
    const nodes = steps.map((step, i) => {
      const tool = findTool(step.toolName);
      const cat = tool?.category || '';
      const argKeys = Object.keys(step.args || {});
      const argSummary = argKeys.length > 0 ? argKeys.join(', ') : '';
      const settings = [];
      if (step.timeoutMs) settings.push(`<span class="wf-pipeline-setting-tag timeout">${step.timeoutMs}ms</span>`);
      if (step.continueOnError) settings.push(`<span class="wf-pipeline-setting-tag continue-on-error">skip-on-fail</span>`);
      const connector = i < steps.length - 1
        ? '<div class="wf-pipeline-connector"><div class="wf-pipeline-connector-line"></div><div class="wf-pipeline-connector-arrow"></div></div>'
        : '';
      return `
        <div class="wf-pipeline-node">
          <div class="wf-pipeline-node-circle">${i + 1}</div>
          <div class="wf-pipeline-node-label">
            <div class="wf-pipeline-node-tool">${esc(step.toolName)}</div>
            ${cat ? `<div class="wf-pipeline-node-category">${esc(cat)}</div>` : ''}
            ${argSummary ? `<div class="wf-pipeline-node-args" title="${escAttr(JSON.stringify(step.args, null, 2))}">${esc(argSummary)}</div>` : ''}
            ${settings.length > 0 ? `<div style="margin-top:0.2rem;display:flex;gap:0.2rem;justify-content:center;flex-wrap:wrap">${settings.join('')}</div>` : ''}
          </div>
        </div>
        ${connector}
      `;
    }).join('');
    pipelineBody = `<div class="wf-pipeline-track">${nodes}</div>`;
  }

  // Config panel
  const stepConfigs = steps.map((step, i) => {
    const tool = findTool(step.toolName);
    const cat = tool?.category || '';
    const hasArgs = step.args && Object.keys(step.args).length > 0;
    return `
      <div class="wf-config-step">
        <div class="wf-config-step-header">
          <span class="wf-config-step-num">${i + 1}</span>
          <span class="wf-config-step-tool">${esc(step.toolName)}</span>
          ${cat ? `<span class="wf-config-step-cat">${esc(cat)}</span>` : ''}
          <span class="wf-config-step-id">${esc(step.id)}</span>
        </div>
        <div class="wf-config-step-body">
          <div class="wf-config-step-fields">
            <div class="cfg-field"><label title="Which security boundary this step runs under. 'Built-in tools' means normal Guardian rules. An access profile adds extra host/path/command restrictions.">Access</label><input type="text" value="${escAttr(formatStepAccess(step.packId, packs))}" readonly style="opacity:0.7;cursor:default" title="Change via raw definition JSON editor below"></div>
            <div class="cfg-field"><label>Timeout (ms)</label><input type="text" value="${escAttr(step.timeoutMs ? String(step.timeoutMs) : 'default')}" readonly style="opacity:0.7;cursor:default"></div>
            <div class="cfg-field"><label>Continue on Error</label><input type="text" value="${step.continueOnError ? 'yes' : 'no'}" readonly style="opacity:0.7;cursor:default"></div>
          </div>
          ${hasArgs ? `<div class="cfg-field" style="margin-top:0.35rem"><label>Arguments</label><pre class="wf-config-args-pre">${esc(JSON.stringify(step.args, null, 2))}</pre></div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  const playbookData = auto.workflow || { id: auto.id, name: auto.name, mode: auto.mode, steps, enabled: auto.enabled, description: auto.description };
  const rawEditorDisabled = auto.builtin === true;
  const configPanel = `
    <details class="wf-config-details">
      <summary class="wf-config-summary">
        <span class="wf-expand-icon" style="font-size:0.6rem">&#9654;</span>
        Advanced Configuration (Power Users)
      </summary>
      <div class="wf-config-body">
        <div class="wf-config-section">
          <div class="wf-config-section-title">Step Configuration</div>
          <div class="wf-config-steps">${stepConfigs}</div>
        </div>
        <div class="wf-config-section">
          <div class="wf-config-section-title">Raw Definition JSON</div>
          <div class="wf-config-section-note">
            ${rawEditorDisabled
              ? 'Create a copy of this starter example before editing its raw definition.'
              : 'Use the simple Edit flow for normal changes. This editor is for advanced troubleshooting and direct definition changes.'}
          </div>
          <textarea class="wf-config-json-editor" data-auto-id="${escAttr(auto.id)}" rows="8" ${rawEditorDisabled ? 'readonly' : ''}>${esc(JSON.stringify(playbookData, null, 2))}</textarea>
          <div class="cfg-actions" style="margin-top:0.5rem">
            <button class="btn btn-primary btn-sm auto-config-save" data-auto-id="${escAttr(auto.id)}" ${rawEditorDisabled ? 'disabled' : ''}>Save Changes</button>
            <span class="auto-config-save-status cfg-save-status" data-auto-id="${escAttr(auto.id)}"></span>
          </div>
        </div>
      </div>
    </details>
  `;

  return `<div class="wf-pipeline-container">${header}${pipelineBody}${configPanel}</div>`;
}

function renderOutputHandlingBadges(outputHandling, promotedFindings = []) {
  const normalized = normalizeOutputHandling(outputHandling);
  const badges = [];
  if (normalized.notify !== 'off') badges.push('<span class="badge badge-info">notifies</span>');
  if (normalized.sendToSecurity !== 'off') badges.push('<span class="badge badge-warn">security</span>');
  if (normalized.persistArtifacts !== 'run_history_only') badges.push('<span class="badge badge-accent">history + analysis</span>');
  if ((promotedFindings || []).length > 0) badges.push(`<span class="badge badge-critical">${promotedFindings.length} finding${promotedFindings.length === 1 ? '' : 's'}</span>`);
  return badges.join(' ') || '<span style="color:var(--text-muted)">Run history only</span>';
}

function renderHistoricalAnalysisStatus(entry) {
  const stored = entry?.storedOutput || null;
  const memory = entry?.memoryPromotion || null;
  if (!stored && !memory) return '';

  const rows = [];
  if (stored) {
    const storedTone = stored.status === 'saved'
      ? 'var(--success)'
      : stored.status === 'blocked' || stored.status === 'skipped'
        ? 'var(--warning)'
        : 'var(--error)';
    rows.push(`
      <div>
        <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:flex-start;flex-wrap:wrap">
          <strong>Stored Output</strong>
          <span style="color:${storedTone}">${esc(stored.status || 'unknown')}</span>
        </div>
        <div style="margin-top:0.2rem;color:var(--text-secondary)">
          ${esc(
            stored.status === 'saved'
              ? `Full output stored for historical analysis${stored.stepCount ? ` · ${stored.stepCount} step${stored.stepCount === 1 ? '' : 's'}` : ''}.`
              : (stored.reason || 'Stored output was not persisted for this run.')
          )}
        </div>
      </div>
    `);
  }
  if (memory) {
    const memoryTone = memory.status === 'saved'
      ? 'var(--success)'
      : memory.status === 'blocked' || memory.status === 'skipped'
        ? 'var(--warning)'
        : 'var(--error)';
    rows.push(`
      <div>
        <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:flex-start;flex-wrap:wrap">
          <strong>Memory Reference</strong>
          <span style="color:${memoryTone}">${esc(memory.status || 'unknown')}</span>
        </div>
        <div style="margin-top:0.2rem;color:var(--text-secondary)">
          ${esc(
            memory.status === 'saved'
              ? `Searchable memory reference saved${memory.agentId ? ` for ${memory.agentId}` : ''}.`
              : (memory.reason || 'No searchable memory reference was saved for this run.')
          )}
        </div>
      </div>
    `);
  }

  return `
    <div style="margin-top:0.9rem;padding:0.8rem 0.9rem;border:1px solid var(--border);border-radius:0;background:var(--bg-primary)">
      <div style="font-weight:600">Historical Analysis</div>
      <div style="margin-top:0.55rem;display:flex;flex-direction:column;gap:0.7rem">
        ${rows.join('')}
      </div>
    </div>
  `;
}

function renderPromotedFindings(promotedFindings) {
  if (!promotedFindings || promotedFindings.length === 0) return '';
  return `
    <div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border);font-size:0.78rem">
      <div style="font-weight:600;margin-bottom:0.35rem">Promoted Findings</div>
      ${promotedFindings.map((finding) => `
        <div style="display:flex;gap:0.5rem;align-items:flex-start;margin-bottom:0.25rem">
          <span class="badge ${finding.severity === 'critical' ? 'badge-critical' : finding.severity === 'warn' ? 'badge-warn' : 'badge-info'}">${esc(finding.severity)}</span>
          <div style="flex:1">
            <div>${esc(finding.title || 'Finding')}</div>
            <div style="color:var(--text-muted)">${esc(finding.description || '')}</div>
          </div>
          ${finding.sendToSecurity && finding.runLink ? `<a class="btn btn-secondary btn-sm" href="${escAttr(finding.runLink)}">Open run</a>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderCreateForm(tools, packs, agents) {
  const assistantAgents = (agents || [])
    .filter((agent) => agent?.canChat !== false && agent?.internal !== true)
    .map((agent) => `<option value="${escAttr(agent.id)}">${esc(formatAssistantAgentOptionLabel(agent))}</option>`)
    .join('');

  return `
    <div class="auto-form-header">
      <div>
        <h4 id="auto-form-title" style="margin:0 0 0.2rem;">Create Automation</h4>
        <div id="auto-form-subtitle" style="font-size:0.74rem;color:var(--text-muted);">Build a one-off tool automation or a multi-step pipeline.</div>
      </div>
    </div>
    <div class="cfg-form-grid">
      <div class="cfg-field">
        <label>Name</label>
        <input id="auto-create-name" type="text" placeholder="My Automation">
      </div>
      <div class="cfg-field" id="auto-id-field">
        <label>ID</label>
        <input id="auto-create-id" type="text" placeholder="my-automation">
      </div>
      <div class="cfg-field">
        <label>Mode <span class="code-tooltip-icon" title="">&#9432;</span></label>
        <select id="auto-create-mode">
          <option value="single">Single Tool</option>
          <option value="sequential">Sequential Pipeline</option>
          <option value="parallel">Parallel Pipeline</option>
        </select>
      </div>
      <div class="cfg-field">
        <label>LLM Provider <span class="code-tooltip-icon" title="">&#9432;</span></label>
        <select id="auto-llm-provider">
          <option value="auto">Auto (smart routing)</option>
          <option value="local">Local model</option>
          <option value="external">External model</option>
        </select>
      </div>
      <input type="hidden" id="auto-create-pack" value="">
    </div>
    <div class="cfg-field" style="margin-top:0.5rem;">
      <label>Description</label>
      <input id="auto-create-description" type="text" placeholder="What this automation does">
    </div>

    <!-- Single tool selector (shown when mode=single) -->
    <div id="auto-single-tool-section" style="margin-top:0.75rem;">
      <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:0.35rem;">Tool <span class="code-tooltip-icon" title="">&#9432;</span></label>
      <div style="display:flex;align-items:center;gap:0.35rem;">
        <input type="hidden" id="auto-single-tool-select" value="">
        <span id="auto-single-tool-display" class="auto-tool-display">No tool selected</span>
        <button class="btn btn-secondary btn-sm" id="auto-single-tool-browse" type="button" style="white-space:nowrap;">Browse</button>
      </div>
      <div id="auto-single-tool-picker-panel" style="display:none;"></div>
      <div id="auto-single-tool-params" style="margin-top:0.5rem;"></div>
      <div class="cfg-field" style="margin-top:0.5rem;">
        <label>Prompt (optional) <span class="code-tooltip-icon" title="">&#9432;</span></label>
        <textarea id="auto-single-prompt" rows="3" placeholder="After running the tool, summarize key findings..."></textarea>
      </div>
    </div>

    <!-- Pipeline step builder (shown when mode=sequential|parallel) -->
    <div id="auto-pipeline-section" style="margin-top:0.75rem;display:none;">
      <label style="font-size:0.8rem;color:var(--text-secondary);display:block;margin-bottom:0.35rem;"><span id="auto-pipeline-label">Steps</span> <span class="code-tooltip-icon" title="">&#9432;</span></label>
      <div id="auto-step-list"></div>
      <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem;">
        <div class="cfg-field" style="width:140px;margin:0;flex-shrink:0;">
          <select id="auto-step-type-select">
            <option value="tool" selected>Tool</option>
            <option value="instruction">Instruction (LLM)</option>
            <option value="delay">Delay</option>
          </select>
        </div>
        <div style="flex:1;display:flex;align-items:center;gap:0.35rem;" id="auto-step-tool-field">
          <input type="hidden" id="auto-step-tool-select" value="">
          <span id="auto-step-tool-display" class="auto-tool-display">No tool selected</span>
          <button class="btn btn-secondary btn-sm" id="auto-step-tool-browse" type="button" style="white-space:nowrap;">Browse</button>
        </div>
        <div class="cfg-field" style="flex:1;margin:0;display:none;" id="auto-step-instruction-field">
          <input id="auto-step-instruction-input" type="text" placeholder="Describe what the LLM should do with prior step outputs...">
        </div>
        <div class="cfg-field" id="auto-step-delay-field" style="display:none;margin:0;">
          <div style="display:flex;align-items:center;gap:0.35rem;">
            <input id="auto-step-delay-value" type="number" min="1" value="5" style="width:70px;">
            <select id="auto-step-delay-unit" style="width:auto;">
              <option value="seconds">Seconds</option>
              <option value="minutes" selected>Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </div>
        </div>
        <button class="btn btn-secondary" id="auto-step-cancel" type="button">Cancel</button>
        <button class="btn btn-secondary" id="auto-step-add" type="button">Add Step</button>
      </div>
      <div id="auto-step-tool-picker-panel" style="display:none;"></div>
      <div id="auto-step-tool-params" style="margin-top:0.5rem;"></div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.35rem;">Add tool, LLM instruction, or delay steps. Instruction steps interpret prior step outputs. Delay steps pause sequential pipelines.</div>
    </div>

    <!-- Schedule toggle -->
    <div class="auto-schedule-toggle" style="margin-top:1rem;">
      <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
        <input type="checkbox" id="auto-schedule-enabled">
        <span style="font-size:0.85rem;color:var(--text-primary);font-weight:500;">Schedule this automation</span>
      </label>
    </div>
    <div id="auto-schedule-section" style="display:none;margin-top:0.5rem;">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Schedule</label>
          <select id="auto-schedule-kind">
            <option value="every_minutes">Every few minutes</option>
            <option value="every_hours">Every few hours</option>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Advanced cron</option>
          </select>
        </div>
        <div class="cfg-field" id="auto-interval-field">
          <label>Interval (minutes)</label>
          <input id="auto-interval" type="number" min="1" step="1" value="30">
        </div>
        <div class="cfg-field" id="auto-minute-field" style="display:none">
          <label>Minute Past The Hour</label>
          <input id="auto-minute" type="number" min="0" max="59" step="1" value="0">
        </div>
        <div class="cfg-field" id="auto-time-field" style="display:none">
          <label>Time</label>
          <input id="auto-time" type="time" value="09:00">
        </div>
        <div class="cfg-field" id="auto-weekday-field" style="display:none">
          <label>Day</label>
          <select id="auto-weekday">
            <option value="1">Monday</option>
            <option value="2">Tuesday</option>
            <option value="3">Wednesday</option>
            <option value="4">Thursday</option>
            <option value="5">Friday</option>
            <option value="6">Saturday</option>
            <option value="0">Sunday</option>
          </select>
        </div>
        <div class="cfg-field" id="auto-custom-cron-field" style="display:none">
          <label>Advanced Cron</label>
          <input id="auto-cron-custom" type="text" placeholder="*/30 * * * *">
        </div>
      </div>
      <div class="ops-inline-help" id="auto-schedule-preview"></div>
      <label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.55rem;cursor:pointer;">
        <input type="checkbox" id="auto-run-once">
        <span style="font-size:0.8rem;color:var(--text-primary);">Single shot: run once on the next matching schedule, then disable automatically</span>
      </label>

      <!-- Assistant turn toggle (inside schedule section) -->
      <div style="margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.75rem;">
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
          <input type="checkbox" id="auto-agent-mode">
          <span style="font-size:0.85rem;font-weight:500;">Run as assistant turn</span>
        </label>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem;">
          Instead of running tools deterministically, wake the assistant with this prompt.
          The assistant has full access to tools, memory, and skills.
        </div>
        <div id="auto-assistant-fields" style="display:none;margin-top:0.5rem;">
          <div class="cfg-form-grid">
            <div class="cfg-field">
              <label>Assistant</label>
              <select id="auto-agent-select">
                <option value="default">Default Assistant</option>
                ${assistantAgents}
              </select>
            </div>
            <div class="cfg-field">
              <label>Delivery Channel</label>
              <select id="auto-agent-channel">
                <option value="scheduled">Background only</option>
                <option value="cli">CLI</option>
                <option value="telegram">Telegram</option>
                <option value="web">Web</option>
              </select>
            </div>
          </div>
          <div class="cfg-field" style="margin-top:0.5rem;">
            <label>Assistant Prompt <span class="code-tooltip-icon" title="">&#9432;</span></label>
            <textarea id="auto-agent-prompt" rows="4" placeholder="Check recent email, calendar, cloud/security alerts, and send me a concise briefing."></textarea>
          </div>
          <label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem;cursor:pointer;">
            <input type="checkbox" id="auto-agent-deliver" checked>
            <span style="font-size:0.8rem;color:var(--text-primary);">Deliver response to channel</span>
          </label>
        </div>
      </div>
    </div>

    <details class="ops-advanced" style="margin-top:0.75rem;">
      <summary>Advanced Options (Power Users)</summary>
      <div class="cfg-form-grid" style="margin-top:0.85rem;">
        <div class="cfg-field">
          <label>Tool Inputs (JSON, optional)</label>
          <textarea id="auto-create-args" rows="4" placeholder='{"host":"192.168.1.1","count":3}'></textarea>
        </div>
        <div class="cfg-field">
          <label>Output Event (optional)</label>
          <input id="auto-create-event" type="text" placeholder="cloud.drift.detected">
        </div>
        <div class="cfg-field">
          <label>Enabled</label>
          <select id="auto-create-enabled">
            <option value="true" selected>Yes</option>
            <option value="false">No</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Notify</label>
          <select id="auto-output-notify">
            <option value="off" selected>Off</option>
            <option value="warn_critical">On warn/critical findings</option>
            <option value="all">On all findings</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Send To Security</label>
          <select id="auto-output-security">
            <option value="off" selected>Off</option>
            <option value="warn_critical">On warn/critical findings</option>
            <option value="all">On all findings</option>
          </select>
        </div>
        <div class="cfg-field" style="grid-column:1 / -1;">
          <label style="display:flex;align-items:flex-start;gap:0.55rem;cursor:pointer;">
            <input id="auto-output-store-enabled" type="checkbox" checked style="margin-top:0.2rem;">
            <span>
              <span style="display:block;font-weight:500;color:var(--text-primary)">Store output for historical analysis</span>
              <span style="display:block;font-size:0.75rem;color:var(--text-muted);line-height:1.45">
                Keep the full automation run output in Guardian&apos;s private automation output store and save a searchable memory reference so the assistant can analyze that run later. This applies only to saved automation runs, not ad hoc tool uses.
              </span>
            </span>
          </label>
        </div>
      </div>
    </details>

    <div style="margin-top:0.5rem;font-size:0.72rem;color:var(--text-muted);line-height:1.5;">
      Automation output is always available in run history. Historical analysis storage is enabled by default for saved automations and can be turned off here. Notifications and Security receive normalized findings only, not raw logs. <code>Output Event</code> is optional and lets scheduled runs emit a named downstream event.
    </div>

    <div id="auto-preflight-panel" style="display:none;margin-top:0.75rem;"></div>

    <div class="cfg-actions">
      <button class="btn btn-primary" id="auto-create-save">Create Automation</button>
      <button class="btn btn-secondary" id="auto-create-cancel">Cancel</button>
      <span id="auto-create-status" class="cfg-save-status"></span>
    </div>

    <input type="hidden" id="auto-edit-id" value="">
    <input type="hidden" id="auto-edit-source" value="">
    <input type="hidden" id="auto-edit-task-id" value="">
  `;
}

function formatAssistantAgentOptionLabel(agent) {
  const baseLabel = agent?.name ? `${agent.name} (${agent.id})` : agent?.id || 'Unknown assistant';
  const orchestrationLabel = typeof agent?.orchestrationLabel === 'string' && agent.orchestrationLabel.trim()
    ? agent.orchestrationLabel.trim()
    : '';
  const routingRole = typeof agent?.routingRole === 'string' && agent.routingRole.trim()
    ? `${agent.routingRole.trim().replace(/\b\w/g, (match) => match.toUpperCase())} lane`
    : '';
  const suffix = orchestrationLabel || routingRole;
  return suffix ? `${baseLabel} - ${suffix}` : baseLabel;
}

function renderRunHistory(entries) {
  const history = Array.isArray(entries) ? entries : [];
  if (history.length === 0) {
    return '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No run output yet.</td></tr>';
  }

  return history.slice(0, 60).map((entry) => `
    <tr>
      <td>${formatTime(entry.time)}</td>
      <td>${esc(entry.name)}</td>
      <td><span class="badge ${entry.source === 'automation' ? 'badge-info' : 'badge-created'}">${esc(entry.source)}</span></td>
      <td>
        <span style="color:${statusColor(entry.status)}">${esc(entry.status)}</span>
        <div class="ops-task-sub" style="margin-top:0.25rem">${renderOutputHandlingBadges(entry.outputHandling, entry.promotedFindings)}</div>
      </td>
      <td>${entry.duration}ms</td>
      <td>
        ${entry.steps && entry.steps.length > 0
          ? `<button class="btn btn-secondary btn-sm auto-run-details" data-run-id="${escAttr(entry.id || '')}">View Output</button>`
          : `<span class="ops-history-message" title="${escAttr(entry.message || '')}">${esc(entry.message || '-')}</span>`
        }
      </td>
    </tr>
    ${entry.steps && entry.steps.length > 0 ? `
    <tr class="auto-run-details-row" id="auto-run-detail-${escAttr(entry.id || '')}" style="display:none">
      <td colspan="6" style="padding:0.5rem 1rem;background:var(--bg-secondary)">
        ${renderRunOutputContent(entry)}
      </td>
    </tr>
    ` : ''}
  `).join('');
}

function renderCompactRunHistory(entries) {
  const history = Array.isArray(entries) ? entries : [];
  if (history.length === 0) {
    return '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent runs yet.</td></tr>';
  }

  return history.slice(0, 60).map((entry) => `
    <tr>
      <td>${formatTime(entry.time)}</td>
      <td>${esc(entry.name)}</td>
      <td><span class="badge ${entry.source === 'automation' ? 'badge-info' : 'badge-created'}">${esc(entry.source)}</span></td>
      <td><span style="color:${statusColor(entry.status)}">${esc(entry.status)}</span></td>
      <td>${entry.duration}ms</td>
      <td class="ops-history-message">${esc(summarizeRunHistoryRow(entry))}</td>
    </tr>
  `).join('');
}

function renderExecutionTimeline(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent automation execution runs yet.</td></tr>';
  }

  const requestedRunId = getRequestedAssistantRunId();
  return runs.slice(0, 20).map((entry) => {
    const summary = entry?.summary || {};
    const items = Array.isArray(entry?.items) ? entry.items : [];
    const owner = summary.agentId || summary.channel || '-';
    const highlighted = summary.runId === requestedRunId;
    return `
      <tr id="auto-execution-run-${escAttr(summary.runId || '')}" ${highlighted ? 'style="outline:2px solid var(--accent);outline-offset:-2px"' : ''}>
        <td>${formatTime(summary.lastUpdatedAt || summary.startedAt || 0)}</td>
        <td>
          <div style="font-weight:600">${esc(summary.title || summary.runId || 'Run')}</div>
          <div class="ops-task-sub">${esc(summary.subtitle || summary.runId || '')}</div>
        </td>
        <td><span class="badge badge-info">${esc(formatRunKind(summary.kind))}</span></td>
        <td>
          <span style="color:${statusColor(summary.status)}">${esc(summary.status || 'unknown')}</span>
          <div class="ops-task-sub">
            ${summary.pendingApprovalCount > 0 ? `${summary.pendingApprovalCount} approval${summary.pendingApprovalCount === 1 ? '' : 's'}` : formatDuration(summary.durationMs)}
          </div>
        </td>
        <td>${esc(owner)}</td>
        <td>${renderExecutionTimelineItems(items, summary.runId || '')}</td>
      </tr>
    `;
  }).join('');
}

function selectExecutionTimelineItems(items, requestedItemId) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!requestedItemId) return items.slice(-8);
  const requestedIndex = items.findIndex((item) => item?.id === requestedItemId);
  if (requestedIndex === -1) return items.slice(-8);
  const windowSize = 8;
  let start = Math.max(0, requestedIndex - 2);
  let end = Math.min(items.length, start + windowSize);
  start = Math.max(0, end - windowSize);
  return items.slice(start, end);
}

function renderExecutionTimelineItems(items, runId) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<span class="ops-history-message">No visible events.</span>';
  }
  const requestedRunId = getRequestedAssistantRunId();
  const requestedItemId = requestedRunId === runId ? getRequestedAssistantRunItemId() : '';
  const recent = selectExecutionTimelineItems(items, requestedItemId);
  return `
    <details ${requestedItemId ? 'open' : ''}>
      <summary>${recent.length} event${recent.length === 1 ? '' : 's'}</summary>
      <div style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.45rem">
        ${recent.map((item) => {
          const contextAssembly = normalizeRunTimelineContextAssembly(item?.contextAssembly);
          const highlighted = requestedItemId && item?.id === requestedItemId;
          return `
          <div
            id="auto-execution-item-${escAttr(item.id || '')}"
            style="padding:0.45rem 0.6rem;border:1px solid var(--border);border-radius:0;background:var(--bg-secondary);${highlighted ? 'outline:2px solid var(--accent);outline-offset:2px;' : ''}"
          >
            <div style="display:flex;gap:0.5rem;align-items:center;justify-content:space-between">
              <strong>${esc(item.title || item.type || 'Event')}</strong>
              <span style="color:${timelineStatusColor(item.status)}">${esc(item.status || 'info')}</span>
            </div>
            <div class="ops-task-sub">${esc(formatTime(item.timestamp))}</div>
            ${item.detail ? `<div style="margin-top:0.35rem;color:var(--text-secondary)">${esc(item.detail)}</div>` : ''}
            ${renderRunTimelineContextAssembly(contextAssembly, esc)}
          </div>
        `;
        }).join('')}
      </div>
    </details>
  `;
}

function normalizeAssistantRuns(runs, requestedRun) {
  const normalized = Array.isArray(runs) ? runs.slice() : [];
  if (!requestedRun?.summary?.runId || requestedRun?.summary?.kind !== 'automation_run') return normalized;
  if (normalized.some((entry) => entry?.summary?.runId === requestedRun.summary.runId)) {
    return normalized;
  }
  return [requestedRun, ...normalized];
}

function renderRunOutputContent(entry) {
  return `
    ${renderRunResultSummary(entry)}
    ${renderHistoricalAnalysisStatus(entry)}
    <div style="margin-top:0.9rem">
      <div style="font-weight:600;margin-bottom:0.45rem">Step Output</div>
      ${renderStepResults(entry.steps)}
    </div>
    ${renderPromotedFindings(entry.promotedFindings)}
  `;
}

function renderRunResultSummary(entry) {
  const blocks = buildRunResultSummaryBlocks(entry);
  const topMessage = String(entry?.message || '').trim();

  return `
    <div style="padding:0.8rem 0.9rem;border:1px solid var(--border);border-radius:0;background:var(--bg-primary)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap">
        <div style="font-weight:600">Run Result</div>
        <div class="ops-task-sub">${esc(entry?.name || 'Automation run')} · ${esc(entry?.status || 'unknown')}</div>
      </div>
      ${topMessage ? `<div style="margin-top:0.35rem;color:var(--text-secondary)">${esc(topMessage)}</div>` : ''}
      ${blocks.length > 0
        ? `<div style="margin-top:0.7rem;display:flex;flex-direction:column;gap:0.6rem">${blocks.map(renderRunResultBlock).join('')}</div>`
        : `<div class="ops-task-sub" style="margin-top:0.55rem">No structured output was captured for this run.</div>`
      }
    </div>
  `;
}

function renderRunResultBlock(block) {
  return `
    <div style="padding:0.65rem 0.75rem;border:1px solid var(--border);border-radius:0;background:var(--bg-secondary)">
      <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;flex-wrap:wrap">
        <strong>${esc(block.title)}</strong>
        ${block.meta ? `<span class="ops-task-sub">${esc(block.meta)}</span>` : ''}
      </div>
      ${block.detail ? `<div style="margin-top:0.25rem;color:var(--text-secondary)">${esc(block.detail)}</div>` : ''}
      ${block.preview ? `<pre style="margin-top:0.45rem;font-size:0.8rem;background:var(--bg-primary);padding:0.5rem;border-radius:0;white-space:pre-wrap;word-break:break-word">${esc(block.preview)}</pre>` : ''}
      ${block.links && block.links.length > 0 ? `
        <div style="margin-top:0.45rem;display:flex;flex-direction:column;gap:0.25rem">
          ${block.links.map((link) => `<div style="font-size:0.83rem">${esc(link.text)}</div>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function buildRunResultSummaryBlocks(entry) {
  const steps = Array.isArray(entry?.steps) ? entry.steps : [];
  const blocks = [];
  let hasBrowserRead = false;

  for (const step of steps) {
    const block = summarizeStepForRunResult(step);
    if (!block) continue;
    if (step?.toolName === 'browser_read') hasBrowserRead = true;
    blocks.push(block);
  }

  if (!blocks.length && String(entry?.message || '').trim()) {
    blocks.push({
      title: 'Outcome',
      detail: String(entry.message).trim(),
    });
  }

  return hasBrowserRead
    ? blocks.filter((block) => block.kind !== 'navigation')
    : blocks;
}

function summarizeStepForRunResult(step) {
  if (!isRecord(step)) return null;
  const toolName = asString(step.toolName);
  const output = step.output;
  const stepMessage = asString(step.message).trim();

  if (toolName === 'browser_navigate' && isRecord(output)) {
    const url = asString(output.url);
    return {
      kind: 'navigation',
      title: 'Opened Page',
      detail: url ? `Opened ${url}` : stepMessage,
      meta: asString(step.status) || '',
    };
  }

  if (toolName === 'browser_read' && isRecord(output)) {
    const url = asString(output.url);
    const content = asString(output.content);
    const pageTitle = extractBrowserPageTitle(content);
    const snippet = extractBrowserReadSnippet(content);
    return {
      kind: 'browser_read',
      title: 'Page Read',
      detail: pageTitle
        ? `${pageTitle}${url ? ` · ${url}` : ''}`
        : (url ? `Read ${url}` : stepMessage),
      meta: asString(output.contentType) || undefined,
      ...(snippet ? { preview: snippet } : {}),
    };
  }

  if (toolName === 'browser_links' && isRecord(output)) {
    const links = Array.isArray(output.links)
      ? output.links.filter(isRecord).slice(0, 8).map((link) => ({
        text: formatBrowserLink(link),
      }))
      : [];
    const count = Array.isArray(output.links) ? output.links.length : links.length;
    return {
      kind: 'browser_links',
      title: 'Links Found',
      detail: count > 0
        ? `Extracted ${count} link${count === 1 ? '' : 's'}.`
        : (stepMessage || 'No links were extracted.'),
      ...(links.length ? { links } : {}),
    };
  }

  if (toolName === 'browser_extract' && isRecord(output)) {
    const structured = isRecord(output.structuredData) ? output.structuredData : null;
    const keys = structured ? Object.keys(structured).slice(0, 8) : [];
    const outline = Array.isArray(output.semanticOutline) ? output.semanticOutline : [];
    return {
      kind: 'browser_extract',
      title: 'Structured Extraction',
      detail: keys.length > 0
        ? `Captured structured fields: ${keys.join(', ')}`
        : (outline.length > 0 ? `Captured semantic outline with ${outline.length} sections.` : stepMessage),
      ...(structured ? { preview: truncateText(JSON.stringify(structured, null, 2), 700) } : {}),
    };
  }

  if (toolName === '_instruction' && typeof output === 'string' && output.trim()) {
    return {
      kind: 'instruction',
      title: 'Instruction Result',
      detail: stepMessage || 'Generated text output from prior steps.',
      preview: truncateText(output.trim(), 700),
    };
  }

  if (toolName === 'fs_write' && isRecord(output)) {
    const path = asString(output.path) || asString(output.filePath);
    return {
      kind: 'fs_write',
      title: 'File Written',
      detail: path ? `Saved output to ${path}` : stepMessage,
    };
  }

  if (typeof output === 'string' && output.trim()) {
    return {
      kind: 'generic',
      title: humanizeToolName(toolName || 'step'),
      detail: stepMessage,
      preview: truncateText(output.trim(), 500),
    };
  }

  return stepMessage
    ? {
        kind: 'generic',
        title: humanizeToolName(toolName || 'step'),
        detail: stepMessage,
      }
    : null;
}

function summarizeRunHistoryRow(entry) {
  const blocks = buildRunResultSummaryBlocks(entry);
  if (blocks[0]?.detail) return blocks[0].detail;
  return String(entry?.message || '').trim() || 'No summary available.';
}

function renderStepResults(steps) {
  if (!steps || steps.length === 0) return '<div style="color:var(--text-muted)">No steps</div>';
  return `<div style="font-size:0.85rem">${steps.map((step, index) => {
    const stepColor = step.status === 'succeeded' ? 'var(--success)' : step.status === 'failed' ? 'var(--error)' : 'var(--warning)';
    const hasOutput = step.output != null && step.output !== '';
    const outputId = `auto-step-output-${index}-${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:4px 0;border-bottom:1px solid var(--border)">
        <span style="color:${stepColor};font-weight:bold;min-width:18px">${step.status === 'succeeded' ? '&#10003;' : step.status === 'failed' ? '&#10007;' : '&#9679;'}</span>
        <span style="min-width:140px;font-weight:500">${esc(step.toolName)}</span>
        <span style="color:var(--text-muted)">${esc(step.message || '')}</span>
        <span style="margin-left:auto;color:var(--text-muted)">${step.durationMs}ms</span>
        ${hasOutput ? `<button class="btn btn-secondary auto-step-output-toggle" data-output-id="${outputId}" style="font-size:0.75rem;padding:2px 6px">Raw Output</button>` : ''}
      </div>
      ${hasOutput ? `<div id="${outputId}" style="display:none;padding:4px 0 4px 28px;max-height:300px;overflow:auto"><pre style="font-size:0.8rem;background:var(--bg-primary);padding:0.5rem;border-radius:0;white-space:pre-wrap;word-break:break-word">${esc(typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2))}</pre></div>` : ''}
    `;
  }).join('')}</div>`;
}

function renderEngineSettings(summary, workflowConfig, studio, packs) {
  return `
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Enabled</label>
          <select id="auto-engine-enabled">
            <option value="true" ${summary.enabled ? 'selected' : ''}>true</option>
            <option value="false" ${!summary.enabled ? 'selected' : ''}>false</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Execution Mode</label>
          <select id="auto-engine-mode">
            <option value="plan_then_execute" ${summary.executionMode === 'plan_then_execute' ? 'selected' : ''}>plan_then_execute</option>
            <option value="direct_execute" ${summary.executionMode === 'direct_execute' ? 'selected' : ''}>direct_execute</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Max Calls / Run</label>
          <input id="auto-max-calls" type="number" min="1" value="${esc(String(summary.maxConnectorCallsPerRun || 12))}">
        </div>
        <div class="cfg-field">
          <label>Max Steps</label>
          <input id="auto-max-steps" type="number" min="1" value="${esc(String(workflowConfig.maxSteps || 12))}">
        </div>
        <div class="cfg-field">
          <label>Max Parallel</label>
          <input id="auto-max-parallel" type="number" min="1" value="${esc(String(workflowConfig.maxParallelSteps || 3))}">
        </div>
        <div class="cfg-field">
          <label>Step Timeout (ms)</label>
          <input id="auto-step-timeout" type="number" min="1000" value="${esc(String(workflowConfig.defaultStepTimeoutMs || 15000))}">
        </div>
        <div class="cfg-field">
          <label>Signed Definitions</label>
          <select id="auto-require-signed">
            <option value="true" ${workflowConfig.requireSignedDefinitions ? 'selected' : ''}>true</option>
            <option value="false" ${!workflowConfig.requireSignedDefinitions ? 'selected' : ''}>false</option>
          </select>
        </div>
        <div class="cfg-field">
          <label>Dry Run First</label>
          <select id="auto-require-dryrun">
            <option value="true" ${workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>true</option>
            <option value="false" ${!workflowConfig.requireDryRunOnFirstExecution ? 'selected' : ''}>false</option>
          </select>
        </div>
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" id="auto-engine-save">Save</button>
        <span id="auto-engine-status" class="cfg-save-status"></span>
      </div>

      <details style="margin-top:1.25rem">
        <summary style="cursor:pointer;font-weight:600;font-size:0.85rem;color:var(--text-primary);">Access Profiles (Advanced)</summary>
        <div style="font-size:0.72rem;color:var(--text-muted);margin:0.5rem 0 0.6rem">
          Access profiles let you assign <strong>tighter security boundaries</strong> to specific automation steps.
          By default, all steps run with your normal Guardian rules (allowed paths, domains, commands, approval policy).
          An access profile adds extra restrictions on top — for example, limiting a monitoring automation to only reach specific hosts.
          <br><br>
          Most users do not need access profiles. If you do, create one here and then assign it to individual steps via the raw definition JSON editor on each automation.
        </div>
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Allowed Capabilities</th><th>Actions</th></tr></thead>
          <tbody>
            ${packs.length === 0
              ? '<tr><td colspan="4" style="color:var(--text-muted)">No access profiles defined. Automations use normal Guardian security rules.</td></tr>'
              : packs.map((pack) => `
                <tr>
                  <td>${esc(pack.id)}</td>
                  <td>${esc(pack.name)}</td>
                  <td>${esc((pack.allowedCapabilities || []).join(', ') || '-')}</td>
                  <td>
                    <button class="btn btn-secondary btn-sm auto-pack-edit" data-pack-id="${escAttr(pack.id)}" title="Load this profile into the editor below">Edit</button>
                    <button class="btn btn-secondary btn-sm auto-pack-delete" data-pack-id="${escAttr(pack.id)}" title="Permanently delete this access profile">Delete</button>
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
        <div class="cfg-field" style="margin-top:0.75rem">
          <label>Profile JSON <span style="color:var(--text-muted);font-weight:normal">(create or update an access profile)</span></label>
          <textarea id="auto-pack-json" rows="4" placeholder='{"id":"prod-only","name":"Production Servers","enabled":true,"allowedCapabilities":["network.read"],"allowedHosts":["prod-api.internal"]}'></textarea>
        </div>
        <div class="cfg-actions">
          <button class="btn btn-primary" id="auto-pack-upsert">Save Profile</button>
          <span id="auto-pack-status" class="cfg-save-status"></span>
        </div>
      </details>

    </div>
  `;
}

// ─── Event binding ──────────────────────────────────────

function bindEvents(container, ctx) {
  const { automations, tools, packs, agents } = ctx;

  // Refresh
  container.querySelector('#auto-refresh')?.addEventListener('click', () => renderAutomations(container));

  const executionFilterForm = container.querySelector('#auto-execution-filter-form');
  executionFilterForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    automationUiState.timelineFilters = {
      continuityKey: normalizeTimelineFilterValue(container.querySelector('#auto-timeline-continuity-key')?.value),
      activeExecutionRef: normalizeTimelineFilterValue(container.querySelector('#auto-timeline-active-exec-ref')?.value),
    };
    void renderAutomationsPreserveScroll(container);
  });

  container.querySelector('#auto-execution-filter-clear')?.addEventListener('click', () => {
    automationUiState.timelineFilters = {
      continuityKey: '',
      activeExecutionRef: '',
    };
    const continuityInput = container.querySelector('#auto-timeline-continuity-key');
    const activeExecutionInput = container.querySelector('#auto-timeline-active-exec-ref');
    if (continuityInput) continuityInput.value = '';
    if (activeExecutionInput) activeExecutionInput.value = '';
    void renderAutomationsPreserveScroll(container);
  });

  // Catalog search
  const catalogSearch = container.querySelector('#auto-catalog-search');
  catalogSearch?.addEventListener('input', () => {
    const q = (catalogSearch.value || '').toLowerCase();
    container.querySelectorAll('.auto-catalog-row').forEach((row) => {
      if (row.classList.contains('wf-pipeline-row')) return; // pipeline detail rows follow their parent
      const text = (row.textContent || '').toLowerCase();
      const match = !q || text.includes(q);
      row.style.display = match ? '' : 'none';
      // Also hide/show the associated pipeline detail row
      const autoId = row.getAttribute('data-auto-id');
      if (autoId) {
        const pipelineRow = container.querySelector(`#auto-pipeline-${CSS.escape(autoId)}`);
        if (pipelineRow) pipelineRow.classList.toggle('wf-filtered-out', !match);
      }
    });
  });

  // Column sorting
  let currentSort = { key: '', dir: 'asc' };
  container.querySelectorAll('.auto-sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort = { key, dir: 'asc' };
      }
      // Update arrows
      container.querySelectorAll('.auto-sortable .auto-sort-arrow').forEach((arrow) => { arrow.textContent = ''; });
      th.querySelector('.auto-sort-arrow').textContent = currentSort.dir === 'asc' ? ' \u25B2' : ' \u25BC';

      const catalogTable = container.querySelector('#auto-catalog-table tbody');
      if (!catalogTable) return;
      const rows = Array.from(catalogTable.querySelectorAll('tr.auto-catalog-row:not(.wf-pipeline-row)'));
      rows.sort((a, b) => {
        const valA = getSortValue(a, key);
        const valB = getSortValue(b, key);
        const cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
        return currentSort.dir === 'asc' ? cmp : -cmp;
      });
      // Re-append rows in sorted order (each main row followed by its pipeline row if any)
      for (const row of rows) {
        catalogTable.appendChild(row);
        const autoId = row.getAttribute('data-auto-id');
        if (autoId) {
          const pipelineRow = container.querySelector(`#auto-pipeline-${CSS.escape(autoId)}`);
          if (pipelineRow) catalogTable.appendChild(pipelineRow);
        }
      }
    });
  });

  function getSortValue(row, key) {
    switch (key) {
      case 'name': return row.querySelector('.ops-task-title')?.textContent?.trim() || '';
      case 'type': return row.querySelector('.auto-kind-badge')?.textContent?.trim() || '';
      case 'schedule': return row.querySelector('.auto-schedule-cell .ops-task-title')?.textContent?.trim() || '';
      case 'status': return row.querySelector('.badge')?.textContent?.trim() || '';
      default: return '';
    }
  }

  // Category filter
  container.querySelectorAll('.wf-category-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cat = chip.getAttribute('data-category');
      container.querySelectorAll('.wf-category-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      container.querySelectorAll('.auto-catalog-row').forEach((row) => {
        const match = cat === 'all' || row.getAttribute('data-category') === cat;
        if (row.classList.contains('wf-pipeline-row')) {
          row.classList.toggle('wf-filtered-out', !match);
        } else {
          row.style.display = match ? '' : 'none';
        }
      });
    });
  });

  // Create/edit form
  const formController = bindCreateForm(container, { tools, packs, agents });

  container.querySelectorAll('.auto-edit').forEach((button) => {
    button.addEventListener('click', () => {
      const autoId = button.getAttribute('data-auto-id');
      const auto = automations.find((item) => item.id === autoId);
      if (!auto) return;
      if (formController.isEditingInline(autoId)) {
        formController.closeEditor();
        return;
      }
      formController.editAutomation(auto);
    });
  });

  // Pipeline expand/collapse
  container.querySelectorAll('.auto-pipeline-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const autoId = btn.getAttribute('data-auto-id');
      const row = container.querySelector(`#auto-pipeline-${autoId}`);
      if (!row) return;
      const isVisible = row.classList.contains('visible');
      row.classList.toggle('visible', !isVisible);
      btn.classList.toggle('expanded', !isVisible);
    });
  });

  // Enable/disable toggle
  container.querySelectorAll('.auto-toggle').forEach((toggle) => {
    toggle.addEventListener('change', async () => {
      const autoId = toggle.getAttribute('data-auto-id');
      const auto = automations.find((a) => a.id === autoId);
      if (!auto) return;
      toggle.disabled = true;
      try {
        requireAutomationMutationSuccess(
          await api.setAutomationEnabled(auto.id, toggle.checked),
          `Could not ${toggle.checked ? 'enable' : 'disable'} '${auto.name}'.`,
        );
        await renderAutomationsPreserveScroll(container);
        setAutomationActionStatus(container, `${toggle.checked ? 'Enabled' : 'Disabled'} '${auto.name}'.`, 'success');
      } catch (err) {
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
        setAutomationActionStatus(container, err instanceof Error ? err.message : String(err), 'error');
      }
    });
  });

  // Run / Dry Run
  container.querySelectorAll('.auto-run, .auto-dryrun').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const auto = automations.find((a) => a.id === autoId);
      if (!auto) return;

      const dryRun = button.classList.contains('auto-dryrun');
      button.disabled = true;
      button.textContent = dryRun ? 'Running dry...' : 'Running...';
      try {
        const result = await api.runAutomation(auto.id, {
          dryRun,
          origin: 'web',
          channel: 'web',
          userId: 'web-user',
          requestedBy: 'web-user',
        });
        if (auto.sourceKind === 'task' && !auto.workflow) {
          button.textContent = result.success ? 'Done' : 'Failed';
        } else {
          const resultsDiv = container.querySelector('#auto-run-results');
          if (resultsDiv && result.run) {
            const runOutputHandling = normalizeOutputHandling(result.run.outputHandling);
            resultsDiv.innerHTML = `
              <div style="margin-top:0.75rem;padding:1rem;background:var(--bg-secondary);border-radius:0">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                  <strong>${esc(result.run.automationName || result.run.playbookName || autoId)}</strong>
                  <span style="color:${result.success ? 'var(--success)' : 'var(--error)'}">${esc(result.status)} (${result.run.durationMs}ms)</span>
                </div>
                <div style="margin-bottom:0.5rem">${renderOutputHandlingBadges(runOutputHandling, result.run.promotedFindings || [])}</div>
                ${renderRunOutputContent({
                  name: result.run.automationName || result.run.playbookName || auto.name,
                  status: result.status,
                  message: result.run.message,
                  steps: result.run.steps || [],
                  promotedFindings: result.run.promotedFindings || [],
                  storedOutput: result.run.storedOutput,
                  memoryPromotion: result.run.memoryPromotion,
                })}
              </div>
            `;
          }
          automationUiState.tabs?.switchTo('output');
          automationUiState.activeTab = 'output';
          button.textContent = dryRun ? 'Dry Run' : 'Run';
        }
        setTimeout(() => renderAutomationsPreserveScroll(container), 900);
      } catch (err) {
        const resultsDiv = container.querySelector('#auto-run-results');
        if (resultsDiv) {
          resultsDiv.innerHTML = `<div style="color:var(--error);padding:0.5rem">${esc(err instanceof Error ? err.message : String(err))}</div>`;
        }
        button.disabled = false;
        button.textContent = dryRun ? 'Dry Run' : 'Run';
      }
    });
  });

  // Create copy / use example
  container.querySelectorAll('.auto-create-copy').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const auto = automations.find((a) => a.id === autoId);
      if (!auto) return;

      const actionLabel = auto.builtin ? 'Use Example' : 'Create Copy';
      button.disabled = true;
      button.textContent = `${actionLabel}...`;
      try {
        const result = requireAutomationMutationSuccess(
          await api.createAutomation(auto.id),
          `Could not ${auto.builtin ? 'create' : 'copy'} '${auto.name}'.`,
        );
        automationUiState.placement = {
          anchorId: auto.builtin ? null : auto.id,
          automationId: result.automationId || auto.id,
        };

        await renderAutomations(container);
        setAutomationActionStatus(container, result.message || `${actionLabel}ed '${auto.name}'.`, 'success');

        // Highlight + scroll to the affected row
        setTimeout(() => {
          const targetId = automationUiState.placement?.automationId || auto.id;
          const newRow = container.querySelector(`tr[data-auto-id="${targetId}"]`);
          if (newRow) {
            newRow.classList.add('auto-clone-highlight');
            newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
          automationUiState.placement = null;
        }, 100);
      } catch (err) {
        automationUiState.placement = null;
        button.disabled = false;
        button.textContent = actionLabel;
        setAutomationActionStatus(container, err instanceof Error ? err.message : String(err), 'error');
      }
    });
  });

  // Delete
  container.querySelectorAll('.auto-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const label = button.getAttribute('data-label') || autoId;
      const auto = automations.find((a) => a.id === autoId);
      if (!auto || !confirm(`Delete automation '${label}'?`)) return;

      try {
        requireAutomationMutationSuccess(
          await api.deleteAutomation(auto.id),
          `Could not delete '${label}'.`,
        );
        await renderAutomationsPreserveScroll(container);
        setAutomationActionStatus(container, `Deleted '${label}'.`, 'success');
      } catch (err) {
        setAutomationActionStatus(container, err instanceof Error ? err.message : String(err), 'error');
      }
    });
  });

  // Run details toggle
  container.querySelectorAll('.auto-run-details').forEach((button) => {
    button.addEventListener('click', () => {
      const runId = button.getAttribute('data-run-id');
      const row = container.querySelector(`#auto-run-detail-${runId}`);
      if (!row) return;
      const visible = row.style.display !== 'none';
      row.style.display = visible ? 'none' : '';
      button.textContent = visible ? 'View Output' : 'Hide Output';
    });
  });

  // Inline config save
  container.querySelectorAll('.auto-config-save').forEach((button) => {
    button.addEventListener('click', async () => {
      const autoId = button.getAttribute('data-auto-id');
      const auto = automations.find((entry) => entry.id === autoId);
      const textarea = container.querySelector(`.wf-config-json-editor[data-auto-id="${autoId}"]`);
      const statusEl = container.querySelector(`.auto-config-save-status[data-auto-id="${autoId}"]`);
      if (!textarea || !statusEl) return;
      if (!auto?.workflow) {
        statusEl.textContent = 'Only step-based automations support raw definition editing.';
        statusEl.style.color = 'var(--error)';
        return;
      }
      if (auto.builtin) {
        statusEl.textContent = 'Create a copy of this starter example before editing it.';
        statusEl.style.color = 'var(--warning)';
        return;
      }
      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = requireAutomationMutationSuccess(
          await api.saveAutomationDefinition(auto.id, JSON.parse(textarea.value.trim())),
          `Could not save '${auto.name}'.`,
        );
        statusEl.textContent = result.message || (result.success ? 'Saved.' : 'Failed.');
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
        if (result.success) setTimeout(() => renderAutomationsPreserveScroll(container), 500);
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });
  });

  // Engine settings
  bindEngineSettings(container, ctx);
}

function bindCreateForm(container, { tools, packs, agents }) {
  const createToggle = container.querySelector('#auto-create-toggle');
  const createForm = container.querySelector('#auto-create-form');
  const titleEl = container.querySelector('#auto-form-title');
  const subtitleEl = container.querySelector('#auto-form-subtitle');
  const saveButton = container.querySelector('#auto-create-save');
  const statusEl = container.querySelector('#auto-create-status');
  const idField = container.querySelector('#auto-id-field');
  const idInput = container.querySelector('#auto-create-id');
  const nameInput = container.querySelector('#auto-create-name');
  const descriptionInput = container.querySelector('#auto-create-description');
  const modeSelect = container.querySelector('#auto-create-mode');
  const enabledSelect = container.querySelector('#auto-create-enabled');
  const singleToolSelect = container.querySelector('#auto-single-tool-select');
  const scheduleCheck = container.querySelector('#auto-schedule-enabled');
  const scheduleSection = container.querySelector('#auto-schedule-section');
  const runOnceCheck = container.querySelector('#auto-run-once');
  const argsInput = container.querySelector('#auto-create-args');
  const argsField = argsInput?.closest('.cfg-field');
  const eventInput = container.querySelector('#auto-create-event');
  const outputNotifySelect = container.querySelector('#auto-output-notify');
  const outputSecuritySelect = container.querySelector('#auto-output-security');
  const outputStoreEnabledCheck = container.querySelector('#auto-output-store-enabled');
  const agentModeCheck = container.querySelector('#auto-agent-mode');
  const assistantFields = container.querySelector('#auto-assistant-fields');
  const agentSelect = container.querySelector('#auto-agent-select');
  const agentChannelSelect = container.querySelector('#auto-agent-channel');
  const agentPromptInput = container.querySelector('#auto-agent-prompt');
  const agentDeliverCheck = container.querySelector('#auto-agent-deliver');
  const editIdInput = container.querySelector('#auto-edit-id');
  const editSourceInput = container.querySelector('#auto-edit-source');
  const editTaskIdInput = container.querySelector('#auto-edit-task-id');
  const defaultFormMarker = document.createElement('div');
  let activeInlineAutoId = null;
  createForm.insertAdjacentElement('afterend', defaultFormMarker);

  function updateSingleToolDisplay(toolName) {
    const displayEl = container.querySelector('#auto-single-tool-display');
    if (displayEl) displayEl.textContent = toolName || 'No tool selected';
  }

  function ensureAssistantModeOption(enabled) {
    const existing = modeSelect.querySelector('option[value="assistant"]');
    if (enabled) {
      if (!existing) {
        const option = document.createElement('option');
        option.value = 'assistant';
        option.textContent = 'Assistant Automation';
        modeSelect.appendChild(option);
      }
      return;
    }
    if (existing) existing.remove();
  }

  function setFormMode(mode, subtitle) {
    titleEl.textContent = mode;
    subtitleEl.textContent = subtitle;
    saveButton.textContent = mode === 'Edit Automation' ? 'Save Changes' : 'Create Automation';
  }

  function setIdReadOnly(readOnly) {
    idInput.readOnly = readOnly;
    idInput.style.opacity = readOnly ? '0.7' : '1';
    idInput.style.cursor = readOnly ? 'not-allowed' : '';
  }

  function clearStatus() {
    statusEl.textContent = '';
    statusEl.style.color = 'var(--text-muted)';
  }

  function removeInlineEditorRow() {
    const row = container.querySelector('.auto-inline-editor-row');
    if (row) row.remove();
  }

  function restoreFormHome() {
    if (createForm.parentElement !== defaultFormMarker.parentElement || createForm.nextElementSibling !== defaultFormMarker) {
      defaultFormMarker.parentElement.insertBefore(createForm, defaultFormMarker);
    }
    createForm.classList.remove('auto-create-form-inline');
    activeInlineAutoId = null;
  }

  function closeEditor() {
    restoreFormHome();
    removeInlineEditorRow();
    createForm.style.display = 'none';
    createToggle.textContent = 'Create Automation';
    resetFormState();
  }

  function attachFormInline(auto) {
    restoreFormHome();
    removeInlineEditorRow();

    const baseRow = container.querySelector(`tr[data-auto-id="${auto.id}"]`);
    const pipelineRow = container.querySelector(`#auto-pipeline-${auto.id}`);
    const anchorRow = pipelineRow || baseRow;
    if (!anchorRow) return false;

    const inlineRow = document.createElement('tr');
    inlineRow.className = 'auto-inline-editor-row auto-catalog-row';
    inlineRow.setAttribute('data-category', auto.category || 'uncategorized');
    inlineRow.innerHTML = `
      <td colspan="6" class="auto-inline-editor-cell">
        <div class="auto-inline-editor-host"></div>
      </td>
    `;
    anchorRow.insertAdjacentElement('afterend', inlineRow);
    inlineRow.querySelector('.auto-inline-editor-host')?.appendChild(createForm);
    createForm.classList.add('auto-create-form-inline');
    createForm.style.display = '';
    activeInlineAutoId = auto.id;
    return true;
  }

  function resetFormState() {
    editIdInput.value = '';
    editSourceInput.value = '';
    editTaskIdInput.value = '';
    setFormMode('Create Automation', 'Build a step-based automation, tool automation, or assistant automation.');
    setIdReadOnly(false);
    modeSelect.disabled = false;
    ensureAssistantModeOption(false);
    scheduleCheck.disabled = false;
    nameInput.value = '';
    idInput.value = '';
    descriptionInput.value = '';
    enabledSelect.value = 'true';
    singleToolSelect.value = '';
    argsInput.value = '';
    eventInput.value = '';
    if (agentModeCheck) agentModeCheck.checked = false;
    if (assistantFields) assistantFields.style.display = 'none';
    if (agentSelect) agentSelect.value = 'default';
    if (agentChannelSelect) agentChannelSelect.value = 'scheduled';
    if (agentPromptInput) agentPromptInput.value = '';
    if (agentDeliverCheck) agentDeliverCheck.checked = true;
    if (llmProviderSelect) llmProviderSelect.value = 'auto';
    const singlePromptReset = container.querySelector('#auto-single-prompt');
    if (singlePromptReset) singlePromptReset.value = '';
    // Reset tool display spans and param panels
    const singleToolDisplay = container.querySelector('#auto-single-tool-display');
    if (singleToolDisplay) singleToolDisplay.textContent = 'No tool selected';
    const stepToolDisplay = container.querySelector('#auto-step-tool-display');
    if (stepToolDisplay) stepToolDisplay.textContent = 'No tool selected';
    const stp = container.querySelector('#auto-single-tool-params');
    if (stp) { stp.innerHTML = ''; stp.style.display = 'none'; }
    const stpp = container.querySelector('#auto-step-tool-params');
    if (stpp) { stpp.innerHTML = ''; stpp.style.display = 'none'; }
    outputNotifySelect.value = 'off';
    outputSecuritySelect.value = 'off';
    if (outputStoreEnabledCheck) outputStoreEnabledCheck.checked = true;
    modeSelect.value = 'single';
    scheduleCheck.checked = false;
    scheduleCheck.disabled = false;
    if (runOnceCheck) runOnceCheck.checked = false;
    scheduleSection.style.display = 'none';
    applyScheduleToForm(container, parseCronToSchedule(''));
    wfSteps.splice(0, wfSteps.length);
    renderStepList();
    updateModeVisibility();
    updateScheduleFields(container);
    updateSchedulePreview(container);
    preflightBypass = false;
    preflightPolicySnapshot = { allowedPaths: [], allowedCommands: [], allowedDomains: [] };
    if (preflightPanel) { preflightPanel.style.display = 'none'; preflightPanel.innerHTML = ''; }
    clearStatus();
  }

  function openCreateMode() {
    resetFormState();
    restoreFormHome();
    removeInlineEditorRow();
    createForm.style.display = '';
    createToggle.textContent = 'Close';
  }

  createToggle?.addEventListener('click', () => {
    if (activeInlineAutoId) {
      openCreateMode();
      return;
    }
    const isOpen = createForm.style.display !== 'none';
    if (isOpen) {
      closeEditor();
      return;
    }
    openCreateMode();
  });

  container.querySelector('#auto-create-cancel')?.addEventListener('click', () => {
    closeEditor();
  });

  // Auto-generate ID from name
  nameInput?.addEventListener('input', () => {
    if (idInput.readOnly) return;
    const name = nameInput.value;
    idInput.value = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  });

  // Mode switch — show/hide single vs pipeline sections
  const singleSection = container.querySelector('#auto-single-tool-section');
  const pipelineSection = container.querySelector('#auto-pipeline-section');

  function updateModeVisibility() {
    const mode = modeSelect.value;
    const isAgentMode = scheduleCheck.checked && agentModeCheck?.checked;
    singleSection.style.display = !isAgentMode && mode === 'single' ? '' : 'none';
    pipelineSection.style.display = !isAgentMode && mode !== 'single' ? '' : 'none';
    if (argsField) argsField.style.display = !isAgentMode && mode === 'single' ? '' : 'none';
    // Update pipeline label: "Tasks" for parallel, "Steps" for sequential
    const stepLabel = container.querySelector('#auto-pipeline-label');
    if (stepLabel) stepLabel.textContent = mode === 'parallel' ? 'Tasks' : 'Steps';
    // ID field always visible
    // Schedule section controlled by checkbox only
    scheduleCheck.disabled = false;
    scheduleSection.style.display = scheduleCheck.checked ? '' : 'none';
  }
  modeSelect?.addEventListener('change', updateModeVisibility);
  updateModeVisibility();

  // Schedule toggle
  scheduleCheck?.addEventListener('change', () => {
    scheduleSection.style.display = scheduleCheck.checked ? '' : 'none';
    updateModeVisibility();
  });

  // Agent mode toggle (inside schedule section)
  agentModeCheck?.addEventListener('change', () => {
    if (assistantFields) assistantFields.style.display = agentModeCheck.checked ? '' : 'none';
    updateModeVisibility();
  });

  // Schedule field visibility
  const scheduleKind = container.querySelector('#auto-schedule-kind');
  scheduleKind?.addEventListener('change', () => {
    const mode = scheduleKind.value;
    const intervalInput = container.querySelector('#auto-interval');
    const currentInterval = Number(intervalInput.value);
    if (mode === 'every_minutes' && currentInterval === 2) intervalInput.value = '30';
    else if (mode === 'every_hours' && currentInterval === 30) intervalInput.value = '2';
    updateScheduleFields(container);
    updateSchedulePreview(container);
  });

  ['#auto-interval', '#auto-minute', '#auto-time', '#auto-weekday', '#auto-cron-custom'].forEach((sel) => {
    container.querySelector(sel)?.addEventListener('input', () => updateSchedulePreview(container));
    container.querySelector(sel)?.addEventListener('change', () => updateSchedulePreview(container));
  });
  runOnceCheck?.addEventListener('change', () => updateSchedulePreview(container));

  updateScheduleFields(container);
  updateSchedulePreview(container);

  // Step builder for pipeline mode
  const stepList = container.querySelector('#auto-step-list');
  const stepToolSelect = container.querySelector('#auto-step-tool-select');
  const wfSteps = [];

  function renderStepList() {
    if (wfSteps.length === 0) {
      stepList.innerHTML = '<div style="font-size:0.8rem;color:var(--text-muted);padding:0.5rem 0;">No steps added yet.</div>';
      return;
    }
    stepList.innerHTML = wfSteps.map((step, i) => {
      const isInstruction = step.type === 'instruction';
      const isDelay = step.type === 'delay';
      const tool = !isInstruction && !isDelay ? tools.find((t) => t.name === step.toolName) : null;
      const label = isDelay ? formatDelayMs(step.delayMs || 0) : isInstruction ? 'LLM Instruction' : esc(step.toolName);
      const stepArgKeys = !isInstruction && !isDelay && step.args ? Object.keys(step.args).filter((k) => step.args[k] != null && step.args[k] !== '') : [];
      const argSummary = stepArgKeys.length > 0
        ? stepArgKeys.map((k) => `${k}=${summarizeArgValue(k, step.args[k])}`).join(', ')
        : '';
      const desc = isDelay
        ? 'Pause pipeline'
        : isInstruction
          ? esc(step.instruction || '(no instruction)')
          : argSummary
            ? esc(argSummary)
            : esc(tool?.shortDescription || tool?.description || '');
      const badge = isDelay
        ? '<span class="badge badge-warning" style="font-size:0.65rem;margin-right:0.3rem;">&#9202;</span>'
        : isInstruction
          ? '<span class="badge badge-info" style="font-size:0.65rem;margin-right:0.3rem;">LLM</span>'
          : '';
      return `
        <div class="wf-step-row" data-index="${i}">
          <span class="wf-step-number">${i + 1}</span>
          <span class="wf-step-name">${badge}${label}</span>
          <span class="wf-step-desc">${desc}</span>
          <div class="wf-step-actions">
            <button class="btn btn-secondary btn-sm auto-step-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
            <button class="btn btn-secondary btn-sm auto-step-down" data-index="${i}" ${i === wfSteps.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
            <button class="btn btn-secondary btn-sm auto-step-remove" data-index="${i}" title="Remove">&times;</button>
          </div>
        </div>
      `;
    }).join('');

    stepList.querySelectorAll('.auto-step-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (idx > 0) { [wfSteps[idx - 1], wfSteps[idx]] = [wfSteps[idx], wfSteps[idx - 1]]; renderStepList(); }
      });
    });
    stepList.querySelectorAll('.auto-step-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (idx < wfSteps.length - 1) { [wfSteps[idx], wfSteps[idx + 1]] = [wfSteps[idx + 1], wfSteps[idx]]; renderStepList(); }
      });
    });
    stepList.querySelectorAll('.auto-step-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        wfSteps.splice(Number(btn.dataset.index), 1);
        renderStepList();
      });
    });
  }
  renderStepList();

  // Step type toggle: show tool selector or instruction input.
  const stepTypeSelect = container.querySelector('#auto-step-type-select');
  const stepToolField = container.querySelector('#auto-step-tool-field');
  const stepInstructionField = container.querySelector('#auto-step-instruction-field');
  const stepInstructionInput = container.querySelector('#auto-step-instruction-input');

  const stepDelayField = container.querySelector('#auto-step-delay-field');
  const stepCancelButton = container.querySelector('#auto-step-cancel');
  const stepToolPickerPanel = container.querySelector('#auto-step-tool-picker-panel');
  const stepToolParamsPanel = container.querySelector('#auto-step-tool-params');

  function resetPendingStepDraft() {
    if (stepToolSelect) stepToolSelect.value = '';
    const stepToolDisplay = container.querySelector('#auto-step-tool-display');
    if (stepToolDisplay) stepToolDisplay.textContent = 'No tool selected';
    if (stepToolPickerPanel) {
      stepToolPickerPanel.style.display = 'none';
      stepToolPickerPanel.innerHTML = '';
    }
    if (stepToolParamsPanel) {
      stepToolParamsPanel.innerHTML = '';
      stepToolParamsPanel.style.display = 'none';
    }
    if (stepInstructionInput) stepInstructionInput.value = '';
    const delayValueInput = container.querySelector('#auto-step-delay-value');
    const delayUnitInput = container.querySelector('#auto-step-delay-unit');
    if (delayValueInput) delayValueInput.value = '5';
    if (delayUnitInput) delayUnitInput.value = 'minutes';
    clearStatus();
  }

  stepTypeSelect?.addEventListener('change', () => {
    const val = stepTypeSelect.value;
    if (stepToolField) stepToolField.style.display = val === 'tool' ? '' : 'none';
    if (stepInstructionField) stepInstructionField.style.display = val === 'instruction' ? '' : 'none';
    if (stepDelayField) stepDelayField.style.display = val === 'delay' ? '' : 'none';
  });

  stepCancelButton?.addEventListener('click', () => {
    resetPendingStepDraft();
  });

  container.querySelector('#auto-step-add')?.addEventListener('click', () => {
    const stepType = stepTypeSelect?.value || 'tool';
    const mode = modeSelect.value;

    if (mode === 'parallel' && stepType === 'instruction') {
      statusEl.textContent = 'Instruction steps are only supported in sequential pipelines.';
      statusEl.style.color = 'var(--error)';
      return;
    }
    if (mode === 'parallel' && stepType === 'delay') {
      statusEl.textContent = 'Delay steps are only supported in sequential pipelines.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    if (stepType === 'instruction') {
      const instruction = stepInstructionInput?.value?.trim();
      if (!instruction) return;
      wfSteps.push({
        id: `step-${wfSteps.length + 1}`,
        type: 'instruction',
        name: 'LLM Instruction',
        packId: '',
        toolName: '',
        instruction,
      });
      if (stepInstructionInput) stepInstructionInput.value = '';
    } else if (stepType === 'delay') {
      const delayVal = Number(container.querySelector('#auto-step-delay-value')?.value) || 5;
      const delayUnit = container.querySelector('#auto-step-delay-unit')?.value || 'minutes';
      const delayMs = delayToMs(delayVal, delayUnit);
      if (delayMs <= 0) return;
      wfSteps.push({
        id: `step-${wfSteps.length + 1}`,
        type: 'delay',
        name: 'Delay',
        packId: '',
        toolName: '',
        delayMs,
      });
    } else {
      const toolName = stepToolSelect.value;
      if (!toolName) return;
      const { args: stepArgs, errors } = readToolParamValues(stepToolParamsPanel);
      if (errors.length > 0) {
        statusEl.textContent = errors[0];
        statusEl.style.color = 'var(--error)';
        return;
      }
      wfSteps.push({ id: `step-${wfSteps.length + 1}`, name: toolName, packId: '', toolName, args: stepArgs });
      resetPendingStepDraft();
    }
    renderStepList();
    clearStatus();
  });

  // Tool picker browse buttons
  const singleToolPickerPanel = container.querySelector('#auto-single-tool-picker-panel');
  const singleToolParamsPanel = container.querySelector('#auto-single-tool-params');
  container.querySelector('#auto-single-tool-browse')?.addEventListener('click', () => {
    if (singleToolPickerPanel?.style.display !== 'none' && singleToolPickerPanel?.innerHTML) {
      singleToolPickerPanel.style.display = 'none';
      singleToolPickerPanel.innerHTML = '';
      return;
    }
    renderToolPicker(singleToolPickerPanel, tools, singleToolSelect, (toolName) => {
      const tool = tools.find((t) => t.name === toolName);
      renderToolParamFields(singleToolParamsPanel, tool, {});
    });
  });

  container.querySelector('#auto-step-tool-browse')?.addEventListener('click', () => {
    if (stepToolPickerPanel?.style.display !== 'none' && stepToolPickerPanel?.innerHTML) {
      stepToolPickerPanel.style.display = 'none';
      stepToolPickerPanel.innerHTML = '';
      return;
    }
    renderToolPicker(stepToolPickerPanel, tools, stepToolSelect, (toolName) => {
      const tool = tools.find((t) => t.name === toolName);
      renderToolParamFields(stepToolParamsPanel, tool, {});
    });
  });

  // LLM provider selector
  const llmProviderSelect = container.querySelector('#auto-llm-provider');

  // Pre-flight validation panel
  const preflightPanel = container.querySelector('#auto-preflight-panel');
  let preflightBypass = false;
  let preflightPolicySnapshot = { allowedPaths: [], allowedCommands: [], allowedDomains: [] };

  async function runPreflightCheck(requests) {
    if (!preflightPanel || requests.length === 0) return true;
    try {
      const data = await api.preflightTools({ requests });
      preflightPolicySnapshot = {
        allowedPaths: Array.isArray(data.policy?.allowedPaths) ? data.policy.allowedPaths.slice() : [],
        allowedCommands: Array.isArray(data.policy?.allowedCommands) ? data.policy.allowedCommands.slice() : [],
        allowedDomains: Array.isArray(data.policy?.allowedDomains) ? data.policy.allowedDomains.slice() : [],
      };
      const issues = (data.results || []).filter((r) => r.decision !== 'allow');
      if (issues.length === 0) {
        preflightPanel.style.display = 'none';
        preflightPanel.innerHTML = '';
        return true;
      }
      renderPreflightResults(issues, data.policy?.mode || 'approve_by_policy');
      return false;
    } catch {
      // If preflight API unavailable, allow save
      return true;
    }
  }

  function continueSaveAfterPreflight() {
    preflightBypass = true;
    preflightPanel.style.display = 'none';
    container.querySelector('#auto-create-save')?.click();
  }

  function renderPreflightResults(issues, policyMode) {
    preflightPanel.style.display = '';
    preflightPanel.innerHTML = `
      <div style="border:1px solid var(--warning);border-radius:0;padding:0.75rem;background:color-mix(in srgb, var(--warning) 6%, var(--bg-surface));">
        <div style="font-weight:600;font-size:0.85rem;margin-bottom:0.5rem;color:var(--warning);">Approval Check</div>
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.5rem;">
          These tools are blocked by current approval or sandbox policy.
          Policy mode: <strong>${esc(policyMode)}</strong>. Fix each one to allow unattended execution.
        </div>
        ${issues.map((issue) => `
          <div class="auto-preflight-issue" style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;border-top:1px solid var(--border);font-size:0.78rem;">
            <span style="color:${issue.decision === 'deny' ? 'var(--error)' : 'var(--warning)'};font-weight:600;min-width:14px;">
              ${issue.decision === 'deny' ? '&#10007;' : '&#9888;'}
            </span>
            <span style="font-weight:500;min-width:120px;flex-shrink:0;">${esc(issue.name)}</span>
            <span style="flex:1;color:var(--text-muted);font-size:0.72rem;">${esc(issue.reason)}</span>
            ${issue.fixes && issue.fixes.length > 0 ? issue.fixes.map((fix) => `
              <button class="btn btn-primary btn-sm auto-preflight-fix"
                data-fix-type="${escAttr(fix.type)}"
                data-fix-value="${escAttr(fix.value)}"
                style="white-space:nowrap;font-size:0.7rem;padding:0.2rem 0.5rem;">
                ${esc(preflightFixLabel(fix.type))}
              </button>
            `).join('') : ''}
          </div>
        `).join('')}
        <div style="margin-top:0.5rem;display:flex;gap:0.5rem;align-items:center;">
          <button class="btn btn-secondary btn-sm" id="auto-preflight-skip" style="font-size:0.72rem;">
            Save anyway (approval needed each run)
          </button>
          <span style="font-size:0.7rem;color:var(--text-muted);">
            Or fix issues above to enable unattended execution.
          </span>
        </div>
      </div>
    `;

    // Fix button handlers — add per-tool auto policy
    preflightPanel.querySelectorAll('.auto-preflight-fix').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fixType = btn.getAttribute('data-fix-type');
        const fixValue = btn.getAttribute('data-fix-value');
        btn.disabled = true;
        btn.textContent = 'Applying...';
        try {
          if (fixType === 'tool_policy') {
            const result = await api.updateToolPolicy({
              toolPolicies: { [fixValue]: 'auto' },
            });
            if (result.success) {
              btn.textContent = 'Applied';
              btn.style.background = 'var(--success)';
              btn.style.borderColor = 'var(--success)';
              // Mark the issue as resolved visually
              const issueRow = btn.closest('.auto-preflight-issue');
              if (issueRow) {
                issueRow.querySelector('span').innerHTML = '&#10003;';
                issueRow.querySelector('span').style.color = 'var(--success)';
              }
              // Re-run preflight to check if all fixed
              const requests = collectFormToolRequests();
              const data = await api.preflightTools({ requests });
              const remaining = (data.results || []).filter((r) => r.decision !== 'allow');
              if (remaining.length === 0) {
                continueSaveAfterPreflight();
              }
            }
          } else if (fixType === 'domain' || fixType === 'path' || fixType === 'command') {
            const sandboxKey = fixType === 'domain' ? 'allowedDomains' : fixType === 'path' ? 'allowedPaths' : 'allowedCommands';
            const currentValues = Array.isArray(preflightPolicySnapshot[sandboxKey]) ? preflightPolicySnapshot[sandboxKey] : [];
            const nextValues = [...new Set([...currentValues, fixValue])];
            const result = await api.updateToolPolicy({
              sandbox: { [sandboxKey]: nextValues },
            });
            if (result.success) {
              btn.textContent = 'Applied';
              btn.style.background = 'var(--success)';
              btn.style.borderColor = 'var(--success)';
              preflightPolicySnapshot[sandboxKey] = nextValues;
              const requests = collectFormToolRequests();
              const data = await api.preflightTools({ requests });
              const remaining = (data.results || []).filter((r) => r.decision !== 'allow');
              if (remaining.length === 0) {
                continueSaveAfterPreflight();
              }
            }
          }
        } catch (err) {
          btn.textContent = 'Failed';
          btn.style.background = 'var(--error)';
        }
      });
    });

    // Skip button
    preflightPanel.querySelector('#auto-preflight-skip')?.addEventListener('click', () => {
      preflightBypass = true;
      preflightPanel.style.display = 'none';
      container.querySelector('#auto-create-save')?.click();
    });
  }

  function collectFormToolRequests() {
    const mode = modeSelect.value;
    const requests = [];
    if (mode === 'single') {
      const tool = singleToolSelect.value;
      if (tool) {
        const argsRaw = argsInput.value.trim();
        let jsonArgs = {};
        if (argsRaw) {
          try { jsonArgs = JSON.parse(argsRaw); } catch { jsonArgs = {}; }
        }
        const paramArgs = collectToolParamValues(singleToolParamsPanel);
        requests.push({ name: tool, args: { ...paramArgs, ...jsonArgs } });
      }
    } else {
      for (const step of wfSteps) {
        if (step.toolName && step.type !== 'instruction' && step.type !== 'delay') {
          requests.push({ name: step.toolName, args: step.args || {} });
        }
      }
    }
    return requests;
  }

  // Save
  container.querySelector('#auto-create-save')?.addEventListener('click', async () => {
    const editId = editIdInput.value.trim();
    const editTaskId = editTaskIdInput.value.trim();
    const id = idInput.value.trim();
    const name = nameInput.value.trim();
    const mode = modeSelect.value;
    const enabled = enabledSelect.value === 'true';
    const description = descriptionInput.value.trim();
    const scheduleEnabled = scheduleCheck.checked;
    const runOnce = runOnceCheck?.checked === true;
    const isAgentMode = scheduleEnabled && agentModeCheck?.checked;

    if (!name || (!isAgentMode && !id)) {
      statusEl.textContent = isAgentMode ? 'Name is required.' : 'Name and ID are required.';
      statusEl.style.color = 'var(--error)';
      return;
    }

    // Build steps (single / pipeline — no assistant branch)
    let steps = [];
    if (mode === 'single') {
      const toolName = singleToolSelect.value;
      if (!toolName) {
        statusEl.textContent = 'Select a tool.';
        statusEl.style.color = 'var(--error)';
        return;
      }
      // Collect args: dynamic param fields first, then JSON textarea as override
      const { args: paramArgs, errors: paramErrors } = readToolParamValues(singleToolParamsPanel);
      if (paramErrors.length > 0) {
        statusEl.textContent = paramErrors[0];
        statusEl.style.color = 'var(--error)';
        return;
      }
      let jsonArgs = {};
      const argsRaw = argsInput.value.trim();
      if (argsRaw) {
        try { jsonArgs = JSON.parse(argsRaw); } catch {
          statusEl.textContent = 'Tool inputs must be valid JSON.';
          statusEl.style.color = 'var(--error)';
          return;
        }
      }
      const args = { ...paramArgs, ...jsonArgs };
      steps = [{ id: `${id}-step-1`, name: toolName, packId: '', toolName, args }];
      // Optional prompt → auto-convert to 2-step sequential (tool + instruction)
      const singlePrompt = container.querySelector('#auto-single-prompt')?.value?.trim();
      if (singlePrompt) {
        const llmProv = llmProviderSelect?.value;
        const instrStep = {
          id: `${id}-step-2`,
          type: 'instruction',
          name: 'LLM Instruction',
          packId: '',
          toolName: '',
          instruction: singlePrompt,
        };
        if (llmProv && llmProv !== 'auto') instrStep.llmProvider = llmProv;
        steps.push(instrStep);
      }
    } else {
      if (wfSteps.length === 0) {
        statusEl.textContent = 'Add at least one step.';
        statusEl.style.color = 'var(--error)';
        return;
      }
      if (mode === 'parallel' && wfSteps.some((step) => step.type === 'instruction' || step.type === 'delay')) {
        statusEl.textContent = 'Parallel pipelines can only contain tool steps.';
        statusEl.style.color = 'var(--error)';
        return;
      }
      // Apply LLM provider to instruction steps
      const llmProv = llmProviderSelect?.value;
      steps = wfSteps.map((step, i) => {
        const base = { ...step, id: `${id}-step-${i + 1}`, packId: '' };
        if (base.type === 'instruction' && llmProv && llmProv !== 'auto') {
          base.llmProvider = llmProv;
        }
        return base;
      });
    }

    // Pre-flight approval check for scheduled automations
    if ((scheduleEnabled || editId || editTaskId) && !isAgentMode && !preflightBypass) {
      const requests = collectFormToolRequests();
      if (requests.length > 0) {
        statusEl.textContent = 'Checking approval requirements...';
        statusEl.style.color = 'var(--text-muted)';
        const pass = await runPreflightCheck(requests);
        if (!pass) {
          statusEl.textContent = 'Some tools require approval. Fix or skip above.';
          statusEl.style.color = 'var(--warning)';
          return;
        }
      }
    }
    preflightBypass = false;

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';

    try {
      const emitEvent = eventInput.value.trim() || undefined;
      const outputHandling = {
        notify: outputNotifySelect.value || 'off',
        sendToSecurity: outputSecuritySelect.value || 'off',
        persistArtifacts: outputStoreEnabledCheck?.checked === false
          ? 'run_history_only'
          : 'run_history_plus_memory',
      };
      const cron = scheduleEnabled ? buildCronFromForm(container) : '';

      if (scheduleEnabled && !cron) {
        statusEl.textContent = 'Choose a valid schedule.';
        statusEl.style.color = 'var(--error)';
        return;
      }

      const llmProv = llmProviderSelect?.value || 'auto';
      const singleToolName = singleToolSelect.value;
      const isExistingStandaloneTask = !!editTaskId && !isAgentMode && !editId;
      const saveInput = isAgentMode
        ? {
            id: editId || id,
            name,
            description,
            enabled,
            kind: 'assistant_task',
            sourceKind: editSourceInput.value.trim() || undefined,
            existingTaskId: editTaskId || undefined,
            task: {
              target: agentSelect?.value || 'default',
              prompt: agentPromptInput?.value?.trim() || '',
              channel: agentChannelSelect?.value || 'scheduled',
              deliver: agentDeliverCheck?.checked !== false,
              ...(llmProv && llmProv !== 'auto' ? { llmProvider: llmProv } : {}),
            },
            schedule: {
              enabled: scheduleEnabled,
              cron,
              runOnce,
            },
            emitEvent,
            outputHandling,
          }
        : isExistingStandaloneTask
          ? {
              id: editId || id,
              name,
              description,
              enabled,
              kind: 'standalone_task',
              sourceKind: editSourceInput.value.trim() || undefined,
              existingTaskId: editTaskId || undefined,
              task: {
                target: singleToolName,
                args: steps[0]?.args || {},
              },
              schedule: {
                enabled: scheduleEnabled,
                cron,
                runOnce,
              },
              emitEvent,
              outputHandling,
            }
          : {
              id: editId || id,
              name,
              description,
              enabled,
              kind: 'workflow',
              sourceKind: editSourceInput.value.trim() || undefined,
              existingTaskId: editTaskId || undefined,
              mode: mode === 'single' ? 'sequential' : mode,
              steps,
              schedule: {
                enabled: scheduleEnabled,
                cron,
                runOnce,
              },
              emitEvent,
              outputHandling,
            };

      const result = await api.saveAutomation(saveInput);
      if (!result.success) {
        statusEl.textContent = result.message || 'Failed.';
        statusEl.style.color = 'var(--error)';
        return;
      }

      statusEl.textContent = editId || editTaskId ? (result.message || 'Saved.') : 'Created.';
      statusEl.style.color = 'var(--success)';
      setTimeout(() => renderAutomationsPreserveScroll(container), 350);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  function editAutomation(auto) {
    const isStandaloneTask = auto.sourceKind === 'task' && !auto.workflow && auto.task;
    const isAgentTask = auto.task?.type === 'agent';
    const firstStep = auto.steps?.[0] || null;

    if (!attachFormInline(auto)) return;

    createToggle.textContent = 'Create Automation';
    setFormMode('Edit Automation', isAgentTask
      ? 'Editing a scheduled assistant automation. Schedule and assistant settings update in place.'
      : isStandaloneTask
        ? 'Editing a scheduled tool automation. Schedule and tool inputs update in place.'
        : 'Editing an existing automation. Existing step arguments and advanced settings are preserved.');
    clearStatus();

    editIdInput.value = auto.id || '';
    editSourceInput.value = isAgentTask ? 'agent_task' : (auto.sourceKind || '');
    editTaskIdInput.value = auto.task?.id || '';

    nameInput.value = auto.name || '';
    idInput.value = auto.id || '';
    descriptionInput.value = auto.description || '';
    enabledSelect.value = String(auto.enabled !== false);
    eventInput.value = auto.task?.emitEvent || '';
    outputNotifySelect.value = auto.outputHandling?.notify || 'off';
    outputSecuritySelect.value = auto.outputHandling?.sendToSecurity || 'off';
    if (outputStoreEnabledCheck) {
      outputStoreEnabledCheck.checked = (auto.outputHandling?.persistArtifacts || 'run_history_plus_memory') !== 'run_history_only';
    }
    if (runOnceCheck) runOnceCheck.checked = auto.runOnce === true;

    wfSteps.splice(0, wfSteps.length, ...(auto.steps || []).map((step) => ({
      ...step,
      args: step.args ? JSON.parse(JSON.stringify(step.args)) : {},
    })));

    // Detect LLM provider from instruction steps or agent task args
    const instrStep = (auto.steps || []).find((s) => s.type === 'instruction' && s.llmProvider);
    const detectedLlmProv = instrStep?.llmProvider || auto.task?.args?.llmProvider || '';
    if (llmProviderSelect) llmProviderSelect.value = detectedLlmProv || 'auto';

    // Detect single-tool-with-prompt pattern: 2 steps where step 2 is instruction
    const isSingleWithPrompt = !isAgentTask && !isStandaloneTask && auto.steps?.length === 2
      && (!auto.steps[0].type || auto.steps[0].type === 'tool')
      && auto.steps[1].type === 'instruction';

    const singlePromptEl = container.querySelector('#auto-single-prompt');

    if (isAgentTask) {
      ensureAssistantModeOption(true);
      modeSelect.value = 'assistant';
      modeSelect.disabled = false;
      // Check schedule toggle + agent mode toggle
      scheduleCheck.checked = true;
      scheduleSection.style.display = '';
      if (agentModeCheck) agentModeCheck.checked = true;
      if (assistantFields) assistantFields.style.display = '';
      if (agentSelect) agentSelect.value = auto.task.target || 'default';
      if (agentChannelSelect) agentChannelSelect.value = auto.task.channel || 'scheduled';
      if (agentPromptInput) agentPromptInput.value = auto.task.prompt || auto.agentPrompt || '';
      if (agentDeliverCheck) agentDeliverCheck.checked = auto.task.deliver !== false;
      descriptionInput.value = auto.task.description || auto.description || '';
      argsInput.value = '';
      enabledSelect.value = String(auto.task.enabled !== false);
      idInput.value = auto.id || '';
      setIdReadOnly(true);
      if (singlePromptEl) singlePromptEl.value = '';
    } else if (isStandaloneTask) {
      ensureAssistantModeOption(false);
      modeSelect.value = 'single';
      modeSelect.disabled = true;
      singleToolSelect.value = auto.task.target || '';
      updateSingleToolDisplay(auto.task.target || '');
      const editTool = tools.find((t) => t.name === auto.task.target);
      renderToolParamFields(singleToolParamsPanel, editTool, auto.task.args || {});
      argsInput.value = auto.task.args ? JSON.stringify(auto.task.args, null, 2) : '';
      scheduleCheck.checked = true;
      scheduleCheck.disabled = true;
      scheduleSection.style.display = '';
      enabledSelect.value = String(auto.task.enabled !== false);
      setIdReadOnly(true);
      if (singlePromptEl) singlePromptEl.value = '';
    } else if (isSingleWithPrompt) {
      // Show as single-tool mode with prompt populated
      modeSelect.disabled = false;
      modeSelect.value = 'single';
      singleToolSelect.value = auto.steps[0]?.toolName || '';
      updateSingleToolDisplay(auto.steps[0]?.toolName || '');
      const editTool = tools.find((t) => t.name === auto.steps[0]?.toolName);
      renderToolParamFields(singleToolParamsPanel, editTool, auto.steps[0]?.args || {});
      argsInput.value = auto.steps[0]?.args ? JSON.stringify(auto.steps[0].args, null, 2) : '';
      if (singlePromptEl) singlePromptEl.value = auto.steps[1].instruction || '';
      scheduleCheck.checked = !!auto.cron;
      scheduleCheck.disabled = false;
      scheduleSection.style.display = auto.cron ? '' : 'none';
      setIdReadOnly(true);
      wfSteps.splice(0, wfSteps.length); // clear pipeline steps for single mode
    } else {
      ensureAssistantModeOption(false);
      modeSelect.disabled = false;
      modeSelect.value = auto.kind === 'pipeline' ? auto.mode : 'single';
      singleToolSelect.value = firstStep?.toolName || '';
      updateSingleToolDisplay(firstStep?.toolName || '');
      if (auto.kind === 'single' && firstStep?.toolName) {
        const editTool = tools.find((t) => t.name === firstStep.toolName);
        renderToolParamFields(singleToolParamsPanel, editTool, firstStep?.args || {});
      }
      argsInput.value = auto.kind === 'single' && firstStep?.args ? JSON.stringify(firstStep.args, null, 2) : '';
      scheduleCheck.checked = !!auto.cron;
      scheduleCheck.disabled = false;
      scheduleSection.style.display = auto.cron ? '' : 'none';
      setIdReadOnly(true);
      if (singlePromptEl) singlePromptEl.value = '';
    }

    renderStepList();
    updateModeVisibility();
    applyScheduleToForm(container, parseCronToSchedule(auto.cron || ''));
    updateScheduleFields(container);
    updateSchedulePreview(container);
    createForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  resetFormState();
  return {
    closeEditor,
    editAutomation,
    isEditingInline: (autoId) => activeInlineAutoId === autoId,
  };
}

function bindEngineSettings(container, ctx) {
  const { packs } = ctx;

  // Toggle panel
  container.querySelector('#auto-engine-toggle')?.addEventListener('click', () => {
    const panel = container.querySelector('#auto-engine-panel');
    const arrow = container.querySelector('#auto-engine-arrow');
    if (!panel) return;
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : '';
    if (arrow) arrow.innerHTML = visible ? '&#9654; Show' : '&#9660; Hide';
  });

  // Save engine settings
  container.querySelector('#auto-engine-save')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#auto-engine-status');
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConnectorsSettings({
        enabled: container.querySelector('#auto-engine-enabled').value === 'true',
        executionMode: container.querySelector('#auto-engine-mode').value,
        maxConnectorCallsPerRun: Number(container.querySelector('#auto-max-calls').value),
        playbooks: {
          enabled: true,
          maxSteps: Number(container.querySelector('#auto-max-steps').value),
          maxParallelSteps: Number(container.querySelector('#auto-max-parallel').value),
          defaultStepTimeoutMs: Number(container.querySelector('#auto-step-timeout').value),
          requireSignedDefinitions: container.querySelector('#auto-require-signed').value === 'true',
          requireDryRunOnFirstExecution: container.querySelector('#auto-require-dryrun').value === 'true',
        },
      });
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  // Access profile upsert
  container.querySelector('#auto-pack-upsert')?.addEventListener('click', async () => {
    const statusEl = container.querySelector('#auto-pack-status');
    statusEl.textContent = 'Saving...';
    try {
      const raw = container.querySelector('#auto-pack-json').value.trim();
      const result = await api.upsertConnectorPack(JSON.parse(raw));
      statusEl.textContent = result.message;
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--error)';
      if (result.success) await renderAutomationsPreserveScroll(container);
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  // Access profile delete
  container.querySelectorAll('.auto-pack-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const packId = button.getAttribute('data-pack-id');
      if (!packId || !confirm(`Delete access profile '${packId}'?`)) return;
      await api.deleteConnectorPack(packId);
      await renderAutomationsPreserveScroll(container);
    });
  });

  // Access profile edit (load into textarea)
  container.querySelectorAll('.auto-pack-edit').forEach((button) => {
    button.addEventListener('click', () => {
      const packId = button.getAttribute('data-pack-id');
      const pack = packs.find((p) => p.id === packId);
      if (!pack) return;
      container.querySelector('#auto-pack-json').value = JSON.stringify(pack, null, 2);
    });
  });

}

// ─── Schedule helpers (ported from operations.js) ───────

function updateScheduleFields(container) {
  const mode = container.querySelector('#auto-schedule-kind')?.value;
  if (!mode) return;
  const intervalField = container.querySelector('#auto-interval-field');
  const minuteField = container.querySelector('#auto-minute-field');
  const timeField = container.querySelector('#auto-time-field');
  const weekdayField = container.querySelector('#auto-weekday-field');
  const customCronField = container.querySelector('#auto-custom-cron-field');

  if (intervalField) intervalField.style.display = mode === 'every_minutes' || mode === 'every_hours' ? '' : 'none';
  if (minuteField) minuteField.style.display = mode === 'every_hours' ? '' : 'none';
  if (timeField) timeField.style.display = mode === 'daily' || mode === 'weekdays' || mode === 'weekly' ? '' : 'none';
  if (weekdayField) weekdayField.style.display = mode === 'weekly' ? '' : 'none';
  if (customCronField) customCronField.style.display = mode === 'custom' ? '' : 'none';

  const intervalLabel = intervalField?.querySelector('label');
  if (intervalLabel) {
    intervalLabel.textContent = mode === 'every_minutes' ? 'Interval (minutes)' : mode === 'every_hours' ? 'Interval (hours)' : 'Interval';
  }
}

function updateSchedulePreview(container) {
  const previewEl = container.querySelector('#auto-schedule-preview');
  if (!previewEl) return;
  const cron = buildCronFromForm(container);
  const runOnce = container.querySelector('#auto-run-once')?.checked === true;
  if (!cron) {
    previewEl.textContent = 'Choose a valid schedule.';
    previewEl.style.color = 'var(--warning)';
    return;
  }
  previewEl.textContent = `${runOnce ? 'Single-shot preview' : 'Schedule preview'}: ${cronToHuman(cron, runOnce)}`;
  previewEl.style.color = 'var(--text-secondary)';
}

function buildCronFromForm(container) {
  const mode = container.querySelector('#auto-schedule-kind')?.value;
  if (!mode) return '';
  const interval = clampInt(container.querySelector('#auto-interval')?.value, 1, 999);
  const minute = clampInt(container.querySelector('#auto-minute')?.value, 0, 59);
  const weekday = container.querySelector('#auto-weekday')?.value;
  const time = parseTimeValue(container.querySelector('#auto-time')?.value);
  const customCron = container.querySelector('#auto-cron-custom')?.value?.trim();

  if (mode === 'every_minutes') {
    if (!interval) return '';
    return interval === 1 ? '* * * * *' : `*/${interval} * * * *`;
  }
  if (mode === 'every_hours') {
    if (!interval && interval !== 0) return '';
    return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
  }
  if ((mode === 'daily' || mode === 'weekdays' || mode === 'weekly') && !time) return '';
  if (mode === 'daily') return `${time.minute} ${time.hour} * * *`;
  if (mode === 'weekdays') return `${time.minute} ${time.hour} * * 1-5`;
  if (mode === 'weekly') return `${time.minute} ${time.hour} * * ${weekday}`;
  if (mode === 'custom') return customCron || '';
  return '';
}

function applyScheduleToForm(container, schedule) {
  container.querySelector('#auto-schedule-kind').value = schedule.mode;
  container.querySelector('#auto-interval').value = String(schedule.interval || 1);
  container.querySelector('#auto-minute').value = String(schedule.minute || 0);
  container.querySelector('#auto-time').value = schedule.time || '09:00';
  container.querySelector('#auto-weekday').value = schedule.weekday || '1';
  container.querySelector('#auto-cron-custom').value = schedule.customCron || '';
}

function parseCronToSchedule(cron) {
  if (!cron) {
    return { mode: 'every_minutes', interval: 30, minute: 0, time: '09:00', weekday: '1', customCron: '' };
  }

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { mode: 'custom', interval: 1, minute: 0, time: '09:00', weekday: '1', customCron: cron };
  }

  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { mode: 'every_minutes', interval: 1, minute: 0, time: '09:00', weekday: '1', customCron: '' };
  }

  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'every_minutes',
      interval: Number.parseInt(min.slice(2), 10) || 30,
      minute: 0,
      time: '09:00',
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'every_hours',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: '09:00',
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'every_hours',
      interval: Number.parseInt(hour.slice(2), 10) || 1,
      minute: Number.parseInt(min, 10) || 0,
      time: '09:00',
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'daily',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '1-5') {
    return {
      mode: 'weekdays',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
      weekday: '1',
      customCron: '',
    };
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return {
      mode: 'weekly',
      interval: 1,
      minute: Number.parseInt(min, 10) || 0,
      time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`,
      weekday: dow,
      customCron: '',
    };
  }

  return { mode: 'custom', interval: 1, minute: 0, time: '09:00', weekday: '1', customCron: cron };
}

// ─── Cron display helpers ───────────────────────────────

function cronToHuman(cron, runOnce = false) {
  if (!cron) return '-';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  let label = cron;
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    label = 'Every minute';
  } else if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = Number.parseInt(min.slice(2), 10);
    label = n === 1 ? 'Every minute' : `Every ${n} minutes`;
  } else if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    label = `Every hour at :${String(min).padStart(2, '0')}`;
  } else if (/^\d+$/.test(min) && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const n = Number.parseInt(hour.slice(2), 10);
    label = n === 1 ? `Every hour at :${String(min).padStart(2, '0')}` : `Every ${n} hours at :${String(min).padStart(2, '0')}`;
  } else if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    label = `Daily at ${fmtClock(hour, min)}`;
  } else if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '1-5') {
    label = `Weekdays at ${fmtClock(hour, min)}`;
  } else if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    label = `${weekdayName(dow)} at ${fmtClock(hour, min)}`;
  }
  return runOnce ? `One shot at ${label}` : label;
}

function fmtClock(hour, min) { return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`; }
function weekdayName(v) { return ({ '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday' })[String(v)] || 'Weekly'; }
function parseTimeValue(v) {
  if (!/^\d{2}:\d{2}$/.test(v || '')) return null;
  const [h, m] = v.split(':').map((p) => Number.parseInt(p, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hour: h, minute: m };
}
function clampInt(v, min, max) {
  const p = Number.parseInt(String(v), 10);
  if (!Number.isFinite(p)) return null;
  return Math.max(min, Math.min(max, p));
}

// ─── Utility ────────────────────────────────────────────

function statusColor(status) {
  if (status === 'succeeded') return 'var(--success)';
  if (status === 'completed') return 'var(--success)';
  if (status === 'failed') return 'var(--error)';
  if (status === 'blocked') return 'var(--warning)';
  if (status === 'cancelled') return 'var(--warning)';
  if (status === 'running') return 'var(--accent)';
  if (status === 'awaiting_approval') return 'var(--warning)';
  if (status === 'pending_approval') return 'var(--warning)';
  return 'var(--text-muted)';
}

function timelineStatusColor(status) {
  switch ((status || '').toLowerCase()) {
    case 'succeeded':
      return 'var(--success)';
    case 'failed':
      return 'var(--error)';
    case 'blocked':
      return 'var(--warning)';
    case 'cancelled':
      return 'var(--warning)';
    case 'running':
      return 'var(--accent)';
    case 'warning':
      return 'var(--warning)';
    default:
      return 'var(--text-muted)';
  }
}

function formatRunKind(kind) {
  switch (kind) {
    case 'assistant_dispatch':
      return 'assistant';
    case 'automation_run':
      return 'automation';
    case 'scheduled_task':
      return 'scheduled';
    case 'code_session':
      return 'code';
    default:
      return String(kind || 'run');
  }
}

function formatDuration(durationMs) {
  const value = Number(durationMs) || 0;
  if (value <= 0) return '-';
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

function formatTime(ts) {
  if (!ts) return '-';
  try { return new Date(ts).toLocaleString(); } catch { return '-'; }
}

// ─── Delay Helpers ─────────────────────────────────────────

function delayToMs(value, unit) {
  const v = Number(value) || 0;
  switch (unit) {
    case 'seconds': return v * 1000;
    case 'minutes': return v * 60 * 1000;
    case 'hours': return v * 3600 * 1000;
    case 'days': return v * 86400 * 1000;
    default: return v * 60 * 1000;
  }
}

function formatDelayMs(ms) {
  if (ms <= 0) return '0s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) {
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / 86400000);
  const h = Math.round((ms % 86400000) / 3600000);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

// ─── Tool Requirement Helpers ──────────────────────────────

const TOOL_REQUIREMENTS = {
  workspace: 'Google Workspace connected',
  email: 'Google Workspace connected',
  cloud: 'Cloud provider configured',
  browser: 'Browser automation enabled',
  search: 'Search sources configured',
  intel: 'Threat intel configured',
  contacts: 'Contacts imported',
};

const TOOL_REQUIREMENTS_BY_PREFIX = {
  m365: 'Microsoft 365 connected',
  outlook: 'Microsoft 365 connected',
  gws: 'Google Workspace connected',
  gmail: 'Google Workspace connected',
  cpanel: 'cPanel profile configured',
  whm: 'WHM profile configured',
  vercel: 'Vercel profile configured',
  cf_: 'Cloudflare profile configured',
  aws: 'AWS profile configured',
  gcp: 'GCP profile configured',
  azure: 'Azure profile configured',
};

function getToolRequirement(tool) {
  for (const [prefix, req] of Object.entries(TOOL_REQUIREMENTS_BY_PREFIX)) {
    if (tool.name.startsWith(prefix)) return req;
  }
  if (tool.category && TOOL_REQUIREMENTS[tool.category]) return TOOL_REQUIREMENTS[tool.category];
  return '';
}

// ─── Tool Picker Panel ─────────────────────────────────────

function renderToolPicker(panelEl, tools, targetSelect, onSelect) {
  const sorted = tools.slice().sort((a, b) =>
    (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));

  const categories = [...new Set(sorted.map((t) => t.category || 'other'))];

  panelEl.innerHTML = `
    <div class="auto-tool-picker">
      <input class="auto-tool-picker-search" type="text" placeholder="Search tools..." style="width:100%;margin-bottom:0.5rem;padding:0.35rem 0.5rem;background:var(--bg-input);border:1px solid var(--border);border-radius:0;color:var(--text-primary);font-size:0.8rem;">
      <div class="auto-tool-picker-list" style="max-height:260px;overflow-y:auto;">
        ${categories.map((cat) => {
          const catTools = sorted.filter((t) => (t.category || 'other') === cat);
          return `
            <div class="auto-tool-picker-category">${esc(cat)}</div>
            ${catTools.map((t) => {
              const req = getToolRequirement(t);
              const reqLabel = req ? `Requires: ${req}` : 'No requirements';
              const reqClass = req ? 'auto-tool-picker-req' : 'auto-tool-picker-req auto-tool-picker-req-none';
              return `<div class="auto-tool-picker-row" data-tool="${escAttr(t.name)}">
                <span class="auto-tool-picker-name">${esc(t.name)}</span>
                <span class="auto-tool-picker-desc">${esc(t.shortDescription || t.description || '')}</span>
                <span class="${reqClass}">${esc(reqLabel)}</span>
              </div>`;
            }).join('')}
          `;
        }).join('')}
      </div>
    </div>
  `;
  panelEl.style.display = '';

  const searchInput = panelEl.querySelector('.auto-tool-picker-search');
  const listEl = panelEl.querySelector('.auto-tool-picker-list');

  searchInput?.addEventListener('input', () => {
    const q = (searchInput.value || '').toLowerCase();
    listEl.querySelectorAll('.auto-tool-picker-row').forEach((row) => {
      const name = (row.dataset.tool || '').toLowerCase();
      const desc = (row.querySelector('.auto-tool-picker-desc')?.textContent || '').toLowerCase();
      row.style.display = !q || name.includes(q) || desc.includes(q) ? '' : 'none';
    });
    listEl.querySelectorAll('.auto-tool-picker-category').forEach((catEl) => {
      let next = catEl.nextElementSibling;
      let hasVisible = false;
      while (next && !next.classList.contains('auto-tool-picker-category')) {
        if (next.style.display !== 'none') hasVisible = true;
        next = next.nextElementSibling;
      }
      catEl.style.display = hasVisible ? '' : 'none';
    });
  });

  listEl.querySelectorAll('.auto-tool-picker-row').forEach((row) => {
    row.addEventListener('click', () => {
      const toolName = row.dataset.tool;
      if (targetSelect) targetSelect.value = toolName;
      // Update display span (sibling of hidden input)
      const displayEl = targetSelect?.parentElement?.querySelector('.auto-tool-display');
      if (displayEl) displayEl.textContent = toolName || 'No tool selected';
      panelEl.style.display = 'none';
      if (onSelect) onSelect(toolName);
    });
  });

  setTimeout(() => searchInput?.focus(), 50);
}

// ─── Dynamic Tool Parameter Fields ─────────────────────────

const SENSITIVE_ARG_KEY_RE = /(password|secret|token|private|api[-_]?key|auth|credential|cookie|cert|certificate|passphrase|clientsecret|privatekey)/i;

/**
 * Render input fields for a tool's parameter schema into a container.
 * Returns nothing — use collectToolParamValues() to read the values.
 */
function renderToolParamFields(containerEl, tool, existingArgs) {
  if (!containerEl) return;
  const schema = tool?.parameters;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') {
    containerEl.innerHTML = '';
    containerEl.style.display = 'none';
    return;
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    containerEl.innerHTML = '';
    containerEl.style.display = 'none';
    return;
  }

  const args = existingArgs || {};
  containerEl.style.display = '';
  containerEl.innerHTML = `
    <div class="auto-tool-params-grid cfg-form-grid">
      ${entries.map(([key, prop]) => {
        const p = prop || {};
        const type = p.type || 'string';
        const desc = p.description || '';
        const isRequired = required.has(key);
        const label = `${esc(key)}${isRequired ? ' *' : ''}`;
        const existing = args[key];
        const requiredAttr = isRequired ? 'data-param-required="true"' : '';

        if (type === 'boolean') {
          const checked = existing === true ? 'checked' : '';
          return `
            <div class="cfg-field">
              <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                <input type="checkbox" class="auto-param-input" data-param-name="${escAttr(key)}" data-param-type="boolean" ${requiredAttr} ${checked}>
                <span>${label}</span>
              </label>
              ${desc ? `<div style="font-size:0.68rem;color:var(--text-muted);">${esc(desc)}</div>` : ''}
            </div>
          `;
        }

        if (p.enum && Array.isArray(p.enum)) {
          const options = p.enum.map((v) => `<option value="${escAttr(String(v))}" ${existing === v ? 'selected' : ''}>${esc(String(v))}</option>`).join('');
          return `
            <div class="cfg-field">
              <label>${label}</label>
              <select class="auto-param-input" data-param-name="${escAttr(key)}" data-param-type="enum" ${requiredAttr}>
                <option value="">—</option>
                ${options}
              </select>
              ${desc ? `<div style="font-size:0.68rem;color:var(--text-muted);">${esc(desc)}</div>` : ''}
            </div>
          `;
        }

        if (type === 'number') {
          return `
            <div class="cfg-field">
              <label>${label}</label>
              <input type="number" class="auto-param-input" data-param-name="${escAttr(key)}" data-param-type="number" ${requiredAttr}
                value="${existing != null ? escAttr(String(existing)) : ''}"
                placeholder="${escAttr(desc)}">
            </div>
          `;
        }

        if (type === 'array') {
          const val = Array.isArray(existing) ? JSON.stringify(existing, null, 2) : '';
          return `
            <div class="cfg-field">
              <label>${label}</label>
              <textarea class="auto-param-input" data-param-name="${escAttr(key)}" data-param-type="array" ${requiredAttr}
                rows="3" placeholder="${escAttr(desc || 'JSON array or comma-separated values')}">${esc(val)}</textarea>
            </div>
          `;
        }

        if (type === 'object') {
          const val = existing != null ? JSON.stringify(existing, null, 2) : '';
          return `
            <div class="cfg-field">
              <label>${label}</label>
              <textarea class="auto-param-input" data-param-name="${escAttr(key)}" data-param-type="object" ${requiredAttr}
                rows="3" placeholder="${escAttr(desc || 'JSON object')}">${esc(val)}</textarea>
            </div>
          `;
        }

        // Default: string
        const isLong = desc.length > 80 || key === 'content' || key === 'body' || key === 'prompt';
        if (isLong) {
          return `
            <div class="cfg-field">
              <label>${label}</label>
              <textarea class="auto-param-input" data-param-name="${escAttr(key)}" data-param-type="string" ${requiredAttr}
                rows="3" placeholder="${escAttr(desc)}">${esc(existing != null ? String(existing) : '')}</textarea>
            </div>
          `;
        }
        return `
          <div class="cfg-field">
            <label>${label}</label>
            <input type="text" class="auto-param-input" data-param-name="${escAttr(key)}" data-param-type="string" ${requiredAttr}
              value="${existing != null ? escAttr(String(existing)) : ''}"
              placeholder="${escAttr(desc)}">
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * Collect values from rendered param fields into an args object.
 * Skips empty optional fields.
 */
function collectToolParamValues(containerEl) {
  const args = {};
  if (!containerEl) return args;
  containerEl.querySelectorAll('.auto-param-input').forEach((input) => {
    const name = input.getAttribute('data-param-name');
    const type = input.getAttribute('data-param-type');
    if (!name) return;

    if (type === 'boolean') {
      if (input.checked) args[name] = true;
      return;
    }
    if (type === 'number') {
      const v = input.value.trim();
      if (v !== '') args[name] = Number(v);
      return;
    }
    if (type === 'object') {
      const v = input.value.trim();
      if (v) {
        try { args[name] = JSON.parse(v); } catch { args[name] = v; }
      }
      return;
    }
    if (type === 'array') {
      const v = input.value.trim();
      if (!v) return;
      if (v.startsWith('[')) {
        try { args[name] = JSON.parse(v); } catch { args[name] = v; }
        return;
      }
      args[name] = v.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
      return;
    }
    // string / enum
    const v = input.value.trim();
    if (v !== '') args[name] = v;
  });
  return args;
}

function readToolParamValues(containerEl) {
  const args = {};
  const errors = [];
  if (!containerEl) return { args, errors };
  containerEl.querySelectorAll('.auto-param-input').forEach((input) => {
    const name = input.getAttribute('data-param-name');
    const type = input.getAttribute('data-param-type');
    const isRequired = input.getAttribute('data-param-required') === 'true';
    if (!name) return;

    if (type === 'boolean') {
      if (input.checked || isRequired) args[name] = input.checked;
      return;
    }

    const raw = input.value.trim();
    if (!raw) {
      if (isRequired) errors.push(`'${name}' is required.`);
      return;
    }

    if (type === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        errors.push(`'${name}' must be a valid number.`);
        return;
      }
      args[name] = parsed;
      return;
    }

    if (type === 'object') {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.push(`'${name}' must be a JSON object.`);
          return;
        }
        args[name] = parsed;
      } catch {
        errors.push(`'${name}' must be valid JSON.`);
      }
      return;
    }

    if (type === 'array') {
      if (raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            errors.push(`'${name}' must be a JSON array.`);
            return;
          }
          args[name] = parsed;
        } catch {
          errors.push(`'${name}' must be a JSON array or comma-separated list.`);
        }
        return;
      }
      args[name] = raw
        .split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter(Boolean);
      return;
    }

    args[name] = raw;
  });
  return { args, errors };
}

function preflightFixLabel(type) {
  if (type === 'domain') return 'Add domain';
  if (type === 'path') return 'Add path';
  if (type === 'command') return 'Add command';
  return 'Auto-approve';
}

function summarizeArgValue(key, value) {
  if (isSensitiveArgKey(key)) return '[hidden]';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return `object(${Object.keys(value).length})`;
  if (typeof value === 'string') return value.length > 30 ? `${value.slice(0, 30)}...` : value;
  return String(value);
}

function isSensitiveArgKey(key) {
  return SENSITIVE_ARG_KEY_RE.test(String(key || ''));
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return value == null ? '' : String(value);
}

function truncateText(value, maxChars) {
  const text = asString(value).trim();
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function humanizeToolName(name) {
  return asString(name)
    .replace(/^_+/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Step';
}

function extractBrowserPageTitle(content) {
  const match = asString(content).match(/- Page Title:\s*(.+)/);
  return match?.[1]?.trim() || '';
}

function extractBrowserReadSnippet(content) {
  const text = asString(content);
  if (!text) return '';
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('### ') && !line.startsWith('```') && !line.startsWith('- Page URL:') && !line.startsWith('- Page Title:') && !line.startsWith('- generic') && !line.startsWith('- /url:'));
  const firstNarrativeLine = lines.find((line) => /[A-Za-z]/.test(line));
  return truncateText(firstNarrativeLine || '', 220);
}

function formatBrowserLink(link) {
  if (!isRecord(link)) return '';
  const text = asString(link.text).trim();
  const href = asString(link.href).trim();
  if (text && href && text !== href) return `${text} -> ${href}`;
  return href || text || '';
}


// Global click handler for step output toggles
if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.auto-step-output-toggle');
    if (!button) return;
    const outputId = button.getAttribute('data-output-id');
    if (!outputId) return;
    const output = document.getElementById(outputId);
    if (!output) return;
    const visible = output.style.display !== 'none';
    output.style.display = visible ? 'none' : '';
    button.textContent = visible ? 'Raw Output' : 'Hide Raw Output';
  });
}

function formatStepAccess(packId, packs) {
  const normalized = (packId || '').trim();
  if (!normalized || normalized.toLowerCase() === 'default') {
    return 'Built-in tools';
  }
  const pack = (packs || []).find((candidate) => candidate.id === normalized);
  return pack ? `${pack.name} (${pack.id})` : normalized;
}
