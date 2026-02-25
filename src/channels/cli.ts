/**
 * CLI channel adapter.
 *
 * Interactive readline prompt with full dashboard parity.
 * Commands: /chat, /agents, /agent, /status, /providers, /budget, /watchdog,
 * /config, /audit, /security, /models, /intel, /clear, /help, /quit, /exit.
 *
 * Accepts the same DashboardCallbacks interface as the web channel for
 * instant feature parity with zero duplication.
 */

import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ChannelAdapter, MessageCallback } from './types.js';
import type { DashboardCallbacks } from './web-types.js';
import { createLogger } from '../util/logging.js';
import { formatGuideForCLI } from '../reference-guide.js';
import type { SetupApplyInput } from '../runtime/setup.js';
import { parseAllowedChatIds } from '../runtime/setup.js';

const log = createLogger('channel:cli');

/** Info returned by the legacy /agents callback. */
export interface AgentInfo {
  id: string;
  name: string;
  state: string;
  capabilities: readonly string[];
}

/** Info returned by the legacy /status callback. */
export interface RuntimeStatus {
  running: boolean;
  agentCount: number;
  guardianEnabled: boolean;
  providers: string[];
}

export interface CLIChannelOptions {
  /** Default agent to route messages to. */
  defaultAgent?: string;
  /** Custom prompt string. */
  prompt?: string;
  /** Input stream (for testing). */
  input?: NodeJS.ReadableStream;
  /** Output stream (for testing). */
  output?: NodeJS.WritableStream;
  /** Legacy callback to list registered agents. */
  onAgents?: () => AgentInfo[];
  /** Legacy callback to get runtime status. */
  onStatus?: () => RuntimeStatus;
  /** Dashboard callbacks — provides full feature parity with web UI. */
  dashboard?: DashboardCallbacks;
  /** Canonical user identity for CLI channel. */
  defaultUserId?: string;
}

export class CLIChannel implements ChannelAdapter {
  readonly name = 'cli';
  private rl: Interface | null = null;
  private onMessage: MessageCallback | null = null;
  private prompt: string;
  private input: NodeJS.ReadableStream;
  private output: NodeJS.WritableStream;
  private onAgents?: () => AgentInfo[];
  private onStatus?: () => RuntimeStatus;
  private dashboard?: DashboardCallbacks;
  private activeAgentId: string | undefined;
  private defaultAgentId: string | undefined;
  private defaultUserId: string;
  private useColor: boolean;

  constructor(options: CLIChannelOptions = {}) {
    this.prompt = options.prompt ?? 'you> ';
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.onAgents = options.onAgents;
    this.onStatus = options.onStatus;
    this.dashboard = options.dashboard;
    this.defaultAgentId = options.defaultAgent;
    this.defaultUserId = options.defaultUserId ?? 'owner';
    this.useColor = !!(this.output as NodeJS.WriteStream).isTTY;
  }

  async start(onMessage: MessageCallback): Promise<void> {
    this.onMessage = onMessage;

    this.rl = createInterface({
      input: this.input,
      output: this.output,
      prompt: this.prompt,
    });

    this.write('\nGuardianAgent CLI — Type a message or /help for commands.\n\n');
    this.rl.prompt();
    this.maybeRunFirstTimeSetup().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.write(`\n${this.yellow('[setup]')} ${msg}\n\n`);
      this.rl?.prompt();
    });

    this.rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      // Handle commands
      if (trimmed.startsWith('/')) {
        await this.handleCommand(trimmed);
        this.rl?.prompt();
        return;
      }

      // Send message to agent
      await this.handleUserMessage(trimmed);
      this.rl?.prompt();
    });

    this.rl.on('close', () => {
      this.write('\nGoodbye!\n');
    });

    log.info('CLI channel started');
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.onMessage = null;
    log.info('CLI channel stopped');
  }

  async send(_userId: string, text: string): Promise<void> {
    this.write(`\nassistant> ${text}\n\n`);
    this.rl?.prompt();
  }

  // ─── Message handling ────────────────────────────────────────

  private async handleUserMessage(text: string): Promise<void> {
    const agentIdForEvent = this.activeAgentId ?? this.defaultAgentId;
    this.trackAnalytics({
      type: 'message_sent',
      channel: 'cli',
      canonicalUserId: this.defaultUserId,
      channelUserId: 'cli',
      agentId: agentIdForEvent,
    });

    // If active agent is set and dashboard dispatch is available, use it
    if (this.activeAgentId && this.dashboard?.onDispatch) {
      try {
        const response = await this.dashboard.onDispatch(this.activeAgentId, {
          content: text,
          userId: this.defaultUserId,
          channel: 'cli',
        });
        this.trackAnalytics({
          type: 'message_success',
          channel: 'cli',
          canonicalUserId: this.defaultUserId,
          channelUserId: 'cli',
          agentId: this.activeAgentId,
        });
        this.write(`\nassistant> ${response.content}\n\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.trackAnalytics({
          type: 'message_error',
          channel: 'cli',
          canonicalUserId: this.defaultUserId,
          channelUserId: 'cli',
          agentId: this.activeAgentId,
          metadata: { error: msg },
        });
        this.write(`\n${this.red('[error]')} ${msg}\n\n`);
      }
      return;
    }

    // Default: send via onMessage callback
    if (!this.onMessage) return;

    try {
      const response = await this.onMessage({
        id: randomUUID(),
        userId: this.defaultUserId,
        channel: 'cli',
        content: text,
        timestamp: Date.now(),
      });
      this.trackAnalytics({
        type: 'message_success',
        channel: 'cli',
        canonicalUserId: this.defaultUserId,
        channelUserId: 'cli',
        agentId: agentIdForEvent,
      });
      this.write(`\nassistant> ${response.content}\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.trackAnalytics({
        type: 'message_error',
        channel: 'cli',
        canonicalUserId: this.defaultUserId,
        channelUserId: 'cli',
        agentId: agentIdForEvent,
        metadata: { error: msg },
      });
      this.write(`\n${this.red('[error]')} ${msg}\n\n`);
    }
  }

  // ─── Command dispatch ────────────────────────────────────────

  private async handleCommand(commandLine: string): Promise<void> {
    const parts = commandLine.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    this.trackAnalytics({
      type: 'command_used',
      channel: 'cli',
      canonicalUserId: this.defaultUserId,
      channelUserId: 'cli',
      agentId: this.activeAgentId ?? this.defaultAgentId,
      metadata: { command: cmd },
    });

    switch (cmd) {
      case 'help':
        this.handleHelp();
        break;
      case 'chat':
        await this.handleChat(args);
        break;
      case 'agents':
        this.handleAgents();
        break;
      case 'agent':
        this.handleAgentDetail(args);
        break;
      case 'status':
        this.handleStatus();
        break;
      case 'providers':
        await this.handleProviders();
        break;
      case 'budget':
        this.handleBudget();
        break;
      case 'watchdog':
        this.handleWatchdog();
        break;
      case 'config':
        await this.handleConfig(args);
        break;
      case 'audit':
        this.handleAudit(args);
        break;
      case 'security':
        this.handleSecurity();
        break;
      case 'models':
        await this.handleModels(args);
        break;
      case 'reset':
        await this.handleReset(args);
        break;
      case 'guide':
        this.handleGuide();
        break;
      case 'setup':
        await this.handleSetup(args);
        break;
      case 'session':
        await this.handleSession(args);
        break;
      case 'quick':
        await this.handleQuick(args);
        break;
      case 'analytics':
        this.handleAnalytics(args);
        break;
      case 'intel':
        await this.handleIntel(args);
        break;
      case 'clear':
        this.handleClear();
        break;
      case 'quit':
      case 'exit':
        this.write('\nShutting down...\n');
        this.rl?.close();
        break;
      default:
        this.write(`\nUnknown command: /${cmd}. Try /help\n\n`);
    }
  }

  // ─── /help ───────────────────────────────────────────────────

  private handleHelp(): void {
    this.write('\n');
    this.write(this.bold('Chat\n'));
    this.write('  /chat [agentId]                        Switch active agent or show current\n');
    this.write('  <text>                                 Send message to active agent\n');
    this.write('\n');
    this.write(this.bold('Status & Monitoring\n'));
    this.write('  /status                                Runtime status overview\n');
    this.write('  /agents                                List all agents\n');
    this.write('  /agent <id>                            Detailed agent info\n');
    this.write('  /providers                             Provider connectivity check\n');
    this.write('  /budget                                Per-agent resource usage\n');
    this.write('  /watchdog                              Watchdog check results\n');
    this.write('\n');
    this.write(this.bold('Configuration\n'));
    this.write('  /config                                View full config (redacted)\n');
    this.write('  /config provider <name>                View specific provider\n');
    this.write('  /config set default <provider>         Change default provider\n');
    this.write('  /config set <provider> <field> <value> Edit provider field\n');
    this.write('  /config add <name> <type> <model> [apiKey]  Add provider\n');
    this.write('  /config test [provider]                Test provider connectivity\n');
    this.write('\n');
    this.write(this.bold('Security & Audit\n'));
    this.write('  /audit [limit]                         Recent audit events\n');
    this.write('  /audit filter <field> <value>          Filter events\n');
    this.write('  /audit summary [windowMs]              Audit stats summary\n');
    this.write('  /security                              Security overview\n');
    this.write('\n');
    this.write(this.bold('Threat Intel\n'));
    this.write('  /intel [status]                        Threat-intel summary\n');
    this.write('  /intel watch [list|add|remove] ...     Manage watchlist targets\n');
    this.write('  /intel scan [query] [--darkweb]        Run intel scan\n');
    this.write('  /intel findings [limit] [status]       List findings\n');
    this.write('  /intel finding <id> status <status>    Update finding status\n');
    this.write('  /intel actions [limit]                 List drafted response actions\n');
    this.write('  /intel action draft <id> <type>        Draft report/takedown/response action\n');
    this.write('  /intel mode [manual|assisted|autonomous] Set response mode\n');
    this.write('\n');
    this.write(this.bold('Models & General\n'));
    this.write('  /models [provider]                     List available models\n');
    this.write('  /reset [agentId]                       Reset conversation memory\n');
    this.write('  /session [list|use|new] ...            Session controls\n');
    this.write('  /quick <email|task|calendar> <details> Run quick action workflow\n');
    this.write('  /analytics [minutes]                   Interaction analytics summary\n');
    this.write('  /setup [run|status]                    First-run setup/status\n');
    this.write('  /guide                                 Show reference guide\n');
    this.write('  /clear                                 Clear screen\n');
    this.write('  /help                                  Show this help\n');
    this.write('  /quit, /exit                           Exit\n');
    this.write('\n');
  }

  // ─── /chat ───────────────────────────────────────────────────

  private async handleChat(args: string[]): Promise<void> {
    if (args.length === 0) {
      // Show current active agent and available agents
      const current = this.activeAgentId ?? this.defaultAgentId ?? 'default';
      this.write(`\nActive agent: ${this.cyan(current)}\n`);

      const agents = this.dashboard?.onAgents?.() ?? this.onAgents?.();
      if (agents && agents.length > 0) {
        this.write('Available agents:\n');
        const visibleAgents = agents.filter(a => 'canChat' in a ? (a as { canChat?: boolean }).canChat !== false : true);
        for (const a of visibleAgents) {
          const marker = a.id === (this.activeAgentId ?? this.defaultAgentId) ? ' (active)' : '';
          this.write(`  ${a.id} — ${a.name}${marker}\n`);
        }
      }
      this.write('\n');
      return;
    }

    const agentId = args[0];

    // Validate agent exists if dashboard is available
    if (this.dashboard?.onAgentDetail) {
      const detail = this.dashboard.onAgentDetail(agentId);
      if (!detail) {
        this.write(`\n${this.red('Error:')} Agent "${agentId}" not found.\n\n`);
        return;
      }
      if (detail.canChat === false) {
        this.write(`\n${this.red('Error:')} Agent "${agentId}" does not handle chat messages.\n\n`);
        return;
      }
    }

    this.activeAgentId = agentId;
    const newPrompt = `you (${agentId})> `;
    this.prompt = newPrompt;
    this.rl?.setPrompt(newPrompt);
    this.write(`\nSwitched to agent: ${this.cyan(agentId)}\n\n`);
  }

  // ─── /agents ─────────────────────────────────────────────────

  private handleAgents(): void {
    // Prefer dashboard callbacks for richer data
    if (this.dashboard?.onAgents) {
      const agents = this.dashboard.onAgents();
      if (agents.length === 0) {
        this.write('\nNo agents registered.\n\n');
        return;
      }

      const headers = ['ID', 'Name', 'State', 'Provider', 'Errors', 'Capabilities'];
      const rows = agents.map(a => [
        a.id,
        a.name,
        this.colorState(a.state),
        a.provider ?? '-',
        String(a.consecutiveErrors),
        a.capabilities.length > 0 ? a.capabilities.join(', ') : 'none',
      ]);

      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    // Legacy fallback
    if (!this.onAgents) {
      this.write('\nAgent listing not available.\n\n');
      return;
    }
    this.writeAgentsLegacy(this.onAgents());
  }

  // ─── /agent <id> ─────────────────────────────────────────────

  private handleAgentDetail(args: string[]): void {
    if (args.length === 0) {
      this.write('\nUsage: /agent <id>\n\n');
      return;
    }

    if (!this.dashboard?.onAgentDetail) {
      this.write('\nAgent detail not available.\n\n');
      return;
    }

    const detail = this.dashboard.onAgentDetail(args[0]);
    if (!detail) {
      this.write(`\nAgent "${args[0]}" not found.\n\n`);
      return;
    }

    this.write('\n');
    this.write(this.bold(`Agent: ${detail.name}\n`));
    this.write(`  ID:           ${detail.id}\n`);
    this.write(`  State:        ${this.colorState(detail.state)}\n`);
    this.write(`  Provider:     ${detail.provider ?? '-'}\n`);
    this.write(`  Schedule:     ${detail.schedule ?? '-'}\n`);
    this.write(`  Errors:       ${detail.consecutiveErrors}\n`);
    this.write(`  Last active:  ${detail.lastActivityMs > 0 ? this.formatTimeAgo(detail.lastActivityMs) : '-'}\n`);
    this.write(`  Capabilities: ${detail.capabilities.length > 0 ? detail.capabilities.join(', ') : 'none'}\n`);

    if (detail.resourceLimits) {
      const rl = detail.resourceLimits;
      this.write(`  Resource limits:\n`);
      this.write(`    Max invocation:   ${rl.maxInvocationBudgetMs}ms\n`);
      this.write(`    Max tokens/min:   ${rl.maxTokensPerMinute}\n`);
      this.write(`    Max concurrent:   ${rl.maxConcurrentTools}\n`);
      this.write(`    Max queue depth:  ${rl.maxQueueDepth}\n`);
    }
    this.write('\n');
  }

  // ─── /status ─────────────────────────────────────────────────

  private handleStatus(): void {
    if (this.dashboard) {
      this.writeEnhancedStatus();
      return;
    }

    // Legacy fallback
    if (!this.onStatus) {
      this.write('\nStatus not available.\n\n');
      return;
    }
    this.writeStatusLegacy(this.onStatus());
  }

  private writeEnhancedStatus(): void {
    this.write('\n');

    // Config section
    const config = this.dashboard!.onConfig?.();
    if (config) {
      this.write(this.bold('Runtime\n'));
      this.write(`  Default provider:  ${config.defaultProvider}\n`);
      this.write(`  Guardian:          ${config.guardian.enabled ? this.green('enabled') : this.red('disabled')}\n`);
      this.write(`  Max stall:         ${config.runtime.maxStallDurationMs}ms\n`);
      this.write(`  Watchdog interval: ${config.runtime.watchdogIntervalMs}ms\n`);
      this.write(`  Log level:         ${config.runtime.logLevel}\n`);
      this.write('\n');
    }

    // Providers section
    const providers = this.dashboard!.onProviders?.();
    if (providers && providers.length > 0) {
      this.write(this.bold('Providers\n'));
      for (const p of providers) {
        this.write(`  ${p.name}: ${p.type} (${p.model}) — ${p.locality}\n`);
      }
      this.write('\n');
    }

    // Agents by state
    const agents = this.dashboard!.onAgents?.();
    if (agents) {
      const stateCounts: Record<string, number> = {};
      for (const a of agents) {
        stateCounts[a.state] = (stateCounts[a.state] ?? 0) + 1;
      }
      this.write(this.bold('Agents\n'));
      this.write(`  Total: ${agents.length}\n`);
      for (const [state, count] of Object.entries(stateCounts)) {
        this.write(`  ${this.colorState(state)}: ${count}\n`);
      }
      this.write('\n');
    }
  }

  // ─── /providers ──────────────────────────────────────────────

  private async handleProviders(): Promise<void> {
    if (!this.dashboard?.onProvidersStatus) {
      this.write('\nProvider info not available.\n\n');
      return;
    }

    this.write('\nChecking provider connectivity...\n');
    const providers = await this.dashboard.onProvidersStatus();

    if (providers.length === 0) {
      this.write('No providers configured.\n\n');
      return;
    }

    const headers = ['Name', 'Type', 'Model', 'Locality', 'Status'];
    const rows = providers.map(p => [
      p.name,
      p.type,
      p.model,
      p.locality,
      p.connected ? this.green('PASS') : this.red('FAIL'),
    ]);

    this.write('\n');
    this.writeTable(headers, rows);

    // Show available models
    for (const p of providers) {
      if (p.availableModels && p.availableModels.length > 0) {
        this.write(`\n${this.bold(p.name)} models: ${p.availableModels.join(', ')}\n`);
      }
    }
    this.write('\n');
  }

  // ─── /budget ─────────────────────────────────────────────────

  private handleBudget(): void {
    if (!this.dashboard?.onBudget) {
      this.write('\nBudget info not available.\n\n');
      return;
    }

    const budget = this.dashboard.onBudget();

    if (budget.agents.length === 0) {
      this.write('\nNo budget data.\n\n');
      return;
    }

    const headers = ['Agent', 'Tokens/min', 'Concurrent', 'Overruns'];
    const rows = budget.agents.map(a => [
      a.agentId,
      String(a.tokensPerMinute),
      String(a.concurrentInvocations),
      String(a.overrunCount),
    ]);

    this.write('\n');
    this.writeTable(headers, rows);

    if (budget.recentOverruns.length > 0) {
      this.write(`\n${this.bold('Recent overruns:')}\n`);
      for (const o of budget.recentOverruns.slice(-5)) {
        this.write(`  ${o.agentId}: ${o.invocationType} — ${Math.round(o.usedMs)}ms / ${o.budgetMs}ms\n`);
      }
    }
    this.write('\n');
  }

  // ─── /watchdog ───────────────────────────────────────────────

  private handleWatchdog(): void {
    if (!this.dashboard?.onWatchdog) {
      this.write('\nWatchdog not available.\n\n');
      return;
    }

    const results = this.dashboard.onWatchdog();

    if (results.length === 0) {
      this.write('\nNo watchdog results.\n\n');
      return;
    }

    const headers = ['Agent', 'Status', 'Details'];
    const rows = results.map(r => {
      let status: string;
      switch (r.action) {
        case 'ok': status = this.green('OK'); break;
        case 'stalled': status = this.yellow('STALLED'); break;
        case 'retry': status = this.yellow('RETRY'); break;
        case 'killed': status = this.red('KILLED'); break;
        default: status = r.action;
      }
      const details: string[] = [];
      if (r.stalledMs !== undefined) details.push(`stalled ${Math.round(r.stalledMs / 1000)}s`);
      if (r.consecutiveErrors !== undefined) details.push(`errors: ${r.consecutiveErrors}`);
      return [r.agentId, status, details.join(', ') || '-'];
    });

    this.write('\n');
    this.writeTable(headers, rows);
    this.write('\n');
  }

  // ─── /config ─────────────────────────────────────────────────

  private async handleConfig(args: string[]): Promise<void> {
    if (args.length === 0) {
      this.writeRedactedConfig();
      return;
    }

    const subCmd = args[0].toLowerCase();

    switch (subCmd) {
      case 'provider':
        this.handleConfigProvider(args.slice(1));
        break;
      case 'set':
        await this.handleConfigSet(args.slice(1));
        break;
      case 'add':
        await this.handleConfigAdd(args.slice(1));
        break;
      case 'test':
        await this.handleConfigTest(args.slice(1));
        break;
      default:
        this.write(`\nUnknown config subcommand: ${subCmd}\n`);
        this.write('Usage: /config [provider|set|add|test]\n\n');
    }
  }

  private writeRedactedConfig(): void {
    if (!this.dashboard?.onConfig) {
      this.write('\nConfig not available.\n\n');
      return;
    }

    const config = this.dashboard.onConfig();

    this.write('\n');
    this.write(this.bold('LLM Providers\n'));
    for (const [name, cfg] of Object.entries(config.llm)) {
      const isDefault = name === config.defaultProvider ? this.green(' (default)') : '';
      this.write(`  ${this.cyan(name)}${isDefault}\n`);
      this.write(`    provider: ${cfg.provider}\n`);
      this.write(`    model:    ${cfg.model}\n`);
      if (cfg.baseUrl) this.write(`    baseUrl:  ${cfg.baseUrl}\n`);
    }

    this.write('\n');
    this.write(this.bold('Channels\n'));
    if (config.channels.cli) this.write(`  CLI:      ${config.channels.cli.enabled ? 'enabled' : 'disabled'}\n`);
    if (config.channels.telegram) this.write(`  Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}\n`);
    if (config.channels.web) {
      this.write(`  Web:      ${config.channels.web.enabled ? 'enabled' : 'disabled'}`);
      if (config.channels.web.port) this.write(` (port ${config.channels.web.port})`);
      this.write('\n');
    }

    this.write('\n');
    this.write(this.bold('Guardian\n'));
    this.write(`  Enabled: ${config.guardian.enabled ? this.green('yes') : this.red('no')}\n`);
    if (config.guardian.rateLimit) {
      this.write(`  Rate limit: ${config.guardian.rateLimit.maxPerMinute}/min, ${config.guardian.rateLimit.maxPerHour}/hr, burst ${config.guardian.rateLimit.burstAllowed}\n`);
    }
    if (config.guardian.inputSanitization) {
      this.write(`  Input sanitization: ${config.guardian.inputSanitization.enabled ? 'enabled' : 'disabled'} (threshold ${config.guardian.inputSanitization.blockThreshold})\n`);
    }
    if (config.guardian.outputScanning) {
      this.write(`  Output scanning: ${config.guardian.outputScanning.enabled ? 'enabled' : 'disabled'} (redact: ${config.guardian.outputScanning.redactSecrets})\n`);
    }
    if (config.guardian.sentinel) {
      this.write(`  Sentinel: ${config.guardian.sentinel.enabled ? 'enabled' : 'disabled'} (${config.guardian.sentinel.schedule})\n`);
    }

    this.write('\n');
    this.write(this.bold('Runtime\n'));
    this.write(`  Max stall:         ${config.runtime.maxStallDurationMs}ms\n`);
    this.write(`  Watchdog interval: ${config.runtime.watchdogIntervalMs}ms\n`);
    this.write(`  Log level:         ${config.runtime.logLevel}\n`);

    this.write('\n');
    this.write(this.bold('Assistant\n'));
    this.write(`  Setup completed: ${config.assistant.setupCompleted ? this.green('yes') : this.yellow('no')}\n`);
    this.write(`  Identity mode:   ${config.assistant.identity.mode}\n`);
    this.write(`  Memory:          ${config.assistant.memory.enabled ? 'enabled' : 'disabled'} (${config.assistant.memory.retentionDays}d retention)\n`);
    this.write(`  Analytics:       ${config.assistant.analytics.enabled ? 'enabled' : 'disabled'} (${config.assistant.analytics.retentionDays}d retention)\n`);
    this.write(`  Quick actions:   ${config.assistant.quickActions.enabled ? 'enabled' : 'disabled'}\n`);
    this.write(`  Threat intel:    ${config.assistant.threatIntel.enabled ? 'enabled' : 'disabled'} (mode ${config.assistant.threatIntel.responseMode}, watchlist ${config.assistant.threatIntel.watchlistCount})\n`);
    this.write(`  Moltbook:        ${config.assistant.threatIntel.moltbook.enabled ? 'enabled' : 'disabled'} (${config.assistant.threatIntel.moltbook.mode}, active-response ${config.assistant.threatIntel.moltbook.allowActiveResponse ? 'on' : 'off'})\n`);
    this.write('\n');
  }

  private handleConfigProvider(args: string[]): void {
    if (args.length === 0) {
      this.write('\nUsage: /config provider <name>\n\n');
      return;
    }

    if (!this.dashboard?.onConfig) {
      this.write('\nConfig not available.\n\n');
      return;
    }

    const config = this.dashboard.onConfig();
    const name = args[0];
    const provider = config.llm[name];

    if (!provider) {
      this.write(`\nProvider "${name}" not found.\n`);
      this.write(`Available: ${Object.keys(config.llm).join(', ')}\n\n`);
      return;
    }

    const isDefault = name === config.defaultProvider;
    this.write('\n');
    this.write(this.bold(`Provider: ${name}${isDefault ? ' (default)' : ''}\n`));
    this.write(`  Type:    ${provider.provider}\n`);
    this.write(`  Model:   ${provider.model}\n`);
    if (provider.baseUrl) this.write(`  Base URL: ${provider.baseUrl}\n`);
    this.write('\n');
  }

  private async handleConfigSet(args: string[]): Promise<void> {
    if (!this.dashboard?.onConfigUpdate) {
      this.write('\nConfig updates not available.\n\n');
      return;
    }

    if (args.length < 2) {
      this.write('\nUsage:\n');
      this.write('  /config set default <provider>\n');
      this.write('  /config set <provider> model|baseUrl|apiKey <value>\n\n');
      return;
    }

    if (args[0] === 'default') {
      const result = await this.dashboard.onConfigUpdate({ defaultProvider: args[1] });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    // /config set <provider> <field> <value>
    if (args.length < 3) {
      this.write('\nUsage: /config set <provider> model|baseUrl|apiKey <value>\n\n');
      return;
    }

    const [provider, field, ...valueParts] = args;
    const value = valueParts.join(' ');
    const validFields = ['model', 'baseUrl', 'apiKey', 'baseurl', 'apikey'];

    if (!validFields.includes(field)) {
      this.write(`\nInvalid field: ${field}. Use model, baseUrl, or apiKey.\n\n`);
      return;
    }

    const normalizedField = field === 'baseurl' ? 'baseUrl' : field === 'apikey' ? 'apiKey' : field;
    const result = await this.dashboard.onConfigUpdate({
      llm: { [provider]: { [normalizedField]: value } },
    });
    this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  private async handleConfigAdd(args: string[]): Promise<void> {
    if (!this.dashboard?.onConfigUpdate) {
      this.write('\nConfig updates not available.\n\n');
      return;
    }

    if (args.length < 3) {
      this.write('\nUsage: /config add <name> <type> <model> [apiKey]\n');
      this.write('  type: ollama, anthropic, openai\n\n');
      return;
    }

    const [name, type, model, apiKey] = args;
    const validTypes = ['ollama', 'anthropic', 'openai'];

    if (!validTypes.includes(type)) {
      this.write(`\nInvalid provider type: ${type}. Use: ${validTypes.join(', ')}\n\n`);
      return;
    }

    const providerUpdate: Record<string, string> = { provider: type, model };
    if (apiKey) providerUpdate.apiKey = apiKey;

    const result = await this.dashboard.onConfigUpdate({
      llm: { [name]: providerUpdate },
    });
    this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  private async handleConfigTest(args: string[]): Promise<void> {
    if (!this.dashboard?.onProvidersStatus) {
      this.write('\nProvider testing not available.\n\n');
      return;
    }

    this.write('\nTesting provider connectivity...\n');
    const providers = await this.dashboard.onProvidersStatus();

    // Filter to specific provider if requested
    const filtered = args.length > 0
      ? providers.filter(p => p.name === args[0])
      : providers;

    if (filtered.length === 0) {
      this.write(`Provider "${args[0]}" not found.\n\n`);
      return;
    }

    for (const p of filtered) {
      const status = p.connected ? this.green('PASS') : this.red('FAIL');
      this.write(`  ${p.name}: ${status}\n`);
      if (p.availableModels && p.availableModels.length > 0) {
        this.write(`    Models: ${p.availableModels.join(', ')}\n`);
      }
    }
    this.write('\n');
  }

  // ─── /audit ──────────────────────────────────────────────────

  private handleAudit(args: string[]): void {
    if (!this.dashboard?.onAuditQuery) {
      this.write('\nAudit log not available.\n\n');
      return;
    }

    // /audit summary [windowMs]
    if (args[0] === 'summary') {
      this.handleAuditSummary(args.slice(1));
      return;
    }

    // /audit filter <field> <value>
    if (args[0] === 'filter') {
      this.handleAuditFilter(args.slice(1));
      return;
    }

    // /audit [limit]
    const limit = args.length > 0 ? parseInt(args[0], 10) : 20;
    const events = this.dashboard.onAuditQuery({ limit: isNaN(limit) ? 20 : limit });

    if (events.length === 0) {
      this.write('\nNo audit events.\n\n');
      return;
    }

    this.write('\n');
    for (const e of events) {
      const time = new Date(e.timestamp).toLocaleTimeString();
      const severity = this.colorSeverity(e.severity);
      const controller = e.controller ? ` [${e.controller}]` : '';
      this.write(`  ${this.dim(time)} ${severity} ${e.type} ${this.dim(e.agentId)}${controller}\n`);
    }
    this.write('\n');
  }

  private handleAuditFilter(args: string[]): void {
    if (args.length < 2) {
      this.write('\nUsage: /audit filter type|severity|agent <value>\n\n');
      return;
    }

    const [field, value] = args;
    const filter: Record<string, unknown> = { limit: 50 };

    switch (field) {
      case 'type': filter.type = value; break;
      case 'severity': filter.severity = value; break;
      case 'agent': filter.agentId = value; break;
      default:
        this.write(`\nInvalid filter field: ${field}. Use type, severity, or agent.\n\n`);
        return;
    }

    const events = this.dashboard!.onAuditQuery!(filter as Parameters<NonNullable<DashboardCallbacks['onAuditQuery']>>[0]);

    if (events.length === 0) {
      this.write('\nNo matching events.\n\n');
      return;
    }

    this.write('\n');
    for (const e of events) {
      const time = new Date(e.timestamp).toLocaleTimeString();
      const severity = this.colorSeverity(e.severity);
      const controller = e.controller ? ` [${e.controller}]` : '';
      this.write(`  ${this.dim(time)} ${severity} ${e.type} ${this.dim(e.agentId)}${controller}\n`);
    }
    this.write('\n');
  }

  private handleAuditSummary(args: string[]): void {
    if (!this.dashboard?.onAuditSummary) {
      this.write('\nAudit summary not available.\n\n');
      return;
    }

    const windowMs = args.length > 0 ? parseInt(args[0], 10) : 3_600_000;
    const summary = this.dashboard.onAuditSummary(isNaN(windowMs) ? 3_600_000 : windowMs);

    this.write('\n');
    this.write(this.bold('Audit Summary\n'));
    this.write(`  Window: ${Math.round((isNaN(windowMs) ? 3_600_000 : windowMs) / 60_000)} minutes\n`);
    this.write(`  Total events: ${summary.totalEvents}\n`);
    this.write('\n');

    this.write('  By severity:\n');
    for (const [sev, count] of Object.entries(summary.bySeverity)) {
      if (count > 0) this.write(`    ${this.colorSeverity(sev as 'info' | 'warn' | 'critical')}: ${count}\n`);
    }

    if (Object.keys(summary.byType).length > 0) {
      this.write('\n  By type:\n');
      for (const [type, count] of Object.entries(summary.byType)) {
        this.write(`    ${type}: ${count}\n`);
      }
    }

    if (summary.topDeniedAgents.length > 0) {
      this.write('\n  Top denied agents:\n');
      for (const a of summary.topDeniedAgents) {
        this.write(`    ${a.agentId}: ${a.count} denials\n`);
      }
    }

    if (summary.topControllers.length > 0) {
      this.write('\n  Top controllers:\n');
      for (const c of summary.topControllers) {
        this.write(`    ${c.controller}: ${c.count}\n`);
      }
    }
    this.write('\n');
  }

  // ─── /security ───────────────────────────────────────────────

  private handleSecurity(): void {
    this.write('\n');
    this.write(this.bold('Security Overview\n'));

    // Guardian config
    const config = this.dashboard?.onConfig?.();
    if (config) {
      this.write(`\n  Guardian: ${config.guardian.enabled ? this.green('ENABLED') : this.red('DISABLED')}\n`);
      if (config.guardian.rateLimit) {
        this.write(`  Rate limit: ${config.guardian.rateLimit.maxPerMinute}/min, ${config.guardian.rateLimit.maxPerHour}/hr\n`);
      }
      if (config.guardian.inputSanitization) {
        this.write(`  Input sanitization: ${config.guardian.inputSanitization.enabled ? 'on' : 'off'}\n`);
      }
      if (config.guardian.outputScanning) {
        this.write(`  Output scanning: ${config.guardian.outputScanning.enabled ? 'on' : 'off'}\n`);
      }
      if (config.guardian.sentinel) {
        this.write(`  Sentinel: ${config.guardian.sentinel.enabled ? 'on' : 'off'} (${config.guardian.sentinel.schedule})\n`);
      }
    }

    // Last-hour audit summary
    if (this.dashboard?.onAuditSummary) {
      const summary = this.dashboard.onAuditSummary(3_600_000);
      this.write('\n');
      this.write(this.bold('  Last hour:\n'));
      this.write(`    Total events:    ${summary.totalEvents}\n`);

      const denials = (summary.byType['action_denied'] ?? 0) + (summary.byType['rate_limited'] ?? 0);
      const secrets = (summary.byType['secret_detected'] ?? 0) + (summary.byType['output_blocked'] ?? 0) + (summary.byType['output_redacted'] ?? 0);
      const anomalies = summary.byType['anomaly_detected'] ?? 0;

      this.write(`    Denials:         ${denials > 0 ? this.yellow(String(denials)) : '0'}\n`);
      this.write(`    Secret events:   ${secrets > 0 ? this.red(String(secrets)) : '0'}\n`);
      this.write(`    Anomalies:       ${anomalies > 0 ? this.red(String(anomalies)) : '0'}\n`);
      this.write(`    Critical:        ${summary.bySeverity.critical > 0 ? this.red(String(summary.bySeverity.critical)) : '0'}\n`);
    } else {
      this.write('\n  Audit data not available.\n');
    }
    this.write('\n');
  }

  // ─── /models ─────────────────────────────────────────────────

  private async handleModels(args: string[]): Promise<void> {
    if (!this.dashboard?.onProvidersStatus) {
      this.write('\nModel listing not available.\n\n');
      return;
    }

    const providers = await this.dashboard.onProvidersStatus();

    // Filter to specific provider if requested
    const filtered = args.length > 0
      ? providers.filter(p => p.name === args[0])
      : providers;

    if (filtered.length === 0) {
      if (args.length > 0) {
        this.write(`\nProvider "${args[0]}" not found.\n\n`);
      } else {
        this.write('\nNo providers configured.\n\n');
      }
      return;
    }

    this.write('\n');
    for (const p of filtered) {
      this.write(this.bold(`${p.name}`) + ` (${p.type}):\n`);
      const activeModel = p.model;

      if (p.availableModels && p.availableModels.length > 0) {
        for (const m of p.availableModels) {
          const marker = m === activeModel ? this.green(' (active)') : '';
          this.write(`  ${m}${marker}\n`);
        }
      } else if (p.connected) {
        this.write(`  ${activeModel}${this.green(' (active)')}\n`);
      } else {
        this.write(`  ${this.dim('Unable to list models — provider not connected')}\n`);
      }
    }
    this.write('\n');
  }

  // ─── /reset ──────────────────────────────────────────────────

  private async handleReset(args: string[]): Promise<void> {
    if (!this.dashboard?.onConversationReset) {
      this.write('\nConversation reset is not available.\n\n');
      return;
    }

    const agentId = args[0] ?? this.activeAgentId ?? this.defaultAgentId ?? 'default';
    const result = await this.dashboard.onConversationReset({
      agentId,
      userId: this.defaultUserId,
      channel: 'cli',
    });
    this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  // ─── /guide ──────────────────────────────────────────────────

  private handleGuide(): void {
    const lines = formatGuideForCLI();
    if (lines.length === 0) {
      this.write('\nGuide is not available.\n\n');
      return;
    }

    this.write('\n');
    this.write(this.bold(`${lines[0]}\n`));
    for (let i = 1; i < lines.length; i++) {
      this.write(`${lines[i]}\n`);
    }
    this.write('\n');
  }

  // ─── /session ────────────────────────────────────────────────

  private async handleSession(args: string[]): Promise<void> {
    if (!this.dashboard?.onConversationSessions) {
      this.write('\nSession controls are not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'list').toLowerCase();
    const agentId = args.length > 1
      ? args[1]
      : (this.activeAgentId ?? this.defaultAgentId ?? 'default');

    if (sub === 'list' || args.length === 0) {
      const sessions = this.dashboard.onConversationSessions({
        userId: this.defaultUserId,
        channel: 'cli',
        agentId,
      });
      if (sessions.length === 0) {
        this.write('\nNo stored sessions.\n\n');
        return;
      }

      this.write(`\nSessions for ${this.cyan(agentId)}:\n`);
      for (const session of sessions) {
        const marker = session.isActive ? this.green(' (active)') : '';
        this.write(
          `  ${session.sessionId}${marker} — ${session.messageCount} messages, ${this.formatTimeAgo(session.lastMessageAt)}\n`,
        );
      }
      this.write('\n');
      return;
    }

    if (sub === 'use') {
      if (!this.dashboard.onConversationUseSession) {
        this.write('\nSession switch is not available.\n\n');
        return;
      }
      if (!args[1]) {
        this.write('\nUsage: /session use <sessionId> [agentId]\n\n');
        return;
      }
      const sessionId = args[1];
      const targetAgent = args[2] ?? (this.activeAgentId ?? this.defaultAgentId ?? 'default');
      const result = this.dashboard.onConversationUseSession({
        agentId: targetAgent,
        userId: this.defaultUserId,
        channel: 'cli',
        sessionId,
      });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    if (sub === 'new') {
      if (!this.dashboard.onConversationReset) {
        this.write('\nNew session is not available.\n\n');
        return;
      }
      const targetAgent = args[1] ?? (this.activeAgentId ?? this.defaultAgentId ?? 'default');
      const result = await this.dashboard.onConversationReset({
        agentId: targetAgent,
        userId: this.defaultUserId,
        channel: 'cli',
      });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    this.write('\nUsage: /session [list|use|new] ...\n\n');
  }

  // ─── /quick ──────────────────────────────────────────────────

  private async handleQuick(args: string[]): Promise<void> {
    if (!this.dashboard?.onQuickActionRun) {
      this.write('\nQuick actions are not available.\n\n');
      return;
    }

    if (args.length < 2) {
      this.write('\nUsage: /quick <email|task|calendar> <details>\n\n');
      return;
    }

    const actionId = args[0].toLowerCase();
    const details = args.slice(1).join(' ').trim();
    const agentId = this.activeAgentId ?? this.defaultAgentId ?? 'default';

    this.write('\nRunning quick action...\n');
    try {
      const response = await this.dashboard.onQuickActionRun({
        actionId,
        details,
        agentId,
        userId: this.defaultUserId,
        channel: 'cli',
      });
      this.write(`\nassistant> ${response.content}\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.write(`\n${this.red('[error]')} ${msg}\n\n`);
    }
  }

  // ─── /analytics ──────────────────────────────────────────────

  private handleAnalytics(args: string[]): void {
    if (!this.dashboard?.onAnalyticsSummary) {
      this.write('\nAnalytics are not available.\n\n');
      return;
    }

    const minutes = args[0] ? Number.parseInt(args[0], 10) : 60;
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
    const summary = this.dashboard.onAnalyticsSummary(safeMinutes * 60_000);

    this.write('\n');
    this.write(this.bold(`Analytics (${safeMinutes}m)\n`));
    this.write(`  Total events: ${summary.totalEvents}\n`);

    if (Object.keys(summary.byType).length > 0) {
      this.write('  By type:\n');
      for (const [type, count] of Object.entries(summary.byType)) {
        this.write(`    ${type}: ${count}\n`);
      }
    }

    if (summary.commandUsage.length > 0) {
      this.write('  Top commands:\n');
      for (const entry of summary.commandUsage.slice(0, 5)) {
        this.write(`    /${entry.command}: ${entry.count}\n`);
      }
    }
    this.write('\n');
  }

  // ─── /intel ──────────────────────────────────────────────────

  private async handleIntel(args: string[]): Promise<void> {
    if (!this.dashboard?.onThreatIntelSummary) {
      this.write('\nThreat intel is not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'status').toLowerCase();
    const rest = args.slice(1);

    switch (sub) {
      case 'status':
        this.handleIntelStatus();
        return;
      case 'plan':
        this.handleIntelPlan();
        return;
      case 'watch':
        this.handleIntelWatch(rest);
        return;
      case 'scan':
        await this.handleIntelScan(rest);
        return;
      case 'findings':
        this.handleIntelFindings(rest);
        return;
      case 'finding':
        this.handleIntelFinding(rest);
        return;
      case 'actions':
        this.handleIntelActions(rest);
        return;
      case 'action':
        this.handleIntelAction(rest);
        return;
      case 'mode':
        this.handleIntelMode(rest);
        return;
      default:
        this.writeIntelUsage();
    }
  }

  private handleIntelStatus(): void {
    const summary = this.dashboard?.onThreatIntelSummary?.();
    if (!summary) {
      this.write('\nThreat intel is not available.\n\n');
      return;
    }

    this.write('\n');
    this.write(this.bold('Threat Intel Summary\n'));
    this.write(`  Monitoring:   ${summary.enabled ? this.green('enabled') : this.red('disabled')}\n`);
    this.write(`  Response mode: ${this.cyan(summary.responseMode)}\n`);
    this.write(`  Watchlist:    ${summary.watchlistCount}\n`);
    this.write(`  Darkweb:      ${summary.darkwebEnabled ? this.yellow('enabled') : this.dim('disabled')}\n`);
    this.write(`  Findings:     ${summary.findings.total} total, ${summary.findings.new} new, ${summary.findings.highOrCritical} high/critical\n`);
    if (summary.forumConnectors.length > 0) {
      this.write('  Forum connectors:\n');
      for (const connector of summary.forumConnectors) {
        const state = connector.enabled ? this.green('enabled') : this.dim('disabled');
        const hostile = connector.hostile ? this.red('hostile') : this.dim('normal');
        this.write(`    - ${connector.id}: ${state}, ${connector.mode}, ${hostile}\n`);
      }
    }
    if (summary.lastScanAt) {
      this.write(`  Last scan:    ${this.formatTimeAgo(summary.lastScanAt)}\n`);
    }
    this.write('\n');
  }

  private handleIntelPlan(): void {
    if (!this.dashboard?.onThreatIntelPlan) {
      this.write('\nThreat intel plan is not available.\n\n');
      return;
    }
    const plan = this.dashboard.onThreatIntelPlan();
    this.write('\n');
    this.write(this.bold(`${plan.title}\n`));
    for (const phase of plan.phases) {
      this.write(`  ${this.cyan(phase.phase)}\n`);
      this.write(`    ${phase.objective}\n`);
      for (const deliverable of phase.deliverables) {
        this.write(`    - ${deliverable}\n`);
      }
    }
    this.write('\n');
  }

  private handleIntelWatch(args: string[]): void {
    if (!this.dashboard?.onThreatIntelWatchlist) {
      this.write('\nThreat intel watchlist is not available.\n\n');
      return;
    }

    const action = (args[0] ?? 'list').toLowerCase();
    if (action === 'list') {
      const watchlist = this.dashboard.onThreatIntelWatchlist();
      if (watchlist.length === 0) {
        this.write('\nNo watchlist targets configured.\n\n');
        return;
      }
      this.write('\nWatchlist targets:\n');
      for (const target of watchlist) {
        this.write(`  - ${target}\n`);
      }
      this.write('\n');
      return;
    }

    if (action !== 'add' && action !== 'remove') {
      this.write('\nUsage: /intel watch [list|add|remove] <target>\n\n');
      return;
    }

    const target = args.slice(1).join(' ').trim();
    if (!target) {
      this.write('\nUsage: /intel watch [add|remove] <target>\n\n');
      return;
    }

    const callback = action === 'add'
      ? this.dashboard.onThreatIntelWatchAdd
      : this.dashboard.onThreatIntelWatchRemove;
    if (!callback) {
      this.write('\nThreat intel watchlist update is not available.\n\n');
      return;
    }

    const result = callback(target);
    this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  private async handleIntelScan(args: string[]): Promise<void> {
    if (!this.dashboard?.onThreatIntelScan) {
      this.write('\nThreat intel scan is not available.\n\n');
      return;
    }

    const includeDarkWeb = args.includes('--darkweb');
    const sourcesArg = args.find((arg) => arg.startsWith('--sources='));
    const queryTokens = args.filter((arg) => arg !== '--darkweb' && !arg.startsWith('--sources='));
    const query = queryTokens.join(' ').trim() || undefined;
    const sources = sourcesArg
      ? sourcesArg.slice('--sources='.length)
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : undefined;

    this.write('\nRunning threat-intel scan...\n');
    const result = await this.dashboard.onThreatIntelScan({
      query,
      includeDarkWeb,
      sources: sources as Parameters<NonNullable<DashboardCallbacks['onThreatIntelScan']>>[0]['sources'],
    });

    const status = result.success ? this.green('OK') : this.yellow('WARN');
    this.write(`${status}: ${result.message}\n`);
    if (result.findings.length > 0) {
      this.write(`\nNew findings (${result.findings.length}):\n`);
      for (const finding of result.findings.slice(0, 8)) {
        this.write(
          `  ${finding.id.slice(0, 8)} ${this.colorIntelSeverity(finding.severity)} ${finding.sourceType} ${finding.target} (${Math.round(finding.confidence * 100)}%)\n`,
        );
      }
      if (result.findings.length > 8) {
        this.write(`  ...and ${result.findings.length - 8} more\n`);
      }
    }
    this.write('\n');
  }

  private handleIntelFindings(args: string[]): void {
    if (!this.dashboard?.onThreatIntelFindings) {
      this.write('\nThreat intel findings are not available.\n\n');
      return;
    }

    let limit = 12;
    let statusArg: string | undefined;
    if (args[0]) {
      const parsed = Number.parseInt(args[0], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
        statusArg = args[1];
      } else {
        statusArg = args[0];
      }
    }

    const findings = this.dashboard.onThreatIntelFindings({
      limit,
      status: statusArg as Parameters<NonNullable<DashboardCallbacks['onThreatIntelFindings']>>[0]['status'],
    });

    if (findings.length === 0) {
      this.write('\nNo findings.\n\n');
      return;
    }

    const headers = ['ID', 'Target', 'Source', 'Severity', 'Conf', 'Status'];
    const rows = findings.map((finding) => [
      finding.id.slice(0, 8),
      finding.target,
      finding.sourceType,
      this.colorIntelSeverity(finding.severity),
      `${Math.round(finding.confidence * 100)}%`,
      finding.status,
    ]);

    this.write('\n');
    this.writeTable(headers, rows);
    this.write('\n');
  }

  private handleIntelFinding(args: string[]): void {
    if (!this.dashboard?.onThreatIntelUpdateFindingStatus) {
      this.write('\nThreat intel finding updates are not available.\n\n');
      return;
    }

    if (args.length < 3 || args[1].toLowerCase() !== 'status') {
      this.write('\nUsage: /intel finding <findingId> status <new|triaged|actioned|dismissed>\n\n');
      return;
    }

    const findingId = args[0];
    const status = args[2].toLowerCase();
    if (!['new', 'triaged', 'actioned', 'dismissed'].includes(status)) {
      this.write('\nInvalid status. Use new, triaged, actioned, or dismissed.\n\n');
      return;
    }

    const result = this.dashboard.onThreatIntelUpdateFindingStatus({
      findingId,
      status: status as Parameters<NonNullable<DashboardCallbacks['onThreatIntelUpdateFindingStatus']>>[0]['status'],
    });
    this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  private handleIntelActions(args: string[]): void {
    if (!this.dashboard?.onThreatIntelActions) {
      this.write('\nThreat intel actions are not available.\n\n');
      return;
    }
    const parsed = args[0] ? Number.parseInt(args[0], 10) : 12;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
    const actions = this.dashboard.onThreatIntelActions(limit);
    if (actions.length === 0) {
      this.write('\nNo drafted actions.\n\n');
      return;
    }

    const headers = ['ID', 'Finding', 'Type', 'Status', 'Approval'];
    const rows = actions.map((action) => [
      action.id.slice(0, 8),
      action.findingId.slice(0, 8),
      action.type,
      action.status,
      action.requiresApproval ? 'required' : 'optional',
    ]);

    this.write('\n');
    this.writeTable(headers, rows);
    this.write('\n');
  }

  private handleIntelAction(args: string[]): void {
    if (!this.dashboard?.onThreatIntelDraftAction) {
      this.write('\nThreat intel action drafting is not available.\n\n');
      return;
    }

    if (args.length < 3 || args[0].toLowerCase() !== 'draft') {
      this.write('\nUsage: /intel action draft <findingId> <report|request_takedown|draft_response|publish_response>\n\n');
      return;
    }

    const findingId = args[1];
    const type = args[2].toLowerCase();
    if (!['report', 'request_takedown', 'draft_response', 'publish_response'].includes(type)) {
      this.write('\nInvalid action type. Use report, request_takedown, draft_response, or publish_response.\n\n');
      return;
    }

    const result = this.dashboard.onThreatIntelDraftAction({
      findingId,
      type: type as Parameters<NonNullable<DashboardCallbacks['onThreatIntelDraftAction']>>[0]['type'],
    });
    this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  private handleIntelMode(args: string[]): void {
    if (!this.dashboard?.onThreatIntelSummary) {
      this.write('\nThreat intel is not available.\n\n');
      return;
    }

    if (args.length === 0) {
      const mode = this.dashboard.onThreatIntelSummary().responseMode;
      this.write(`\nCurrent response mode: ${this.cyan(mode)}\n\n`);
      return;
    }

    if (!this.dashboard.onThreatIntelSetResponseMode) {
      this.write('\nThreat intel response mode updates are not available.\n\n');
      return;
    }

    const mode = args[0].toLowerCase();
    if (!['manual', 'assisted', 'autonomous'].includes(mode)) {
      this.write('\nUsage: /intel mode <manual|assisted|autonomous>\n\n');
      return;
    }

    const result = this.dashboard.onThreatIntelSetResponseMode(
      mode as Parameters<NonNullable<DashboardCallbacks['onThreatIntelSetResponseMode']>>[0],
    );
    this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  private writeIntelUsage(): void {
    this.write('\nThreat Intel usage:\n');
    this.write('  /intel [status]\n');
    this.write('  /intel plan\n');
    this.write('  /intel watch [list|add|remove] <target>\n');
    this.write('  /intel scan [query] [--darkweb] [--sources=web,news,social,forum]\n');
    this.write('  /intel findings [limit] [status]\n');
    this.write('  /intel finding <id> status <new|triaged|actioned|dismissed>\n');
    this.write('  /intel actions [limit]\n');
    this.write('  /intel action draft <findingId> <report|request_takedown|draft_response|publish_response>\n');
    this.write('  /intel mode <manual|assisted|autonomous>\n\n');
  }

  // ─── /setup ──────────────────────────────────────────────────

  private async handleSetup(args: string[]): Promise<void> {
    const sub = (args[0] ?? 'run').toLowerCase();

    if (!this.dashboard?.onSetupStatus) {
      this.write('\nSetup flow is not available.\n\n');
      return;
    }

    if (sub === 'status') {
      const status = await this.dashboard.onSetupStatus();
      this.write('\n');
      this.write(this.bold('Setup Status\n'));
      this.write(`  Completed: ${status.completed ? this.green('yes') : this.yellow('no')}\n`);
      this.write(`  Ready: ${status.ready ? this.green('yes') : this.yellow('no')}\n`);
      for (const step of status.steps) {
        const color = step.status === 'complete'
          ? this.green
          : step.status === 'warning'
          ? this.yellow
          : this.red;
        this.write(`  ${color(step.status.toUpperCase())} ${step.title}: ${step.detail}\n`);
      }
      this.write('\n');
      return;
    }

    await this.runSetupWizard();
  }

  private async runSetupWizard(): Promise<void> {
    if (!this.dashboard?.onSetupApply) {
      this.write('\nSetup updates are not available.\n\n');
      return;
    }

    this.write('\nSetup\n');
    this.write('Press Enter to accept defaults shown in [brackets].\n\n');

    const modeInput = (await this.ask('LLM mode [ollama/external] (ollama): ')).trim().toLowerCase();
    const llmMode = modeInput === 'external' ? 'external' : 'ollama';

    const update: SetupApplyInput = {
      llmMode,
      setupCompleted: true,
      setDefaultProvider: true,
    };

    if (llmMode === 'ollama') {
      const providerName = (await this.ask('Provider name [ollama]: ')).trim() || 'ollama';
      const model = (await this.ask('Model [llama3.2]: ')).trim() || 'llama3.2';
      const baseUrl = (await this.ask('Base URL [http://127.0.0.1:11434]: ')).trim() || 'http://127.0.0.1:11434';
      update.providerName = providerName;
      update.providerType = 'ollama';
      update.model = model;
      update.baseUrl = baseUrl;
    } else {
      const providerName = (await this.ask('Provider name [primary]: ')).trim() || 'primary';
      const providerTypeInput = (await this.ask('Provider type [openai/anthropic] (openai): ')).trim().toLowerCase();
      const providerType = providerTypeInput === 'anthropic' ? 'anthropic' : 'openai';
      const modelDefault = providerType === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4.1-mini';
      const model = (await this.ask(`Model [${modelDefault}]: `)).trim() || modelDefault;
      const apiKey = (await this.ask('API key: ')).trim();
      const baseUrl = (await this.ask('Base URL (optional): ')).trim();

      update.providerName = providerName;
      update.providerType = providerType;
      update.model = model;
      update.apiKey = apiKey;
      if (baseUrl) update.baseUrl = baseUrl;
    }

    const tgEnabledInput = (await this.ask('Enable Telegram? [y/N]: ')).trim().toLowerCase();
    const telegramEnabled = tgEnabledInput === 'y' || tgEnabledInput === 'yes';
    update.telegramEnabled = telegramEnabled;
    if (telegramEnabled) {
      const botToken = (await this.ask('Telegram bot token: ')).trim();
      const allowedInput = (await this.ask('Allowed chat IDs (comma-separated, optional): ')).trim();
      update.telegramBotToken = botToken;
      if (allowedInput) {
        update.telegramAllowedChatIds = parseAllowedChatIds(allowedInput);
      }
    }

    this.write('\nApplying setup...\n');
    const result = await this.dashboard.onSetupApply(update);
    this.write(`${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
  }

  private async maybeRunFirstTimeSetup(): Promise<void> {
    if (!this.dashboard?.onSetupStatus) return;
    const status = await this.dashboard.onSetupStatus();
    if (status.completed) return;

    this.write(`${this.yellow('[setup]')} First-run setup is incomplete. Run ${this.cyan('/setup')} to configure Ollama/API + Telegram.\n\n`);
  }

  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve('');
        return;
      }
      this.rl.question(question, (answer) => resolve(answer));
    });
  }

  // ─── /clear ──────────────────────────────────────────────────

  private handleClear(): void {
    this.write('\x1b[2J\x1b[H');
  }

  // ─── Formatting helpers ──────────────────────────────────────

  private trackAnalytics(event: Parameters<NonNullable<DashboardCallbacks['onAnalyticsTrack']>>[0]): void {
    try {
      this.dashboard?.onAnalyticsTrack?.(event);
    } catch {
      // Ignore analytics failures in user-facing channel flow.
    }
  }

  private write(text: string): void {
    this.output.write(text);
  }

  private green(text: string): string {
    return this.useColor ? `\x1b[32m${text}\x1b[0m` : text;
  }

  private red(text: string): string {
    return this.useColor ? `\x1b[31m${text}\x1b[0m` : text;
  }

  private yellow(text: string): string {
    return this.useColor ? `\x1b[33m${text}\x1b[0m` : text;
  }

  private cyan(text: string): string {
    return this.useColor ? `\x1b[36m${text}\x1b[0m` : text;
  }

  private bold(text: string): string {
    return this.useColor ? `\x1b[1m${text}\x1b[0m` : text;
  }

  private dim(text: string): string {
    return this.useColor ? `\x1b[2m${text}\x1b[0m` : text;
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private colorState(state: string): string {
    switch (state) {
      case 'running':
      case 'idle':
      case 'ready':
        return this.green(state);
      case 'errored':
      case 'dead':
        return this.red(state);
      case 'stalled':
      case 'paused':
        return this.yellow(state);
      default:
        return state;
    }
  }

  private colorSeverity(severity: string): string {
    switch (severity) {
      case 'critical': return this.red(severity);
      case 'warn': return this.yellow(severity);
      case 'info': return this.dim(severity);
      default: return severity;
    }
  }

  private colorIntelSeverity(severity: string): string {
    switch (severity) {
      case 'critical':
        return this.red(severity);
      case 'high':
        return this.red(severity);
      case 'medium':
        return this.yellow(severity);
      case 'low':
        return this.dim(severity);
      default:
        return severity;
    }
  }

  private formatTimeAgo(timestampMs: number): string {
    const diff = Date.now() - timestampMs;
    if (diff < 1000) return 'just now';
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    return `${Math.round(diff / 3_600_000)}h ago`;
  }

  private writeTable(headers: string[], rows: string[][]): void {
    // Calculate column widths (use stripped text for width calculation)
    const colWidths = headers.map((h, i) => {
      const maxRowWidth = rows.reduce((max, row) => {
        return Math.max(max, this.stripAnsi(row[i] ?? '').length);
      }, 0);
      return Math.max(h.length, maxRowWidth);
    });

    // Header
    const headerLine = headers.map((h, i) => this.bold(h.padEnd(colWidths[i]))).join('  ');
    this.write(`  ${headerLine}\n`);

    // Separator
    const sep = colWidths.map(w => '─'.repeat(w)).join('──');
    this.write(`  ${sep}\n`);

    // Rows
    for (const row of rows) {
      const line = row.map((cell, i) => {
        const stripped = this.stripAnsi(cell);
        const pad = colWidths[i] - stripped.length;
        return cell + ' '.repeat(Math.max(0, pad));
      }).join('  ');
      this.write(`  ${line}\n`);
    }
  }

  // ─── Legacy formatting (backward compat) ─────────────────────

  private writeAgentsLegacy(agents: AgentInfo[]): void {
    if (agents.length === 0) {
      this.write('\nNo agents registered.\n\n');
      return;
    }
    this.write('\nRegistered agents:\n');
    for (const a of agents) {
      const caps = a.capabilities.length > 0 ? a.capabilities.join(', ') : 'none';
      this.write(`  ${a.name} (${a.id}) — ${a.state} [${caps}]\n`);
    }
    this.write('\n');
  }

  private writeStatusLegacy(status: RuntimeStatus): void {
    this.write('\nRuntime status:\n');
    this.write(`  Running:   ${status.running ? 'yes' : 'no'}\n`);
    this.write(`  Agents:    ${status.agentCount}\n`);
    this.write(`  Guardian:  ${status.guardianEnabled ? 'enabled' : 'disabled'}\n`);
    this.write(`  Providers: ${status.providers.length > 0 ? status.providers.join(', ') : 'none'}\n`);
    this.write('\n');
  }
}
