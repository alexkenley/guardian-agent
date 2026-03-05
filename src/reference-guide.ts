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
          'Create a bot via @BotFather and get BOT_TOKEN',
          'Enable Telegram in web Config Center and paste the bot token',
          'Set allowed chat IDs in Config Center to restrict access',
          'Restart after Telegram channel structural changes (enable/disable/token updates)',
          'Useful commands in Telegram: /help, /guide, /reset [agentId], /quick <action> <details>',
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
        title: 'Scheduled Tasks & Operations',
        items: [
          'Operations page manages recurring scheduled tasks — tools or playbooks run on cron intervals',
          'Built-in presets are auto-installed on first run, including Network Watch, Network Anomaly Guard, Network Threat Summary, Network Baseline Status, Traffic Threat Check, WiFi Scan, Network Fingerprint Scan, System Health, Full Network Discovery, Resource Monitor, Process Watch, Service Check, Connection Audit, DNS Health Check, Gateway Ping, Localhost Port Scan, Threat Intel Scan, Knowledge Base Check, and Daily System Report',
          'Cron format: minute hour day month weekday. Examples: */15 * * * * (every 15 min), 0 * * * * (every hour), 0 0 * * * (daily midnight), 0 6 * * * (daily 6 AM)',
          'Each task can target a tool (e.g. net_arp_scan, net_threat_check, net_fingerprint, sys_resources) or a playbook (e.g. home-network)',
          'Manual run: click Run on any task to execute immediately outside the cron schedule',
          'Enable/Disable: pause a schedule without deleting it; disabled tasks keep their configuration and history',
          'Optional event emission: tasks can emit named events on completion for other agents to subscribe to',
          'Run history shows recent executions with status, duration, and messages',
          'CLI equivalent: scheduled tasks are managed via the web Operations page or the API',
        ],
      },
      {
        title: 'Network Connectors & Playbooks',
        items: [
          'Three built-in connector packs are auto-installed on first run: Home Network, System Monitor, Security Audit',
          'Each pack bundles a connector configuration with pre-configured multi-step playbooks',
          'Home Network pack: Network Discovery (interfaces, ARP, gateway ping, DNS) and Full Infrastructure Audit playbooks',
          'System Monitor pack: System Health Check playbook (OS info, resources, processes, services)',
          'Security Audit pack: Security Scan playbook (connections, processes, localhost port scan)',
          'Devices tab shows discovered network devices with IP, MAC, hostname, vendor/type classification, trust status, and open ports',
          'Threats tab shows baseline status, active network alerts, and acknowledgement workflow',
          'Click Scan Now on the Devices tab to run an immediate ARP network scan',
          'Run or Dry Run any playbook from the Connectors tab to execute its steps',
          'Advanced Settings: configure execution mode, step limits, timeouts, and pack/playbook JSON editing',
          'Playbook/tool results feed into device inventory and active network threat analysis automatically',
        ],
      },
      {
        title: 'Security And Troubleshooting',
        items: [
          'Guardian blocks prompt-injection and secret leaks by default',
          'Web dashboard supports configurable auth modes (bearer_required, localhost_no_auth, disabled)',
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
