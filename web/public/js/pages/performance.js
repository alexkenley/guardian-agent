import { api } from '../api.js';
import { enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';

let currentContainer = null;
const DEFAULT_PROFILE_POWER_MODE = 'balanced';
const state = {
  status: null,
  activeTab: 'overview',
  preview: null,
  selectedProcessTargetIds: new Set(),
  selectedCleanupTargetIds: new Set(),
  cleanupFeedback: null,
  profileFeedback: null,
  selectedProfileId: null,
  profileDraftTemplate: null,
  processCatalog: null,
  processCatalogStatus: 'idle',
  processCatalogError: null,
  processCatalogActiveProfileId: null,
  processSearch: '',
};

const PERFORMANCE_HELP = {
  overview: {
    'Host Snapshot': {
      whatItIs: 'This section is the current host-level performance snapshot for the active profile.',
      whatSeeing: 'You are seeing CPU, memory, disk, live process pressure, and whether this runtime can execute reviewed cleanup actions.',
      whatCanDo: 'Use it to decide whether you need a different profile, a reviewed cleanup pass, or more latency coverage.',
      howLinks: 'Profiles define cleanup rules and latency probes. Cleanup uses the same runtime process view shown here.',
    },
    'Latency Checks': {
      whatItIs: 'This section shows the active profile’s configured internet and API probes.',
      whatSeeing: 'You are seeing the most recent probe state for each target the active profile tracks.',
      whatCanDo: 'Use it to separate host slowdowns from upstream or internet responsiveness problems.',
      howLinks: 'Latency targets are managed in Profiles and surfaced back here on Overview.',
    },
  },
  profiles: {
    'Profile Library': {
      whatItIs: 'This is the editable library of workstation performance profiles.',
      whatSeeing: 'You are seeing which profile is active, what each profile protects or recommends for cleanup, and which latency checks it defines.',
      whatCanDo: 'Create a new profile, tune its protect or cleanup rules, add latency checks, and apply it without leaving the page.',
      howLinks: 'These definitions are persisted through the shared config system and then exercised operationally from Performance.',
    },
  },
  cleanup: {
    'Recommended Cleanup': {
      whatItIs: 'This is the preview-first cleanup workflow for reviewed workstation actions.',
      whatSeeing: 'You are seeing Guardian’s recommended process batch based on the active profile and the current process snapshot.',
      whatCanDo: 'Generate a preview, review every suggested process, and run only the selected subset when host process control is available.',
      howLinks: 'Profiles influence the recommendation set. Protected rows stay visible but disabled so the refusal is inspectable.',
    },
  },
  history: {
    'Recent Activity': {
      whatItIs: 'This section records profile switches and cleanup actions that ran through the Performance page.',
      whatSeeing: 'You are seeing the latest operator-initiated actions together with success state and selection counts.',
      whatCanDo: 'Use it to verify what changed recently before running another cleanup pass.',
      howLinks: 'History stays local to Performance so workstation actions remain easy to audit.',
    },
  },
};

export async function renderPerformance(container, options = {}) {
  currentContainer = container;
  state.activeTab = normalizeTabId(options?.tab ?? state.activeTab);
  container.innerHTML = '<div class="loading">Loading performance data...</div>';

  try {
    state.status = await api.performanceStatus();
    syncStateWithStatus();
    container.innerHTML = `
      <div class="layout-heading">
        <h2 class="page-title">Performance</h2>
      </div>
      ${renderGuidancePanel({
        kicker: 'Performance Guide',
        title: 'Workstation monitoring, editable profiles, and reviewed cleanup',
        whatItIs: 'Performance is the workstation-operations page for host pressure, profile management, latency checks, and reviewed cleanup actions.',
        whatSeeing: 'You are seeing the current machine snapshot, editable performance profiles, and the guarded cleanup workflow that proposes specific process rows before any mutation happens.',
        whatCanDo: 'Inspect host pressure, create or tune profiles, add latency checks, preview recommended cleanup, and run only the reviewed subset when runtime support is available.',
        howLinks: 'Performance owns day-to-day workstation tuning. Automations can call the same capabilities later, but this page is the operator control surface.',
      })}
      <div id="performance-tabs"></div>
    `;

    const tabsContainer = container.querySelector('#performance-tabs');
    if (!tabsContainer) return;

    createTabs(tabsContainer, [
      { id: 'overview', label: 'Overview', render: (panel) => { state.activeTab = 'overview'; renderOverviewTab(panel); } },
      { id: 'profiles', label: 'Profiles', render: (panel) => { state.activeTab = 'profiles'; renderProfilesTab(panel); } },
      { id: 'cleanup', label: 'Cleanup', render: (panel) => { state.activeTab = 'cleanup'; renderCleanupTab(panel); } },
      { id: 'history', label: 'History', render: (panel) => { state.activeTab = 'history'; renderHistoryTab(panel); } },
    ], state.activeTab);
  } catch (error) {
    container.innerHTML = `<div class="loading">Failed to load performance data: ${esc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

export async function updatePerformance() {
  if (!currentContainer) return;
  await renderPerformance(currentContainer, { tab: state.activeTab });
}

function syncStateWithStatus() {
  const profiles = state.status?.profiles ?? [];
  const activeProfileId = state.status?.activeProfile ?? null;
  if (state.processCatalogActiveProfileId !== activeProfileId) {
    state.processCatalog = null;
    state.processCatalogStatus = 'idle';
    state.processCatalogError = null;
    state.processCatalogActiveProfileId = activeProfileId;
  }

  if (profiles.length === 0) {
    state.selectedProfileId = null;
    return;
  }

  if (profiles.some((profile) => profile.id === state.selectedProfileId)) {
    return;
  }

  const activeProfile = profiles.find((profile) => profile.id === state.status?.activeProfile);
  state.selectedProfileId = activeProfile?.id ?? profiles[0]?.id ?? null;
}

function clearCleanupPreview() {
  state.preview = null;
  state.selectedProcessTargetIds = new Set();
  state.selectedCleanupTargetIds = new Set();
}

function renderOverviewTab(panel) {
  const status = state.status;
  const snapshot = status?.snapshot ?? {};
  const topProcesses = snapshot.topProcesses ?? [];
  const latencyTargets = status?.latencyTargets ?? [];
  const capabilities = status?.capabilities ?? {};
  const memorySubtitle = snapshot.memoryTotalMb
    ? `${formatPercent(snapshot.memoryPercent)} of ${formatGb(snapshot.memoryTotalMb)} total`
    : 'Used memory';
  const diskSubtitle = snapshot.diskTotalMb
    ? `${formatPercent(snapshot.diskPercentFree)} free of ${formatGb(snapshot.diskTotalMb)} total`
    : 'Free disk space';

  panel.innerHTML = `
    ${renderGuidancePanel({
      kicker: 'Overview',
      compact: true,
      whatItIs: 'Overview is the fast workstation health summary for the active performance profile.',
      whatSeeing: 'You are seeing current host pressure, process visibility, cleanup capability status, and the profile’s latency coverage.',
      whatCanDo: 'Use it to decide whether you should change profiles, build a cleanup preview, or add missing latency checks.',
      howLinks: 'Profiles define cleanup and latency behavior. Cleanup is still review-first on its own tab.',
    })}
    <div class="table-container">
      <div class="table-header"><h3>Host Snapshot</h3></div>
      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">OS</div>
          <div class="card-value">${esc(status?.os || 'unknown')}</div>
          <div class="card-subtitle">Active profile: ${esc(status?.activeProfile || 'none')}</div>
        </div>
        <div class="status-card ${severityClass(snapshot.cpuPercent, 80, 60)}">
          <div class="card-title">CPU</div>
          <div class="card-value">${formatPercent(snapshot.cpuPercent)}</div>
          <div class="card-subtitle">Current host usage</div>
        </div>
        <div class="status-card ${severityClass(snapshot.memoryPercent, 85, 70)}">
          <div class="card-title">Memory</div>
          <div class="card-value">${formatGb(snapshot.memoryMb)}</div>
          <div class="card-subtitle">${esc(memorySubtitle)}</div>
        </div>
        <div class="status-card ${severityClass(snapshot.diskPercentFree != null ? 100 - snapshot.diskPercentFree : undefined, 90, 75)}">
          <div class="card-title">Disk Free</div>
          <div class="card-value">${formatGb(snapshot.diskFreeMb)}</div>
          <div class="card-subtitle">${esc(diskSubtitle)}</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Processes</div>
          <div class="card-value">${formatInt(snapshot.processCount)}</div>
          <div class="card-subtitle">From the latest sample</div>
        </div>
        <div class="status-card ${capabilities.canManageProcesses ? 'success' : 'warning'}">
          <div class="card-title">Cleanup Control</div>
          <div class="card-value">${capabilities.canManageProcesses ? 'Writable' : 'Read-only'}</div>
          <div class="card-subtitle">${esc(capabilities.canManageProcesses ? 'Reviewed process actions are available.' : 'Preview remains available, but execution is blocked on this runtime.')}</div>
        </div>
      </div>
    </div>

    <div class="table-container">
      <div class="table-header"><h3>Latency Checks</h3></div>
      ${latencyTargets.length > 0 ? `
        <table>
          <thead>
            <tr><th>Target</th><th>Type</th><th>State</th><th>Latency</th><th>Detail</th></tr>
          </thead>
          <tbody>
            ${latencyTargets.map((target) => `
              <tr>
                <td>
                  <div><strong>${esc(target.label)}</strong></div>
                  <div class="card-subtitle">${esc(target.target || 'resolved at runtime')}</div>
                </td>
                <td>${esc(target.kind)}</td>
                <td><span class="status-chip ${latencyStateClass(target.state)}">${esc(target.state)}</span></td>
                <td>${target.latencyMs != null ? `${Math.round(target.latencyMs)} ms` : 'n/a'}</td>
                <td>${esc(target.detail || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : `
        <div class="cfg-center-body">
          <div class="ops-inline-help">
            This profile does not define any latency checks yet. Add internet or API probes in Profiles if you want Overview to distinguish workstation pressure from upstream slowness.
          </div>
          <div class="cfg-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-open-performance-tab="profiles">Manage Profiles</button>
          </div>
        </div>
      `}
    </div>

    <div class="table-container">
      <div class="table-header"><h3>Top Processes</h3></div>
      ${topProcesses.length > 0 ? `
        <table>
          <thead>
            <tr><th>Name</th><th>PID</th><th>CPU</th><th>Memory</th><th>Guardian Status</th><th>Why It Matters</th></tr>
          </thead>
          <tbody>
            ${topProcesses.map((processInfo) => `
              <tr>
                <td>${esc(processInfo.name)}</td>
                <td>${formatInt(processInfo.pid)}</td>
                <td>${formatPercent(processInfo.cpuPercent)}</td>
                <td>${formatMb(processInfo.memoryMb)}</td>
                <td>${processInfo.protected
                  ? `<span class="status-chip warning" title="${escAttr(processInfo.protectionReason || 'Protected')}">Protected</span>`
                  : '<span class="status-chip success">Reviewable</span>'}</td>
                <td>${esc(summarizeProcessPressure(processInfo))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div class="cfg-center-body"><div class="ops-inline-help">No process sample is available yet.</div></div>'}
    </div>
  `;

  panel.querySelectorAll('[data-open-performance-tab]').forEach((button) => {
    button.addEventListener('click', async () => {
      await openPerformanceTab(button.getAttribute('data-open-performance-tab'));
    });
  });

  enhanceSectionHelp(panel, PERFORMANCE_HELP.overview);
}

function renderProfilesTab(panel) {
  const status = state.status;
  const profiles = (status?.profiles ?? []).map(cloneEditableProfile);
  if (state.processCatalogStatus === 'idle') {
    void loadProcessCatalog();
  }
  const allProcessGroups = groupProcessCatalog(state.processCatalog ?? [], '');
  const processGroups = groupProcessCatalog(state.processCatalog ?? [], state.processSearch);
  const suggestedProfiles = buildSuggestedProfileTemplates(allProcessGroups);

  panel.innerHTML = `
    ${renderGuidancePanel({
      kicker: 'Profiles',
      compact: true,
      whatItIs: 'Profiles are the saved workstation modes that drive cleanup recommendations and latency coverage.',
      whatSeeing: 'You are seeing the full profile library together with an inline editor for create, update, apply, and delete.',
      whatCanDo: 'Create a new profile, tune cleanup or protect rules, add latency checks, and apply it immediately without leaving Performance.',
      howLinks: 'Profile changes are persisted through Guardian’s shared config update path and take effect here operationally.',
    })}
    <div class="table-container">
      <div class="table-header"><h3>Profile Library</h3></div>
      <div class="performance-profile-workspace">
        <aside class="performance-profile-sidebar">
          <div class="performance-profile-sidebar-header">
            <div>
              <div class="performance-profile-sidebar-title">Saved Profiles</div>
              <div class="performance-profile-sidebar-note">Switch between profiles, create a new one, or load an example based on your running apps.</div>
            </div>
            <button class="btn btn-secondary btn-sm" type="button" data-add-profile>New</button>
          </div>
          <div class="performance-profile-list" data-performance-profile-list></div>
          ${suggestedProfiles.length > 0 ? `
            <div class="performance-profile-suggestions">
              <div class="performance-profile-sidebar-title">Suggested Examples</div>
              <div class="performance-profile-sidebar-note">Generated from apps that are running right now.</div>
              <div class="performance-profile-suggestion-list">
                ${suggestedProfiles.map((profile) => `
                  <button class="btn btn-secondary btn-sm performance-profile-suggestion-btn" type="button" data-profile-suggestion="${escAttr(profile.id)}">${esc(profile.name)}</button>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </aside>
        <div class="performance-profile-editor" data-performance-profile-editor></div>
      </div>
    </div>
  `;

  const listEl = panel.querySelector('[data-performance-profile-list]');
  const editorEl = panel.querySelector('[data-performance-profile-editor]');
  const addBtn = panel.querySelector('[data-add-profile]');
  const suggestionLookup = new Map(suggestedProfiles.map((profile) => [profile.id, profile]));

  function renderProfileList() {
    if (!listEl) return;
    listEl.innerHTML = profiles.length === 0
      ? '<div class="performance-profile-empty">No profiles are saved yet. Create one to define cleanup rules and latency checks.</div>'
      : profiles.map((profile) => {
        const isSelected = profile.id === state.selectedProfileId;
        return `
          <button
            class="performance-profile-item${isSelected ? ' active' : ''}"
            type="button"
            data-profile-id="${escAttr(profile.id)}"
            title="${escAttr(profile.name || profile.id)}"
          >
            <span class="performance-profile-item-title">${esc(profile.name || profile.id)}</span>
            <span class="performance-profile-item-meta">${esc(profile.powerMode ? profile.powerMode.replaceAll('_', ' ') : 'no host power intent')}</span>
            <span class="performance-profile-item-badges">
              ${summarizeProfileBadges(profile, status?.activeProfile).map((badge) => `<span class="performance-profile-item-badge">${esc(badge)}</span>`).join('')}
            </span>
          </button>
        `;
      }).join('');

    listEl.querySelectorAll('[data-profile-id]').forEach((button) => {
      button.addEventListener('click', () => {
        state.profileFeedback = null;
        state.profileDraftTemplate = null;
        state.selectedProfileId = button.getAttribute('data-profile-id');
        renderProfileList();
        renderEditor();
      });
    });
  }

  function renderEditor() {
    if (!editorEl) return;
    const isCreateMode = !state.selectedProfileId;
    const existingProfile = profiles.find((profile) => profile.id === state.selectedProfileId) ?? null;
    const profile = existingProfile ?? cloneEditableProfile(state.profileDraftTemplate ?? buildDefaultProfile());
    const profileLabel = profile.name || profile.id || 'New Profile';
    const statusText = state.profileFeedback?.text || '';
    const statusKind = state.profileFeedback?.kind || 'info';

    editorEl.innerHTML = `
      <div class="table-header performance-profile-editor-header">
        <h3>${esc(isCreateMode ? 'Create New Profile' : `Edit ${profileLabel}`)}</h3>
        <span class="cfg-header-note">${esc(isCreateMode ? 'Create mode' : profile.id === status?.activeProfile ? 'Active profile' : 'Saved profile')}</span>
      </div>
      <div class="ops-inline-help performance-profile-editor-copy">
        Profiles control which process names Guardian protects, which ones it recommends for cleanup, and which latency checks surface on Overview. Process name lists accept one item per line or comma-separated values.
      </div>
      <div class="ops-inline-help performance-profile-editor-copy">
        <code>Apply</code> only switches the active profile. Guardian still requires an explicit reviewed cleanup preview before it stops anything, and <code>Protect</code> means "never target this name for cleanup," not "ensure this app is launched."
      </div>
      <div class="cfg-form-grid performance-profile-form">
        <div class="cfg-field">
          <label>Profile Name</label>
          <input type="text" data-profile-field="name" value="${escAttr(profile.name)}" placeholder="Build Sprint">
        </div>
        <div class="cfg-field">
          <label>Profile ID</label>
          <input type="text" data-profile-field="id" value="${escAttr(profile.id)}" placeholder="build-sprint"${isCreateMode ? '' : ' readonly'}>
        </div>
        <div class="cfg-field">
          <label>Power Intent</label>
          <select data-profile-field="powerMode">
            ${renderPowerModeOptions(profile.powerMode || DEFAULT_PROFILE_POWER_MODE)}
          </select>
        </div>
        <div class="cfg-field performance-profile-span-2">
          <label>Recommend Closing</label>
          <textarea class="performance-profile-textarea" data-profile-field="terminate" placeholder="Discord.exe&#10;Spotify.exe">${esc(formatProfileList(profile.terminateProcessNames))}</textarea>
        </div>
        <div class="cfg-field performance-profile-span-2">
          <label>Always Protect</label>
          <textarea class="performance-profile-textarea" data-profile-field="protect" placeholder="code&#10;node&#10;git">${esc(formatProfileList(profile.protectProcessNames))}</textarea>
        </div>
      </div>

      <div class="performance-latency-editor">
        <div class="table-header performance-latency-editor-header">
          <h3>Latency Checks</h3>
          <span class="cfg-header-note">Shown on Overview for this profile</span>
        </div>
        <div class="performance-latency-list" data-latency-list>
          ${renderLatencyRows(profile.latencyTargets)}
        </div>
        <div class="cfg-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-add-latency="internet">Add Internet Check</button>
          <button class="btn btn-secondary btn-sm" type="button" data-add-latency="api">Add API Check</button>
        </div>
      </div>

      <div class="performance-process-browser">
        <div class="table-header performance-process-browser-header">
          <h3>Running Processes</h3>
          <span class="cfg-header-note">Quick-add by executable name</span>
        </div>
        <div class="ops-inline-help performance-process-browser-copy">
          The list below is live process data grouped by executable name so it maps cleanly onto this profile’s terminate and protect rules. Exact Windows Task Manager icons are not wired yet; this slice focuses on the rule-building workflow first.
        </div>
        <div class="performance-process-browser-toolbar">
          <div class="cfg-field performance-process-browser-search">
            <label>Search Running Processes</label>
            <input type="text" data-process-search value="${escAttr(state.processSearch)}" placeholder="Search by process name or path">
          </div>
          <div class="cfg-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-refresh-processes>Refresh Running Processes</button>
          </div>
        </div>
        ${renderProcessCatalog(processGroups, profile)}
      </div>

      <div class="cfg-actions">
        <button class="btn btn-primary" type="button" data-save-profile>${isCreateMode ? 'Create Profile' : 'Save Profile'}</button>
        <button class="btn btn-secondary" type="button" data-apply-profile${isCreateMode ? ' hidden' : ''}>${profile.id === status?.activeProfile ? 'Reapply Active Profile' : 'Apply Profile'}</button>
        <button class="btn btn-secondary" type="button" data-preview-cleanup${isCreateMode ? ' hidden' : ''}>${profile.id === status?.activeProfile ? 'Preview Cleanup' : 'Apply + Preview Cleanup'}</button>
        <button class="btn btn-secondary" type="button" data-delete-profile${isCreateMode ? ' hidden' : ''}${profiles.length <= 1 ? ' disabled' : ''}>Delete Profile</button>
        <span class="cfg-save-status ${statusKind}" data-profile-status>${esc(statusText)}</span>
      </div>
    `;

    const latencyList = editorEl.querySelector('[data-latency-list]');
    const statusEl = editorEl.querySelector('[data-profile-status]');

    latencyList?.querySelectorAll('[data-latency-row]').forEach((row) => {
      wireLatencyRow(row, latencyList);
    });

    editorEl.querySelector('[data-process-search]')?.addEventListener('input', (event) => {
      state.processSearch = event.target.value || '';
      renderEditor();
    });

    editorEl.querySelector('[data-refresh-processes]')?.addEventListener('click', async () => {
      state.profileFeedback = null;
      await loadProcessCatalog(true);
    });

    editorEl.querySelectorAll('[data-add-process-name][data-add-process-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        upsertProcessRule(editorEl, button.getAttribute('data-add-process-name'), button.getAttribute('data-add-process-mode'));
      });
    });

    editorEl.querySelectorAll('[data-add-latency]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!latencyList) return;
        removeLatencyEmptyState(latencyList);
        latencyList.insertAdjacentHTML('beforeend', renderLatencyTargetRow(
          button.getAttribute('data-add-latency') === 'api'
            ? { kind: 'api', id: '', targetRef: 'defaultProvider' }
            : { kind: 'internet', id: '', target: 'https://1.1.1.1' },
        ));
        const rows = latencyList.querySelectorAll('[data-latency-row]');
        const row = rows[rows.length - 1];
        if (row) {
          wireLatencyRow(row, latencyList);
        }
      });
    });

    editorEl.querySelector('[data-save-profile]')?.addEventListener('click', async () => {
      if (!statusEl) return;
      setStatusText(statusEl, 'Saving profile...', 'pending');
      try {
        const nextProfile = collectProfileDraft(editorEl, existingProfile);
        const hasConflictingId = profiles.some((entry) => entry.id === nextProfile.id && entry.id !== state.selectedProfileId);
        if (hasConflictingId) {
          throw new Error(`Profile ID '${nextProfile.id}' already exists.`);
        }

        const nextProfiles = isCreateMode
          ? [...profiles, nextProfile]
          : profiles.map((entry) => (entry.id === state.selectedProfileId ? nextProfile : entry));
        const result = await api.updateConfig({
          assistant: {
            performance: {
              profiles: nextProfiles.map(buildConfigProfile),
            },
          },
        });
        state.profileFeedback = { kind: result.success ? 'success' : 'error', text: result.message || (result.success ? 'Profile saved.' : 'Profile update failed.') };
        if (result.success) {
          state.selectedProfileId = nextProfile.id;
          clearCleanupPreview();
          await updatePerformance();
          return;
        }
        setStatusText(statusEl, state.profileFeedback.text, state.profileFeedback.kind);
      } catch (error) {
        setStatusText(statusEl, error instanceof Error ? error.message : String(error), 'error');
      }
    });

    editorEl.querySelector('[data-apply-profile]')?.addEventListener('click', async () => {
      if (!existingProfile || !statusEl) return;
      setStatusText(statusEl, 'Applying profile...', 'pending');
      try {
        const result = await api.performanceApplyProfile(existingProfile.id);
        state.profileFeedback = { kind: result.success ? 'success' : 'error', text: result.message };
        if (result.success) {
          clearCleanupPreview();
          await updatePerformance();
          return;
        }
        setStatusText(statusEl, state.profileFeedback.text, state.profileFeedback.kind);
      } catch (error) {
        setStatusText(statusEl, error instanceof Error ? error.message : String(error), 'error');
      }
    });

    editorEl.querySelector('[data-preview-cleanup]')?.addEventListener('click', async () => {
      if (!existingProfile || !statusEl) return;
      setStatusText(statusEl, 'Preparing cleanup preview...', 'pending');
      try {
        if (existingProfile.id !== state.status?.activeProfile) {
          const applyResult = await api.performanceApplyProfile(existingProfile.id);
          if (!applyResult.success) {
            setStatusText(statusEl, applyResult.message, 'error');
            return;
          }
        }

        const previewResult = await api.performancePreviewAction('cleanup');
        state.preview = previewResult;
        state.selectedProcessTargetIds = new Set(
          (previewResult.processTargets || [])
            .filter((target) => target.checkedByDefault && target.selectable)
            .map((target) => target.targetId),
        );
        state.selectedCleanupTargetIds = new Set(
          (previewResult.cleanupTargets || [])
            .filter((target) => target.checkedByDefault && target.selectable)
            .map((target) => target.targetId),
        );
        const totalTargetCount = (previewResult.processTargets?.length || 0) + (previewResult.cleanupTargets?.length || 0);
        state.cleanupFeedback = totalTargetCount > 0
          ? {
            kind: 'success',
            text: `${existingProfile.id !== state.status?.activeProfile ? 'Profile applied. ' : ''}Cleanup preview ready. Review ${totalTargetCount} recommended target${totalTargetCount === 1 ? '' : 's'} before running anything.`,
          }
          : {
            kind: 'warning',
            text: `${existingProfile.id !== state.status?.activeProfile ? 'Profile applied. ' : ''}No cleanup candidates were recommended from the current process list.`,
          };
        state.activeTab = 'cleanup';
        await updatePerformance();
      } catch (error) {
        setStatusText(statusEl, error instanceof Error ? error.message : String(error), 'error');
      }
    });

    editorEl.querySelector('[data-delete-profile]')?.addEventListener('click', async () => {
      if (!existingProfile || !statusEl) return;
      if (profiles.length <= 1) {
        setStatusText(statusEl, 'Keep at least one profile so Performance retains a usable default mode.', 'warning');
        return;
      }
      if (!confirm(`Delete performance profile '${existingProfile.name || existingProfile.id}'?`)) return;

      setStatusText(statusEl, 'Deleting profile...', 'pending');
      try {
        const nextProfiles = profiles.filter((entry) => entry.id !== existingProfile.id);
        const result = await api.updateConfig({
          assistant: {
            performance: {
              profiles: nextProfiles.map(buildConfigProfile),
            },
          },
        });
        state.profileFeedback = { kind: result.success ? 'success' : 'error', text: result.message || (result.success ? 'Profile deleted.' : 'Profile delete failed.') };
        if (result.success) {
          state.selectedProfileId = nextProfiles[0]?.id ?? null;
          clearCleanupPreview();
          await updatePerformance();
          return;
        }
        setStatusText(statusEl, state.profileFeedback.text, state.profileFeedback.kind);
      } catch (error) {
        setStatusText(statusEl, error instanceof Error ? error.message : String(error), 'error');
      }
    });
  }

  addBtn?.addEventListener('click', () => {
    state.profileFeedback = null;
    state.profileDraftTemplate = null;
    state.selectedProfileId = null;
    renderProfileList();
    renderEditor();
  });

  panel.querySelectorAll('[data-profile-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      const suggestion = suggestionLookup.get(button.getAttribute('data-profile-suggestion'));
      if (!suggestion) return;
      state.profileFeedback = null;
      state.selectedProfileId = null;
      state.profileDraftTemplate = suggestion;
      renderProfileList();
      renderEditor();
    });
  });

  renderProfileList();
  renderEditor();
  enhanceSectionHelp(panel, PERFORMANCE_HELP.profiles);
}

function renderCleanupTab(panel) {
  const capabilities = state.status?.capabilities ?? {};
  const preview = state.preview;
  const selectedProcessCount = state.selectedProcessTargetIds.size;
  const selectedCleanupCount = state.selectedCleanupTargetIds.size;
  const selectionCount = selectedProcessCount + selectedCleanupCount;
  const canRunSelected = Boolean(preview) && capabilities.canManageProcesses && selectionCount > 0;

  panel.innerHTML = `
    ${renderGuidancePanel({
      kicker: 'Cleanup',
      compact: true,
      whatItIs: 'Cleanup is the reviewed mutation surface for workstation process cleanup.',
      whatSeeing: 'You are seeing runtime execution capability status, the preview trigger, and the reviewed target list when Guardian has suggestions.',
      whatCanDo: 'Build a preview, inspect every target, and run only the selected subset on runtimes that support host process control.',
      howLinks: 'The active profile heavily influences the recommendations. Use Profiles if the preview is too empty or too noisy.',
    })}
    <div class="table-container">
      <div class="table-header"><h3>Recommended Cleanup</h3></div>
      <div class="cfg-center-body">
        <div class="ops-inline-help">
          ${esc(buildCleanupCapabilityMessage(capabilities, state.status?.os))}
        </div>
        <div class="cfg-actions">
          <button class="btn btn-primary" type="button" id="performance-preview-button">Build Cleanup Preview</button>
          <button class="btn btn-secondary" type="button" id="performance-refresh-button">Refresh Snapshot</button>
          <button class="btn btn-secondary" type="button" data-open-performance-tab="profiles">Manage Profiles</button>
        </div>
        <div id="performance-cleanup-feedback" class="cfg-save-status"></div>
      </div>
    </div>

    ${preview ? `
      <div class="table-container">
        <div class="table-header"><h3>Selection Summary</h3></div>
        <div class="cfg-center-body">
          <div class="ops-inline-help">
            ${esc(selectionCount > 0
              ? `${selectionCount} reviewed target${selectionCount === 1 ? ' is' : 's are'} selected for execution.`
              : 'No targets are selected yet. Review the preview and check only the rows you want Guardian to act on.')}
          </div>
          ${!capabilities.canManageProcesses ? `
            <div class="ops-inline-help">
              This runtime is read-only for process control, so the preview is advisory only. You can still use it to tune profile rules before switching to a writable environment.
            </div>
          ` : ''}
          <div class="cfg-actions">
            <button class="btn btn-primary" type="button" id="performance-run-button"${canRunSelected ? '' : ' disabled'}>Run Selected (${selectionCount})</button>
          </div>
        </div>
      </div>
      ${renderPreviewTable('Recommended Processes', preview.processTargets, 'process')}
      ${preview.cleanupTargets?.length ? renderPreviewTable('Additional Cleanup Tasks', preview.cleanupTargets, 'cleanup') : ''}
    ` : `
      <div class="table-container">
        <div class="table-header"><h3>How Cleanup Works</h3></div>
        <div class="cfg-center-body">
          <div class="ops-inline-help">
            Guardian builds this preview from the active profile and the current process list. If the result is too empty, add terminate hints or loosen the profile in Profiles. If it is too noisy, expand the protect list for tools you never want touched.
          </div>
        </div>
      </div>
    `}
  `;

  panel.querySelector('#performance-preview-button')?.addEventListener('click', async () => {
    const feedback = panel.querySelector('#performance-cleanup-feedback');
    setStatusText(feedback, 'Generating reviewed cleanup preview...', 'pending');
    try {
      const previewResult = await api.performancePreviewAction('cleanup');
      state.preview = previewResult;
      state.selectedProcessTargetIds = new Set(
        (previewResult.processTargets || [])
          .filter((target) => target.checkedByDefault && target.selectable)
          .map((target) => target.targetId),
      );
      state.selectedCleanupTargetIds = new Set(
        (previewResult.cleanupTargets || [])
          .filter((target) => target.checkedByDefault && target.selectable)
          .map((target) => target.targetId),
      );
      const totalTargetCount = (previewResult.processTargets?.length || 0) + (previewResult.cleanupTargets?.length || 0);
      state.cleanupFeedback = totalTargetCount > 0
        ? {
          kind: 'success',
          text: `Preview ready. Review ${totalTargetCount} recommended target${totalTargetCount === 1 ? '' : 's'} before running anything.`,
        }
        : {
          kind: 'warning',
          text: 'No cleanup candidates were recommended from the current profile and process list. Add terminate hints or switch profiles, then preview again.',
        };
      renderCleanupTab(panel);
    } catch (error) {
      setStatusText(feedback, error instanceof Error ? error.message : String(error), 'error');
    }
  });

  panel.querySelector('#performance-refresh-button')?.addEventListener('click', async () => {
    clearCleanupPreview();
    state.cleanupFeedback = {
      kind: 'info',
      text: 'Status refreshed. Build a new preview to review the latest process list.',
    };
    await updatePerformance();
  });

  panel.querySelectorAll('[data-open-performance-tab]').forEach((button) => {
    button.addEventListener('click', async () => {
      await openPerformanceTab(button.getAttribute('data-open-performance-tab'));
    });
  });

  panel.querySelectorAll('[data-target-kind][data-target-id]').forEach((input) => {
    input.addEventListener('change', () => {
      const targetId = input.getAttribute('data-target-id');
      const kind = input.getAttribute('data-target-kind');
      if (!targetId || !kind) return;
      const selection = kind === 'process' ? state.selectedProcessTargetIds : state.selectedCleanupTargetIds;
      if (input.checked) selection.add(targetId);
      else selection.delete(targetId);
      renderCleanupTab(panel);
    });
  });

  panel.querySelector('#performance-run-button')?.addEventListener('click', async () => {
    if (!state.preview || !capabilities.canManageProcesses) return;
    const feedback = panel.querySelector('#performance-cleanup-feedback');
    setStatusText(feedback, 'Running selected cleanup actions...', 'pending');
    try {
      const result = await api.performanceRunAction({
        previewId: state.preview.previewId,
        selectedProcessTargetIds: [...state.selectedProcessTargetIds],
        selectedCleanupTargetIds: [...state.selectedCleanupTargetIds],
      });
      clearCleanupPreview();
      state.cleanupFeedback = { kind: result.success ? 'success' : 'error', text: result.message };
      await updatePerformance();
    } catch (error) {
      setStatusText(feedback, error instanceof Error ? error.message : String(error), 'error');
    }
  });

  if (state.cleanupFeedback?.text) {
    setStatusText(panel.querySelector('#performance-cleanup-feedback'), state.cleanupFeedback.text, state.cleanupFeedback.kind);
  }

  enhanceSectionHelp(panel, PERFORMANCE_HELP.cleanup);
}

function renderHistoryTab(panel) {
  const history = state.status?.history ?? [];
  panel.innerHTML = `
    ${renderGuidancePanel({
      kicker: 'History',
      compact: true,
      whatItIs: 'History is the recent log of performance actions and profile changes.',
      whatSeeing: 'You are seeing the latest workstation actions run through this page and whether each one succeeded.',
      whatCanDo: 'Use it to confirm what changed before you run another cleanup or switch profiles again.',
      howLinks: 'This keeps workstation changes inspectable without sending you into unrelated audit surfaces.',
    })}
    <div class="table-container">
      <div class="table-header"><h3>Recent Activity</h3></div>
      ${history.length > 0 ? `
        <table>
          <thead>
            <tr><th>When</th><th>Action</th><th>Result</th><th>Selection</th><th>Message</th></tr>
          </thead>
          <tbody>
            ${history.map((entry) => `
              <tr>
                <td>${esc(formatTimestamp(entry.executedAt))}</td>
                <td>${esc(formatHistoryAction(entry.actionId))}</td>
                <td><span class="status-chip ${entry.success ? 'success' : 'error'}">${entry.success ? 'success' : 'failed'}</span></td>
                <td>${esc(formatHistorySelection(entry))}</td>
                <td>${esc(entry.message)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div class="cfg-center-body"><div class="ops-inline-help">No performance activity has been recorded yet.</div></div>'}
    </div>
  `;

  enhanceSectionHelp(panel, PERFORMANCE_HELP.history);
}

function renderPreviewTable(title, targets, kind) {
  if (!Array.isArray(targets) || targets.length === 0) {
    const emptyMessage = kind === 'process'
      ? 'No process targets were suggested for this preview. Adjust the active profile if you want Guardian to recommend more candidates.'
      : `No ${title.toLowerCase()} were suggested for this preview.`;
    return `
      <div class="table-container">
        <div class="table-header"><h3>${esc(title)}</h3></div>
        <div class="cfg-center-body">
          <div class="ops-inline-help">${esc(emptyMessage)}</div>
          ${kind === 'process' ? '<div class="cfg-actions"><button class="btn btn-secondary btn-sm" type="button" data-open-performance-tab="profiles">Manage Profiles</button></div>' : ''}
        </div>
      </div>
    `;
  }

  return `
    <div class="table-container">
      <div class="table-header"><h3>${esc(title)}</h3></div>
      <table>
        <thead>
          <tr><th>Select</th><th>Name</th><th>PID</th><th>CPU</th><th>Memory</th><th>Reason</th><th>Risk</th></tr>
        </thead>
        <tbody>
          ${targets.map((target) => `
            <tr>
              <td>
                <input
                  type="checkbox"
                  data-target-kind="${escAttr(kind)}"
                  data-target-id="${escAttr(target.targetId)}"
                  ${target.selectable ? '' : 'disabled'}
                  ${isSelected(kind, target.targetId) ? 'checked' : ''}
                />
              </td>
              <td>
                <div><strong>${esc(target.label || target.name || target.targetId)}</strong></div>
                ${target.blockedReason ? `<div class="card-subtitle">${esc(target.blockedReason)}</div>` : ''}
              </td>
              <td>${target.pid != null ? formatInt(target.pid) : 'n/a'}</td>
              <td>${formatPercent(target.cpuPercent)}</td>
              <td>${formatMb(target.memoryMb)}</td>
              <td>${esc(target.suggestedReason || '')}</td>
              <td>${esc(target.risk)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function loadProcessCatalog(force = false) {
  if (state.processCatalogStatus === 'pending') {
    return;
  }
  if (!force && state.processCatalogStatus === 'ready' && Array.isArray(state.processCatalog)) {
    return;
  }

  state.processCatalogStatus = 'pending';
  state.processCatalogError = null;
  try {
    const result = await api.performanceProcesses();
    state.processCatalog = Array.isArray(result?.processes) ? result.processes : [];
    state.processCatalogStatus = 'ready';
    state.processCatalogActiveProfileId = state.status?.activeProfile ?? null;
  } catch (error) {
    state.processCatalogStatus = 'error';
    state.processCatalogError = error instanceof Error ? error.message : String(error);
  }

  if (state.activeTab === 'profiles' && currentContainer) {
    await updatePerformance();
  }
}

function renderProcessCatalog(processGroups, profile) {
  const terminateSet = new Set((profile?.terminateProcessNames ?? []).map((name) => normalizeProcessName(name)));
  const protectSet = new Set((profile?.protectProcessNames ?? []).map((name) => normalizeProcessName(name)));

  if (state.processCatalogStatus === 'pending') {
    return '<div class="cfg-center-body"><div class="ops-inline-help">Loading running processes from the host...</div></div>';
  }
  if (state.processCatalogStatus === 'error') {
    return `<div class="cfg-center-body"><div class="ops-inline-help">Failed to load running processes: ${esc(state.processCatalogError || 'unknown error')}</div></div>`;
  }
  if (!Array.isArray(state.processCatalog) || state.processCatalog.length === 0) {
    return '<div class="cfg-center-body"><div class="ops-inline-help">No running processes were returned by the host adapter.</div></div>';
  }
  if (processGroups.length === 0) {
    return '<div class="cfg-center-body"><div class="ops-inline-help">No running processes matched your current search.</div></div>';
  }

  return `
    <table class="performance-process-table">
      <thead>
        <tr><th>Process</th><th>Instances</th><th>Memory</th><th>CPU</th><th>CPU Time</th><th>Guardian Status</th><th>Quick Add</th></tr>
      </thead>
      <tbody>
        ${processGroups.map((processGroup) => {
          const normalizedName = normalizeProcessName(processGroup.name);
          const alreadyClosing = terminateSet.has(normalizedName);
          const alreadyProtected = protectSet.has(normalizedName);
          return `
            <tr>
              <td>
                <div><strong>${esc(processGroup.name)}</strong></div>
                <div class="card-subtitle">${esc(processGroup.executablePath || 'Executable path unavailable')}</div>
              </td>
              <td>${esc(String(processGroup.instanceCount))}</td>
              <td>${formatMb(processGroup.memoryMb)}</td>
              <td>${processGroup.cpuPercent != null ? formatPercent(processGroup.cpuPercent) : 'n/a'}</td>
              <td>${formatCpuTime(processGroup.cpuTimeSec)}</td>
              <td>${processGroup.protected
                ? `<span class="status-chip warning" title="${escAttr(processGroup.protectionReason || 'Protected')}">Protected</span>`
                : '<span class="status-chip success">Reviewable</span>'}</td>
              <td>
                <div class="performance-process-row-actions">
                  <button class="btn btn-secondary btn-sm" type="button" data-add-process-mode="terminate" data-add-process-name="${escAttr(processGroup.name)}"${alreadyClosing ? ' disabled' : ''}>${alreadyClosing ? 'Added To Close' : 'Add To Close'}</button>
                  <button class="btn btn-secondary btn-sm" type="button" data-add-process-mode="protect" data-add-process-name="${escAttr(processGroup.name)}"${alreadyProtected ? ' disabled' : ''}>${alreadyProtected ? 'Added To Protect' : 'Add To Protect'}</button>
                </div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function groupProcessCatalog(processes, searchValue = '') {
  const search = String(searchValue || '').trim().toLowerCase();
  const groups = new Map();

  for (const processInfo of processes) {
    const key = normalizeProcessName(processInfo.name);
    if (!key) continue;
    const existing = groups.get(key) || {
      key,
      name: processInfo.name,
      instanceCount: 0,
      memoryMb: 0,
      cpuPercent: 0,
      cpuPercentAvailable: false,
      cpuTimeSec: 0,
      cpuTimeAvailable: false,
      protected: Boolean(processInfo.protected),
      protectionReason: processInfo.protectionReason,
      executablePath: processInfo.executablePath,
    };

    existing.instanceCount += 1;
    if (typeof processInfo.memoryMb === 'number') {
      existing.memoryMb += processInfo.memoryMb;
    }
    if (typeof processInfo.cpuPercent === 'number') {
      existing.cpuPercent += processInfo.cpuPercent;
      existing.cpuPercentAvailable = true;
    }
    if (typeof processInfo.cpuTimeSec === 'number') {
      existing.cpuTimeSec += processInfo.cpuTimeSec;
      existing.cpuTimeAvailable = true;
    }
    if (!existing.executablePath && processInfo.executablePath) {
      existing.executablePath = processInfo.executablePath;
    }
    if (processInfo.protected) {
      existing.protected = true;
      existing.protectionReason = processInfo.protectionReason || existing.protectionReason;
    }

    groups.set(key, existing);
  }

  return [...groups.values()]
    .filter((processGroup) => {
      if (!search) return true;
      return processGroup.name.toLowerCase().includes(search)
        || String(processGroup.executablePath || '').toLowerCase().includes(search);
    })
    .sort((left, right) => {
      const memoryDelta = (right.memoryMb ?? 0) - (left.memoryMb ?? 0);
      if (memoryDelta !== 0) return memoryDelta;
      const cpuDelta = (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0);
      if (cpuDelta !== 0) return cpuDelta;
      return left.name.localeCompare(right.name);
    })
    .map((processGroup) => ({
      ...processGroup,
      cpuPercent: processGroup.cpuPercentAvailable ? round(processGroup.cpuPercent) : undefined,
      cpuTimeSec: processGroup.cpuTimeAvailable ? round(processGroup.cpuTimeSec) : undefined,
      memoryMb: round(processGroup.memoryMb),
    }));
}

function buildSuggestedProfileTemplates(processGroups) {
  if (!Array.isArray(processGroups) || processGroups.length === 0) {
    return [];
  }

  const displayNames = new Map(processGroups.map((processGroup) => [normalizeProcessName(processGroup.name), processGroup.name]));
  const hasAny = (...names) => names.some((name) => displayNames.has(name));
  const pickNames = (...names) => names
    .map((name) => displayNames.get(name))
    .filter((name, index, values) => !!name && values.indexOf(name) === index);

  const suggestions = [];

  if (hasAny('ollama', 'lm studio', 'vmmemwsl')) {
    suggestions.push({
      id: uniqueSuggestedProfileId('local-model-focus'),
      name: 'Local Model Focus',
      powerMode: 'high_performance',
      autoActionsEnabled: false,
      allowedActionIds: [],
      terminateProcessNames: pickNames('mailbird', 'chatgpt', 'onedrive', 'googledrivefs', 'wispr flow', 'm365copilot'),
      protectProcessNames: pickNames('code', 'node', 'ollama', 'lm studio', 'vmmemwsl'),
      latencyTargets: [
        { kind: 'internet', id: 'cloudflare', target: 'https://1.1.1.1' },
        { kind: 'api', id: 'default-llm', targetRef: 'defaultProvider' },
      ],
    });
  }

  if (hasAny('firefox', 'msedge')) {
    suggestions.push({
      id: uniqueSuggestedProfileId('browser-research'),
      name: 'Browser Research',
      powerMode: 'balanced',
      autoActionsEnabled: false,
      allowedActionIds: [],
      terminateProcessNames: pickNames('mailbird', 'onedrive', 'googledrivefs', 'wispr flow', 'razerappengine'),
      protectProcessNames: pickNames('firefox', 'msedge', 'chatgpt', 'code'),
      latencyTargets: [
        { kind: 'internet', id: 'cloudflare', target: 'https://1.1.1.1' },
      ],
    });
  }

  if (hasAny('mailbird', 'onedrive', 'googledrivefs', 'wispr flow', 'chatgpt')) {
    suggestions.push({
      id: uniqueSuggestedProfileId('deep-work-quiet'),
      name: 'Deep Work Quiet',
      powerMode: 'high_performance',
      autoActionsEnabled: false,
      allowedActionIds: [],
      terminateProcessNames: pickNames('mailbird', 'chatgpt', 'onedrive', 'googledrivefs', 'wispr flow', 'phoneexperiencehost', 'm365copilot', 'razerappengine'),
      protectProcessNames: pickNames('code', 'node', 'ollama', 'lm studio'),
      latencyTargets: [
        { kind: 'internet', id: 'cloudflare', target: 'https://1.1.1.1' },
        { kind: 'api', id: 'default-llm', targetRef: 'defaultProvider' },
      ],
    });
  }

  return suggestions.filter((profile) => profile.terminateProcessNames.length > 0 || profile.protectProcessNames.length > 0);
}

function uniqueSuggestedProfileId(baseId) {
  const existingIds = new Set((state.status?.profiles ?? []).map((profile) => profile.id));
  if (!existingIds.has(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function upsertProcessRule(editorEl, processName, mode) {
  if (!processName || !mode) return;
  const targetSelector = mode === 'protect' ? '[data-profile-field="protect"]' : '[data-profile-field="terminate"]';
  const oppositeSelector = mode === 'protect' ? '[data-profile-field="terminate"]' : '[data-profile-field="protect"]';
  const targetField = editorEl.querySelector(targetSelector);
  const oppositeField = editorEl.querySelector(oppositeSelector);
  if (!targetField || !oppositeField) return;

  const normalizedTarget = normalizeProcessName(processName);
  const nextTargetValues = parseProfileList(targetField.value).filter((value) => normalizeProcessName(value) !== normalizedTarget);
  nextTargetValues.push(processName);
  targetField.value = nextTargetValues.join('\n');

  const nextOppositeValues = parseProfileList(oppositeField.value).filter((value) => normalizeProcessName(value) !== normalizedTarget);
  oppositeField.value = nextOppositeValues.join('\n');
}

function normalizeProcessName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.endsWith('.exe') ? normalized.slice(0, -4) : normalized;
}

async function openPerformanceTab(tabId) {
  state.activeTab = normalizeTabId(tabId);
  await updatePerformance();
}

function normalizeTabId(value) {
  if (value === 'cleanup' || value === 'profiles' || value === 'history' || value === 'overview') {
    return value;
  }
  if (value === 'actions') return 'cleanup';
  if (value === 'live' || value === 'latency') return 'overview';
  return 'overview';
}

function summarizeProcessPressure(processInfo) {
  if (processInfo.protected) {
    return processInfo.protectionReason || 'Protected by Guardian policy.';
  }
  const cpuPercent = processInfo.cpuPercent ?? 0;
  const memoryMb = processInfo.memoryMb ?? 0;
  if (cpuPercent >= 20 && memoryMb >= 800) {
    return 'High CPU and memory usage make this a strong cleanup candidate if it is not essential.';
  }
  if (cpuPercent >= 12) {
    return 'Using notable CPU from the latest sample.';
  }
  if (memoryMb >= 600) {
    return 'Using notable memory from the latest sample.';
  }
  return 'Visible in the latest sample, but not currently protected.';
}

function buildCleanupCapabilityMessage(capabilities, os) {
  if (capabilities.canManageProcesses) {
    return 'Guardian can stop reviewed process targets on this runtime after you confirm the final selected subset.';
  }
  return `Guardian can still inspect ${os || 'this'} process activity and build a preview, but host process control is read-only on this runtime.`;
}

function summarizeProfileBadges(profile, activeProfileId) {
  const badges = [];
  if (profile.id === activeProfileId) badges.push('Active');
  if (profile.terminateProcessNames.length > 0) badges.push(`${profile.terminateProcessNames.length} cleanup`);
  if (profile.protectProcessNames.length > 0) badges.push(`${profile.protectProcessNames.length} protected`);
  if (profile.latencyTargets.length > 0) badges.push(`${profile.latencyTargets.length} latency`);
  if (profile.autoActionsEnabled && profile.allowedActionIds.length > 0) badges.push(`${profile.allowedActionIds.length} auto-action`);
  if (badges.length === 0) badges.push('Minimal profile');
  return badges;
}

function cloneEditableProfile(profile) {
  return {
    id: String(profile?.id || ''),
    name: String(profile?.name || ''),
    powerMode: profile?.powerMode || DEFAULT_PROFILE_POWER_MODE,
    autoActionsEnabled: profile?.autoActionsEnabled === true,
    allowedActionIds: Array.isArray(profile?.allowedActionIds) ? [...profile.allowedActionIds] : [],
    terminateProcessNames: Array.isArray(profile?.terminateProcessNames) ? [...profile.terminateProcessNames] : [],
    protectProcessNames: Array.isArray(profile?.protectProcessNames) ? [...profile.protectProcessNames] : [],
    latencyTargets: Array.isArray(profile?.latencyTargets)
      ? profile.latencyTargets.map((target) => ({
        id: String(target?.id || ''),
        kind: target?.kind === 'api' ? 'api' : 'internet',
        target: String(target?.target || ''),
        targetRef: String(target?.targetRef || ''),
      }))
      : [],
  };
}

function buildDefaultProfile() {
  return cloneEditableProfile({
    id: '',
    name: '',
    powerMode: DEFAULT_PROFILE_POWER_MODE,
    autoActionsEnabled: false,
    allowedActionIds: [],
    terminateProcessNames: [],
    protectProcessNames: [],
    latencyTargets: [],
  });
}

function renderPowerModeOptions(selectedValue) {
  return [
    { value: 'balanced', label: 'Balanced' },
    { value: 'high_performance', label: 'High Performance' },
    { value: 'power_saver', label: 'Power Saver' },
  ].map((option) => `<option value="${option.value}"${option.value === selectedValue ? ' selected' : ''}>${esc(option.label)}</option>`).join('');
}

function formatProfileList(values) {
  return Array.isArray(values) ? values.join('\n') : '';
}

function parseProfileList(value) {
  if (!value) return [];
  return [...new Set(
    String(value)
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function buildConfigProfile(profile) {
  const next = {
    id: profile.id,
    name: profile.name,
  };

  if (profile.powerMode) {
    next.powerMode = profile.powerMode;
  }

  if (profile.autoActionsEnabled || profile.allowedActionIds.length > 0) {
    next.autoActions = {
      enabled: profile.autoActionsEnabled,
      allowedActionIds: [...profile.allowedActionIds],
    };
  }

  if (profile.terminateProcessNames.length > 0 || profile.protectProcessNames.length > 0) {
    next.processRules = {};
    if (profile.terminateProcessNames.length > 0) {
      next.processRules.terminate = [...profile.terminateProcessNames];
    }
    if (profile.protectProcessNames.length > 0) {
      next.processRules.protect = [...profile.protectProcessNames];
    }
  }

  if (profile.latencyTargets.length > 0) {
    next.latencyTargets = profile.latencyTargets.map((target) => {
      const nextTarget = {
        kind: target.kind === 'api' ? 'api' : 'internet',
        id: target.id,
      };
      if (target.target) {
        nextTarget.target = target.target;
      }
      if (target.targetRef) {
        nextTarget.targetRef = target.targetRef;
      }
      return nextTarget;
    });
  }

  return next;
}

function collectProfileDraft(editorEl, existingProfile) {
  const name = getInputValue(editorEl, '[data-profile-field="name"]');
  if (!name) {
    throw new Error('Profile name is required.');
  }

  const requestedId = getInputValue(editorEl, '[data-profile-field="id"]') || name;
  const id = sanitizeProfileId(requestedId);
  if (!id) {
    throw new Error('Profile ID is required and must contain letters or numbers.');
  }

  const powerMode = getInputValue(editorEl, '[data-profile-field="powerMode"]') || DEFAULT_PROFILE_POWER_MODE;
  const terminateProcessNames = parseProfileList(getInputValue(editorEl, '[data-profile-field="terminate"]'));
  const protectProcessNames = parseProfileList(getInputValue(editorEl, '[data-profile-field="protect"]'));
  const latencyTargets = collectLatencyTargets(editorEl);

  return {
    id,
    name,
    powerMode,
    autoActionsEnabled: existingProfile?.autoActionsEnabled === true,
    allowedActionIds: Array.isArray(existingProfile?.allowedActionIds) ? [...existingProfile.allowedActionIds] : [],
    terminateProcessNames,
    protectProcessNames,
    latencyTargets,
  };
}

function renderLatencyRows(latencyTargets = []) {
  if (!latencyTargets.length) {
    return '<div class="performance-profile-empty performance-profile-empty--inline" data-latency-empty>No latency checks yet. Add one to separate workstation issues from provider or internet latency.</div>';
  }
  return latencyTargets.map((target) => renderLatencyTargetRow(target)).join('');
}

function renderLatencyTargetRow(target = {}) {
  const kind = target.kind === 'api' ? 'api' : 'internet';
  const mode = target.targetRef === 'defaultProvider' ? 'default-provider' : 'custom-target';
  return `
    <div class="performance-latency-row" data-latency-row>
      <div class="cfg-field">
        <label>Type</label>
        <select data-latency-field="kind">
          <option value="internet"${kind === 'internet' ? ' selected' : ''}>Internet</option>
          <option value="api"${kind === 'api' ? ' selected' : ''}>API</option>
        </select>
      </div>
      <div class="cfg-field">
        <label>Label</label>
        <input type="text" data-latency-field="id" value="${escAttr(target.id || '')}" placeholder="cloudflare">
      </div>
      <div class="cfg-field">
        <label>Source</label>
        <select data-latency-field="mode">
          <option value="custom-target"${mode === 'custom-target' ? ' selected' : ''}>Custom URL</option>
          <option value="default-provider"${mode === 'default-provider' ? ' selected' : ''}>Default Provider</option>
        </select>
      </div>
      <div class="cfg-field">
        <label>Endpoint</label>
        <input type="text" data-latency-field="target" value="${escAttr(target.target || '')}" placeholder="${kind === 'internet' ? 'https://1.1.1.1' : 'https://api.example.com/health'}">
      </div>
      <div class="performance-latency-row-actions">
        <button class="btn btn-secondary btn-sm" type="button" data-remove-latency>Remove</button>
      </div>
    </div>
  `;
}

function wireLatencyRow(row, latencyList) {
  const kindSelect = row.querySelector('[data-latency-field="kind"]');
  const modeSelect = row.querySelector('[data-latency-field="mode"]');
  const targetInput = row.querySelector('[data-latency-field="target"]');
  const removeBtn = row.querySelector('[data-remove-latency]');

  function syncRow() {
    if (!kindSelect || !modeSelect || !targetInput) return;
    const isInternet = kindSelect.value === 'internet';
    const defaultProviderOption = [...modeSelect.options].find((option) => option.value === 'default-provider');
    if (defaultProviderOption) {
      defaultProviderOption.disabled = isInternet;
    }
    if (isInternet && modeSelect.value === 'default-provider') {
      modeSelect.value = 'custom-target';
    }
    const usesDefaultProvider = modeSelect.value === 'default-provider';
    targetInput.disabled = usesDefaultProvider;
    targetInput.placeholder = usesDefaultProvider
      ? 'Uses the current default provider URL'
      : isInternet
        ? 'https://1.1.1.1'
        : 'https://api.example.com/health';
  }

  kindSelect?.addEventListener('change', syncRow);
  modeSelect?.addEventListener('change', syncRow);
  removeBtn?.addEventListener('click', () => {
    row.remove();
    ensureLatencyEmptyState(latencyList);
  });

  syncRow();
}

function collectLatencyTargets(editorEl) {
  return [...editorEl.querySelectorAll('[data-latency-row]')].map((row) => {
    const kind = getInputValue(row, '[data-latency-field="kind"]') === 'api' ? 'api' : 'internet';
    const id = sanitizeProfileId(getInputValue(row, '[data-latency-field="id"]'));
    const mode = getInputValue(row, '[data-latency-field="mode"]');
    const target = getInputValue(row, '[data-latency-field="target"]');

    if (!id) {
      throw new Error('Each latency check needs a label.');
    }

    if (kind === 'internet') {
      if (!target) {
        throw new Error(`Latency check '${id}' needs an endpoint URL.`);
      }
      return { kind, id, target };
    }

    if (mode === 'default-provider') {
      return { kind, id, targetRef: 'defaultProvider' };
    }

    if (!target) {
      throw new Error(`Latency check '${id}' needs an endpoint URL or a default provider source.`);
    }

    return { kind, id, target };
  });
}

function removeLatencyEmptyState(latencyList) {
  latencyList.querySelector('[data-latency-empty]')?.remove();
}

function ensureLatencyEmptyState(latencyList) {
  if (latencyList.querySelector('[data-latency-row]')) {
    return;
  }
  latencyList.innerHTML = '<div class="performance-profile-empty performance-profile-empty--inline" data-latency-empty>No latency checks yet. Add one to separate workstation issues from provider or internet latency.</div>';
}

function getInputValue(root, selector) {
  const element = root.querySelector(selector);
  if (!element) return '';
  return typeof element.value === 'string' ? element.value.trim() : '';
}

function sanitizeProfileId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatHistoryAction(actionId) {
  if (actionId === 'apply_profile') return 'Profile switch';
  if (actionId === 'cleanup') return 'Reviewed cleanup';
  return actionId.replaceAll('_', ' ');
}

function formatHistorySelection(entry) {
  if (entry.selectedProcessCount > 0 || entry.selectedCleanupCount > 0) {
    return `${entry.selectedProcessCount} process / ${entry.selectedCleanupCount} cleanup`;
  }
  return 'No host mutation';
}

function isSelected(kind, targetId) {
  const selection = kind === 'process' ? state.selectedProcessTargetIds : state.selectedCleanupTargetIds;
  return selection.has(targetId);
}

function setStatusText(element, text, kind = 'info') {
  if (!element) return;
  element.textContent = text || '';
  element.className = `cfg-save-status ${kind || 'info'}`.trim();
}

function severityClass(value, high, medium) {
  if (typeof value !== 'number') return 'info';
  if (value >= high) return 'error';
  if (value >= medium) return 'warning';
  return 'success';
}

function latencyStateClass(stateValue) {
  if (stateValue === 'ok') return 'success';
  if (stateValue === 'disabled' || stateValue === 'idle') return 'warning';
  return 'error';
}

function formatPercent(value) {
  return typeof value === 'number' ? `${Math.round(value)}%` : 'n/a';
}

function formatMb(value) {
  return typeof value === 'number' ? `${Math.round(value)} MB` : 'n/a';
}

function formatCpuTime(value) {
  if (typeof value !== 'number') return 'n/a';
  if (value >= 3600) return `${round(value / 3600)} h`;
  if (value >= 60) return `${round(value / 60)} min`;
  return `${round(value)} s`;
}

function formatGb(value) {
  return typeof value === 'number' ? `${round(value / 1024)} GB` : 'n/a';
}

function formatInt(value) {
  return typeof value === 'number' ? String(Math.round(value)) : 'n/a';
}

function formatTimestamp(value) {
  if (typeof value !== 'number') return 'unknown';
  return new Date(value).toLocaleString();
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value) {
  return esc(value).replace(/'/g, '&#39;');
}
