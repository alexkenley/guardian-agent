export interface CliHelpTopic {
  aliases: string[];
  title: string;
  summary: string;
  usage: string[];
  examples?: string[];
  notes?: string[];
}

export const CLI_HELP_TOPICS: readonly CliHelpTopic[] = [
  {
    aliases: ['help'],
    title: '/help',
    summary: 'Show the top-level command list or detailed help for one command.',
    usage: [
      '/help',
      '/help <command>',
    ],
    examples: [
      '/help models',
      '/help tools',
      '/help /mode',
    ],
    notes: [
      'You can pass a command name with or without the leading slash.',
      'Use /guide when you want broader operator docs instead of command syntax.',
    ],
  },
  {
    aliases: ['chat'],
    title: '/chat',
    summary: 'Show the current active chat agent or switch to a specific chat-capable agent.',
    usage: [
      '/chat',
      '/chat <agentId>',
    ],
    examples: [
      '/chat agent-1',
    ],
    notes: [
      'Managed internal tier-routing agents cannot be selected directly here; use /mode for that.',
      'Plain text without a leading slash is sent to the current active agent.',
    ],
  },
  {
    aliases: ['code'],
    title: '/code',
    summary: 'List, create, attach, detach, and inspect the current coding session for this CLI surface.',
    usage: [
      '/code',
      '/code list',
      '/code current',
      '/code create <workspaceRoot> [| title]',
      '/code attach <sessionId-or-match>',
      '/code detach',
    ],
    examples: [
      '/code list',
      '/code current',
      '/code create /mnt/s/development/testapp | TestApp',
      '/code attach testapp',
      '/code detach',
    ],
    notes: [
      'The CLI keeps one focused coding session at a time for implicit repo work.',
      'Attach can resolve a unique session by exact id, title, or workspace match.',
      'Natural-language chat can also ask Guardian to switch or detach on the fly; /code is the explicit fallback control.',
    ],
  },
  {
    aliases: ['coding-backends', 'codingbackends'],
    title: '/coding-backends',
    summary: 'Inspect and manage configured external coding CLI backends such as Claude Code, Codex, Gemini CLI, and Aider.',
    usage: [
      '/coding-backends',
      '/coding-backends list',
      '/coding-backends status [sessionId]',
      '/coding-backends enable <backendId>',
      '/coding-backends disable <backendId>',
      '/coding-backends default <backendId>',
      '/coding-backends add <backendId>',
      '/coding-backends remove <backendId>',
    ],
    examples: [
      '/coding-backends',
      '/coding-backends add claude-code',
      '/coding-backends default codex',
      '/coding-backends status',
    ],
    notes: [
      'add enables a known preset when it is available but not yet configured.',
      'Runtime session status is only available when the web channel has initialized coding-backend orchestration.',
    ],
  },
  {
    aliases: ['mode'],
    title: '/mode',
    summary: 'Control whether chat routes automatically, locally, through managed cloud, or through frontier providers.',
    usage: [
      '/mode',
      '/mode auto',
      '/mode local',
      '/mode managed-cloud',
      '/mode frontier',
    ],
    examples: [
      '/mode local',
      '/mode managed-cloud',
      '/mode auto',
    ],
    notes: [
      'auto uses Guardian routing logic; local, managed-cloud, and frontier force the tier.',
      'Switching back to auto clears any explicit tier pin so routing can decide again.',
    ],
  },
  {
    aliases: ['approve', 'deny'],
    title: '/approve and /deny',
    summary: 'Fallback chat commands for approvals when you are given an approval ID.',
    usage: [
      '/approve <approvalId> [approvalId ...]',
      '/deny <approvalId> [approvalId ...]',
    ],
    examples: [
      '/approve 123e4567-e89b-12d3-a456-426614174000',
      '/deny 123e4567-e89b-12d3-a456-426614174000',
    ],
    notes: [
      'These are routed through normal chat dispatch for chat-level approval flows.',
      'Use /tools approve or /tools deny when you are working from the tool-runtime approval table.',
    ],
  },
  {
    aliases: ['agents'],
    title: '/agents',
    summary: 'List registered agents and their basic state, provider, and capabilities.',
    usage: [
      '/agents',
    ],
  },
  {
    aliases: ['agent'],
    title: '/agent',
    summary: 'Show details for one agent, including state, provider, activity, and resource limits.',
    usage: [
      '/agent <id>',
    ],
    examples: [
      '/agent agent-1',
    ],
  },
  {
    aliases: ['status'],
    title: '/status',
    summary: 'Show a runtime overview including providers, agents, and Guardian status.',
    usage: [
      '/status',
    ],
  },
  {
    aliases: ['providers'],
    title: '/providers',
    summary: 'Check configured provider connectivity and show model discovery results when available.',
    usage: [
      '/providers',
    ],
    notes: [
      'This is a provider connectivity check, not a guaranteed end-to-end inference test.',
      'For local Ollama models, use ollama run <model> "hello" to prove the selected model can actually initialize.',
    ],
  },
  {
    aliases: ['budget'],
    title: '/budget',
    summary: 'Show per-agent rate and concurrency usage plus any recent overruns.',
    usage: [
      '/budget',
    ],
  },
  {
    aliases: ['watchdog'],
    title: '/watchdog',
    summary: 'Inspect watchdog health checks for stalls, retries, and agent health signals.',
    usage: [
      '/watchdog',
    ],
  },
  {
    aliases: ['assistant'],
    title: '/assistant',
    summary: 'Inspect the assistant control plane: sessions, jobs, traces, and policy decisions.',
    usage: [
      '/assistant',
      '/assistant summary',
      '/assistant sessions [limit]',
      '/assistant jobs [limit|all]',
      '/assistant policy [limit]',
      '/assistant traces [limit]',
      '/assistant routing [limit]',
    ],
    examples: [
      '/assistant traces 20',
      '/assistant traces continuity=shared-tier:owner exec=code_session:Repo Fix',
      '/assistant routing 20 continuity=shared-tier:owner',
      '/assistant jobs 10',
      '/assistant jobs all',
    ],
    notes: [
      'traces shows in-memory assistant dispatch traces; routing shows the durable intent-routing decision log.',
      'Both traces and routing accept continuity=<key> and exec=<ref> filters.',
      'jobs defaults to the operator-relevant recent view; use `all` to inspect the raw recent job feed including routine background delegated work.',
    ],
  },
  {
    aliases: ['config'],
    title: '/config',
    summary: 'View and update runtime configuration from the CLI.',
    usage: [
      '/config',
      '/config provider <name>',
      '/config telegram status|on|off|token|chatids ...',
      '/config set <provider> model|baseUrl|apiKey|credentialRef <value>',
      '/config add <name> <type> <model> [apiKey]',
      '/config test [provider]',
    ],
    examples: [
      '/config provider ollama',
      '/config set ollama model llama3.3',
      '/config add myollama ollama mistral',
    ],
    notes: [
      'The CLI add path currently accepts provider types: ollama, anthropic, and openai.',
      'Use /config telegram ... to manage the Telegram channel from the terminal.',
      'The primary provider is derived automatically from the routed provider defaults, so there is no separate global default command.',
    ],
  },
  {
    aliases: ['auth'],
    title: '/auth',
    summary: 'Inspect, enable, disable, or rotate the web auth token used by the dashboard.',
    usage: [
      '/auth status',
      '/auth enable',
      '/auth disable',
      '/auth rotate',
      '/auth reveal',
    ],
    notes: [
      'enable switches Web Authentication back to bearer_required mode.',
      'disable opens the dashboard without a bearer token and should only be used on trusted networks.',
      'rotate generates a new token when that callback is available.',
      'reveal prints the active token if one is configured.',
    ],
  },
  {
    aliases: ['tools'],
    title: '/tools',
    summary: 'Inspect the tool runtime, run tools manually, and manage tool policy or approvals.',
    usage: [
      '/tools list',
      '/tools run <tool> [jsonArgs]',
      '/tools approvals [pending]',
      '/tools approve <approvalId>',
      '/tools deny <approvalId> [reason]',
      '/tools jobs',
      '/tools policy',
      '/tools policy mode <approve_each|approve_by_policy|autonomous>',
      '/tools policy paths <comma,separated,paths>',
      '/tools policy commands <comma,separated,prefixes>',
      '/tools policy domains <comma,separated,domains>',
      '/tools browser',
      '/tools browser enable|disable',
      '/tools browser domains <comma,separated,domains>',
      '/tools categories',
      '/tools categories enable|disable <category>',
    ],
    examples: [
      '/tools run fs_list {"path":"docs"}',
      '/tools policy commands git,npm,node',
      '/tools approvals pending',
    ],
    notes: [
      'jsonArgs must be a valid JSON object when supplied.',
      'policy commands expects command prefixes, not full shell snippets.',
      'Use /tools for the tool-runtime control plane; use /approve and /deny for chat-level approval flows.',
    ],
  },
  {
    aliases: ['skills'],
    title: '/skills',
    summary: 'List loaded skills, inspect one skill, or enable and disable skills at runtime.',
    usage: [
      '/skills list',
      '/skills show <skillId>',
      '/skills enable <skillId>',
      '/skills disable <skillId>',
    ],
    examples: [
      '/skills show github',
    ],
  },
  {
    aliases: ['campaign'],
    title: '/campaign',
    summary: 'Run campaign/contact workflow shortcuts from the CLI.',
    usage: [
      '/campaign help',
      '/campaign discover <url> [tagsCsv]',
      '/campaign import <csvPath> [source]',
      '/campaign contacts [limit] [query]',
      '/campaign create <name> | <subjectTemplate> | <bodyTemplate>',
      '/campaign add <campaignId> <contactId[,contactId...]>',
      '/campaign list [limit]',
      '/campaign preview <campaignId> [limit]',
      '/campaign run <campaignId> [maxRecipients]',
    ],
    examples: [
      '/campaign discover https://example.com security,saas',
      '/campaign create April Outreach | Intro for {{name}} | Hi {{name}}, ...',
    ],
    notes: [
      'The create command uses pipe separators to split name, subject, and body.',
      'campaign run is approval-gated before email is sent.',
    ],
  },
  {
    aliases: ['connectors'],
    title: '/connectors',
    summary: 'Operate the connector framework: status, packs, and runtime settings.',
    usage: [
      '/connectors status',
      '/connectors packs',
      '/connectors settings ...',
      '/connectors pack upsert <json>',
      '/connectors pack delete <packId>',
      '/connectors settings enable|disable',
      '/connectors settings mode <plan_then_execute|direct_execute>',
      '/connectors settings limit <number>',
      '/connectors settings playbooks <on|off>',
      '/connectors settings playbooks enabled <on|off>',
      '/connectors settings playbooks max-steps <number>',
      '/connectors settings playbooks max-parallel <number>',
      '/connectors settings playbooks timeout-ms <milliseconds>',
      '/connectors settings playbooks require-signed <on|off>',
      '/connectors settings playbooks require-dryrun <on|off>',
      '/connectors settings studio enabled <on|off>',
      '/connectors settings studio mode <read_only|builder>',
      '/connectors settings studio ticket <on|off>',
      '/connectors settings json <json>',
    ],
    examples: [
      '/connectors status',
      '/connectors settings studio mode builder',
      '/connectors settings json {"playbooks":{"maxSteps":20}}',
    ],
  },
  {
    aliases: ['automations'],
    title: '/automations',
    summary: 'List automations, inspect recent runs, run one, or save/delete a definition.',
    usage: [
      '/automations list',
      '/automations runs',
      '/automations run <automationId> [--dry-run]',
      '/automations save <json>',
      '/automations delete <automationId>',
    ],
    examples: [
      '/automations run browser-read-smoke --dry-run',
    ],
    notes: [
      'run returns the created run id and any pending approval ids for steps that need approval.',
    ],
  },
  {
    aliases: ['audit'],
    title: '/audit',
    summary: 'Inspect audit history or summary counts for recent runtime events.',
    usage: [
      '/audit [limit]',
      '/audit filter <field> <value>',
      '/audit summary [windowMs]',
    ],
    examples: [
      '/audit 20',
      '/audit filter type secret_detected',
      '/audit summary 300000',
    ],
  },
  {
    aliases: ['security'],
    title: '/security',
    summary: 'Show a combined security overview including Guardian posture and audit metrics.',
    usage: [
      '/security',
    ],
  },
  {
    aliases: ['policy'],
    title: '/policy',
    summary: 'Inspect or change the policy engine mode and rule state.',
    usage: [
      '/policy',
      '/policy mode <off|shadow|enforce>',
      '/policy reload',
    ],
    notes: [
      'shadow compares policy-engine decisions with legacy behavior without enforcing them.',
      'enforce makes the policy-engine result authoritative.',
    ],
  },
  {
    aliases: ['intel'],
    title: '/intel',
    summary: 'Operate the threat-intel workflow: watchlist, scans, findings, actions, and response mode.',
    usage: [
      '/intel status',
      '/intel plan',
      '/intel watch [list|add|remove] <target>',
      '/intel scan [query] [--darkweb] [--sources=a,b]',
      '/intel findings [limit] [status]',
      '/intel finding <findingId> status <new|triaged|actioned|dismissed>',
      '/intel actions [limit]',
      '/intel action draft <findingId> <report|takedown|response>',
      '/intel mode <manual|assisted|autonomous>',
    ],
    examples: [
      '/intel scan leaked password --sources=social,forum',
      '/intel watch add example.com',
    ],
  },
  {
    aliases: ['models'],
    title: '/models',
    summary: 'List models for one or more providers and optionally switch the configured model interactively.',
    usage: [
      '/models',
      '/models <provider>',
      '/config set <provider> model <model>',
    ],
    examples: [
      '/models ollama',
      '/config set ollama model gpt-oss:120b',
    ],
    notes: [
      'Selecting a model here updates Guardian config only. The provider still has to be able to load that model.',
      'For local Ollama models, validate the selected tag with ollama run <model> "hello".',
      'If /models lets you pick a model but the next prompt fails with an Ollama 500, the model artifact or Ollama build is the problem, not the CLI switch itself.',
    ],
  },
  {
    aliases: ['reset'],
    title: '/reset',
    summary: 'Clear conversation state for an agent and start fresh without removing the agent itself.',
    usage: [
      '/reset [agentId]',
    ],
    notes: [
      'Use /session new if you want a fresh stored session in the session system.',
    ],
  },
  {
    aliases: ['factory-reset', 'factoryreset'],
    title: '/factory-reset',
    summary: 'Destructive reset for stored data, config, or both.',
    usage: [
      '/factory-reset data',
      '/factory-reset config',
      '/factory-reset all',
    ],
    notes: [
      'Use this carefully. data and config target different persisted state; all does both.',
    ],
  },
  {
    aliases: ['session'],
    title: '/session',
    summary: 'List stored chat sessions, switch to one, or create a fresh session.',
    usage: [
      '/session list [agentId]',
      '/session use <sessionId> [agentId]',
      '/session new [agentId]',
    ],
    examples: [
      '/session list',
      '/session use abc123 agent-1',
    ],
  },
  {
    aliases: ['quick'],
    title: '/quick',
    summary: 'Run a quick action workflow without writing a long prompt.',
    usage: [
      '/quick <action> <details>',
    ],
    examples: [
      '/quick task Draft the follow-up checklist for the outage review',
      '/quick security Review the current runtime and workspace for MCP and sandbox exposure',
    ],
  },
  {
    aliases: ['analytics'],
    title: '/analytics',
    summary: 'Show recent interaction analytics for the selected time window.',
    usage: [
      '/analytics [minutes]',
    ],
    examples: [
      '/analytics 180',
    ],
  },
  {
    aliases: ['guide'],
    title: '/guide',
    summary: 'Show the shared operator reference guide for workflows beyond one command.',
    usage: [
      '/guide',
    ],
    notes: [
      'Use this when you need the broader operating model; use /help <command> when you need syntax and examples for a CLI command.',
    ],
  },
  {
    aliases: ['google'],
    title: '/google',
    summary: 'Inspect or start native Google Workspace OAuth from the CLI.',
    usage: [
      '/google status',
      '/google login',
    ],
    notes: [
      'login starts Guardian-owned Google OAuth and prints the browser consent URL.',
    ],
  },
  {
    aliases: ['version'],
    title: '/version',
    summary: 'Show the running Guardian Agent version.',
    usage: [
      '/version',
    ],
  },
  {
    aliases: ['diag'],
    title: '/diag',
    summary: 'Run system diagnostics and print startup/config related checks.',
    usage: [
      '/diag',
    ],
  },
  {
    aliases: ['clear'],
    title: '/clear',
    summary: 'Clear the terminal screen.',
    usage: [
      '/clear',
    ],
    notes: [
      'This only clears the visible terminal display. It does not reset chat context or sessions.',
    ],
  },
  {
    aliases: ['kill', 'killswitch', 'quit', 'exit', 'close', 'shutdown'],
    title: '/kill and exit aliases',
    summary: 'Shut down services and exit the CLI.',
    usage: [
      '/kill',
      '/quit',
      '/exit',
      '/close',
      '/shutdown',
    ],
    notes: [
      'All of these route to the same kill-switch behavior.',
    ],
  },
];

export function findCliHelpTopic(topic: string): CliHelpTopic | undefined {
  const normalized = topic.replace(/^\/+/, '').trim().toLowerCase();
  return CLI_HELP_TOPICS.find((entry) => entry.aliases.includes(normalized));
}

export function formatCliCommandGuideForPrompt(
  topics: readonly CliHelpTopic[] = CLI_HELP_TOPICS,
): string {
  return [
    'Use this Guardian CLI slash-command guide only when the user asks how to operate Guardian from the terminal.',
    'Do not invent commands or subcommands that are not listed here.',
    ...topics.map((topic) => `- ${topic.title}: ${topic.summary}`),
    'When the user needs exact syntax or examples, point them to /help <command>.',
    'When the user needs the broader operator workflow, point them to /guide.',
  ].join('\n');
}
