/**
 * Shared reference guide content for CLI, Telegram, and Web UI.
 */

export interface ReferenceGuidePageSection {
  title: string;
  items: string[];
  note?: string;
}

export interface ReferenceGuidePage {
  id: string;
  title: string;
  summary: string;
  sections: ReferenceGuidePageSection[];
}

export interface ReferenceGuideCategory {
  id: string;
  title: string;
  description: string;
  pages: ReferenceGuidePage[];
}

export interface ReferenceGuide {
  title: string;
  intro: string;
  categories: ReferenceGuideCategory[];
}

export function getReferenceGuide(): ReferenceGuide {
  return {
    title: 'Guardian Agent Reference Guide',
    intro: 'Operator wiki for setup, day-to-day use, automations, and security controls across web, CLI, and Telegram.',
    categories: [
      {
        id: 'getting-started',
        title: 'Getting Started',
        description: 'Bootstrap the assistant, learn the control surfaces, and manage conversations.',
        pages: [
          {
            id: 'quick-start',
            title: 'Quick Start',
            summary: 'Bring the assistant online, open the dashboard, and confirm your provider and auth configuration.',
            sections: [
              {
                title: 'Start The System',
                items: [
                  'Run Guardian Agent from the repo root with the platform startup script or `npx guardianagent`.',
                  'Open the web dashboard at `http://localhost:3000` when the web channel is enabled.',
                  'If no web auth token is configured, Guardian Agent generates an ephemeral token at startup and prints it to the console.',
                  'Use the Configuration Center in the web UI or CLI `/config` to create or update provider settings instead of editing YAML by hand.',
                ],
              },
              {
                title: 'Verify Readiness',
                items: [
                  'Use the Dashboard page to confirm runtime status, agent health, provider connectivity, and assistant state.',
                  'Open `#/config` to verify the default provider, web auth settings, and channel configuration.',
                  'Use CLI `/providers` or the Providers tab to confirm the selected provider is reachable.',
                  'Use CLI `/guide` or Telegram `/guide` to pull the same reference content outside the web UI.',
                ],
                note: 'Most configuration changes now appear in the web UI without a manual browser refresh because the dashboard listens for server-sent invalidation events.',
              },
            ],
          },
          {
            id: 'chat-sessions',
            title: 'Chat, Sessions, And Quick Actions',
            summary: 'Use the assistant conversationally while keeping context, approvals, and fast actions under control.',
            sections: [
              {
                title: 'Normal Chat Flow',
                items: [
                  'Choose an agent in the web chat panel or with CLI `/chat <agentId>` when you want to pin work to one agent.',
                  'Conversation memory is scoped per user, channel, and logical assistant. The built-in tier-routed local/external assistant shares one memory and session history across mode switches.',
                  'Use the web New Conversation control, CLI `/reset [agentId]`, or Telegram `/reset [agentId]` to clear context.',
                ],
              },
              {
                title: 'Session Management',
                items: [
                  'Use CLI `/session list`, `/session use <sessionId>`, and `/session new` to revisit or branch prior work.',
                  'Assistant state in the dashboard shows queued and running sessions, wait times, execution times, and recent traces.',
                  'Quick actions are available through the web quick-action bar, CLI `/quick <email|task|calendar> <details>`, and Telegram `/quick ...`.',
                ],
                note: 'Chat streaming uses SSE. Tool calls, token streaming, and completion events show up live in the web chat panel.',
              },
            ],
          },
          {
            id: 'assistant-control-plane',
            title: 'Assistant Control Plane',
            summary: 'Inspect runtime state, approvals, jobs, traces, and policy decisions from the operator surfaces.',
            sections: [
              {
                title: 'Web Control Surfaces',
                items: [
                  'Dashboard shows session queue depth, assistant throughput, latency, background jobs, and scheduled cron jobs.',
                  'Configuration > Tools exposes tool policy mode, sandbox boundaries, provider routing, categories, approvals, and recent jobs.',
                  'Security shows audit history, network posture, and threat-intel workflows.',
                ],
              },
              {
                title: 'CLI Control Surfaces',
                items: [
                  'Use `/assistant summary`, `/assistant sessions`, `/assistant jobs`, `/assistant traces`, and `/assistant policy` for the same orchestration state in the terminal.',
                  'Use `/tools` to inspect tool policy and pending approvals, and `/approve` or `/deny` as fallback commands if native prompts are not suitable.',
                  'Use `/mode` to switch between auto, local-only, and external-only routing without changing agent definitions.',
                ],
                note: 'Approval prompts should normally be handled through the native buttons or inline prompt flow first. Fallback commands remain useful for remote or scripted sessions.',
              },
            ],
          },
          {
            id: 'tools-and-approvals',
            title: 'Tools, Approvals, And Browser Automation',
            summary: 'Run workstation tools safely, tune policy boundaries, and understand how browser sessions behave.',
            sections: [
              {
                title: 'Tool Governance',
                items: [
                  'Configuration > Tools is the main operator surface for policy mode, category enablement, provider routing, approvals, and recent jobs.',
                  'Use CLI `/tools` for the same operational visibility when you are working outside the web UI.',
                  'Allowed paths, commands, and domains should be adjusted deliberately; treat them as policy boundaries, not convenience toggles.',
                ],
              },
              {
                title: 'Approvals',
                items: [
                  'Pending tool actions are surfaced in web approvals, CLI native prompts, and Telegram approval flows.',
                  'Use `/approve [approvalId]` and `/deny [approvalId]` as fallback commands when native approval controls are unavailable.',
                  'Recent approval outcomes show up in audit history and assistant policy views, so you can verify what was allowed and why.',
                ],
              },
              {
                title: 'Browser Automation',
                items: [
                  'Browser automation is provided through managed MCP servers: Playwright for full interaction and Lightpanda for fast read-only page analysis.',
                  'Browser navigation only supports HTTP and HTTPS targets, and private hosts are blocked for SSRF protection.',
                  'Browser MCP startup does not require the general MCP toggle to be enabled; if browser tooling is on and the binaries are available, GuardianAgent registers the browser servers automatically.',
                  'Use Lightpanda first for page reading and structure extraction; use Playwright when you need clicks, typing, screenshots, uploads, or richer interaction.',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'providers-and-channels',
        title: 'Providers And Channels',
        description: 'Connect LLMs and external channels, then validate each path end to end.',
        pages: [
          {
            id: 'ollama-local',
            title: 'Connect Ollama (Local)',
            summary: 'Configure a local model for private, low-latency operation.',
            sections: [
              {
                title: 'Local Provider Setup',
                items: [
                  'Install and run Ollama locally before configuring Guardian Agent.',
                  'Pull at least one model first, for example `ollama pull llama3.2`.',
                  'In the Providers tab choose the local provider path, then set a profile name, model, and base URL if needed.',
                  'CLI equivalent: `/config add ollama ollama llama3.2` followed by `/config set default ollama`.',
                ],
              },
              {
                title: 'Validation',
                items: [
                  'Use the Providers tab test button or CLI `/providers` to verify connectivity and model discovery.',
                  'If the provider is unavailable, check the Ollama process and base URL before changing Guardian configuration.',
                ],
              },
            ],
          },
          {
            id: 'cloud-providers',
            title: 'Connect Cloud Providers',
            summary: 'Add external models from OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI, or Google Gemini for quality fallback, smart routing, or explicit cloud use.',
            sections: [
              {
                title: 'External Provider Setup',
                items: [
                  'In Configuration > AI & Search choose External Providers, then select the provider family (OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI, or Google Gemini), model, and either paste the API key once or point the profile at a credential ref.',
                  'CLI equivalent: `/config add <name> <provider> <model> <apiKey>` where provider is openai, anthropic, groq, mistral, deepseek, together, xai, or google.',
                  'Set the default provider from the Providers tab or with `/config set default <name>`.',
                ],
              },
              {
                title: 'Built-In Provider Families',
                items: [
                  'Local provider family: Ollama.',
                  'External native provider families: OpenAI and Anthropic.',
                  'External OpenAI-compatible provider families: Groq, Mistral, DeepSeek, Together, xAI, and Google Gemini.',
                  'The web provider picker is driven from the runtime registry, so new built-in families appear there without a separate static UI list.',
                ],
              },
              {
                title: 'Routing Notes',
                items: [
                  'Tools can route to local or external providers by category when smart provider routing is enabled.',
                  'You can disable smart routing or override specific tool or category behavior in Configuration > Tools.',
                  'Provider changes propagate to the running web UI immediately.',
                ],
              },
            ],
          },
          {
            id: 'credential-storage',
            title: 'Credential Storage Options',
            summary: 'Guardian supports a simple paste-once path for most users and an environment-backed ref path for advanced operators.',
            sections: [
              {
                title: 'Simple Paste-Once Mode',
                items: [
                  'Paste provider, search, or Telegram secrets directly into the web configuration forms when you want the easiest setup path.',
                  'Guardian stores those secrets in the encrypted local secret store and keeps them out of the main `config.yaml` file.',
                  'When a secret is already configured, the UI shows it as configured and lets you paste a replacement without revealing the current value.',
                ],
                note: 'The local secret store is primarily meant to keep secrets out of plain-text config. On shared servers or managed environments, prefer env-backed refs.',
              },
              {
                title: 'Advanced Env-Backed Refs',
                items: [
                  'Set the real secret in the host environment, for example `OPENAI_API_KEY` or `BRAVE_API_KEY`.',
                  'Open Configuration > AI & Search > Credential Refs and create a stable ref name such as `llm.openai.primary` that maps to that environment variable.',
                  'In provider, search, or Telegram settings, leave the secret field blank and enter that credential ref instead.',
                ],
              },
              {
                title: 'Which Path To Use',
                items: [
                  'Use paste-once local storage for laptops, desktops, and straightforward single-host deployments.',
                  'Use env-backed refs when the app is deployed through service managers, containers, CI, or any environment where operators already manage secrets outside the app.',
                  'Both paths resolve through the same credential-ref layer at runtime, so providers and tools behave the same once configured.',
                ],
              },
            ],
          },
          {
            id: 'google-workspace',
            title: 'Google Workspace',
            summary: 'Enable Gmail, Calendar, Drive, Docs, Sheets, and Contacts via native integration.',
            sections: [
              {
                title: 'Integration',
                items: [
                  'Native integration (default): GuardianAgent calls Google APIs directly. No external CLI dependency. OAuth handled within the app via a localhost callback with PKCE. Tokens stored encrypted at rest.',
                  'Uses the `gws` and `gws_schema` tool names. The LLM interface is direct — no separate CLI authentication needed.',
                ],
              },
              {
                title: 'Setup (3 Steps)',
                items: [
                  'Step 1 — Create OAuth credentials: Go to the Google Cloud Console (console.cloud.google.com). Create a new project if needed (top-left project selector > New Project). Navigate to APIs & Services > Credentials. Click "+ Create Credentials" > "OAuth client ID". IMPORTANT: Set Application type to "Desktop app" (not "Web application"). Give it any name (e.g. "Guardian Agent Desktop") and click Create. On the confirmation dialog, click "Download JSON" to get your client_secret.json file.',
                  'Before creating credentials you may need to configure the OAuth consent screen: Go to Google Auth Platform > Audience (or OAuth consent screen). Set user type to External, fill in the app name and your email, save. Then under Publishing status click "Publish App" — without this, only manually-added test users can authenticate.',
                  'Enable the Google APIs you plan to use: Go to APIs & Services > Library. Search for and enable: Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API. Only enable what you need.',
                  'Step 2 — Upload credentials: In Guardian Agent, go to Configuration > Integrations > Google Workspace. Select Native mode. Upload the client_secret.json file you downloaded, or manually place it at ~/.guardianagent/google-credentials.json.',
                  'Step 3 — Connect: Select the Google services you want (Gmail, Calendar, Drive, Docs, Sheets, Contacts). Click "Connect Google". A browser window opens for Google consent. Approve access, and the connection is live immediately.',
                ],
              },
            ],
          },
          {
            id: 'telegram',
            title: 'Telegram Channel',
            summary: 'Bring the assistant into Telegram with BotFather setup and allowed chat IDs.',
            sections: [
              {
                title: 'Bot Setup',
                items: [
                  'Create the bot through `@BotFather` using `/newbot`, then copy the returned token.',
                  'Enable Telegram in Configuration > Integrations, then either paste the token once for secure local storage or leave the token field blank and provide an env-backed credential ref.',
                  'Send at least one message to the bot, then fetch your `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates`.',
                  'Paste allowed chat IDs into the configuration. Group IDs are commonly negative and often start with `-100`.',
                ],
              },
              {
                title: 'CLI Equivalent',
                items: [
                  'Use `/config telegram on`, `/config telegram token <token>`, `/config telegram chatids <id1,id2,...>`, and `/config telegram status`.',
                  'Telegram channel changes are hot-reloaded, so enable/disable and token updates apply without a full application restart.',
                ],
              },
            ],
          },
          {
            id: 'web-search-and-document-search',
            title: 'Web Search And Document Search',
            summary: 'Use live web search, page fetch, and local document search together without losing source control.',
            sections: [
              {
                title: 'Web Search',
                items: [
                  'Built-in web search and fetch tools can run through the configured search provider path without leaving Guardian controls.',
                  'Use Configuration > Search Sources to set provider options and either paste premium search keys once or assign env-backed credential refs.',
                  'Search config changes apply immediately and invalidate the web UI so the current state stays visible.',
                ],
              },
              {
                title: 'Document Search',
                items: [
                  'Native hybrid search combines BM25 keyword matching and vector similarity across local directories, repositories, URLs, and files.',
                  'Use the Search Sources configuration area to add, remove, enable, disable, or reindex document sources.',
                  'Keep collections tight and purposeful so retrieval quality remains high and reindex times stay reasonable.',
                ],
                note: 'Treat web search and document search as complementary: web search is for external freshness, document search is for trusted local context.',
              },
            ],
          },
        ],
      },
      {
        id: 'automation-and-operations',
        title: 'Automation And Operations',
        description: 'Operate scheduled work, inspect tool output, and manage network or intel workflows.',
        pages: [
          {
            id: 'automations',
            title: 'Automations',
            summary: 'Build deterministic workflows or scheduled assistant reports, then run them manually or on a cron schedule.',
            sections: [
              {
                title: 'Create And Run',
                items: [
                  'The Automations page is the unified home for playbooks and scheduled tasks.',
                  'Automations can run a single tool, multiple tools in sequential or parallel mode, or a scheduled assistant turn that uses normal Guardian skills and tools.',
                  'Use Edit for normal updates such as names, tools, steps, and schedules without dropping into raw JSON.',
                  'Use Examples to install starter automations such as Agent Host Guard and Firewall Sentry, then Clone to fork an existing workflow.',
                  'Use Dry Run before live execution when you want a safe preview path.',
                ],
              },
              {
                title: 'Scheduling And Limits',
                items: [
                  'Any automation can be given a cron schedule and turned into a recurring task.',
                  'Use Single shot when you want the task to run once on the next matching schedule and then disable itself automatically.',
                  'Scheduled assistant tasks need a prompt plus a target agent. They are best for recurring briefs, watchlists, and open-ended checks that should decide what to inspect at runtime.',
                  'Scheduled task creation is the approval checkpoint. After the task is saved, later cron runs do not re-prompt for the same action.',
                  'Power-user options remain available through the advanced JSON/config sections when you need direct definition edits.',
                  'Engine Settings control max steps, max parallelism, timeout defaults, and execution mode.',
                  'Permission policies restrict what hosts, file paths, and commands an automation can touch.',
                ],
              },
              {
                title: 'Inspect Results',
                items: [
                  'Run history now keeps per-step output, not just status text.',
                  'Scheduled tool runs, scheduled playbook runs, and scheduled assistant runs can be expanded in Automations to inspect captured output.',
                  'Where output is shown in the UI, operators can copy it directly or export it as plain text or HTML for sharing and review.',
                  'Live UI invalidation updates the Automations page when runs finish, schedules change, or playbooks are edited.',
                ],
              },
              {
                title: 'Security Automation Starters',
                items: [
                  'Use `agent-host-guard` when you want workstation baseline and anomaly-response playbooks.',
                  'Use `firewall-sentry` when you want host and gateway firewall posture checks plus firewall-drift triage.',
                  'Preset scheduled jobs such as `host-monitor-watch`, `firewall-posture-watch`, `gateway-firewall-watch`, and `gateway-firewall-posture` are available from Examples.',
                ],
              },
            ],
          },
          {
            id: 'network-operations',
            title: 'Network Operations',
            summary: 'Use the Network page for inventory, one-off diagnostics, and network run history. Use Security for the unified alert queue.',
            sections: [
              {
                title: 'Core Tabs',
                items: [
                  'Overview summarizes device counts, baseline readiness, active alerts, and quick actions.',
                  'Devices shows discovered devices, trust state, open ports, and first/last seen timestamps.',
                  'Security owns the unified alert queue; Network keeps the operational device and diagnostics views.',
                  'History shows recent scheduled and manual network runs with expandable per-step output.',
                ],
              },
              {
                title: 'Tools Tab',
                items: [
                  'The Diagnostics tab groups network tools by category and uses dropdown selectors instead of a scrolling tab strip.',
                  'Choose a category first, then select the specific tool to run.',
                  'Each tool panel keeps its own argument form and result viewer so raw output is inspectable immediately.',
                  'Live result panels include Copy, Text export, and HTML export actions so one-off scan output can be reused outside the dashboard.',
                ],
              },
              {
                title: 'What Gets Persisted',
                items: [
                  'Inventory-oriented outputs feed the device inventory service automatically.',
                  'Threat and baseline actions update the network baseline and alert state.',
                  'Scheduled network jobs also write structured history entries so operators can review what ran and what it returned.',
                  'Expanded history output uses the same copy and export controls as live results, so archived runs can be saved as `.txt` or `.html` without rerunning the tool.',
                ],
              },
            ],
          },
          {
            id: 'threat-intel-and-campaigns',
            title: 'Threat Intel And Campaigns',
            summary: 'Run watchlist scans, triage findings, draft responses, and use approval-gated outreach workflows.',
            sections: [
              {
                title: 'Threat Intel Operator Surfaces',
                items: [
                  'Use Security > Threat Intel in the web UI to manage watch targets, change response mode, run manual scans, and review findings in one place.',
                  'CLI `/intel ...` is the full operator surface for threat intel: status, plan, watchlist management, scans, findings, finding status changes, drafted actions, and response mode changes.',
                  'Telegram currently exposes the three quick intel operators: `/intel status`, `/intel scan <query> [--darkweb]`, and `/intel findings`.',
                  'Threat-intel results stay visible in Security, and high-risk scan results are also promoted into the wider security signal path.',
                ],
              },
              {
                title: 'Threat Intel Commands And Tools',
                items: [
                  'CLI operators: `/intel [status]`, `/intel plan`, `/intel watch [list|add|remove] <target>`, `/intel scan [query] [--darkweb] [--sources=web,news,social,forum]`, `/intel findings [limit] [status]`, `/intel finding <id> status <new|triaged|actioned|dismissed>`, `/intel actions [limit]`, `/intel action draft <findingId> <report|request_takedown|draft_response|publish_response>`, and `/intel mode <manual|assisted|autonomous>`.',
                  'Built-in threat-intel tools exposed to the assistant and automations are `intel_summary`, `intel_watch_add`, `intel_watch_remove`, `intel_scan`, `intel_findings`, and `intel_draft_action`.',
                  'The built-in scheduled example is `threat-intel-scan`, which runs `intel_scan` on a recurring schedule from Operations.',
                ],
              },
              {
                title: 'Threat Intel Operating Notes',
                items: [
                  'Response mode can be manual, assisted, or autonomous depending on your tolerance for automatic action.',
                  'Dark-web scanning is opt-in and disabled by default unless explicitly enabled.',
                  'Use watchlist entries for people, handles, brands, domains, and fraud or impersonation phrases you want monitored over time.',
                  'Moltbook connectors should be treated as hostile integrations and kept behind strict allowlists and approval gates.',
                ],
              },
              {
                title: 'Campaign Workflows',
                items: [
                  'Discover contacts with `/campaign discover <url> [tagsCsv]` or import them from CSV.',
                  'Create campaigns with `/campaign create <name> | <subjectTemplate> | <bodyTemplate>`.',
                  'Preview content with `/campaign preview <campaignId> [limit]` before sending.',
                  'Run sends with `/campaign run <campaignId> [maxRecipients]`; outbound sends remain approval-gated.',
                ],
                note: 'Template placeholders such as `{name}`, `{company}`, and `{email}` are available in campaign subject and body templates.',
              },
            ],
          },
          {
            id: 'quick-actions-and-schedules',
            title: 'Quick Actions And Schedules',
            summary: 'Use fast structured actions for routine work, then promote repeatable tasks into scheduled automations.',
            sections: [
              {
                title: 'Quick Actions',
                items: [
                  'Quick actions are available in the web UI, CLI `/quick ...`, and Telegram `/quick ...` for common email, task, and calendar flows.',
                  'Use quick actions when the job is structured but not worth building a full playbook.',
                  'Quick action runs still pass through normal approval, policy, and audit controls.',
                ],
              },
              {
                title: 'When To Schedule',
                items: [
                  'Promote repetitive quick or manual workflows into Automations when they need cron execution, output history, or stronger guardrails.',
                  'Use scheduled tasks for periodic network checks, intel scans, system health checks, and repeatable playbook runs.',
                  'Review run history and step output after the first scheduled execution to confirm the automation is doing what you expect.',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'data-security-and-troubleshooting',
        title: 'Data, Security, And Troubleshooting',
        description: 'Understand identity, observability, and the fastest operator checks when something is off.',
        pages: [
          {
            id: 'identity-and-memory',
            title: 'Identity And Memory',
            summary: 'Control how users map across channels and how conversation state is retained.',
            sections: [
              {
                title: 'Identity Modes',
                items: [
                  '`single_user` shares one assistant identity across web, CLI, and Telegram.',
                  '`channel_user` keeps identities separate by channel unless you alias-map them deliberately.',
                  'Choose the mode that matches whether you want one shared assistant memory or distinct channel personas.',
                ],
              },
              {
                title: 'Memory Behavior',
                items: [
                  'Conversation memory is stored in SQLite when available, with retention settings exposed through configuration.',
                  'Switching between `auto`, `local-only`, and `external-only` changes which backend answers, but the built-in tier assistant keeps one shared chat history and knowledge base.',
                  'Reset conversation state when you want a clean run without changing the longer-term identity policy.',
                  'Assistant memory, analytics, and search-oriented history should be reviewed together when debugging stale context.',
                ],
              },
            ],
          },
          {
            id: 'analytics-and-observability',
            title: 'Analytics And Observability',
            summary: 'Use built-in analytics, audit history, and assistant state views to understand system behavior.',
            sections: [
              {
                title: 'Operator Views',
                items: [
                  'Analytics summary is available in the dashboard and with CLI `/analytics [minutes]`.',
                  'Assistant state exposes running jobs, failed jobs, queue pressure, traces, and policy decisions.',
                  'Security monitoring surfaces audit volume, denied actions, network posture, host-monitor alerts, gateway-firewall alerts, and recent notifications.',
                ],
              },
              {
                title: 'Audit Workflow',
                items: [
                  'Use the Security page or CLI `/audit`, `/audit summary`, and `/security` to inspect recent events.',
                  'Audit entries are hash-chained; use the verification control when you need tamper-evidence confirmation.',
                  'Audit details can be expanded in the web UI when you need the full raw event payload instead of the short preview.',
                  'Policy reloads, auth changes, and tool decisions are all reflected in audit visibility.',
                ],
              },
            ],
          },
          {
            id: 'policy-and-audit',
            title: 'Policy-As-Code And Audit',
            summary: 'Use deterministic policy rules and audit evidence together when you need to explain or change behavior safely.',
            sections: [
              {
                title: 'Policy Engine',
                items: [
                  'Policy-as-code supports off, shadow, and enforce modes depending on how aggressively you want rules to apply.',
                  'Configuration > Tools & Policy and CLI `/policy ...` expose the current mode, family settings, and reload controls.',
                  'Shadow mode is the safest way to compare rule output with current behavior before switching to enforce.',
                ],
              },
              {
                title: 'Audit Use',
                items: [
                  'Audit entries capture policy changes, approvals, denials, security events, and important operator actions.',
                  'Use audit verification and summary views before changing policy if you need evidence of what actually happened.',
                  'Prefer adjusting the policy model or tool boundaries instead of repeatedly approving the same risky action by hand.',
                ],
              },
            ],
          },
          {
            id: 'security-and-troubleshooting',
            title: 'Security And Troubleshooting',
            summary: 'Start with auth, provider health, permissions, and audit evidence before assuming a deeper runtime bug.',
            sections: [
              {
                title: 'First Checks',
                items: [
                  'If the web dashboard rejects you, confirm the bearer token or session cookie state in Web Authentication settings.',
                  'If a model appears offline, verify connectivity in the Providers tab or with CLI `/providers`.',
                  'If file or command execution is blocked, review Tools policy and allowed path or command settings before retrying.',
                  'If network data looks stale, use the Network History tab and recent outputs to confirm whether the scan actually ran.',
                ],
              },
              {
                title: 'Security Defaults',
                items: [
                  'Guardian blocks prompt injection patterns, secret leakage, and risky tool actions by default.',
                  'Bearer auth is mandatory for the web dashboard; there is no unauthenticated dashboard mode.',
                  'Rotate web auth credentials from the web Config Center or with CLI `/auth rotate`.',
                  'Security alerts default to CLI-only delivery; use Configuration > System to enable web or Telegram fanout.',
                  'Use audit and policy views to understand why an action was denied instead of loosening controls blindly.',
                  'Outbound HTTP tool calls are checked against SSRF protection rules that block private IPs, cloud metadata endpoints, and obfuscated addresses.',
                ],
                note: 'Configuration changes now propagate to the web UI live, so if something still looks wrong after a save, verify the underlying runtime state rather than assuming the browser is stale.',
              },
            ],
          },
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

  for (const category of guide.categories) {
    lines.push(category.title);
    lines.push(`  ${category.description}`);
    lines.push('');

    for (const page of category.pages) {
      lines.push(`- ${page.title}`);
      lines.push(`  ${page.summary}`);
      for (const section of page.sections) {
        lines.push(`  ${section.title}:`);
        for (const item of section.items) {
          lines.push(`    - ${item}`);
        }
        if (section.note) {
          lines.push(`    Note: ${section.note}`);
        }
      }
      lines.push('');
    }
  }

  return lines;
}

export function formatGuideForTelegram(guide: ReferenceGuide = getReferenceGuide()): string {
  const lines: string[] = [];
  lines.push(guide.title);
  lines.push(guide.intro);
  lines.push('');

  for (const category of guide.categories) {
    lines.push(`${category.title}:`);
    lines.push(category.description);
    lines.push('');

    for (const page of category.pages) {
      lines.push(`${page.title} - ${page.summary}`);
      for (const section of page.sections) {
        lines.push(`${section.title}:`);
        for (const item of section.items) {
          lines.push(`- ${item}`);
        }
        if (section.note) {
          lines.push(`Note: ${section.note}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}
