/**
 * Shared reference guide content for CLI, Telegram, and Web UI.
 */

export interface ReferenceGuideSection {
  title: string;
  items: string[];
}

export interface ReferenceGuide {
  title: string;
  intro: string;
  sections: ReferenceGuideSection[];
}

export function getReferenceGuide(): ReferenceGuide {
  return {
    title: 'Guardian Agent Reference Guide',
    intro: 'How to use your assistant, configure LLMs, and connect channels.',
    sections: [
      {
        title: 'Quick Start',
        items: [
          'Run: npx guardianagent',
          'Open web dashboard at http://localhost:3000 (if web channel enabled)',
          'Open Config Center in web or use CLI /config to set provider details (config is created/updated automatically)',
          'Use Config Center Web Authentication panel or CLI /auth status to manage bearer token mode',
          'Set default provider with web Config Center or CLI /config set default <provider>',
          'Check assistant runtime state with web Assistant State tab or CLI /assistant',
          'Web auth token: if not configured, Guardian Agent generates an ephemeral token at startup (shown in console)',
          'Verify provider connectivity: web Config page or CLI /providers',
          'In CLI, type /help for commands and /guide for this reference',
        ],
      },
      {
        title: 'Use The Assistant',
        items: [
          'Choose an agent in web Chat or with CLI /chat <agentId>',
          'Send normal messages; conversation memory is kept per user+channel+agent',
          'Reset context: CLI /reset [agentId], Telegram /reset [agentId], or web New Conversation button',
          'Quick actions: CLI /quick <email|task|calendar> <details>, Telegram /quick ..., or web Quick Actions bar',
          'Session controls: CLI /session list|use|new to revisit or branch conversations',
        ],
      },
      {
        title: 'Assistant Control Plane',
        items: [
          'Use web Assistant State to inspect session queues, priority scheduling, latency, traces, background jobs, and policy decisions',
          'CLI: /assistant summary for top-level state, /assistant sessions for queue detail',
          'CLI: /assistant jobs to inspect scan/config jobs and failures',
          'CLI: /assistant policy to review recent allow/deny/rate-limit decisions',
          'CLI: /assistant traces to inspect per-request step traces and timing',
          'Use web Tools tab or CLI /tools to run approved workstation tools and review approvals/jobs',
          'For chat-driven tool approvals, use the native prompt or buttons first (CLI: Approve (y) / Deny (n), Telegram: inline buttons); /approve [approvalId] and /deny [approvalId] remain available as fallback commands',
          'For local file discovery, use tool fs_search (chat can call it) and include your folder in Tools -> Allowed Paths',
          'CLI policy shortcut: /tools policy paths <comma,separated,paths> (supports C:\\... and /mnt/c/... formats)',
          'Campaign automation commands: CLI /campaign help (discover contacts, create campaigns, preview, run with approvals)',
        ],
      },
      {
        title: 'Connect Ollama (Local)',
        items: [
          'Install and run Ollama locally',
          'Pull a model first, for example: ollama pull llama3.2',
          'In Config Center choose Local (Ollama), then set profile name and model',
          'CLI equivalent: /config add ollama ollama llama3.2 and /config set default ollama',
          'Use CLI /providers or web Config to verify connectivity',
        ],
      },
      {
        title: 'Connect OpenAI or Anthropic',
        items: [
          'In Config Center choose External API, then set provider type, API key, and model',
          'CLI equivalent: /config add <name> openai|anthropic <model> <apiKey>',
          'Switch default provider via CLI /config set default <name> or web Config page',
          'Optional advanced path: use CLI /config add and /config set for provider fine-tuning',
        ],
      },
      {
        title: 'Connect Google Workspace (Gmail, Calendar, Drive)',
        items: [
          'Google Workspace tools use the gws CLI (https://github.com/googleworkspace/cli) — install it globally or from the GitHub releases page',
          'You need a Google Cloud project with OAuth 2.0 credentials before you can sign in',
          'Quick path (requires gcloud CLI): install the Google Cloud CLI from https://docs.cloud.google.com/sdk/docs/install-sdk, run "gcloud auth login", then "gws auth setup"',
          'Manual path (no gcloud needed): go to Google Cloud Console > APIs & Services > Credentials (https://console.cloud.google.com/apis/credentials)',
          'Manual step 1: Create a project if you don\'t have one (top-left project selector > New Project)',
          'Manual step 2: Go to Google Auth Platform > Audience (left sidebar). Set user type to External, fill in app name and your email, save',
          'Manual step 3: On the Audience page, under "Publishing status", click Publish App to move out of Testing mode — otherwise only manually-added test users can authenticate',
          'Manual step 4: Go to Credentials (left sidebar) > + Create Credentials > OAuth client ID. Set Application type to "Desktop app" (NOT Web application). Name it anything. Click Create',
          'Manual step 5: Download the client secret JSON from the confirmation dialog. Save it as ~/.config/gws/client_secret.json (Windows: %USERPROFILE%\\.config\\gws\\client_secret.json). Create the folder if needed',
          'After setting up credentials (either path), run "gws auth login" in your terminal — a browser window opens for Google consent',
          'If you see "access_denied" or "app not verified": go back to Google Auth Platform > Audience and either Publish the app or add your email under Test Users',
          'Enable the APIs you need: go to APIs & Services > Library in Cloud Console and enable Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API (only enable what you need)',
          'Enable in Guardian Agent: open Settings > Google Workspace, select services, and click Enable. Restart Guardian Agent for the tools to become available',
          'Verify setup: Settings > Google Workspace should show CLI Installed, Auth Connected, Integration Enabled',
          'CLI check: /google status shows connection state from the command line',
        ],
      },
      {
        title: 'Gmail Campaign Automation',
        items: [
          'Set Google OAuth access token in env var GOOGLE_OAUTH_ACCESS_TOKEN (gmail.send scope)',
          'Discover contacts from sites: /campaign discover <url> [tagsCsv]',
          'Import contacts from CSV: /campaign import <csvPath> [source]',
          'Create campaign: /campaign create <name> | <subjectTemplate> | <bodyTemplate>',
          'Preview content before sending: /campaign preview <campaignId> [limit]',
          'Run campaign send: /campaign run <campaignId> [maxRecipients] (approval required before send)',
          'Use placeholders in templates: {name}, {company}, {email}',
        ],
      },
      {
        title: 'Connect Telegram',
        items: [
          'Step 1: Open Telegram, search for @BotFather, open it, and press Start',
          'Step 2: Send /newbot and follow prompts for bot name + username (username must end with "bot")',
          'Step 3: Copy the bot token returned by BotFather (format: 123456789:AA...) and keep it secret',
          'Step 4: In Guardian Agent, open Config Center -> Settings -> Telegram Channel, set Enable Telegram = Yes, paste token, and save',
          'Step 5: In Telegram, open your new bot and send one message (for example: /start)',
          'Step 6: Get your chat ID by opening https://api.telegram.org/bot<token>/getUpdates and copying message.chat.id',
          'Step 7: Paste chat ID(s) into Allowed Chat IDs and save (group IDs are usually negative, often -100...)',
          'CLI equivalent: /config telegram on, /config telegram token <token>, /config telegram chatids <id1,id2,...>, /config telegram status',
          'Telegram channel changes (enable/disable/token/chat IDs) are applied immediately without restart',
          'Useful commands in Telegram: /help, /guide, /reset [agentId], /quick <action> <details>, /approve [approvalId], /deny [approvalId]',
        ],
      },
      {
        title: 'Identity & Memory',
        items: [
          "Identity mode 'single_user' shares one assistant identity across web/CLI/Telegram",
          "Identity mode 'channel_user' keeps identities separate unless alias-mapped",
          'Conversation memory is persisted in SQLite with retention policy controls',
          'Use Config Center to adjust retention and default identity',
        ],
      },
      {
        title: 'Analytics',
        items: [
          'Assistant interactions are logged to SQLite analytics storage',
          'View analytics in web Monitoring or CLI /analytics [minutes]',
          'Track command usage, message errors, quick actions, and config outcomes',
        ],
      },
      {
        title: 'Threat Intel & Deepfake Defense',
        items: [
          'Open web Threat Intel tab for watchlist, scans, findings triage, and action drafts',
          'CLI commands: /intel status, /intel watch add <target>, /intel scan [query], /intel findings',
          'Telegram quick intel: /intel status, /intel scan <query>, /intel findings',
          'Moltbook connector can run in mock or API mode under assistant.threatIntel.moltbook settings',
          'Moltbook is treated as hostile: strict allowedHosts + timeout/size guards + manual publishing by default',
          'Darkweb scanning is configurable and disabled by default unless explicitly enabled',
          'Use assisted/manual response mode for human approval before external publishing actions',
        ],
      },
      {
        title: 'Automations',
        items: [
          'Automations page manages all automated tasks — from single-tool runs to multi-step pipelines',
          'Each automation can run one tool or chain multiple tools in sequence or parallel',
          'Optional cron schedule turns any automation into a recurring task',
          '18+ built-in examples available via the Examples button (network, system, security categories)',
          'Permission policies restrict what hosts, paths, and commands an automation can access',
          'Run or Dry Run any automation on demand; scheduled automations also run on their cron',
          'Clone any automation to create a copy for modification',
          'Engine Settings panel configures global limits (max steps, timeouts, execution mode)',
          'Run history shows all recent executions with status, duration, and step details',
          'Cron format: minute hour day month weekday. Examples: */15 * * * * (every 15 min), 0 * * * * (every hour), 0 0 * * * (daily midnight)',
          'Devices tab on Network page shows discovered network devices; Threats tab shows alerts',
        ],
      },
      {
        title: 'Security And Troubleshooting',
        items: [
          'Guardian blocks prompt-injection and secret leaks by default',
          'Web dashboard requires bearer token authentication (no unauthenticated mode)',
          'Manage/rotate token via Config Center Web Authentication panel or CLI /auth rotate',
          'Review events in web Security tab or CLI /audit /security',
          'If file access is denied, add the target root folder in Tools policy Allowed Paths, then retry',
          'Check model connectivity with CLI /providers or web LLM status',
          'If config changes are not reflected, use /config test and confirm provider status',
        ],
      },
    ],
  };
}

export function formatGuideForCLI(guide: ReferenceGuide = getReferenceGuide()): string[] {
  const lines: string[] = [];
  lines.push(guide.title);
  lines.push(guide.intro);
  lines.push('');

  for (const section of guide.sections) {
    lines.push(section.title);
    for (const item of section.items) {
      lines.push(`  - ${item}`);
    }
    lines.push('');
  }

  return lines;
}

export function formatGuideForTelegram(guide: ReferenceGuide = getReferenceGuide()): string {
  const lines: string[] = [];
  lines.push(guide.title);
  lines.push(guide.intro);
  lines.push('');

  for (const section of guide.sections) {
    lines.push(`${section.title}:`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
