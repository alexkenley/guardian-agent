/**
 * Cloud page - cloud monitoring and configuration hub.
 */

import { api } from '../api.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';

let currentContainer = null;

const CLOUD_HELP = {
  overview: {
    'Provider Posture': {
      whatItIs: 'This section summarizes saved cloud provider posture across all supported providers.',
      whatSeeing: 'You are seeing counts for profiles, inline secrets, credential refs, endpoint overrides, and notable posture notes.',
      whatCanDo: 'Use it to spot weak auth patterns or custom endpoint usage before you drill into Connections.',
      howLinks: 'Overview summarizes connection posture, while Connections is where you actually manage provider profiles.',
    },
    'How This Area Works': {
      whatItIs: 'This is the orientation note for how the Cloud hub is organized.',
      whatSeeing: 'You are seeing a short explanation of where setup, activity review, and automation entry points live.',
      whatCanDo: 'Use it to decide whether you need connection setup, audit review, or automation creation next.',
      howLinks: 'It explains the handoff between Connections, Activity, and Automations.',
    },
  },
  connections: {
    'Cloud Controls': {
      whatItIs: 'This section controls whether the cloud runtime is enabled at all.',
      whatSeeing: 'You are seeing the global runtime toggle that gates whether saved cloud profiles can be used.',
      whatCanDo: 'Enable or disable cloud tooling before operators or automations try to use saved credentials.',
      howLinks: 'The provider-specific connection forms below only matter when the overall cloud runtime is enabled.',
    },
    'Connection Model': {
      whatItIs: 'This section explains how saved cloud profiles are used by the rest of the app.',
      whatSeeing: 'You are seeing guidance on saved credentials, preserved secrets, and advanced endpoint overrides.',
      whatCanDo: 'Use it to understand what gets stored here and how those profiles are consumed later.',
      howLinks: 'Saved connections feed Cloud Activity and cloud-focused automations, while raw editing remains an advanced path only.',
    },
  },
  activity: {
    'Cloud Approvals': {
      whatItIs: 'This section lists cloud-related approval requests.',
      whatSeeing: 'You are seeing approval items for cloud tools that need operator confirmation or review.',
      whatCanDo: 'Use it to review pending cloud actions and understand the risk and origin of each request.',
      howLinks: 'Approvals here complement policy and audit information, while connection editing still happens in Connections.',
    },
    'Recent Cloud Tool Jobs': {
      whatItIs: 'This is the recent execution history for cloud tool jobs.',
      whatSeeing: 'You are seeing recent cloud job status, origin, creation time, and a short detail preview.',
      whatCanDo: 'Review recent cloud actions and confirm whether they succeeded or failed.',
      howLinks: 'This operational history pairs with cloud audit events below and the deeper workflow ownership in Automations.',
    },
    'Recent Cloud Audit Activity': {
      whatItIs: 'This section shows recent cloud-related audit events.',
      whatSeeing: 'You are seeing recent denials, approvals, and cloud action records with severity and reason context.',
      whatCanDo: 'Use it to investigate what happened recently in the cloud domain without leaving the hub.',
      howLinks: 'It ties cloud operations back to the shared audit and policy system.',
    },
  },
  automations: {
    'Cloud Automation Entry Points': {
      whatItIs: 'This section explains how the Cloud hub hands off into Automations.',
      whatSeeing: 'You are seeing the ownership boundary between cloud setup and repeatable workflows.',
      whatCanDo: 'Use it to jump into Automations when a cloud task should become repeatable or scheduled.',
      howLinks: 'Cloud can launch automation creation, but Automations remains the system of record for workflow editing and run history.',
    },
    'Cloud Workflows': {
      whatItIs: 'This section lists workflow definitions that contain cloud steps.',
      whatSeeing: 'You are seeing enabled or disabled cloud-focused playbooks and the steps they contain.',
      whatCanDo: 'Review what cloud workflows already exist before creating or editing additional ones in Automations.',
      howLinks: 'These workflows are displayed here for context, but they are still owned and edited on the Automations page.',
    },
    'Cloud Scheduled Tasks': {
      whatItIs: 'This section lists scheduled tasks that target cloud tools.',
      whatSeeing: 'You are seeing cloud-targeted schedules, cron expressions, and current status.',
      whatCanDo: 'Review what cloud work is already scheduled before creating new automation schedules.',
      howLinks: 'Scheduling ownership stays in Automations even when the task is cloud-focused.',
    },
  },
};

const CLOUD_PROVIDER_DEFS = [
  {
    key: 'cpanelProfiles',
    label: 'cPanel / WHM',
    fields: [
      { key: 'id', label: 'Profile ID', type: 'text', placeholder: 'cpanel-prod' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Production WHM' },
      { key: 'type', label: 'Type', type: 'select', options: ['whm', 'cpanel'] },
      { key: 'host', label: 'Host', type: 'text', placeholder: 'server.example.com' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '2087' },
      { key: 'username', label: 'Username', type: 'text', placeholder: 'root' },
      { key: 'credentialRef', label: 'Credential Ref', type: 'text', placeholder: 'cloud.whm.prod' },
      { key: 'apiToken', label: 'API Token', type: 'password', configuredKey: 'apiTokenConfigured', placeholder: 'Leave blank to keep existing token' },
      { key: 'defaultCpanelUser', label: 'Default cPanel User', type: 'text', placeholder: 'site-owner' },
      { key: 'ssl', label: 'Use TLS', type: 'checkbox' },
      { key: 'allowSelfSigned', label: 'Allow Self-Signed TLS', type: 'checkbox' },
    ],
  },
  {
    key: 'vercelProfiles',
    label: 'Vercel',
    fields: [
      { key: 'id', label: 'Profile ID', type: 'text', placeholder: 'vercel-prod' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Production Vercel' },
      { key: 'credentialRef', label: 'Credential Ref', type: 'text', placeholder: 'cloud.vercel.prod' },
      { key: 'apiToken', label: 'API Token', type: 'password', configuredKey: 'apiTokenConfigured', placeholder: 'Leave blank to keep existing token' },
      { key: 'teamId', label: 'Team ID', type: 'text', placeholder: 'team_123' },
      { key: 'slug', label: 'Default Team/Project Slug', type: 'text', placeholder: 'my-team' },
      { key: 'apiBaseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.vercel.com' },
    ],
  },
  {
    key: 'cloudflareProfiles',
    label: 'Cloudflare',
    fields: [
      { key: 'id', label: 'Profile ID', type: 'text', placeholder: 'cloudflare-main' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Main Cloudflare' },
      { key: 'credentialRef', label: 'Credential Ref', type: 'text', placeholder: 'cloud.cloudflare.main' },
      { key: 'apiToken', label: 'API Token', type: 'password', configuredKey: 'apiTokenConfigured', placeholder: 'Leave blank to keep existing token' },
      { key: 'accountId', label: 'Account ID', type: 'text', placeholder: 'account-id' },
      { key: 'defaultZoneId', label: 'Default Zone ID', type: 'text', placeholder: 'zone-id' },
      { key: 'apiBaseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.cloudflare.com/client/v4' },
    ],
  },
  {
    key: 'awsProfiles',
    label: 'AWS',
    fields: [
      { key: 'id', label: 'Profile ID', type: 'text', placeholder: 'aws-prod' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Production AWS' },
      { key: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1' },
      { key: 'accessKeyIdCredentialRef', label: 'Access Key Ref', type: 'text', placeholder: 'cloud.aws.prod.access' },
      { key: 'secretAccessKeyCredentialRef', label: 'Secret Key Ref', type: 'text', placeholder: 'cloud.aws.prod.secret' },
      { key: 'sessionTokenCredentialRef', label: 'Session Token Ref', type: 'text', placeholder: 'cloud.aws.prod.session' },
      { key: 'accessKeyId', label: 'Access Key ID', type: 'password', configuredKey: 'accessKeyIdConfigured', placeholder: 'Leave blank to keep existing key' },
      { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', configuredKey: 'secretAccessKeyConfigured', placeholder: 'Leave blank to keep existing secret' },
      { key: 'sessionToken', label: 'Session Token', type: 'password', configuredKey: 'sessionTokenConfigured', placeholder: 'Optional temporary token' },
      { key: 'endpoints', label: 'Endpoint Overrides (JSON)', type: 'json', placeholder: '{\n  "s3": "http://localhost:4566"\n}' },
    ],
  },
  {
    key: 'gcpProfiles',
    label: 'GCP',
    fields: [
      { key: 'id', label: 'Profile ID', type: 'text', placeholder: 'gcp-prod' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Production GCP' },
      { key: 'projectId', label: 'Project ID', type: 'text', placeholder: 'my-project' },
      { key: 'location', label: 'Location', type: 'text', placeholder: 'us-central1' },
      { key: 'accessTokenCredentialRef', label: 'Access Token Ref', type: 'text', placeholder: 'cloud.gcp.prod.token' },
      { key: 'serviceAccountCredentialRef', label: 'Service Account Ref', type: 'text', placeholder: 'cloud.gcp.prod.service-account' },
      { key: 'accessToken', label: 'Access Token', type: 'password', configuredKey: 'accessTokenConfigured', placeholder: 'Leave blank to keep existing token' },
      { key: 'serviceAccountJson', label: 'Service Account JSON', type: 'textarea', configuredKey: 'serviceAccountConfigured', placeholder: '{\n  "type": "service_account"\n}' },
      { key: 'endpoints', label: 'Endpoint Overrides (JSON)', type: 'json', placeholder: '{\n  "storage": "http://localhost:4443"\n}' },
    ],
  },
  {
    key: 'azureProfiles',
    label: 'Azure',
    fields: [
      { key: 'id', label: 'Profile ID', type: 'text', placeholder: 'azure-prod' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Production Azure' },
      { key: 'subscriptionId', label: 'Subscription ID', type: 'text', placeholder: 'subscription-id' },
      { key: 'tenantId', label: 'Tenant ID', type: 'text', placeholder: 'tenant-id' },
      { key: 'defaultResourceGroup', label: 'Default Resource Group', type: 'text', placeholder: 'rg-main' },
      { key: 'blobBaseUrl', label: 'Blob Base URL', type: 'text', placeholder: 'https://account.blob.core.windows.net' },
      { key: 'accessTokenCredentialRef', label: 'Access Token Ref', type: 'text', placeholder: 'cloud.azure.prod.token' },
      { key: 'clientIdCredentialRef', label: 'Client ID Ref', type: 'text', placeholder: 'cloud.azure.prod.client-id' },
      { key: 'clientSecretCredentialRef', label: 'Client Secret Ref', type: 'text', placeholder: 'cloud.azure.prod.client-secret' },
      { key: 'accessToken', label: 'Access Token', type: 'password', configuredKey: 'accessTokenConfigured', placeholder: 'Leave blank to keep existing token' },
      { key: 'clientId', label: 'Client ID', type: 'password', configuredKey: 'clientIdConfigured', placeholder: 'Leave blank to keep existing client ID' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', configuredKey: 'clientSecretConfigured', placeholder: 'Leave blank to keep existing secret' },
      { key: 'endpoints', label: 'Endpoint Overrides (JSON)', type: 'json', placeholder: '{\n  "management": "https://management.azure.com"\n}' },
    ],
  },
];

export async function renderCloud(container, options = {}) {
  currentContainer = container;
  container.innerHTML = `
    <h2 class="page-title">Cloud</h2>
    ${renderGuidancePanel({
      kicker: 'Cloud Guide',
      title: 'Connection setup, posture, and cloud operations',
      whatItIs: 'Cloud is the dedicated hub for provider connections, cloud posture, recent cloud activity, and cloud-focused automation entry points.',
      whatSeeing: 'You are seeing tabs for summary posture, guided connection forms, cloud activity, and automation handoff.',
      whatCanDo: 'Use this page to connect providers, review cloud-specific operational activity, and move into automations from saved connections.',
      howLinks: 'Connection setup lives here, Security receives normalized findings, and Automations owns repeatable workflow configuration and run history.',
    })}
  `;

  createTabs(container, [
    { id: 'overview', label: 'Overview', render: renderOverviewTab },
    { id: 'connections', label: 'Connections', render: renderConnectionsTab },
    { id: 'activity', label: 'Activity', render: renderActivityTab },
    { id: 'automations', label: 'Automations', render: renderAutomationsTab },
  ], normalizeCloudTab(options?.tab));
}

export async function updateCloud() {
  if (!currentContainer) return;
  const activeTab = currentContainer.dataset.activeTab;
  await renderCloud(currentContainer, { tab: activeTab });
}

function normalizeCloudTab(tab) {
  if (tab === 'config') return 'connections';
  return tab || 'overview';
}

async function renderOverviewTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [config, auditEvents] = await Promise.all([
      api.config(),
      api.audit({ limit: 200 }).catch(() => []),
    ]);
    const cloud = getCloudConfig(config);
    const providerRows = buildProviderRows(cloud);
    const activeProviders = providerRows.filter((row) => row.count > 0).length;
    const cloudEvents = (auditEvents || []).filter(isCloudAuditEvent).slice(0, 30);
    const deniedCount = cloudEvents.filter((event) => event.type === 'action_denied').length;

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Overview',
        compact: true,
        whatItIs: 'Overview is the posture summary for the cloud domain.',
        whatSeeing: 'You are seeing runtime status, profile counts, secret posture, TLS exceptions, and recent cloud activity indicators.',
        whatCanDo: 'Use it to confirm the cloud runtime is configured safely and decide whether you need Connections or Activity next.',
        howLinks: 'It summarizes posture only; editing happens in Connections and operational review happens in Activity.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card ${cloud.enabled ? 'success' : 'error'}">
          <div class="card-title">Cloud Runtime</div>
          <div class="card-value">${cloud.enabled ? 'Enabled' : 'Disabled'}</div>
          <div class="card-subtitle">${activeProviders} provider families configured</div>
        </div>
        <div class="status-card info">
          <div class="card-title">Profiles</div>
          <div class="card-value">${cloud.profileCounts?.total || 0}</div>
          <div class="card-subtitle">Saved cloud connections</div>
        </div>
        <div class="status-card ${cloud.security?.inlineSecretProfileCount ? 'warning' : 'success'}">
          <div class="card-title">Inline Secrets</div>
          <div class="card-value">${cloud.security?.inlineSecretProfileCount || 0}</div>
          <div class="card-subtitle">${cloud.security?.credentialRefCount || 0} credential refs configured</div>
        </div>
        <div class="status-card ${cloud.security?.selfSignedProfileCount ? 'warning' : 'accent'}">
          <div class="card-title">TLS Exceptions</div>
          <div class="card-value">${cloud.security?.selfSignedProfileCount || 0}</div>
          <div class="card-subtitle">Profiles accepting self-signed certificates</div>
        </div>
        <div class="status-card ${deniedCount > 0 ? 'warning' : 'info'}">
          <div class="card-title">Recent Denials</div>
          <div class="card-value">${deniedCount}</div>
          <div class="card-subtitle">${cloudEvents.length} recent cloud audit events</div>
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
        <div class="table-header"><h3>How This Area Works</h3></div>
        <div class="cfg-center-body">
          <div class="ops-inline-help">
            Use <strong>Connections</strong> to add or edit provider credentials. Use <strong>Activity</strong> to review cloud actions, denials, and approvals. Use <strong>Automations</strong> to launch repeatable cloud monitoring and operations from saved connections.
          </div>
        </div>
      </div>
    `;
    enhanceSectionHelp(panel, CLOUD_HELP.overview, createGenericHelpFactory('Cloud Overview'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderConnectionsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const config = await api.config();
    const cloud = getCloudConfig(config);
    panel.innerHTML = renderGuidancePanel({
      kicker: 'Connections',
      compact: true,
      whatItIs: 'Connections is the guided setup surface for supported cloud providers.',
      whatSeeing: 'You are seeing the global cloud runtime toggle plus provider-specific connection forms.',
      whatCanDo: 'Create, update, test, and delete cloud profiles without dropping into raw JSON as the primary flow.',
      howLinks: 'Saved profiles here are used later by cloud activity views and cloud-focused automations.',
    });

    const globalSection = document.createElement('div');
    globalSection.className = 'table-container';
    globalSection.innerHTML = `
      <div class="table-header">
        <h3>Cloud Controls</h3>
        <span class="cfg-header-note">The cloud runtime must be enabled before cloud tools and automations can use saved profiles.</span>
      </div>
      <div class="cfg-center-body">
        <div class="cfg-form-grid">
          <div class="cfg-field">
            <label>Enable Cloud Tools</label>
            <select id="cloud-enabled-toggle">
              <option value="true" ${cloud.enabled ? 'selected' : ''}>Enabled</option>
              <option value="false" ${!cloud.enabled ? 'selected' : ''}>Disabled</option>
            </select>
          </div>
        </div>
        <div class="cfg-actions">
          <button class="btn btn-primary" id="cloud-enabled-save" type="button">Save Cloud Runtime</button>
          <span id="cloud-enabled-status" class="cfg-save-status"></span>
        </div>
      </div>
    `;
    panel.appendChild(globalSection);

    globalSection.querySelector('#cloud-enabled-save')?.addEventListener('click', async () => {
      const statusEl = globalSection.querySelector('#cloud-enabled-status');
      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.updateConfig({
          assistant: {
            tools: {
              cloud: {
                enabled: globalSection.querySelector('#cloud-enabled-toggle')?.value === 'true',
              },
            },
          },
        });
        statusEl.textContent = result.message || 'Saved.';
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });

    const info = document.createElement('div');
    info.className = 'table-container';
    info.innerHTML = `
      <div class="table-header"><h3>Connection Model</h3></div>
      <div class="cfg-center-body" style="font-size:0.78rem;color:var(--text-secondary);line-height:1.6;">
        Save credentials here, then use the Cloud Activity surface or cloud-focused automations to act on them.
        Leaving a secret field blank preserves any currently stored secret for that profile. Advanced endpoint overrides remain available as JSON fields for providers that support them.
      </div>
    `;
    panel.appendChild(info);

    for (const def of CLOUD_PROVIDER_DEFS) {
      panel.appendChild(createCloudConnectionSection(def, cloud));
    }

    applyInputTooltips(panel);
    enhanceSectionHelp(panel, CLOUD_HELP.connections, createGenericHelpFactory('Cloud Connections'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderActivityTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [auditEvents, toolsState] = await Promise.all([
      api.audit({ limit: 200 }).catch(() => []),
      api.toolsState(200).catch(() => ({ approvals: [], jobs: [] })),
    ]);
    const cloudEvents = (auditEvents || []).filter(isCloudAuditEvent).slice(0, 60);
    const cloudApprovals = (toolsState.approvals || []).filter((approval) => isCloudToolName(approval.toolName));
    const cloudJobs = (toolsState.jobs || []).filter((job) => isCloudToolName(job.toolName));

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Activity',
        compact: true,
        whatItIs: 'Activity is the operational review surface for recent cloud approvals, jobs, and audit events.',
        whatSeeing: 'You are seeing pending approvals, recent cloud tool jobs, and recent cloud audit activity.',
        whatCanDo: 'Use it to understand what cloud actions happened recently and whether they were approved, denied, or failed.',
        howLinks: 'It complements the shared audit system and points back to connection or automation context rather than replacing those workflows.',
      })}
      <div class="table-container">
        <div class="table-header"><h3>Cloud Approvals</h3></div>
        <table>
          <thead><tr><th>Approval</th><th>Tool</th><th>Risk</th><th>Origin</th><th>Status</th></tr></thead>
          <tbody>
            ${cloudApprovals.length === 0
              ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No cloud approvals in queue.</td></tr>'
              : cloudApprovals.map((approval) => `
                <tr>
                  <td title="${escAttr(approval.id)}">${esc(shortId(approval.id))}</td>
                  <td>${esc(approval.toolName)}</td>
                  <td>${esc(approval.risk)}</td>
                  <td>${esc(approval.origin)}</td>
                  <td>${esc(approval.status)}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Cloud Tool Jobs</h3></div>
        <table>
          <thead><tr><th>Job</th><th>Tool</th><th>Status</th><th>Origin</th><th>Created</th><th>Detail</th></tr></thead>
          <tbody>
            ${cloudJobs.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No cloud jobs recorded yet.</td></tr>'
              : cloudJobs.map((job) => `
                <tr>
                  <td title="${escAttr(job.id)}">${esc(shortId(job.id))}</td>
                  <td>${esc(job.toolName)}</td>
                  <td><span class="badge ${statusClass(job.status)}">${esc(job.status)}</span></td>
                  <td>${esc(job.origin)}</td>
                  <td>${esc(formatDate(job.createdAt))}</td>
                  <td>${esc(job.error || job.resultPreview || job.argsPreview || '-')}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Recent Cloud Audit Activity</h3></div>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Severity</th><th>Tool</th><th>Controller</th><th>Reason</th></tr></thead>
          <tbody>
            ${cloudEvents.length === 0
              ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recent cloud audit activity.</td></tr>'
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
    enhanceSectionHelp(panel, CLOUD_HELP.activity, createGenericHelpFactory('Cloud Activity'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function renderAutomationsTab(panel) {
  panel.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [connState, tasks] = await Promise.all([
      api.connectorsState(40).catch(() => ({ playbooks: [], runs: [] })),
      api.scheduledTasks().catch(() => []),
    ]);
    const playbooks = (connState.playbooks || []).filter((playbook) => (playbook.steps || []).some((step) => isCloudToolName(step.toolName)));
    const taskRows = (tasks || []).filter((task) => isCloudToolName(task.target));

    panel.innerHTML = `
      ${renderGuidancePanel({
        kicker: 'Automations',
        compact: true,
        whatItIs: 'This tab is the cloud-side entry point into repeatable workflows.',
        whatSeeing: 'You are seeing a cloud-filtered view of workflows and scheduled tasks, plus a link into Automations.',
        whatCanDo: 'Use it to understand existing cloud automations and then move into Automations to edit or create them.',
        howLinks: 'Cloud starts the workflow journey, but Automations remains the owner of workflow definitions, schedules, and run history.',
      })}
      <div class="intel-summary-grid">
        <div class="status-card info">
          <div class="card-title">Cloud Automations</div>
          <div class="card-value">${playbooks.length}</div>
          <div class="card-subtitle">Workflow definitions with cloud steps</div>
        </div>
        <div class="status-card accent">
          <div class="card-title">Scheduled Cloud Tasks</div>
          <div class="card-value">${taskRows.length}</div>
          <div class="card-subtitle">Cloud-targeted scheduled runs</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header">
          <h3>Cloud Automation Entry Points</h3>
          <a class="btn btn-primary" href="#/automations">Open Automations</a>
        </div>
        <div class="cfg-center-body">
          <div class="ops-inline-help">
            Cloud automations are still owned by the main Automations page. This tab surfaces cloud-focused entries so operators can move from connection setup to repeatable monitoring quickly.
          </div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Cloud Workflows</h3></div>
        <table>
          <thead><tr><th>Name</th><th>Mode</th><th>Steps</th><th>Status</th></tr></thead>
          <tbody>
            ${playbooks.length === 0
              ? '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No cloud workflows yet.</td></tr>'
              : playbooks.map((playbook) => `
                <tr>
                  <td>${esc(playbook.name)}</td>
                  <td>${esc(playbook.mode)}</td>
                  <td>${(playbook.steps || []).map((step) => esc(step.toolName)).join(', ')}</td>
                  <td>${playbook.enabled ? 'Enabled' : 'Disabled'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-container">
        <div class="table-header"><h3>Cloud Scheduled Tasks</h3></div>
        <table>
          <thead><tr><th>Name</th><th>Target</th><th>Cron</th><th>Status</th></tr></thead>
          <tbody>
            ${taskRows.length === 0
              ? '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No cloud-targeted scheduled tasks yet.</td></tr>'
              : taskRows.map((task) => `
                <tr>
                  <td>${esc(task.name || task.target)}</td>
                  <td>${esc(task.target)}</td>
                  <td>${esc(task.cron || '-')}</td>
                  <td>${task.enabled ? 'Enabled' : 'Disabled'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
    enhanceSectionHelp(panel, CLOUD_HELP.automations, createGenericHelpFactory('Cloud Automations'));
    activateContextHelp(panel);
  } catch (err) {
    panel.innerHTML = `<div class="loading">Error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function createCloudConnectionSection(def, cloud) {
  const section = document.createElement('div');
  section.className = 'table-container';
  const profiles = Array.isArray(cloud[def.key]) ? cloud[def.key] : [];

  section.innerHTML = `
    <div class="table-header">
      <h3>${esc(def.label)}</h3>
      <span class="cfg-header-note">${profiles.length} profile${profiles.length === 1 ? '' : 's'}</span>
    </div>
    <div class="cfg-center-body">
      <div class="cfg-form-grid">
        <div class="cfg-field">
          <label>Profile</label>
          <select data-profile-select>
            <option value="__new__">Create new profile...</option>
            ${profiles.map((profile) => `<option value="${escAttr(profile.id)}">${esc(profile.name || profile.id)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="cfg-form-grid" data-fields-grid></div>
      <div class="cfg-actions">
        <button class="btn btn-primary" type="button" data-save-profile>Save Profile</button>
        <button class="btn btn-secondary" type="button" data-delete-profile>Delete Profile</button>
        <span class="cfg-save-status" data-profile-status></span>
      </div>
    </div>
  `;

  const selectEl = section.querySelector('[data-profile-select]');
  const gridEl = section.querySelector('[data-fields-grid]');
  const statusEl = section.querySelector('[data-profile-status]');
  const deleteBtn = section.querySelector('[data-delete-profile]');

  function renderFields(profileId) {
    const profile = profileId === '__new__'
      ? buildDefaultProfile(def)
      : profiles.find((entry) => entry.id === profileId) || buildDefaultProfile(def);
    gridEl.innerHTML = def.fields.map((field) => renderCloudField(def, field, profile)).join('');
    deleteBtn.disabled = profileId === '__new__';
    applyInputTooltips(section);
  }

  selectEl.addEventListener('change', () => renderFields(selectEl.value));
  renderFields(selectEl.value);

  section.querySelector('[data-save-profile]')?.addEventListener('click', async () => {
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const nextProfile = collectCloudProfile(section, def, profiles);
      const existingIndex = profiles.findIndex((profile) => profile.id === nextProfile.id);
      const nextProfiles = profiles.slice();
      if (existingIndex >= 0) nextProfiles[existingIndex] = nextProfile;
      else nextProfiles.push(nextProfile);

      const result = await api.updateConfig({
        assistant: {
          tools: {
            cloud: {
              [def.key]: nextProfiles,
            },
          },
        },
      });
      statusEl.textContent = result.message || 'Saved.';
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success) {
        setTimeout(() => updateCloud(), 250);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  deleteBtn?.addEventListener('click', async () => {
    const profileId = selectEl.value;
    if (!profileId || profileId === '__new__') return;
    if (!confirm(`Delete cloud profile '${profileId}'?`)) return;
    statusEl.textContent = 'Deleting...';
    statusEl.style.color = 'var(--text-muted)';
    try {
      const result = await api.updateConfig({
        assistant: {
          tools: {
            cloud: {
              [def.key]: profiles.filter((profile) => profile.id !== profileId),
            },
          },
        },
      });
      statusEl.textContent = result.message || 'Deleted.';
      statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
      if (result.success) {
        setTimeout(() => updateCloud(), 250);
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.style.color = 'var(--error)';
    }
  });

  return section;
}

function renderCloudField(def, field, profile) {
  const value = profile[field.key];
  const configured = field.configuredKey ? profile[field.configuredKey] : false;
  const configuredNote = configured ? 'Configured - leave blank to keep existing value' : '';
  const placeholder = configuredNote || field.placeholder || '';

  if (field.type === 'checkbox') {
    const checked = value === true || (value == null && field.key === 'ssl');
    return `
      <div class="cfg-field">
        <label>${esc(field.label)}</label>
        <label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.55rem;">
          <input data-cloud-field="${escAttr(field.key)}" type="checkbox" ${checked ? 'checked' : ''}>
          <span style="font-size:0.75rem;color:var(--text-secondary)">${checked ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>
    `;
  }

  if (field.type === 'select') {
    return `
      <div class="cfg-field">
        <label>${esc(field.label)}</label>
        <select data-cloud-field="${escAttr(field.key)}">
          ${(field.options || []).map((option) => `<option value="${escAttr(option)}"${option === value ? ' selected' : ''}>${esc(option)}</option>`).join('')}
        </select>
      </div>
    `;
  }

  if (field.type === 'textarea' || field.type === 'json') {
    return `
      <div class="cfg-field" style="grid-column: 1 / -1;">
        <label>${esc(field.label)}</label>
        <textarea
          data-cloud-field="${escAttr(field.key)}"
          data-cloud-field-type="${escAttr(field.type)}"
          rows="${field.type === 'json' ? 5 : 6}"
          placeholder="${escAttr(placeholder)}"
          spellcheck="false"
        >${field.type === 'json' ? esc(value ? JSON.stringify(value, null, 2) : '') : esc(value || '')}</textarea>
      </div>
    `;
  }

  return `
    <div class="cfg-field">
      <label>${esc(field.label)}</label>
      <input
        data-cloud-field="${escAttr(field.key)}"
        data-cloud-field-type="${escAttr(field.type || 'text')}"
        type="${field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}"
        value="${field.type === 'password' ? '' : escAttr(value ?? '')}"
        placeholder="${escAttr(placeholder)}"
      >
    </div>
  `;
}

function collectCloudProfile(section, def, profiles) {
  const selectedId = section.querySelector('[data-profile-select]')?.value;
  const existing = selectedId && selectedId !== '__new__'
    ? profiles.find((profile) => profile.id === selectedId)
    : {};
  const nextProfile = { ...(existing || {}) };

  for (const field of def.fields) {
    const input = section.querySelector(`[data-cloud-field="${cssEscape(field.key)}"]`);
    if (!input) continue;
    if (field.type === 'checkbox') {
      nextProfile[field.key] = !!input.checked;
      continue;
    }

    const raw = String(input.value || '');
    if (field.type === 'number') {
      nextProfile[field.key] = raw.trim() ? Number(raw) : undefined;
      continue;
    }
    if (field.type === 'json') {
      if (!raw.trim()) {
        nextProfile[field.key] = undefined;
        continue;
      }
      try {
        nextProfile[field.key] = JSON.parse(raw);
      } catch {
        throw new Error(`${field.label} must be valid JSON.`);
      }
      continue;
    }

    if (field.type === 'password') {
      if (raw.trim()) nextProfile[field.key] = raw.trim();
      continue;
    }

    nextProfile[field.key] = raw.trim() || undefined;
  }

  if (!nextProfile.id) {
    throw new Error(`${def.label}: Profile ID is required.`);
  }
  if (!nextProfile.name) {
    nextProfile.name = nextProfile.id;
  }

  return nextProfile;
}

function createGenericHelpFactory(area) {
  return (title) => ({
    whatItIs: `${title} is part of ${area}.`,
    whatSeeing: 'You are seeing the current cloud settings, posture, or activity for this section.',
    whatCanDo: 'Review the current state here and use the controls in the section when you need to act.',
    howLinks: `This section supports the broader ${area} workflow and links to related pages when deeper work is required.`,
  });
}

function buildDefaultProfile(def) {
  const base = { id: '', name: '' };
  if (def.key === 'cpanelProfiles') return { ...base, type: 'whm', port: 2087, ssl: true, allowSelfSigned: false };
  if (def.key === 'awsProfiles') return { ...base, region: 'us-east-1' };
  if (def.key === 'gcpProfiles') return { ...base, location: 'us-central1' };
  return base;
}

function getCloudConfig(config) {
  return config?.assistant?.tools?.cloud || {
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
}

function buildProviderRows(cloud) {
  return [
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
}

function shortId(id) {
  return id?.slice(0, 8) || '';
}

function statusClass(status) {
  if (status === 'succeeded' || status === 'approved') return 'badge-running';
  if (status === 'pending' || status === 'awaiting_approval') return 'badge-warn';
  if (status === 'failed' || status === 'denied') return 'badge-errored';
  return 'badge-idle';
}

function formatDate(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function auditSeverityClass(severity) {
  if (severity === 'critical') return 'badge-critical';
  if (severity === 'warn') return 'badge-warn';
  return 'badge-info';
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

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function escAttr(input) {
  return esc(input).replace(/"/g, '&quot;');
}
