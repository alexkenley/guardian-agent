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
    title: 'GuardianAgent Reference Guide',
    intro: 'How to use your assistant, configure LLMs, and connect channels.',
    sections: [
      {
        title: 'Quick Start',
        items: [
          'Run: npx guardianagent',
          'Complete first-run setup in web Setup tab or CLI /setup (config is created/updated automatically)',
          'Open web dashboard at http://localhost:3000 (if web channel enabled)',
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
        title: 'Connect Ollama (Local)',
        items: [
          'Install and run Ollama locally',
          'Pull a model first, for example: ollama pull llama3.2',
          'Run setup: choose Local Ollama, provider name, and model in web Setup or CLI /setup',
          'Use CLI /providers or web Config to verify connectivity',
        ],
      },
      {
        title: 'Connect OpenAI or Anthropic',
        items: [
          'Run setup: choose External API and select openai or anthropic',
          'Enter API key and model in web Setup or CLI /setup',
          'Switch default provider via CLI /config set default <name> or web Config page',
          'Optional advanced path: use CLI /config add and /config set for provider fine-tuning',
        ],
      },
      {
        title: 'Connect Telegram',
        items: [
          'Create a bot via @BotFather and get BOT_TOKEN',
          'Enable Telegram in web Setup or CLI /setup and paste the bot token',
          'Set allowed chat IDs during setup to restrict access',
          'Check setup status in web Setup tab or CLI /setup status',
          'Useful commands in Telegram: /help, /guide, /reset [agentId], /quick <action> <details>',
        ],
      },
      {
        title: 'Identity & Memory',
        items: [
          "Identity mode 'single_user' shares one assistant identity across web/CLI/Telegram",
          "Identity mode 'channel_user' keeps identities separate unless alias-mapped",
          'Conversation memory is persisted in SQLite with retention policy controls',
          'Use setup/config to adjust retention and default identity',
        ],
      },
      {
        title: 'Analytics',
        items: [
          'Assistant interactions are logged to SQLite analytics storage',
          'View analytics in web Monitoring or CLI /analytics [minutes]',
          'Track command usage, message errors, quick actions, setup/config outcomes',
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
        title: 'Security And Troubleshooting',
        items: [
          'Guardian blocks prompt-injection and secret leaks by default',
          'Review events in web Security tab or CLI /audit /security',
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
