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
    intro: 'Operator wiki for setup, day-to-day use, coding workflows, cloud connections, automations, and security controls across web, CLI, and Telegram.',
    categories: [
      {
        id: 'getting-started',
        title: 'Getting Started',
        description: 'Bootstrap the assistant, learn the control surfaces, use the coding IDE, and manage conversations safely.',
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
                  'If no web auth token is configured, or if `channels.web.auth.rotateOnStartup` is enabled, Guardian Agent generates a runtime-ephemeral token at startup and prints it to the interactive terminal.',
                  'The Windows and Unix startup scripts now tell you whether the dashboard will reuse a pinned token or print a per-run runtime token at startup.',
                  'Use the Configuration Center in the web UI or CLI `/config` to create or update provider settings instead of editing YAML by hand.',
                ],
              },
              {
                title: 'Verify Readiness',
                items: [
                  'Use the Dashboard page to confirm runtime status, agent health, provider connectivity, and assistant state.',
                  'Open `#/config` to verify the default provider, web auth settings, and channel configuration.',
                  'Open `#/code` when you want the repo-scoped coding surface, and `#/security` when you want posture, alerts, activity, audit, or threat-intel visibility.',
                  'Use CLI `/providers` or Configuration > AI Providers to confirm the selected provider is reachable.',
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
                  'Quick actions are available through the web quick-action bar, CLI `/quick <action> <details>`, and Telegram `/quick ...`.',
                  'Built-in quick actions cover email, task planning, calendar planning, and a security review that runs the Assistant Security scan flow.',
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
                  'Automations now includes an `Execution Timeline` section that acts as the global operator view for recent assistant, code-session, workflow, and scheduled-task runs.',
                  'Use the execution timeline when you need to reconstruct what the agent did, why a run paused, which tool step failed, or how approvals and verification progressed.',
                  'Configuration > Tools exposes tool enablement, routing, approvals, and recent jobs. Configuration > Security owns sandbox enforcement, allowlists, degraded-backend overrides, browser risk controls, and policy posture.',
                  'Security is the main operator surface for posture, unified alerts, agentic activity history, audit evidence, threat-intel workflows, and native Windows Defender state. It is not the main home for generic run playback.',
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
                  'Configuration > Tools is the main operator surface for tool enablement, category routing, approvals, and recent jobs.',
                  'Configuration > Security is where you review or change sandbox enforcement, degraded-backend overrides, browser security posture, allowlists, and policy-engine posture.',
                  'Configuration > Security now combines sandbox enforcement and assistant policy-widening gates in one control surface. `Strict` means fail closed when the strong sandbox is unavailable. `Permissive` means Guardian can keep running on a degraded backend, but the risky degraded-backend surfaces still stay off until you explicitly opt in.',
                  'Use CLI `/tools` for the same operational visibility when you are working outside the web UI.',
                  'Allowed paths, commands, and domains should be adjusted deliberately; treat them as policy boundaries, not convenience toggles.',
                  'The `.guardianagent/` data directory is a hard-denied path at the Guardian admission layer. The agent cannot read, write, copy, or delete any files under `~/.guardianagent/` through filesystem tools, even if the operator adds the home directory to `allowedPaths`. This prevents agent self-modification of config, auth tokens, memory stores, and integrity signatures. Internal services (memory, search, OAuth, audit) write to this directory through their own APIs, bypassing the filesystem tool gate.',
                  'When the web dashboard needs to change a protected allowlist or policy setting, it now mints the required privileged ticket automatically. If your dashboard session expired, enter the bearer token once and the interrupted save is retried automatically.',
                ],
              },
              {
                title: 'Approvals',
                items: [
                  'Pending tool actions are surfaced in web approvals, CLI native prompts, and Telegram approval flows.',
                  'Inside code sessions, safe repo-local reads and edits stay low-friction, while repo execution and persistence actions only auto-approve after the workspace trust state reaches `trusted`.',
                  'Use `/approve [approvalId]` and `/deny [approvalId]` as fallback commands when native approval controls are unavailable.',
                  'Recent approval outcomes show up in audit history and assistant policy views, so you can verify what was allowed and why.',
                ],
              },
              {
                title: 'Browser Automation',
                items: [
                  'Browser automation is provided through the managed Playwright MCP backend and Guardian wrapper tools built on top of it.',
                  'Use the Guardian-native browser wrapper tools first: `browser_capabilities`, `browser_navigate`, `browser_read`, `browser_links`, `browser_extract`, `browser_state`, and `browser_act`.',
                  'The wrapper uses one backend for both reads and interaction: Playwright snapshots for page state and fixed Playwright DOM extraction for links and structured metadata.',
                  '`browser_capabilities` shows which Playwright capabilities are connected and whether the current wrapper session already has a page open for the current user, channel, or code session.',
                  '`browser_state` captures a fresh Playwright-backed page snapshot with stable refs. Use the returned `stateId` plus those refs with `browser_act` for click, type, fill, and select actions.',
                  '`browser_interact` remains available as a compatibility shim. `action=list` still surfaces refs, but new interactive flows and saved automations should prefer `browser_state` + `browser_act`.',
                  'Browser navigation only supports HTTP and HTTPS targets, and private hosts are blocked for SSRF protection.',
                  'Private/internal browser targets are hard-blocked before any allowlist remediation is offered. Guardian should not suggest adding metadata IPs or RFC1918 hosts to the browser allowlist.',
                  'Browser host checks now prefer `assistant.tools.browser.allowedDomains` when it is configured; otherwise they fall back to the main tool `allowedDomains` list.',
                  'Use Configuration > Security > Browser Automation > Allowed Domains to add browser hosts manually. An entry such as `httpbin.org` also covers subdomains like `www.httpbin.org`.',
                  'Browser MCP startup does not require the general MCP toggle to be enabled; if browser tooling is on and the Playwright binary is available, GuardianAgent registers the browser server automatically.',
                  'Browser config changes from the dashboard or CLI now apply live. Guardian restarts the managed Playwright backend in-process, refreshes the wrapper tools, and reports a degraded result if the backend could not be started.',
                  'Conversational browser automation authoring now compiles deterministic workflows to the Guardian wrapper tool names directly. Saved automations should contain `browser_*` steps such as `browser_state` and `browser_act`, not raw `mcp-playwright-*` identifiers.',
                  'Third-party MCP servers are different from the managed browser path: they stay blocked until explicitly marked `startupApproved`, and they default to network-off, clean-environment startup unless you opt in.',
                  'Raw `mcp-playwright-*` tools still exist as fallback escape hatches, but they are hidden from the normal assistant-visible tool list so the model prefers the wrapper surface for ordinary browser work.',
                ],
              },
            ],
          },
          {
            id: 'coding-assistant-ide',
            title: 'Coding Assistant IDE',
            summary: 'Use backend-owned code sessions, Monaco editing, bounded repo review, and session-scoped approvals for repo work.',
            sections: [
              {
                title: 'Start A Code Session',
                items: [
                  'Open `#/code` and create a session with a title plus the workspace root you want Guardian to anchor to.',
                  'Each code session is backend-owned and persists the coding transcript, workspace profile, repo map, trust state, approvals, recent jobs, and verification state.',
                  'The web Code page is the richest coding client, but main chat, CLI, and Telegram can attach to the same backend code session when you want to continue the work from another surface.',
                ],
              },
              {
                title: 'IDE And Session Context',
                items: [
                  'The Code page combines a session rail, explorer, Monaco editor and diff view, manual terminal panes, an assistant sidebar for chat and activity, and an editor-owned code inspector for guided investigation, local flow, and repo impact views.',
                  'The assistant sidebar uses backend session state rather than browser-only state, so workspace profile, indexed repo map, working set, pending approvals, recent jobs, and checks survive refreshes and cross-surface reuse.',
                  'The `Activity` view now starts with a session-scoped run timeline. It shows the most recent coding runs for that code session, including tool steps, approval pauses, and verification milestones before the lower-level approvals, task, and check cards.',
                  'Use the Code activity timeline when you want the local story for one coding session. Use Automations > Execution Timeline when you want the global cross-session view.',
                  'Use the inline editor search beside `Inspect` to search within the current file, jump to each match in Monaco, and step forward or backward through repeated hits without opening the full Monaco find widget.',
                  'Terminal panes remain operator-controlled PTY sessions. Assistant-driven file edits, shell execution, tests, builds, and linting still go through the guarded tool path instead of taking over a PTY.',
                  'Manual terminal sessions inherit a hardened environment and open/exit events land in audit history, but they are still operator terminals rather than a substitute for guarded tool execution.',
                ],
              },
              {
                title: 'Code Inspector',
                items: [
                  'Use the `Inspect` button or Monaco CodeLens in supported TypeScript and JavaScript files to open the code inspector for the selected symbol, current cursor region, or active file section.',
                  'The inspector can stay inline in the Code page or be detached into its own popup window when you want a larger parallel investigation surface while still editing.',
                  'The `Investigate` tab explains what the current code does, what it depends on, which deterministic risks or quality issues stand out, and where to inspect next.',
                  'The `Flow` tab focuses on symbol-level callers, callees, and local execution flow inside the active file or selected large-file section.',
                  'The `Impact` tab shows cross-file blast radius using the workspace map, including imports, importers, nearby files, and working-set relevance.',
                  'Large files are inspected section by section instead of failing outright, so the inspector can anchor analysis to the current cursor or a chosen section without parsing the whole file at once.',
                  'Structure insights update live from the unsaved Monaco buffer after a short debounce, so the inspector can follow edits before you save.',
                ],
              },
              {
                title: 'Repo Trust And Native AV',
                items: [
                  'New code sessions no longer assume a cloned repo is automatically safe. Guardian first stores a bounded static repo review and then, when available, schedules a background native malware scan of the workspace root.',
                  'Windows code sessions consume Windows Defender custom-path scans. Unix-like hosts consume `clamscan` or `clamdscan` when installed.',
                  'The Code page exposes trust state directly through session badges, activity cards, and warning banners. Trust states are `trusted`, `caution`, and `blocked`, and native AV status is folded into the trust summary.',
                  'Activity cards and Edit Session now render repo-trust findings as expandable deterministic reviews with `Why this matters`, `Investigate next`, and observed context instead of a flat findings dump.',
                  'Guardian prioritizes native AV and blocking trust findings to the top of the bounded findings list, so a repo does not show `blocked` without also surfacing the blocking indicator.',
                  'Documentation and prompt-testing content can still produce prompt-injection caution signals, but ordinary inline Node bootstrap helpers now stay in review-only territory unless they pair with stronger execution indicators.',
                  'Operators can manually trust the current findings from Edit Session. That override is session-scoped, keeps the raw findings visible, and clears automatically if the assessment changes.',
                  'When workspace trust is not cleared, README-derived summaries and raw working-set snippets are suppressed from the model prompt so repo content is treated as untrusted data rather than instructions.',
                  'A `trusted` result means the shipped static review and optional native AV scan did not find current indicators. It is not an agentic repo review or a proof that the repo is safe.',
                ],
              },
              {
                title: 'Coding Approvals',
                items: [
                  'Safe repo-local coding tools such as `code_edit`, `code_patch`, `code_create`, `code_plan`, `code_git_diff`, and repo-scoped file operations remain auto-approved inside the active workspace.',
                  'Execution and persistence actions such as `code_test`, `code_build`, `code_lint`, `memory_save`, and workflow or task mutations only auto-approve when the effective workspace trust state is `trusted`.',
                  'Read-only shell commands such as `git status` stay low-friction. Non-read-only shell execution in a `caution` or `blocked` workspace requires approval even under autonomous policy mode.',
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
                  'In Configuration > AI Providers choose the local provider path, then set a profile name, model, and base URL if needed.',
                  'CLI equivalent: `/config add ollama ollama llama3.2` followed by `/config set default ollama`.',
                ],
              },
              {
                title: 'Validation',
                items: [
                  'Use Configuration > AI Providers or CLI `/providers` to verify connectivity and model discovery.',
                  'If the provider is unavailable, check the Ollama process and base URL before changing Guardian configuration.',
                ],
              },
            ],
          },
          {
            id: 'cloud-providers',
            title: 'Connect Hosted AI Providers',
            summary: 'Add external models from OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI, or Google Gemini for quality fallback, smart routing, or explicit hosted-model use.',
            sections: [
              {
                title: 'External Provider Setup',
                items: [
                  'In Configuration > AI Providers choose External Providers, then select the provider family (OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI, or Google Gemini), model, and either paste the API key once or point the profile at a credential ref.',
                  'CLI equivalent: `/config add <name> <provider> <model> <apiKey>` where provider is openai, anthropic, groq, mistral, deepseek, together, xai, or google.',
                  'Set the default provider from Configuration > AI Providers or with `/config set default <name>`.',
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
                  'Open Configuration > AI Providers > Credential Refs and create a stable ref name such as `llm.openai.primary` that maps to that environment variable.',
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
                  'Step 2 — Upload credentials: In Guardian Agent, open Cloud > Connections > Google Workspace. Select Native mode, then upload the `client_secret.json` file you downloaded, or manually place it at `~/.guardianagent/google-credentials.json`.',
                  'Step 3 — Connect: Select the Google services you want (Gmail, Calendar, Drive, Docs, Sheets, Contacts). Click "Connect Google". A browser window opens for Google consent. Approve access, and the connection is live immediately.',
                ],
              },
            ],
          },
          {
            id: 'microsoft-365',
            title: 'Microsoft 365',
            summary: 'Enable Outlook Mail, Calendar, OneDrive, and Contacts via native Microsoft Graph integration.',
            sections: [
              {
                title: 'Integration',
                items: [
                  'Native integration: GuardianAgent calls the Microsoft Graph REST API directly. No MSAL, no Graph SDK — hand-rolled OAuth 2.0 PKCE with encrypted token storage.',
                  'Uses the `m365` (generic Graph API), `m365_schema` (endpoint reference), `outlook_draft`, and `outlook_send` tool names.',
                  'Single base URL: graph.microsoft.com/v1.0. Consistent OData query parameters ($filter, $select, $top, $orderby).',
                ],
              },
              {
                title: 'Setup (3 Steps)',
                items: [
                  'Step 1 — Register app: Go to the Microsoft Entra admin center (entra.microsoft.com). Click "New registration". Name it anything (e.g. "Guardian Agent"). Set supported account types to "Any Entra ID directory + personal Microsoft accounts". Under Redirect URI, select "Mobile and desktop applications" and enter http://localhost:18433/callback. Click Register. Then go to Authentication > Settings, enable "Allow public client flows", and click Save. Copy the Application (client) ID from the Overview page.',
                  'Step 2 — Enter Client ID: In Guardian Agent, open Cloud > Connections > Microsoft 365. Paste the Application (client) ID. Optionally set a Tenant ID (defaults to `common` for broadest compatibility).',
                  'Step 3 — Connect: Select the services you want (Mail, Calendar, OneDrive, Contacts). Click "Connect Microsoft". A browser window opens for consent. Approve access, and the connection is live immediately.',
                ],
              },
              {
                title: 'Available Services',
                items: [
                  'Mail — read, search, draft, send, folders, attachments via Outlook.',
                  'Calendar — list events, calendar view with recurring expansion, create/update/delete events.',
                  'OneDrive — list files, search, get metadata, storage quota.',
                  'Contacts — list, create, update, delete contacts.',
                  'User — get current user profile (display name, email address).',
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
                  'Enable Telegram in Configuration > Integration System, then either paste the token once for secure local storage or leave the token field blank and provide an env-backed credential ref.',
                  'Integration System stays limited to operator access, channels, and maintenance. AI provider, search, and cloud connection details live on their own owner tabs.',
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
                  'Use Configuration > Search Providers to set provider options and either paste premium search keys once or assign env-backed credential refs.',
                  'Configuration > Search Providers only owns search and retrieval behavior. Ollama and other LLM provider profiles stay in Configuration > AI Providers.',
                  'Search config changes apply immediately and invalidate the web UI so the current state stays visible.',
                ],
              },
              {
                title: 'Document Search',
                items: [
                  'Native hybrid search combines BM25 keyword matching and vector similarity across local directories, repositories, URLs, and files.',
                  'When you already know the exact local PDF path, use `fs_read` to extract the document text directly instead of indexing first.',
                  'Use Configuration > Search Providers to add, remove, enable, disable, or reindex document sources.',
                  'The Search Providers overview now uses a compact runtime state summary instead of a vanity status-card strip, so the tab stays focused on source management.',
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
            summary: 'Build deterministic workflows, scheduled assistant reports, or manual on-demand assistant automations, then run them from Automations or on a cron schedule.',
            sections: [
              {
                title: 'Create And Run',
                items: [
                  'The Automations page is the unified home for saved automations, schedules, and built-in starter examples.',
                  'Automations can run a single tool, multiple tools in sequential or parallel pipelines, a scheduled assistant turn, or a manual on-demand assistant automation. The assistant turn option is inside the schedule section — check "Run as assistant turn" to create a full agent task with tools, memory, and skills.',
                  'Pipeline steps can be tool steps, LLM instruction steps (text synthesis from prior step outputs), or delay steps (pause the pipeline for a set duration). Delay steps are only meaningful in sequential mode.',
                  'Instruction steps can also be evidence-grounded so reports and summaries carry forward citations or structured evidence captured by earlier search or retrieval steps.',
                  'The tool picker (Browse button) lets you search tools by name or description and shows integration requirements (e.g. Google Workspace connected, AWS profile configured).',
                  'An optional prompt on single-tool automations auto-converts the automation into a 2-step sequential pipeline (tool + LLM instruction).',
                  'The LLM Provider selector controls which model handles instruction steps and agent tasks. Auto uses smart routing; Local/External force a specific provider type.',
                  'Use Edit for normal updates such as names, tools, steps, and schedules without dropping into raw JSON.',
                  'The advanced raw definition editor on saved step-based automations now saves through the same backend automation contract as the structured form, so linked schedules and output-routing metadata stay attached. Built-in starter examples must be copied before raw editing is enabled.',
                  'Use the `Use Example` action on built-in starter rows to create a saved automation such as Agent Host Guard or Firewall Sentry, and use `Create Copy` to fork an already-saved automation.',
                  'Built-in starter examples shown in the Automations catalog now come from the backend automation catalog directly instead of being reconstructed in the browser from separate template and preset lists.',
                  'Use Dry Run before live execution when you want a safe preview path.',
                  'Named automations can also be controlled from chat: Guardian can inspect, run, enable, disable, or delete saved automations through the same backend control plane used by the UI.',
                  'If a chat automation request is incomplete, Guardian now keeps it inside automation authoring and returns a draft with the missing schedule, goal, or deterministic steps instead of falling back into browser or general chat handling.',
                ],
              },
              {
                title: 'Scheduling And Limits',
                items: [
                  'Any automation can be given a cron schedule and turned into a recurring task, or left manual-only so it runs only when an operator triggers it.',
                  'Use Single shot when you want the task to run once on the next matching schedule and then disable itself automatically.',
                  'Scheduled assistant tasks need a prompt plus a target agent. Enable "Run as assistant turn" inside the schedule section to create one. They are best for recurring briefs, watchlists, and open-ended checks that should decide what to inspect at runtime.',
                  'Pre-flight approval check: when scheduling an automation, the system checks whether any tools will require manual approval at runtime. If so, a validation panel shows the issues with one-click "Auto-approve" buttons that set per-tool auto policies. You can also skip the check and accept that each run may need manual approval.',
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
                  'Approval-gated automations keep one stable run record and resume after the approval decision instead of starting over from scratch.',
                  'Manual and scheduled automation runs can be expanded in Automations to inspect captured output.',
                  'Automations now also includes an `Execution Timeline` view for recent runs across assistant dispatch, coding sessions, automations, and scheduled jobs. It is the main global playback surface for run status, approvals, tool progression, and verification events.',
                  'Use `Execution Timeline` when you need to answer "what happened in this run?" and use `Run History` when you need automation-specific step output and artifacts.',
                  'Where output is shown in the UI, operators can copy it directly or export it as plain text or HTML for sharing and review.',
                  'Live UI invalidation updates the Automations page when runs finish, schedules change, or automations are edited.',
                ],
              },
              {
                title: 'Security Automation Starters',
                items: [
                  'Use `agent-host-guard` when you want workstation baseline and anomaly-response playbooks.',
                  'Use `firewall-sentry` when you want host and gateway firewall posture checks plus firewall-drift triage.',
                  'Those packs now include unified alert search and operating-mode recommendation steps so the operator gets both raw findings and a posture recommendation in one run.',
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
                  'Built-in scheduled examples include `threat-intel-scan` for recurring intel collection and `assistant-security-scan` for recurring Assistant Security posture reviews from Operations.',
                  'Configuration > Security now owns the managed Assistant Security monitoring schedule, so recurring posture scans stay visible as product configuration rather than a hidden automation.',
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
                  'Quick actions are available in the web UI, CLI `/quick ...`, and Telegram `/quick ...` for common email, task, calendar, and security-review flows.',
                  'Use quick actions when the job is structured but not worth building a full playbook.',
                  'Quick action runs still pass through normal approval, policy, and audit controls.',
                ],
              },
              {
                title: 'When To Schedule',
                items: [
                  'Promote repetitive quick or manual workflows into Automations when they need cron execution, output history, or stronger guardrails.',
                  'Use scheduled automations for periodic network checks, intel scans, system health checks, and repeatable automation runs.',
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
                  'Security monitoring now surfaces posture state, unified alerts, Assistant Security findings and runs, audit volume, denied actions, host-monitor alerts, gateway-firewall alerts, native-provider alerts, and recent notifications.',
                ],
              },
              {
                title: 'Audit Workflow',
                items: [
                  'Use Security > Security Log or CLI `/audit`, `/audit summary`, and `/security` to inspect recent events.',
                  'Audit entries are hash-chained; use the verification control when you need tamper-evidence confirmation.',
                  'Security Log alerts and audit rows now expand into deterministic investigation guidance, normalized context, and raw event data so operators can work from structured evidence instead of freeform summaries alone.',
                  'Audit details can be expanded in Security Log when you need the full raw event payload instead of the short preview.',
                  'Policy reloads, auth changes, and tool decisions are all reflected in audit visibility.',
                ],
              },
            ],
          },
          {
            id: 'defensive-security-suite',
            title: 'Defensive Security Suite',
            summary: 'Use the Security page, native provider integrations, and agentic triage loop to operate the local defensive stack.',
            sections: [
              {
                title: 'Main Operator Surface',
                items: [
                  'The Security page is the main operator surface for the local defensive suite. It combines posture, Assistant Security, threat intel, the Security Log, and native Windows Defender visibility in one place.',
                  'Unified local security alerts currently aggregate host monitoring, network baseline and anomaly analysis, gateway firewall monitoring, and native Windows Defender alerts.',
                  'Windows host-monitor persistence alerts now use heuristics rather than treating every new autorun as equally severe. Script-host, network-path, and user-writable autoruns stay high risk, while conventional installed-app autoruns under `Program Files` are downgraded to reduce noise.',
                  'Use the Security page when you need posture and evidence. Use the Network page for device inventory and diagnostics, and the Code page when the issue is repo trust inside a coding session.',
                  'Built-in Assistant Security tools exposed to the assistant and automations are `assistant_security_summary`, `assistant_security_scan`, and `assistant_security_findings`; recurring posture reviews can use the `assistant-security-scan` preset.',
                  'Assistant Security continuous monitoring is scheduler-driven infrastructure work. It runs the built-in scan service directly and does not create a conversational assistant turn.',
                ],
              },
              {
                title: 'Profiles, Modes, And Containment',
                items: [
                  'The runtime stores deployment profiles (`personal`, `home`, `organization`) separately from operating modes (`monitor`, `guarded`, `lockdown`, `ir_assist`).',
                  'Monitor is the normal default. Posture can recommend escalation, and containment can temporarily auto-elevate to `guarded` when elevated alerts stack together.',
                  'Configuration > Security also exposes conservative Assistant Security auto-containment thresholds. By default, only high-confidence sandbox, trust-boundary, and MCP findings can tighten controls automatically.',
                  'Containment remains bounded and policy-driven. The shipped system does not fully auto-remediate or silently take over the host.',
                ],
              },
              {
                title: 'Native Host Protection',
                items: [
                  'Windows Defender is integrated as a native provider, not replaced. Guardian can refresh status, expose provider health and alerts, request quick, full, and custom path scans, and request signature updates from the Security page.',
                  'The Coding Assistant now consumes native AV signals as a secondary repo-assessment input. A native detection can be merged into `workspaceTrust` and force the repo trust state to `blocked`.',
                  'On Unix-like hosts, code-session repo scanning can use `clamscan` or `clamdscan` when installed. That Unix AV signal is currently consumed in code-session workspace trust rather than shown as a first-class Security-page provider. A clean native AV result does not override suspicious static repo findings.',
                ],
              },
              {
                title: 'Agentic Triage',
                items: [
                  'The defensive suite includes an LLM-backed `security-triage` agent plus an event dispatcher that investigates selected security events.',
                  'The triage path is intentionally conservative: read-only evidence gathering first, repeated events deduped with a cooldown window, expected guardrail denials skipped, and completed investigations recorded in the Assistant Security activity log.',
                  'The shipped triage loop does not automatically acknowledge, resolve, suppress, or launch mutating host actions purely because an alert fired.',
                ],
              },
              {
                title: 'MCP Security Uplifts',
                items: [
                  'Third-party MCP servers now require explicit startup approval before Guardian will launch them from config, which narrows config-tampering-to-code-execution risk at boot.',
                  'Guardian now treats third-party MCP tool descriptions and schemas as untrusted metadata, uses safer default risk handling, and keeps trust-level overrides from broadly down-ranking server risk.',
                  'MCP server runtime hardening now includes explicit network and environment controls, a pinned Playwright MCP path instead of `@latest`, transport/output caps, and dedicated MCP category gating in the executor.',
                  'Assistant Security surfaces MCP exposure separately so operators can watch for connected third-party servers, network access, environment inheritance, and trust overrides over time.',
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
                  'Configuration > Security and CLI `/policy ...` expose the current mode, family settings, and reload controls.',
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
                  'If a dashboard save or browser-config action drops you back to the auth prompt, the secure web session expired. Re-enter the current dashboard token and retry the change.',
                  'If a model appears offline, verify connectivity in Configuration > AI Providers or with CLI `/providers`.',
                  'If file or command execution is blocked, review Configuration > Tools, Configuration > Security, and the relevant allowed path or command settings before retrying.',
                  'If repo execution is blocked in the Code page, inspect the code session workspace trust badge, native AV summary, approvals tab, and recent jobs before assuming the coding tools are broken.',
                  'If network data looks stale, use the Network History tab and recent outputs to confirm whether the scan actually ran.',
                ],
              },
              {
                title: 'Security Defaults',
                items: [
                  'Guardian blocks prompt injection patterns, secret leakage, and risky tool actions by default.',
                  'New code sessions authorize the workspace path for repo-local access, but they do not treat the attached repo as automatically safe for execution.',
                  'Bearer auth is mandatory for the web dashboard; there is no unauthenticated dashboard mode.',
                  'Rotate web auth credentials from the web Config Center or with CLI `/auth rotate`.',
                  'Security alerts default to CLI-only delivery for primary security events; triage and automation summaries stay in Security until you explicitly add `automation_finding` notification fanout.',
                  'Default notification filters also mute low-confidence drift families and expected guardrail denials such as degraded-backend terminal blocks or containment-enforced action denials, so the stream stays focused on primary detections.',
                  'Use audit and policy views to understand why an action was denied instead of loosening controls blindly.',
                  'Outbound HTTP tool calls are checked against SSRF protection rules that block private IPs, cloud metadata endpoints, and obfuscated addresses.',
                  'Third-party MCP servers are now gated more tightly by default, but they still deserve the same scrutiny as shell, browser, and network tooling when you decide whether to enable them.',
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
