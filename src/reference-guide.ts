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
    intro: 'Operator guide for setup, day-to-day use, coding workflows, cloud connections, automations, and security controls across web, CLI, and Telegram. For implementation details and deeper technical documentation, use the GitHub repository links in this guide.',
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
                  'If web authentication is enabled, use the token shown at startup or your configured dashboard credentials to sign in.',
                  'Use the Configuration Center in the web UI or CLI `/config` to create or update settings instead of editing config files directly.',
                ],
              },
              {
                title: 'Verify Readiness',
                items: [
                  'Use the Dashboard page to confirm the assistant is running and ready.',
                  'Open `#/config` to verify your AI connection, web access settings, and enabled channels.',
                  'Open Configuration > Integrations > Coding Assistants when you want to confirm whether Guardian can delegate work to Claude Code, Codex, Gemini CLI, or Aider.',
                  'Open Configuration > Appearance when you want to raise the dashboard text size slightly, switch to a more readable font preset, or reduce interface motion.',
                  'Open `#/code` when you want the repo-scoped coding surface, and `#/security` when you want alerts, findings, and security status.',
                  'Use CLI `/providers` or Configuration > AI Providers to confirm the selected provider is reachable.',
                  'Use CLI `/guide` or Telegram `/guide` to pull the same reference content outside the web UI.',
                ],
                note: 'Most configuration changes now appear in the web UI without a manual browser refresh because the dashboard listens for server-sent invalidation events.',
              },
              {
                title: 'Which Page To Use',
                items: [
                  'Use Dashboard for chat, recent runs, and general system status.',
                  'Use Code for repo work, coding sessions, approvals, and workspace activity.',
                  'Use Automations for saved workflows, schedules, output, and run history.',
                  'Use Security for alerts, Assistant Security, threat intel, and security activity.',
                  'Use Configuration for setup, integrations, AI connections, tools, and appearance.',
                ],
              },
            ],
          },
          {
            id: 'github-repo',
            title: 'GitHub Repository',
            summary: 'Use the public repository for technical documentation, security policy, and contribution workflow.',
            sections: [
              {
                title: 'Main Links',
                items: [
                  'Repository: https://github.com/Threat-Vector-Security/guardian-agent',
                  'README: https://github.com/Threat-Vector-Security/guardian-agent/blob/main/README.md',
                  'Security policy: https://github.com/Threat-Vector-Security/guardian-agent/blob/main/SECURITY.md',
                  'Docs and architecture notes: https://github.com/Threat-Vector-Security/guardian-agent/tree/main/docs',
                  'Issues and pull requests: https://github.com/Threat-Vector-Security/guardian-agent/issues',
                ],
              },
              {
                title: 'When To Use GitHub',
                items: [
                  'Use this in-product guide for normal operation and day-to-day workflows.',
                  'Use GitHub when you want implementation details, design specs, security notes, or troubleshooting depth that would clutter the operator guide.',
                  'If you want to contribute, start from the repo README and docs folder, then use issues and pull requests from the repository.',
                ],
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
                  'Conversation memory is scoped per user, channel, and logical assistant. Switching chat mode does not start a separate conversation by itself.',
                  'Web chat now shows a source badge on every assistant reply so you can see whether the answer came from the local lane, external lane, fallback path, or a non-model system response.',
                  'In plain terms: `local` means your local AI path answered, `external` means a hosted AI path answered, and `system` means the reply came from product logic rather than a normal model turn.',
                  'The web `Ask the agent...` field supports multiline drafting. Press `Enter` to send and `Shift+Enter` to add a new line.',
                  'Use the web New Conversation control, CLI `/reset [agentId]`, or Telegram `/reset [agentId]` to clear context.',
                  'Short corrective replies such as `Use Outlook`, `No, Codex the CLI coding assistant`, or `the Guardian workspace` should now be treated as repairs of the active misunderstanding when there is recent context, not as unrelated brand-new tasks.',
                ],
              },
              {
                title: 'Session Management',
                items: [
                  'Use CLI `/session list`, `/session use <sessionId>`, and `/session new` to revisit or branch prior work.',
                  'Assistant state in the dashboard shows queued and running sessions, wait times, execution times, and recent traces.',
                  'Quick actions are available through the web quick-action bar, CLI `/quick <action> <details>`, and Telegram `/quick ...`.',
                  'Built-in quick actions cover email, task planning, calendar planning, and a security review that runs the Assistant Security scan flow.',
                  'Chat can show whether a reply came from the local or hosted model path when that is useful for troubleshooting.',
                  'Guardian chat can work against one focused coding session at a time on each surface. In the web UI, choose the current coding session from the session cards in `#/code`. In CLI, use `/code current`, `/code attach <sessionId-or-match>`, `/code detach`, and `/code create <workspaceRoot> [| title]`.',
                  'You can also ask Guardian to switch, attach, or detach a coding session in normal chat. The explicit controls exist as the operator fallback when you want to verify or override the current focus directly.',
                ],
                note: 'Web chat shows live progress while the assistant is working.',
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
                  'Use `Agent Runtime` when you want the recent job view for assistant work, delegated work, and held results.',
                  'Held delegated results can be replayed, kept held, or dismissed directly from `Agent Runtime`.',
                  'Automations now includes an `Execution Timeline` section that acts as the global operator view for recent assistant, code-session, workflow, and scheduled-task runs.',
                  'Use the execution timeline when you need to reconstruct what the agent did, why a run paused, which tool step failed, or how approvals and verification progressed.',
                  'Routing Trace gives you a quick explanation of how Guardian interpreted a request and where it sent the work.',
                  'Configuration > Tools is where you manage tools and approvals. Security is where you review alerts, posture, and security activity.',
                ],
              },
              {
                title: 'CLI Control Surfaces',
                items: [
                  'Use `/assistant summary`, `/assistant sessions`, `/assistant jobs`, `/assistant traces`, `/assistant routing`, and `/assistant policy` for the same operational visibility in the terminal.',
                  'Use `/assistant jobs all` when you want the raw recent job feed instead of the filtered operator view.',
                  'Use `/assistant jobs followup <jobId> <replay|keep_held|dismiss>` when a delegated result is waiting for operator review.',
                  'Use `/tools` to inspect tool policy and pending approvals, and `/approve` or `/deny` as fallback commands if native prompts are not suitable.',
                  'Use `/mode` to switch between auto, local-only, and external-only routing without changing agent definitions.',
                  'Guardian chat can also explain the CLI command surface in normal language. Ask things like "How do I attach a coding workspace from the CLI?" and it should answer from the built-in command guide, then point you to `/help <command>` for exact syntax.',
                  'Auto mode chooses the best available AI path for the request. If only one AI path is available, Guardian uses it automatically.',
                  'Blocked work such as approvals, clarifications, and workspace switches can be resumed cleanly across the supported operator surfaces.',
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
                  'Configuration > Tools is the main operator surface for tool enablement, approvals, and recent jobs.',
                  'Configuration > Security is where you review or change the main protection settings for browser, shell, and other higher-risk actions.',
                  'Use CLI `/tools` for the same operational visibility when you are working outside the web UI.',
                  'Treat allowed paths, commands, and domains as trust boundaries, not convenience toggles.',
                  'Coding work stays scoped to the active coding session instead of silently widening normal chat access.',
                  'If a protected setting change is interrupted by auth, sign in again and retry the change from the dashboard.',
                ],
              },
              {
                title: 'Approvals',
                items: [
                  'Pending tool actions show up through web approvals, CLI prompts, and Telegram approval flows.',
                  'In web chat and the Coding Workspace, approvals should appear inline on the same blocked response that asked for approval.',
                  'Blocked approval or clarification state should stay durable even if you ask an unrelated question, but unrelated replies should not keep repeating the old blocker UI inline.',
                  'If you click a web approval button and then switch panels, the clicked approval state should persist instead of resetting back to fresh buttons.',
                  'Ordinary clarification answers like `Use Gmail` or `Codex` should stay in normal chat flow and not be mistaken for approval commands.',
                  'Other blockers such as `Use Outlook`, `switch to Test Tactical Game App`, or `connect Google Workspace first` should resume the original request instead of starting a new unrelated one.',
                  'When a coding request is blocked on a workspace switch and the chat is then attached to the required Coding Workspace, Guardian should resume the stored coding request automatically instead of making you repeat it.',
                  'Use the managed package-install path for public package-manager installs when you want Guardian to review the request before it executes.',
                  'Inside code sessions, safe repo-local reads and edits stay low-friction, while repo execution and persistence actions only auto-approve after the workspace trust state reaches `trusted`.',
                  'Explicit trusted memory requests such as `Remember that ...` should normally save directly without a separate approval step. Approval or denial is reserved for tainted, quarantined, or otherwise policy-gated memory mutations.',
                  'Use `/approve [approvalId]` and `/deny [approvalId]` as fallback commands when native approval controls are unavailable.',
                  'Recent approval outcomes stay visible in the product history views so you can verify what was allowed and why.',
                ],
              },
              {
                title: 'Managed Package Installs',
                items: [
                  'Ask the assistant to perform public package-manager installs through the managed path when you want Guardian to review packages before execution.',
                  'Supported v1 forms are explicit registry installs for `npm install`, `pnpm add`, `yarn add`, `bun add`, and `pip install`.',
                  'Guardian rejects command chaining, redirects, local paths, direct URLs, VCS specs, requirements files, and editable installs in this path so the review stays deterministic.',
                  'If the staged review is `caution`, re-run with explicit caution acceptance. If the staged review is `blocked`, the install does not proceed.',
                  'Use the Security page to review package-install alerts under the unified alert feed. The alert source for this feature is `install`.',
                ],
              },
              {
                title: 'Browser Automation',
                items: [
                  'Browser automation is built into Guardian.',
                  'Use the built-in browser actions exposed through chat and automations rather than raw backend integrations.',
                  'Guardian can inspect page state, extract content, follow links, and interact with supported web pages through the managed browser surface.',
                  'Browser navigation only supports HTTP and HTTPS targets, and private hosts are blocked for SSRF protection.',
                  'Use Configuration > Security > Browser Automation > Allowed Domains to add browser hosts manually. An entry such as `httpbin.org` also covers subdomains like `www.httpbin.org`.',
                  'Browser configuration changes can be applied from the dashboard or CLI.',
                  'Third-party browser-like integrations should still be treated carefully and require explicit approval before use.',
                ],
              },
            ],
          },
          {
            id: 'coding-assistant-ide',
            title: 'Coding Workspace',
            summary: 'Use persistent code sessions, Monaco editing, bounded repo review, and session-scoped approvals for repo work.',
            sections: [
              {
                title: 'Start A Code Session',
                items: [
                  'Create a code session either from Guardian chat or from `#/code` by choosing a title plus the workspace root you want Guardian to anchor to.',
                  'Each code session keeps its own coding context, repo state, approvals, recent jobs, and verification history.',
                  'Creating or attaching a code session authorizes repo-local work for that session. It does not widen general non-Code file access.',
                  'Guardian chat is the canonical coding chat in the web UI. CLI and Telegram can also attach to the same code session when you want to continue the work from another surface.',
                  'Treat each chat surface as having one focused coding session at a time. Switch the focused session when you want a different repo to become the default coding target for that surface.',
                  'In the web UI, the Coding Workspace session cards control which coding session is current for Guardian chat. Click a session card to make it current. In CLI, use `/code attach <sessionId-or-match>` and `/code detach` for the same job.',
                  'Guardian chat can also switch, list, inspect, and detach Coding Workspace sessions directly from normal language requests such as "List the coding sessions", "What coding workspace is this chat attached to?", "Switch this chat to the coding workspace for TestApp", and "Detach this chat from the current coding workspace."',
                ],
              },
              {
                title: 'IDE And Session Context',
                items: [
                  'The Coding Workspace page (`#/code`) is a workbench: session rail, explorer, editor and diff view, manual terminal panes, activity, and a code inspector for guided investigation.',
                  'Session context survives refreshes and can be reused from other attached surfaces.',
                  'Guardian chat stays available while you are in the Coding Workspace and follows the currently focused code session.',
                  'When the workbench is opened from a run or trace link, it can open a session for inspection without changing which session is currently attached to Guardian chat.',
                  'The workbench activity rail shows the session timeline for approvals, verification, and recent work.',
                  'Workspace Activity cards now show the same response-source badge treatment as the main chat rail, so delegated coding replies keep their provenance when you inspect them from the workbench.',
                  'Recent session timeline events can also show bounded model-response provenance and context-compaction diagnostics, so you can tell when Guardian had to shrink prompt history or which model path produced the final coding reply.',
                  'Use the Code activity timeline when you want the local story for one coding session. Use Automations > Execution Timeline when you want the global cross-session view.',
                  'Use the inline editor search beside `Inspect` to search within the current file, jump to each match in Monaco, and step forward or backward through repeated hits without opening the full Monaco find widget.',
                  'Manual terminals remain operator-controlled. Assistant actions still stay under approvals and policy rather than taking over a terminal directly.',
                  'Manual terminals are for operator use rather than a substitute for guarded assistant actions.',
                ],
              },
              {
                title: 'External Coding Backends',
                items: [
                  'Configuration > Integrations > Coding Assistants shows the built-in external coding backends Guardian knows how to launch: Claude Code, Codex, Gemini CLI, and Aider.',
                  'That panel is intentionally simple: enable or disable the built-in backends you want available and choose a default when needed.',
                  'Guardian only uses these backends when the user explicitly asks to delegate coding work to an external tool. Direct coding requests should still run through Guardian’s built-in coding tools by default.',
                  'Mentioning Codex or another backend as the subject of a question is not enough to launch it. Questions such as "Why did Codex do this?" should stay in normal explanation or investigation flow unless you explicitly ask Guardian to use that backend.',
                  'Approval copy for delegated coding backends now includes the active coding workspace so you can see which repo Guardian will launch the CLI in before you approve it.',
                  'If a delegated coding request explicitly mentions a different coding workspace than the current attachment, Guardian should stop and ask you to switch instead of silently running the CLI in the wrong repo.',
                ],
              },
              {
                title: 'Code Inspector',
                items: [
                  'Use the `Inspect` button or editor actions in supported TypeScript and JavaScript files to open the code inspector for the selected symbol, current cursor region, or active file section.',
                  'The inspector can stay inline in the Code page or be detached into its own popup window when you want a larger parallel investigation surface while still editing.',
                  'The `Investigate` tab explains what the current code does, what it depends on, which deterministic risks or quality issues stand out, and where to inspect next.',
                  'The `Flow` tab focuses on symbol-level callers, callees, and local execution flow inside the active file or selected large-file section.',
                  'The `Impact` tab shows cross-file blast radius across related files and references.',
                  'Large files are inspected section by section instead of failing outright, so the inspector can anchor analysis to the current cursor or a chosen section without parsing the whole file at once.',
                  'Structure insights update from unsaved edits after a short delay, so the inspector can follow changes before you save.',
                ],
              },
              {
                title: 'Repo Trust And Native AV',
                items: [
                  'New code sessions do not assume a cloned repo is automatically safe. Guardian reviews the workspace and can block or slow down higher-risk actions until you trust it.',
                  'When native host protection is available, Guardian can use those results as part of the workspace trust decision.',
                  'The Code page exposes trust state directly through session badges, activity cards, and warning banners.',
                  'Activity cards and Edit Session explain why a repo was flagged and what to review next.',
                  'The most serious blockers are prioritised at the top of the trust findings.',
                  'Operators can manually trust the current findings from Edit Session. That override is session-scoped, keeps the raw findings visible, and clears automatically if the assessment changes.',
                  'If trust is not cleared, Guardian limits how much repo context it will rely on for autonomous work.',
                  'A `trusted` result means current checks did not find blocking indicators. It is not a guarantee that the repo is safe.',
                ],
              },
              {
                title: 'Coding Approvals',
                items: [
                  'Safe repo-local reads and edits remain low-friction inside the active workspace.',
                  'Execution and persistence actions only auto-approve when the effective workspace trust state is `trusted`.',
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
                  'In Configuration > AI Providers choose the local provider path, then set a profile name and model.',
                  'CLI equivalent: `/config add ollama ollama llama3.2` followed by `/config set default ollama`.',
                  'With approval, Guardian can also inspect configured provider profiles and switch between already-available models through the normal chat/tool path.',
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
                  'In Configuration > AI Providers choose External Providers, then select the service, model, and credentials.',
                  'CLI equivalent: `/config add <name> <provider> <model> <apiKey>`.',
                  'Set the default provider from Configuration > AI Providers or with `/config set default <name>`.',
                ],
              },
              {
                title: 'Built-In Provider Families',
                items: [
                  'Guardian supports both local and hosted AI providers.',
                  'Use a hosted provider when you want higher-quality responses or a fallback path beyond your local model.',
                  'Use the web picker to choose from the built-in supported services.',
                ],
              },
              {
                title: 'Usage Notes',
                items: [
                  'You can choose whether Guardian should prefer local AI, hosted AI, or auto-select between them.',
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
                  'Both paths work the same once configured.',
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
                  'Google Workspace is supported directly inside Guardian for Gmail, Calendar, Drive, Docs, Sheets, and Contacts.',
                  'You do not need a separate Google CLI tool to use the built-in Google Workspace features.',
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
                  'Microsoft 365 is supported directly inside Guardian for Outlook Mail, Calendar, OneDrive, and Contacts.',
                  'You can connect a personal Microsoft account or an organization account that allows the required access.',
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
                  'Automations can run a single tool, multiple workflow steps, a scheduled assistant task, or a manual on-demand assistant automation.',
                  'You can combine read, write, browser, instruction, and delay-style steps in one workflow when the job needs more than a single action.',
                  'The tool picker (Browse button) lets you search tools by name or description and shows integration requirements (e.g. Google Workspace connected, AWS profile configured).',
                  'If a single-tool automation also needs a written summary, the editor can help you expand it into a multi-step workflow.',
                  'The AI selector lets you use auto mode or force a local or hosted model path for the automation.',
                  'Use Edit for normal updates such as names, tools, steps, and schedules without dropping into raw JSON.',
                  'Advanced JSON editing is available for power users, but normal updates should stay in the structured form. Built-in examples must be copied before editing.',
                  'Use the `Use Example` action on built-in starter rows to create a saved automation such as Agent Host Guard or Firewall Sentry, and use `Create Copy` to fork an already-saved automation.',
                  'Use Dry Run before live execution when you want a safe preview path.',
                  'Named automations can also be controlled from chat: Guardian can inspect, run, enable, disable, or delete saved automations.',
                  'If a chat automation request is incomplete, Guardian returns a draft instead of guessing the missing schedule, goal, or steps.',
                ],
              },
              {
                title: 'Ask For The Right Shape',
                items: [
                  'For repeatable monitoring and threshold checks, ask for a deterministic workflow explicitly. Example: `Create a deterministic scheduled automation named "WHM Social Check Disk Quota". Run it daily at 9:00 AM. Do not create an assistant automation. Create a step-based workflow using built-in tools only. Query the WHM Social profile for all accounts with disk used and quota, compute remaining MB, and notify me in the web channel only when any account has 100 MB or less remaining. If no account is near quota, do not send a notification.`',
                  'For recurring open-ended research or briefing work, ask for a scheduled assistant task explicitly. Example: `Create a scheduled assistant automation named "Daily Threat Brief". Run it every weekday at 8:00 AM. Use built-in tools to review saved watchlists, summarize the most important changes, and deliver the report to the web channel.`',
                  'For operator-triggered work that should not run on a timer, ask for a manual assistant automation explicitly. Example: `Create a manual assistant automation named "Investigate New Domain". Do not schedule it. When I run it, inspect the supplied domain with built-in tools, summarize findings, and stop for approval before any outreach or mutation.`',
                  'Be explicit about delivery. Scheduled automations should normally deliver to `web`, `telegram`, or `cli`, or stay `scheduled` with no direct message delivery. Do not use `code-session` as the delivery channel for recurring scheduled runs.',
                ],
                note: 'If you only describe the goal in open-ended language, Guardian may choose an assistant automation. If you want fixed tool steps, say `deterministic`, `step-based workflow`, and `do not create an assistant automation`.',
              },
              {
                title: 'Scheduling And Limits',
                items: [
                  'Any automation can be given a cron schedule and turned into a recurring task, or left manual-only so it runs only when an operator triggers it.',
                  'Use Single shot when you want the task to run once on the next matching schedule and then disable itself automatically.',
                  'Scheduled assistant tasks are best for recurring briefs, watchlists, and open-ended checks that should decide what to inspect at runtime.',
                  'Pre-flight approval check: when scheduling an automation, the system checks whether any tools will require manual approval at runtime. If so, a validation panel shows the issues with one-click "Auto-approve" buttons that set per-tool auto policies. You can also skip the check and accept that each run may need manual approval.',
                  'Scheduled task creation is the approval checkpoint. After the task is saved, later cron runs do not re-prompt for the same action.',
                  'Power-user options remain available through the advanced JSON/config sections when you need direct definition edits.',
                  'Automation settings let you control how large or parallel a run can become.',
                  'Permission policies still restrict what hosts, file paths, and commands an automation can touch.',
                ],
              },
              {
                title: 'Inspect Results',
                items: [
                  'Automations now separates `Output` from `History & Timeline`, so the page no longer mixes raw run output with the chronological execution view in one long panel.',
                  'The `Output` tab leads with a readable run result summary for each recent run, then lets you expand into raw per-step output only when you need it.',
                  'Run history now keeps per-step output, not just status text.',
                  'Saved automations keep enough history for Guardian to review earlier runs later without you having to rerun them.',
                  'Approval-gated automations keep one stable run record and resume after the approval decision instead of starting over from scratch.',
                  'Manual and scheduled automation runs can be expanded in the `Output` tab to inspect captured output.',
                  'The `History & Timeline` tab keeps the compact run ledger together with the `Execution Timeline` view for recent runs across assistant dispatch, coding sessions, automations, and scheduled jobs.',
                  'Use `History & Timeline` when you need to answer "what happened in this run?" and use `Output` when you need the automation-specific result payload, step output, and artifacts.',
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
                  'Built-in scheduled examples are available for recurring intel collection and recurring Assistant Security posture reviews.',
                  'Configuration > Security owns the managed Assistant Security monitoring schedule.',
                ],
              },
              {
                title: 'Threat Intel Operating Notes',
                items: [
                  'Response mode can be manual, assisted, or autonomous depending on your tolerance for automatic action.',
                  'Dark-web scanning is opt-in and disabled by default unless explicitly enabled.',
                  'Use watchlist entries for people, handles, brands, domains, and fraud or impersonation phrases you want monitored over time.',
                  'Treat third-party intel connectors carefully and keep them behind strict approval and access controls.',
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
                  'Conversation memory is persisted when available, with retention settings exposed through configuration.',
                  'The web `Memory` page is the unified operator surface for durable memory: global memory, code-session memory, operator-curated pages, derived indexes, linked outputs, and review-only records.',
                  'Operator-curated memory pages can be created, edited, and archived from the Memory page when durable memory is writable; the runtime keeps those edits in the structured memory store rather than loose files.',
                  'Derived memory pages and hygiene findings are inspectable but remain read-only and refreshable by design.',
                  'Switching between `auto`, `local-only`, and `external-only` changes who answers, but it does not create a separate conversation by itself.',
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
                  'Assistant state shows recent jobs, failures, and what Guardian has been doing recently.',
                  'Security monitoring shows alerts, Assistant Security findings, and recent security activity.',
                ],
              },
              {
                title: 'Audit Workflow',
                items: [
                  'Use Security > Security Log or CLI `/audit`, `/audit summary`, and `/security` to inspect recent events.',
                  'Use the audit views when you need to confirm what happened, what was approved, or why an action was blocked.',
                  'Security Log entries can be expanded when you need more detail than the short preview.',
                  'Policy changes, auth changes, and tool decisions are reflected in the audit history.',
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
                  'Unified local security alerts currently aggregate host monitoring, network baseline and anomaly analysis, gateway firewall monitoring, native Windows Defender alerts, and package-install trust alerts.',
                  'Host persistence alerts are prioritised to reduce noise while keeping higher-risk autoruns prominent.',
                  'Use the Security page when you need posture and evidence. Use the Network page for device inventory and diagnostics, and the Code page when the issue is repo trust inside a coding session.',
                  'Built-in Assistant Security checks can be run from the assistant, automations, and the Security page.',
                  'Assistant Security continuous monitoring runs in the background rather than as a normal chat turn.',
                ],
              },
              {
                title: 'Profiles, Modes, And Containment',
                items: [
                  'Deployment profiles (`personal`, `home`, `organization`) are separate from operating modes (`monitor`, `guarded`, `lockdown`, `ir_assist`).',
                  'Monitor is the normal default. Posture can recommend escalation, and containment can temporarily auto-elevate to `guarded` when elevated alerts stack together.',
                  'Configuration > Security lets you tune how conservative Assistant Security should be before it tightens controls automatically.',
                  'Containment remains bounded and policy-driven. The shipped system does not fully auto-remediate or silently take over the host.',
                ],
              },
              {
                title: 'Native Host Protection',
                items: [
                  'Windows Defender is integrated as a native provider. Guardian can refresh status, show alerts, request scans, and request signature updates from the Security page.',
                  'Code sessions can use native AV results as part of repo trust and blocking decisions.',
                  'Managed package installs can also use native AV results and may block before install if a detection is found.',
                  'On Unix-like hosts, available native AV results can also inform code-session trust, but a clean scan does not override other suspicious repo findings.',
                ],
              },
              {
                title: 'Agentic Triage',
                items: [
                  'Guardian includes a conservative automated triage path for selected security events.',
                  'That triage path gathers evidence first, avoids noisy repeats, and records completed investigations in activity history.',
                  'It does not automatically acknowledge alerts or launch mutating host actions just because an alert fired.',
                ],
              },
              {
                title: 'Third-Party Connectors',
                items: [
                  'Third-party connector servers require explicit approval before Guardian will launch them.',
                  'Guardian keeps third-party connector access under tighter restrictions than built-in capabilities by default.',
                  'Assistant Security can surface connector exposure separately so operators can watch for added risk over time.',
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
                  'If the web dashboard rejects you, confirm whether Web Authentication is set to bearer_required and then check the bearer token or session cookie state.',
                  'If a dashboard save or browser-config action drops you back to the auth prompt, the secure web session expired. Re-enter the current dashboard token and retry the change.',
                  'If a model appears offline, verify connectivity in Configuration > AI Providers or with CLI `/providers`.',
                  'If file or command execution is blocked, review Configuration > Tools and Configuration > Security before retrying.',
                  'If repo execution is blocked in the Code page, inspect the code session workspace trust badge, native AV summary, approvals tab, and recent jobs before assuming the coding tools are broken.',
                  'If network data looks stale, use the Network History tab and recent outputs to confirm whether the scan actually ran.',
                ],
              },
              {
                title: 'Security Defaults',
                items: [
                  'Guardian blocks prompt injection patterns, secret leakage, and risky tool actions by default.',
                  'New code sessions authorize the workspace path for repo-local access, but they do not treat the attached repo as automatically safe for execution.',
                  'Web Authentication can be disabled on trusted networks, but bearer_required remains the safer default for the dashboard.',
                  'Rotate web auth credentials from the web Config Center or with CLI `/auth rotate`; toggle bearer protection from CLI with `/auth enable` or `/auth disable`.',
                  'Security alerts stay focused on the higher-signal detections by default.',
                  'Use audit and policy views to understand why an action was denied instead of loosening controls blindly.',
                  'Outbound network tools are restricted to reduce private-host and metadata-service access risks.',
                  'Third-party connector servers should be treated with the same scrutiny as shell, browser, and network tooling when you decide whether to enable them.',
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
