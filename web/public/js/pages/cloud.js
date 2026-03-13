/**
 * Cloud page - cloud monitoring and configuration hub.
 */

import { api } from '../api.js';
import { activateContextHelp, enhanceSectionHelp, renderGuidancePanel } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';
import { applyInputTooltips } from '../tooltip.js';

let currentContainer = null;
const cloudUiState = {
  selectedProfiles: {},
};

const CLOUD_HELP = {
  overview: {
    'Provider Posture': {
      whatItIs: 'This section summarizes the current cloud-connection posture across every supported provider family configured in Guardian.',
      whatSeeing: 'You are seeing profile counts, secret-storage posture, endpoint-override usage, TLS exceptions, and other signals that tell you whether cloud setup is clean or risky.',
      whatCanDo: 'Use it to spot insecure auth patterns, odd endpoint overrides, or connection sprawl before you drill into the provider forms in Connections.',
      howLinks: 'It is a posture summary only. The actual editing of provider profiles happens in Connections.',
    },
    'How This Area Works': {
      whatItIs: 'This section explains how the Cloud hub is divided between setup, operational review, and workflow handoff.',
      whatSeeing: 'You are seeing guidance on which tab owns connection editing, which tab shows recent cloud actions, and where repeatable workflows are managed.',
      whatCanDo: 'Use it when you are deciding whether the next step is connection setup, activity review, or moving into Automations.',
      howLinks: 'It clarifies the handoff between Connections, Activity, and Automations so you do not edit the wrong place.',
    },
  },
  connections: {
    'Cloud Controls': {
      whatItIs: 'This section controls whether the cloud tooling runtime is enabled globally for the installation.',
      whatSeeing: 'You are seeing the top-level switch that determines whether saved cloud profiles can actually be used by tools and automations.',
      whatCanDo: 'Turn cloud tooling on before operators or workflows try to use saved credentials, or disable it entirely when cloud actions should be blocked.',
      howLinks: 'The provider-specific connection forms below only matter when this overall cloud runtime is enabled.',
    },
    'Connection Model': {
      whatItIs: 'This section explains the data model for saved cloud profiles, including how credentials and advanced endpoint settings are treated.',
      whatSeeing: 'You are seeing guidance on stored credentials, preserved secrets, profile reuse, and when advanced endpoint overrides are appropriate.',
      whatCanDo: 'Use it to understand what this page stores, what it does not store, and how those saved profiles are consumed later by tools and automations.',
      howLinks: 'Saved connections feed Cloud Activity and cloud-focused automations, while raw config editing remains the advanced path only.',
    },
  },
  activity: {
    'Cloud Approvals': {
      whatItIs: 'This section is the queue of cloud-tool actions that have reached an approval checkpoint.',
      whatSeeing: 'You are seeing pending cloud requests together with their origin, risk context, and the action that is waiting for operator confirmation.',
      whatCanDo: 'Review whether a cloud action should proceed and understand why the runtime escalated it for human review.',
      howLinks: 'This sits alongside policy and audit visibility, while connection editing itself still happens in Connections.',
    },
    'Recent Cloud Tool Jobs': {
      whatItIs: 'This section is the recent execution history for cloud-specific tool jobs and workflow steps.',
      whatSeeing: 'You are seeing recent cloud job records with status, origin, creation time, and a short preview of what the job attempted or returned.',
      whatCanDo: 'Check what just ran, confirm whether it succeeded, and spot failing or noisy cloud actions quickly.',
      howLinks: 'It pairs with the cloud audit events below and with the deeper workflow ownership that remains in Automations.',
    },
    'Recent Cloud Audit Activity': {
      whatItIs: 'This section shows the recent audit trail for cloud-related activity across approvals, denials, and executed actions.',
      whatSeeing: 'You are seeing cloud audit events with time, severity, reason, and other context needed to understand what happened recently.',
      whatCanDo: 'Investigate recent cloud behavior without immediately jumping into the full shared audit page.',
      howLinks: 'It ties cloud operations back to the shared audit and policy system used across the rest of Guardian.',
    },
  },
  automations: {
    'Cloud Automation Entry Points': {
      whatItIs: 'This section explains when a cloud task should stop being an ad hoc action and become an automation.',
      whatSeeing: 'You are seeing the ownership boundary between cloud connection setup here and repeatable workflow management in Automations.',
      whatCanDo: 'Use it as the handoff point when a cloud operation should become repeatable, scheduled, or part of a larger workflow.',
      howLinks: 'Cloud can launch you into automation work, but Automations remains the system of record for editing, scheduling, and run history.',
    },
    'Cloud Workflows': {
      whatItIs: 'This section lists existing workflow definitions that already contain cloud-related steps.',
      whatSeeing: 'You are seeing cloud-focused playbooks, whether they are enabled, and the kinds of steps they contain.',
      whatCanDo: 'Check what cloud workflows already exist before creating a duplicate or deciding to edit one in Automations.',
      howLinks: 'These workflows are shown here for context, but their real editing surface is still the Automations page.',
    },
    'Cloud Scheduled Tasks': {
      whatItIs: 'This section lists the scheduled tasks that already target cloud tools or cloud-containing workflows.',
      whatSeeing: 'You are seeing cloud-focused schedules, their cron expressions or cadence, and whether they are currently enabled.',
      whatCanDo: 'Review what cloud work is already on a timer before creating new scheduled automations.',
      howLinks: 'Even when the task is cloud-focused, schedule ownership stays in Automations.',
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
      { key: 'host', label: 'Host', type: 'text', placeholder: 'server.example.com', help: 'Hostname, host:port, or a root http(s) URL. Do not include a path.' },
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
      { key: 'apiBaseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.vercel.com', help: 'Full root URL for the API. Trailing slash is fine; queries and fragments are not.' },
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
      { key: 'apiBaseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.cloudflare.com/client/v4', help: 'Full root URL for the API, including path segments like /client/v4 when needed.' },
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
      { key: 'endpoints', label: 'Endpoint Overrides (JSON)', type: 'json', placeholder: '{\n  "s3": "http://localhost:4566"\n}', help: 'JSON object mapping service names to full http(s) endpoint URLs.' },
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
      { key: 'endpoints', label: 'Endpoint Overrides (JSON)', type: 'json', placeholder: '{\n  "storage": "http://localhost:4443"\n}', help: 'JSON object mapping service names to full http(s) endpoint URLs.' },
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
      { key: 'blobBaseUrl', label: 'Blob Base URL', type: 'text', placeholder: 'https://account.blob.core.windows.net', help: 'Full root URL for blob storage. Do not add SAS query parameters here.' },
      { key: 'accessTokenCredentialRef', label: 'Access Token Ref', type: 'text', placeholder: 'cloud.azure.prod.token' },
      { key: 'clientIdCredentialRef', label: 'Client ID Ref', type: 'text', placeholder: 'cloud.azure.prod.client-id' },
      { key: 'clientSecretCredentialRef', label: 'Client Secret Ref', type: 'text', placeholder: 'cloud.azure.prod.client-secret' },
      { key: 'accessToken', label: 'Access Token', type: 'password', configuredKey: 'accessTokenConfigured', placeholder: 'Leave blank to keep existing token' },
      { key: 'clientId', label: 'Client ID', type: 'password', configuredKey: 'clientIdConfigured', placeholder: 'Leave blank to keep existing client ID' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', configuredKey: 'clientSecretConfigured', placeholder: 'Leave blank to keep existing secret' },
      { key: 'endpoints', label: 'Endpoint Overrides (JSON)', type: 'json', placeholder: '{\n  "management": "https://management.azure.com"\n}', help: 'JSON object mapping service names to full http(s) endpoint URLs.' },
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
      whatSeeing: 'You are seeing tabs for posture summary, guided connection forms, recent cloud approvals and jobs, and automation handoff for repeatable cloud work.',
      whatCanDo: 'Connect cloud providers, inspect recent cloud activity, and hand cloud tasks off into Automations when they should become repeatable.',
      howLinks: 'Connection setup lives here, Security receives normalized security findings, and Automations owns repeatable workflow configuration and run history.',
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
        Leaving a secret field blank preserves any currently stored secret for that profile. Host fields accept a hostname, host:port, or root URL; API base URL and endpoint override fields expect full http(s) URLs. Advanced endpoint overrides remain available as JSON fields for providers that support them.
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
  let selectedProfileId = profiles.some((profile) => profile.id === cloudUiState.selectedProfiles[def.key])
    ? cloudUiState.selectedProfiles[def.key]
    : (profiles[0]?.id || null);

  section.innerHTML = `
    <div class="table-header">
      <h3>${esc(def.label)}</h3>
      <span class="cfg-header-note">${profiles.length} profile${profiles.length === 1 ? '' : 's'}</span>
    </div>
    <div class="cfg-center-body">
      <div class="cloud-profile-browser">
        <div class="cloud-profile-sidebar">
          <div class="cloud-profile-sidebar-header">
            <div>
              <div class="cloud-profile-sidebar-title">Saved Profiles</div>
              <div class="cloud-profile-sidebar-note">Select one to edit or create a new ${esc(def.label)} profile.</div>
            </div>
            <button class="btn btn-secondary" type="button" data-cloud-add-profile>+ Add</button>
          </div>
          <div class="cloud-profile-list" data-cloud-profile-list></div>
        </div>
        <div class="cloud-profile-editor" data-cloud-profile-editor></div>
      </div>
    </div>
  `;

  const listEl = section.querySelector('[data-cloud-profile-list]');
  const editorEl = section.querySelector('[data-cloud-profile-editor]');
  const addBtn = section.querySelector('[data-cloud-add-profile]');

  function renderProfileList() {
    listEl.innerHTML = profiles.length === 0
      ? '<div class="cloud-profile-empty">No profiles saved yet. Use Add to create the first one.</div>'
      : profiles.map((profile) => {
        const isActive = profile.id === selectedProfileId;
        const badges = summarizeCloudProfileBadges(def, profile);
        return `
          <button
            class="cloud-profile-item${isActive ? ' active' : ''}"
            type="button"
            data-cloud-profile-id="${escAttr(profile.id)}"
            title="${escAttr(profile.name || profile.id)}"
          >
            <span class="cloud-profile-item-title">${esc(profile.name || profile.id)}</span>
            <span class="cloud-profile-item-meta">${esc(profile.id || 'Unsaved profile')}</span>
            ${badges.length
              ? `<span class="cloud-profile-item-badges">${badges.map((badge) => `<span class="cloud-profile-item-badge">${esc(badge)}</span>`).join('')}</span>`
              : ''}
          </button>
        `;
      }).join('');

    listEl.querySelectorAll('[data-cloud-profile-id]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedProfileId = button.getAttribute('data-cloud-profile-id');
        cloudUiState.selectedProfiles[def.key] = selectedProfileId;
        renderProfileList();
        renderEditor();
      });
    });
  }

  function renderEditor() {
    const isCreateMode = !selectedProfileId;
    const profile = isCreateMode
      ? buildDefaultProfile(def)
      : profiles.find((entry) => entry.id === selectedProfileId) || buildDefaultProfile(def);
    const profileLabel = profile.name || profile.id || def.label;
    const introText = isCreateMode
      ? `Create a new ${def.label} profile here. Stored secret fields are optional on first pass and can be rotated later.`
      : `Editing ${profileLabel}. Leaving secret fields blank preserves any stored values already attached to this profile.`;

    editorEl.innerHTML = `
      <div class="table-header" style="padding-left:0;padding-right:0;">
        <h3>${esc(isCreateMode ? `Create New ${def.label} Profile` : `Edit ${profileLabel}`)}</h3>
        <span class="cfg-header-note">${esc(isCreateMode ? 'Create mode' : 'Edit mode')}</span>
      </div>
      <div class="ops-inline-help cloud-profile-editor-copy">${esc(introText)}</div>
      <div class="cfg-form-grid" data-fields-grid>
        ${def.fields.map((field) => renderCloudField(def, field, profile)).join('')}
      </div>
      <div class="cfg-actions">
        <button class="btn btn-primary" type="button" data-save-profile>${isCreateMode ? 'Create Profile' : 'Save Profile'}</button>
        <button class="btn btn-secondary" type="button" data-delete-profile ${isCreateMode ? 'style="display:none;"' : ''}>Delete Profile</button>
        <span class="cfg-save-status" data-profile-status></span>
      </div>
    `;

    const statusEl = editorEl.querySelector('[data-profile-status]');

    editorEl.querySelector('[data-save-profile]')?.addEventListener('click', async () => {
      statusEl.textContent = 'Saving...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const nextProfile = collectCloudProfile(
          editorEl,
          def,
          profiles.find((entry) => entry.id === selectedProfileId),
        );
        const hasConflictingId = profiles.some((entry) => entry.id === nextProfile.id && entry.id !== selectedProfileId);
        if (hasConflictingId) {
          throw new Error(`${def.label}: Profile ID '${nextProfile.id}' already exists.`);
        }
        const existingIndex = selectedProfileId
          ? profiles.findIndex((entry) => entry.id === selectedProfileId)
          : -1;
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
          cloudUiState.selectedProfiles[def.key] = nextProfile.id;
          setTimeout(() => updateCloud(), 250);
        }
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });

    editorEl.querySelector('[data-delete-profile]')?.addEventListener('click', async () => {
      if (!selectedProfileId) return;
      if (!confirm(`Delete cloud profile '${selectedProfileId}'?`)) return;
      statusEl.textContent = 'Deleting...';
      statusEl.style.color = 'var(--text-muted)';
      try {
        const result = await api.updateConfig({
          assistant: {
            tools: {
              cloud: {
                [def.key]: profiles.filter((profile) => profile.id !== selectedProfileId),
              },
            },
          },
        });
        statusEl.textContent = result.message || 'Deleted.';
        statusEl.style.color = result.success ? 'var(--success)' : 'var(--warning)';
        if (result.success) {
          const remaining = profiles.filter((profile) => profile.id !== selectedProfileId);
          cloudUiState.selectedProfiles[def.key] = remaining[0]?.id || null;
          setTimeout(() => updateCloud(), 250);
        }
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.style.color = 'var(--error)';
      }
    });

    applyInputTooltips(section);
  }

  addBtn?.addEventListener('click', () => {
    selectedProfileId = null;
    cloudUiState.selectedProfiles[def.key] = null;
    renderProfileList();
    renderEditor();
  });

  renderProfileList();
  renderEditor();

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
        ${field.help ? `<div class="cfg-help-text" style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem;">${esc(field.help)}</div>` : ''}
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
        ${field.help ? `<div class="cfg-help-text" style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem;">${esc(field.help)}</div>` : ''}
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
        ${field.help ? `<div class="cfg-help-text" style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem;margin-bottom:0.35rem;">${esc(field.help)}</div>` : ''}
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
      ${field.help ? `<div class="cfg-help-text" style="font-size:0.72rem;color:var(--text-muted);margin-top:0.2rem;">${esc(field.help)}</div>` : ''}
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

function collectCloudProfile(section, def, existingProfile) {
  const existing = existingProfile || {};
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
  const providerTitles = new Set(['cPanel / WHM', 'Vercel', 'Cloudflare', 'AWS', 'GCP', 'Azure']);

  return (title) => {
    if (providerTitles.has(title)) {
      return {
        whatItIs: `This section is the saved-profile browser and editor for the ${title} provider family.`,
        whatSeeing: `You are seeing the saved ${title} profiles on the left and the create or edit form for the currently active ${title} profile on the right.`,
        whatCanDo: `Select an existing ${title} profile to edit it, start a new one, rotate credentials, and save or delete ${title} profiles.`,
        howLinks: `The ${title} profiles managed here are later used by cloud tools, approvals, activity review, and cloud-focused automations.`,
      };
    }
    if (/^Create New .+ Profile$/.test(title)) {
      return {
        whatItIs: 'This section is the create flow for a new cloud provider profile.',
        whatSeeing: 'You are seeing the required identifiers, credential fields, and any advanced JSON or endpoint fields needed for that provider family.',
        whatCanDo: 'Enter the provider details, leave secret fields blank until you are ready to store them, and create a new reusable cloud profile.',
        howLinks: 'A profile created here becomes selectable for later cloud-tool runs, approvals, and automations.',
      };
    }
    if (/^Edit\s+/.test(title)) {
      return {
        whatItIs: 'This section is the editor for the currently selected cloud provider profile.',
        whatSeeing: 'You are seeing the saved profile values together with the fields that can be updated, including secret rotation fields when applicable.',
        whatCanDo: 'Review the selected profile, update identifiers or endpoints, rotate credentials, and save or delete the profile.',
        howLinks: 'Changes made here affect the profile used by later cloud actions, approvals, and automation runs.',
      };
    }
    return null;
  };
}

function buildDefaultProfile(def) {
  const base = { id: '', name: '' };
  if (def.key === 'cpanelProfiles') return { ...base, type: 'whm', port: 2087, ssl: true, allowSelfSigned: false };
  if (def.key === 'awsProfiles') return { ...base, region: 'us-east-1' };
  if (def.key === 'gcpProfiles') return { ...base, location: 'us-central1' };
  return base;
}

function summarizeCloudProfileBadges(def, profile) {
  const badges = [];
  const configuredSecretCount = def.fields.filter((field) => field.configuredKey && profile[field.configuredKey]).length;
  const credentialRefCount = def.fields.filter((field) => /credentialRef$/i.test(field.key) && profile[field.key]).length;

  if (def.key === 'cpanelProfiles' && profile.type) badges.push(profile.type.toUpperCase());
  if (profile.region) badges.push(profile.region);
  if (profile.location) badges.push(profile.location);
  if (configuredSecretCount > 0) badges.push(configuredSecretCount === 1 ? 'secret stored' : `${configuredSecretCount} secrets stored`);
  if (credentialRefCount > 0) badges.push(credentialRefCount === 1 ? '1 credential ref' : `${credentialRefCount} credential refs`);
  if (profile.allowSelfSigned) badges.push('self-signed TLS');
  if (profile.apiBaseUrl || (profile.endpoints && Object.keys(profile.endpoints).length > 0) || profile.blobBaseUrl) badges.push('custom endpoint');

  return badges;
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
