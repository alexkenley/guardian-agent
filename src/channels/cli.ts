/**
 * CLI channel adapter.
 *
 * Interactive readline prompt with full dashboard parity.
 * Commands: /chat, /agents, /agent, /status, /assistant, /providers, /budget, /watchdog,
 * /config, /campaign, /connectors, /playbooks, /audit, /security, /models, /intel, /clear, /help, /quit, /exit.
 *
 * Accepts the same DashboardCallbacks interface as the web channel for
 * instant feature parity with zero duplication.
 */

import { createInterface, type Interface } from 'node:readline';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChannelAdapter, MessageCallback } from './types.js';
import type { DashboardCallbacks } from './web-types.js';
import type { SetupApplyInput } from '../runtime/setup.js';
import { createLogger } from '../util/logging.js';
import { formatGuideForCLI } from '../reference-guide.js';

const log = createLogger('channel:cli');

const HISTORY_DIR = join(homedir(), '.guardianagent');
const HISTORY_PATH = join(HISTORY_DIR, 'cli-history');
const MAX_HISTORY = 500;

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
  /** Package version for /version command. */
  version?: string;
  /** Config file path for /diag command. */
  configPath?: string;
  /** Startup status hints displayed in banner. */
  startupStatus?: {
    guardianEnabled?: boolean;
    providerName?: string;
    channels?: string[];
    dashboardUrl?: string;
    authToken?: string;
    warnings?: string[];
  };
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
  private version: string;
  private configPath: string;
  private startupStatus?: CLIChannelOptions['startupStatus'];

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
    this.version = options.version ?? '1.0.0';
    this.configPath = options.configPath ?? '';
    this.startupStatus = options.startupStatus;
  }

  async start(onMessage: MessageCallback): Promise<void> {
    this.onMessage = onMessage;

    // Load persisted command history for Up/Down arrow recall
    let history: string[] = [];
    try {
      if (existsSync(HISTORY_PATH)) {
        history = readFileSync(HISTORY_PATH, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .slice(-MAX_HISTORY);
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load CLI history');
    }

    this.rl = createInterface({
      input: this.input,
      output: this.output,
      prompt: this.prompt,
      history,
      historySize: MAX_HISTORY,
    });

    if (this.useColor) {
      this.writeBanner();
    } else {
      this.write('\nGuardian Agent CLI\n  /help — list all commands  |  /kill — shutdown all services\n\n');
    }
    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      // Persist to history file
      try {
        mkdirSync(HISTORY_DIR, { recursive: true });
        appendFileSync(HISTORY_PATH, trimmed + '\n');
      } catch (err) {
        log.warn({ err }, 'Failed to save CLI history');
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
      case 'mode':
        await this.handleMode(args);
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
      case 'assistant':
        this.handleAssistant(args);
        break;
      case 'tools':
        await this.handleTools(args);
        break;
      case 'skills':
        this.handleSkills(args);
        break;
      case 'campaign':
        await this.handleCampaign(args);
        break;
      case 'connectors':
        await this.handleConnectors(args);
        break;
      case 'playbooks':
        await this.handlePlaybooks(args);
        break;
      case 'config':
        await this.handleConfig(args);
        break;
      case 'auth':
        await this.handleAuth(args);
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
      case 'session':
        await this.handleSession(args);
        break;
      case 'quick':
        await this.handleQuick(args);
        break;
      case 'approve':
      case 'deny':
        // Route through normal chat dispatch so approval UX matches Telegram.
        await this.handleUserMessage(commandLine);
        break;
      case 'analytics':
        this.handleAnalytics(args);
        break;
      case 'intel':
        await this.handleIntel(args);
        break;
      case 'google':
        await this.handleGoogle(args);
        break;
      case 'version':
        this.handleVersion();
        break;
      case 'diag':
        await this.handleDiag();
        break;
      case 'clear':
        this.handleClear();
        break;
      case 'factory-reset':
        await this.handleFactoryReset(args);
        break;
      case 'kill':
      case 'killswitch':
      case 'quit':
      case 'exit':
      case 'close':
      case 'shutdown':
        this.write('\n' + this.red('⚡ KILLSWITCH') + ' — Shutting down all services...\n');
        this.rl?.close();
        if (this.dashboard?.onKillswitch) {
          this.dashboard.onKillswitch();
        }
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
    this.write('  /mode [auto|local|external]            Switch routing mode (auto / local-only / external-only)\n');
    this.write('  /approve [approvalId ...]              Approve pending chat tool action(s)\n');
    this.write('  /deny [approvalId ...]                 Deny pending chat tool action(s)\n');
    this.write('  <text>                                 Send message to active agent\n');
    this.write('\n');
    this.write(this.bold('Status & Monitoring\n'));
    this.write('  /status                                Runtime status overview\n');
    this.write('  /agents                                List all agents\n');
    this.write('  /agent <id>                            Detailed agent info\n');
    this.write('  /providers                             Provider connectivity check\n');
    this.write('  /budget                                Per-agent resource usage\n');
    this.write('  /watchdog                              Watchdog check results\n');
    this.write('  /assistant [summary|sessions|jobs|policy|traces] [limit]  Assistant control-plane state\n');
    this.write('\n');
    this.write(this.bold('Configuration\n'));
    this.write('  /config                                View full config (redacted)\n');
    this.write('  /config provider <name>                View specific provider\n');
    this.write('  /config telegram ...                   Configure Telegram channel (status/on/off/token/chatids)\n');
    this.write('  /config set default <provider>         Change default provider\n');
    this.write('  /config set <provider> <field> <value> Edit provider field\n');
    this.write('  /config add <name> <type> <model> [apiKey]  Add provider\n');
    this.write('  /config test [provider]                Test provider connectivity\n');
    this.write('  /auth [status|rotate|reveal]           Manage web auth/token settings\n');
    this.write('\n');
    this.write(this.bold('Tools\n'));
    this.write('  /tools [list|run|approvals|jobs|policy]  Tool runtime control plane\n');
    this.write('  /tools run <tool> [jsonArgs]            Execute a tool manually\n');
    this.write('  /tools approve <approvalId>             Approve pending tool action\n');
    this.write('  /tools deny <approvalId> [reason]       Deny pending tool action\n');
    this.write('  /tools policy paths <csv>               Set allowed filesystem roots\n');
    this.write('  /tools policy commands <csv>            Set allowlisted shell command prefixes\n');
    this.write('  /tools policy domains <csv>             Set allowlisted network domains\n');
    this.write('  /tools browser                          View browser automation config\n');
    this.write('  /tools browser enable|disable           Enable/disable browser tools\n');
    this.write('  /tools browser domains <csv>            Set browser allowed domains\n');
    this.write('  /tools categories                       Show tool category status\n');
    this.write('  /tools categories enable|disable <cat>  Enable/disable a tool category\n');
    this.write('  /skills [list|show|enable|disable]      Inspect and toggle runtime skills\n');
    this.write('  /campaign ...                            Contact discovery + email campaign workflows\n');
    this.write('  /connectors [status|packs|settings|pack] Connector framework control plane\n');
    this.write('  /playbooks [list|run|upsert|delete|runs] Playbook registry + execution\n');
    this.write('  /google [status|login|logout]           Google Workspace connection\n');
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
    this.write('  /factory-reset data|config|all         ' + this.red('Factory reset (data/config/all)') + '\n');
    this.write('  /session [list|use|new] ...            Session controls\n');
    this.write('  /quick <email|task|calendar> <details> Run quick action workflow\n');
    this.write('  /analytics [minutes]                   Interaction analytics summary\n');
    this.write('  /guide                                 Show reference guide\n');
    this.write('  /version                               Show version\n');
    this.write('  /diag                                  Run system diagnostics\n');
    this.write('  /clear                                 Clear screen\n');
    this.write('  /help                                  Show this help\n');
    this.write('  /kill                                  ' + this.red('Kill all services and exit') + '\n');
    this.write('  /quit /exit /close /shutdown            Aliases for /kill\n');
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
        // Filter: canChat !== false AND not internal tier agents
        const visibleAgents = agents.filter(a => {
          if ('canChat' in a && (a as { canChat?: boolean }).canChat === false) return false;
          if ('internal' in a && (a as { internal?: boolean }).internal) return false;
          return true;
        });
        if (visibleAgents.length > 0) {
          this.write('Available agents:\n');
          for (const a of visibleAgents) {
            const marker = a.id === (this.activeAgentId ?? this.defaultAgentId) ? ' (active)' : '';
            this.write(`  ${a.id} — ${a.name}${marker}\n`);
          }
        } else {
          this.write(`Messages are automatically routed. Use ${this.cyan('/mode')} to switch between auto, local-only, or external-only.\n`);
        }
      }
      this.write('\n');
      return;
    }

    const agentId = args[0];

    // Block switching to internal tier agents — use /mode instead
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
      if ((detail as { internal?: boolean }).internal) {
        this.write(`\nAgent "${agentId}" is managed by automatic routing. Use ${this.cyan('/mode auto|local|external')} to switch routing mode.\n\n`);
        return;
      }
    }

    this.activeAgentId = agentId;
    const newPrompt = `you (${agentId})> `;
    this.prompt = newPrompt;
    this.rl?.setPrompt(newPrompt);
    this.write(`\nSwitched to agent: ${this.cyan(agentId)}\n\n`);
  }

  // ─── /mode ──────────────────────────────────────────────────

  private async handleMode(args: string[]): Promise<void> {
    if (!this.dashboard?.onRoutingMode) {
      this.write(`\nRouting mode not available (no dashboard callbacks).\n\n`);
      return;
    }

    if (args.length === 0) {
      // Show current mode
      const current = this.dashboard.onRoutingMode();
      this.write(`\nRouting mode: ${this.cyan(current.tierMode)}\n`);
      this.write(`  Complexity threshold: ${current.complexityThreshold}\n`);
      this.write(`  Fallback on failure: ${current.fallbackOnFailure}\n`);
      this.write(`\nAvailable modes: ${this.cyan('auto')} | ${this.cyan('local')} | ${this.cyan('external')}\n`);
      this.write(`  auto     — Route by message complexity (recommended)\n`);
      this.write(`  local    — Force all messages to local LLM\n`);
      this.write(`  external — Force all messages to external LLM\n`);
      this.write('\n');
      return;
    }

    const modeArg = args[0].toLowerCase();
    const modeMap: Record<string, 'auto' | 'local-only' | 'external-only'> = {
      auto: 'auto',
      local: 'local-only',
      'local-only': 'local-only',
      external: 'external-only',
      'external-only': 'external-only',
    };

    const mode = modeMap[modeArg];
    if (!mode) {
      this.write(`\n${this.red('Error:')} Invalid mode "${modeArg}". Use: auto, local, or external\n\n`);
      return;
    }

    if (!this.dashboard.onRoutingModeUpdate) {
      this.write(`\nRouting mode update not available.\n\n`);
      return;
    }

    const result = this.dashboard.onRoutingModeUpdate(mode);
    // When switching to auto, clear activeAgentId so messages go through routing
    if (mode === 'auto') {
      this.activeAgentId = undefined;
      this.prompt = 'you> ';
      this.rl?.setPrompt('you> ');
    }
    this.write(`\n${result.message}\n\n`);
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

  // ─── /assistant ──────────────────────────────────────────────

  private handleAssistant(args: string[]): void {
    if (!this.dashboard?.onAssistantState) {
      this.write('\nAssistant state is not available.\n\n');
      return;
    }

    const mode = (args[0] ?? 'summary').toLowerCase();
    const state = this.dashboard.onAssistantState();
    const { summary } = state.orchestrator;

    if (mode === 'sessions') {
      const parsed = args[1] ? Number.parseInt(args[1], 10) : 12;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
      const sessions = state.orchestrator.sessions.slice(0, limit);
      if (sessions.length === 0) {
        this.write('\nNo assistant sessions have run yet.\n\n');
        return;
      }

      const headers = ['Session', 'Status', 'Queue', 'Reqs', 'Wait', 'Exec', 'E2E', 'Last'];
      const rows = sessions.map((session) => [
        `${session.channel}:${session.userId}:${session.agentId}`,
        session.status === 'running'
          ? this.green('running')
          : session.status === 'queued'
          ? this.yellow('queued')
          : this.dim('idle'),
        String(session.queueDepth),
        String(session.totalRequests),
        session.lastQueueWaitMs !== undefined ? `${session.lastQueueWaitMs}ms` : '-',
        session.lastExecutionMs !== undefined ? `${session.lastExecutionMs}ms` : '-',
        session.lastEndToEndMs !== undefined ? `${session.lastEndToEndMs}ms` : '-',
        session.lastCompletedAt ? this.formatTimeAgo(session.lastCompletedAt) : '-',
      ]);

      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (mode === 'jobs') {
      const parsed = args[1] ? Number.parseInt(args[1], 10) : 12;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
      const jobs = state.jobs.jobs.slice(0, limit);
      if (jobs.length === 0) {
        this.write('\nNo tracked jobs yet.\n\n');
        return;
      }
      const headers = ['Job', 'Source', 'Status', 'Started', 'Duration', 'Detail', 'Error'];
      const rows = jobs.map((job) => [
        job.type,
        job.source,
        job.status === 'failed'
          ? this.red('failed')
          : job.status === 'running'
          ? this.yellow('running')
          : this.green('succeeded'),
        this.formatTimeAgo(job.startedAt),
        job.durationMs !== undefined ? `${job.durationMs}ms` : '-',
        job.detail ?? '-',
        job.error ?? '-',
      ]);

      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (mode === 'policy') {
      const parsed = args[1] ? Number.parseInt(args[1], 10) : 12;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
      const decisions = state.lastPolicyDecisions.slice(0, limit);
      if (decisions.length === 0) {
        this.write('\nNo recent policy decisions.\n\n');
        return;
      }
      const headers = ['Time', 'Type', 'Severity', 'Agent', 'Controller', 'Reason'];
      const rows = decisions.map((decision) => [
        this.formatTimeAgo(decision.timestamp),
        decision.type,
        this.colorSeverity(decision.severity),
        decision.agentId,
        decision.controller ?? '-',
        decision.reason ?? '-',
      ]);

      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (mode === 'traces') {
      const parsed = args[1] ? Number.parseInt(args[1], 10) : 12;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
      const traces = state.orchestrator.traces.slice(0, limit);
      if (traces.length === 0) {
        this.write('\nNo recent assistant traces.\n\n');
        return;
      }

      const headers = ['Type', 'Priority', 'Status', 'Session', 'Queue', 'Exec', 'E2E', 'Last Step'];
      const rows = traces.map((trace) => {
        const lastStep = trace.steps.length > 0 ? trace.steps[trace.steps.length - 1] : null;
        const status = trace.status === 'failed'
          ? this.red('failed')
          : trace.status === 'running'
          ? this.yellow('running')
          : trace.status === 'queued'
          ? this.yellow('queued')
          : this.green('succeeded');
        return [
          trace.requestType,
          trace.priority,
          status,
          `${trace.channel}:${trace.userId}:${trace.agentId}`,
          trace.queueWaitMs !== undefined ? `${trace.queueWaitMs}ms` : '-',
          trace.executionMs !== undefined ? `${trace.executionMs}ms` : '-',
          trace.endToEndMs !== undefined ? `${trace.endToEndMs}ms` : '-',
          lastStep ? `${lastStep.name} (${lastStep.status})` : '-',
        ];
      });

      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    this.write('\n');
    this.write(this.bold('Assistant Orchestrator\n'));
    this.write(`  Default provider: ${state.defaultProvider}\n`);
    this.write(`  Providers:        ${state.providers.join(', ') || 'none'}\n`);
    this.write(`  Guardian:         ${state.guardianEnabled ? this.green('enabled') : this.red('disabled')}\n`);
    this.write(`  Uptime:           ${this.formatDuration(summary.uptimeMs)}\n`);
    this.write('\n');
    this.write(`  Sessions:         ${summary.sessionCount}\n`);
    this.write(`  Running:          ${summary.runningCount}\n`);
    this.write(`  Queued:           ${summary.queuedCount}\n`);
    this.write(`  Queue priority:   high=${summary.queuedByPriority.high}, normal=${summary.queuedByPriority.normal}, low=${summary.queuedByPriority.low}\n`);
    this.write(`  Requests:         ${summary.totalRequests} (${summary.completedRequests} success, ${summary.failedRequests} failed)\n`);
    this.write(`  Avg exec latency: ${summary.avgExecutionMs}ms\n`);
    this.write(`  Avg e2e latency:  ${summary.avgEndToEndMs}ms\n`);
    this.write(`  Jobs:             ${state.jobs.summary.running} running, ${state.jobs.summary.failed} failed, ${state.jobs.summary.total} tracked\n`);
    this.write(`  Policy events:    ${state.lastPolicyDecisions.length} recent decisions\n`);

    if (state.orchestrator.sessions.length > 0) {
      this.write('\n');
      this.write(this.bold('  Recent sessions:\n'));
      for (const session of state.orchestrator.sessions.slice(0, 5)) {
        const status = session.status === 'running'
          ? this.green('running')
          : session.status === 'queued'
          ? this.yellow('queued')
          : this.dim('idle');
        const queue = session.queueDepth > 0 ? `queue=${session.queueDepth}` : 'queue=0';
        const exec = session.lastExecutionMs !== undefined ? `exec=${session.lastExecutionMs}ms` : 'exec=-';
        const e2e = session.lastEndToEndMs !== undefined ? `e2e=${session.lastEndToEndMs}ms` : 'e2e=-';
        this.write(`    ${status} ${session.channel}:${session.userId}:${session.agentId} (${queue}, ${exec}, ${e2e})\n`);
      }
      this.write(`\n  Use ${this.cyan('/assistant sessions')} for full table.\n`);
    }
    this.write(`  Use ${this.cyan('/assistant jobs')} for background jobs.\n`);
    this.write(`  Use ${this.cyan('/assistant policy')} for recent policy decisions.\n`);
    this.write(`  Use ${this.cyan('/assistant traces')} for request step traces.\n`);

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
      case 'telegram':
        await this.handleConfigTelegram(args.slice(1));
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
        this.write('Usage: /config [provider|telegram|set|add|test]\n\n');
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
    if (config.channels.telegram) {
      this.write(`  Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}\n`);
      this.write(`  Telegram token: ${config.channels.telegram.botTokenConfigured ? 'configured' : 'not configured'}\n`);
      const allowlist = config.channels.telegram.allowedChatIds?.length
        ? config.channels.telegram.allowedChatIds.join(', ')
        : 'not set';
      this.write(`  Telegram chat IDs: ${allowlist}\n`);
    }
    if (config.channels.web) {
      this.write(`  Web:      ${config.channels.web.enabled ? 'enabled' : 'disabled'}`);
      if (config.channels.web.port) this.write(` (port ${config.channels.web.port})`);
      this.write('\n');
      if (config.channels.web.auth) {
        this.write(`  Web auth: ${config.channels.web.auth.mode} (${config.channels.web.auth.tokenConfigured ? 'token configured' : 'no token'})\n`);
      }
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
    this.write(`  Config baseline: ${config.assistant.setupCompleted ? this.green('yes') : this.yellow('no')}\n`);
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

  private async handleConfigTelegram(args: string[]): Promise<void> {
    if (!this.dashboard?.onConfig) {
      this.write('\nConfig not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'status').toLowerCase();
    const telegram = this.dashboard.onConfig().channels.telegram;

    if (sub === 'status' || sub === 'show') {
      this.write('\n');
      this.write(this.bold('Telegram Channel\n'));
      this.write(`  Enabled:          ${telegram?.enabled ? this.green('yes') : this.yellow('no')}\n`);
      this.write(`  Bot token:        ${telegram?.botTokenConfigured ? this.green('configured') : this.red('not configured')}\n`);
      const allowlist = telegram?.allowedChatIds?.length
        ? telegram.allowedChatIds.join(', ')
        : 'not set (all chats allowed)';
      this.write(`  Allowed chat IDs: ${allowlist}\n`);
      if (telegram?.defaultAgent) this.write(`  Default agent:    ${telegram.defaultAgent}\n`);
      this.write('\n');
      this.write('Usage:\n');
      this.write('  /config telegram on|off\n');
      this.write('  /config telegram token <token|clear>\n');
      this.write('  /config telegram chatids <id1,id2,...|clear>\n\n');
      return;
    }

    if (!this.dashboard.onConfigUpdate) {
      this.write('\nConfig updates not available.\n\n');
      return;
    }

    if (sub === 'on' || sub === 'enable' || sub === 'off' || sub === 'disable') {
      const enabled = sub === 'on' || sub === 'enable';
      const result = await this.dashboard.onConfigUpdate({
        channels: {
          telegram: {
            enabled,
          },
        },
      });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n`);
      if (result.success) this.write('Restart required for Telegram channel changes to take effect.\n');
      this.write('\n');
      return;
    }

    if (sub === 'token') {
      const tokenValue = args.slice(1).join(' ').trim();
      if (!tokenValue) {
        this.write('\nUsage: /config telegram token <token|clear>\n\n');
        return;
      }
      const botToken = tokenValue.toLowerCase() === 'clear' ? '' : tokenValue;
      const result = await this.dashboard.onConfigUpdate({
        channels: {
          telegram: {
            botToken,
          },
        },
      });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n`);
      if (result.success) this.write('Restart required for Telegram channel changes to take effect.\n');
      this.write('\n');
      return;
    }

    if (sub === 'chatids' || sub === 'chats') {
      const listRaw = args.slice(1).join(' ').trim();
      if (!listRaw) {
        this.write('\nUsage: /config telegram chatids <id1,id2,...|clear>\n\n');
        return;
      }

      let chatIds: number[];
      if (listRaw.toLowerCase() === 'clear') {
        chatIds = [];
      } else {
        chatIds = this.parseChatIdList(listRaw);
        if (chatIds.length === 0) {
          this.write('\nNo valid chat IDs found. Use a comma-separated numeric list.\n\n');
          return;
        }
      }

      const result = await this.dashboard.onConfigUpdate({
        channels: {
          telegram: {
            allowedChatIds: chatIds,
          },
        },
      });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n`);
      if (result.success) this.write('Restart required for Telegram channel changes to take effect.\n');
      this.write('\n');
      return;
    }

    this.write(`\nUnknown /config telegram subcommand: ${sub}\n`);
    this.write('Usage:\n');
    this.write('  /config telegram status\n');
    this.write('  /config telegram on|off\n');
    this.write('  /config telegram token <token|clear>\n');
    this.write('  /config telegram chatids <id1,id2,...|clear>\n\n');
  }

  private parseChatIdList(value: string): number[] {
    return value
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id));
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

  // ─── /auth ───────────────────────────────────────────────────

  private async handleAuth(args: string[]): Promise<void> {
    if (!this.dashboard?.onAuthStatus) {
      this.write('\nAuth controls are not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'status').toLowerCase();
    if (sub === 'status') {
      const status = this.dashboard.onAuthStatus();
      this.write('\n');
      this.write(this.bold('Web Auth\n'));
      this.write(`  Mode:            ${status.mode}\n`);
      this.write(`  Token:           ${status.tokenConfigured ? this.green('configured') : this.red('missing')}\n`);
      this.write(`  Token source:    ${status.tokenSource}\n`);
      if (status.tokenPreview) this.write(`  Token preview:   ${status.tokenPreview}\n`);
      this.write(`  Rotate startup:  ${status.rotateOnStartup ? 'yes' : 'no'}\n`);
      if (status.sessionTtlMinutes) this.write(`  Session TTL:     ${status.sessionTtlMinutes} minutes\n`);
      this.write(`  Endpoint:        http://${status.host}:${status.port}\n`);
      this.write('\n');
      return;
    }

    if (sub === 'rotate') {
      if (!this.dashboard.onAuthRotate) {
        this.write('\nToken rotation is not available.\n\n');
        return;
      }
      const result = await this.dashboard.onAuthRotate();
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n`);
      if (result.token) {
        this.write(`  New token: ${this.cyan(result.token)}\n`);
      }
      this.write('\n');
      return;
    }

    if (sub === 'reveal') {
      if (!this.dashboard.onAuthReveal) {
        this.write('\nToken reveal is not available.\n\n');
        return;
      }
      const result = await this.dashboard.onAuthReveal();
      if (result.success && result.token) {
        this.write(`\nToken: ${this.cyan(result.token)}\n\n`);
      } else {
        this.write('\nNo token configured.\n\n');
      }
      return;
    }

    this.write('\nUsage: /auth [status|rotate|reveal]\n\n');
  }

  // ─── /tools ──────────────────────────────────────────────────

  private async handleTools(args: string[]): Promise<void> {
    if (!this.dashboard?.onToolsState) {
      this.write('\nTools runtime is not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'list').toLowerCase();
    const state = this.dashboard.onToolsState({ limit: 40 });
    const writeToolNotices = (): void => {
      if (!state.notices?.length) return;
      this.write('\n');
      for (const notice of state.notices) {
        const prefix = notice.level === 'warn' ? this.yellow('WARN') : this.dim('INFO');
        this.write(`${prefix}: ${notice.message}\n`);
      }
      this.write('\n');
    };

    if (sub === 'list') {
      writeToolNotices();
      if (state.tools.length === 0) {
        this.write('\nNo tools are registered.\n\n');
        return;
      }
      const headers = ['Name', 'Risk', 'Description'];
      const rows = state.tools.map((tool) => [
        tool.name,
        tool.risk,
        tool.description,
      ]);
      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (sub === 'run') {
      if (!this.dashboard.onToolsRun) {
        this.write('\nTool execution is not available.\n\n');
        return;
      }
      const toolName = args[1];
      if (!toolName) {
        this.write('\nUsage: /tools run <toolName> [jsonArgs]\n\n');
        return;
      }
      let parsedArgs: Record<string, unknown> = {};
      const jsonRaw = args.slice(2).join(' ').trim();
      if (jsonRaw) {
        try {
          parsedArgs = JSON.parse(jsonRaw) as Record<string, unknown>;
        } catch {
          this.write('\nInvalid JSON args. Example: /tools run fs_list {"path":"docs"}\n\n');
          return;
        }
      }
      const result = await this.dashboard.onToolsRun({
        toolName,
        args: parsedArgs,
        origin: 'cli',
        agentId: this.activeAgentId ?? this.defaultAgentId,
        userId: this.defaultUserId,
        channel: 'cli',
      });
      const statusLabel = result.success
        ? this.green('OK')
        : result.status === 'pending_approval'
          ? this.yellow('INFO')
          : this.red('FAIL');
      this.write(`\n${statusLabel}: ${result.message}\n`);
      this.write(`  Job: ${result.jobId}\n`);
      if (result.approvalId) this.write(`  Approval: ${result.approvalId}\n`);
      if (result.output !== undefined) {
        const rendered = JSON.stringify(result.output, null, 2);
        this.write(`  Output:\n${this.dim(rendered)}\n`);
      }
      this.write('\n');
      return;
    }

    if (sub === 'approvals') {
      const pendingOnly = args[1] === 'pending';
      const approvals = pendingOnly
        ? state.approvals.filter((approval) => approval.status === 'pending')
        : state.approvals;
      if (approvals.length === 0) {
        this.write('\nNo approvals found.\n\n');
        return;
      }
      const headers = ['Approval', 'Tool', 'Status', 'Risk', 'Origin', 'Created'];
      const rows = approvals.map((approval) => [
        approval.id,
        approval.toolName,
        approval.status,
        approval.risk,
        approval.origin,
        new Date(approval.createdAt).toLocaleTimeString(),
      ]);
      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (sub === 'approve' || sub === 'deny') {
      if (!this.dashboard.onToolsApprovalDecision) {
        this.write('\nApproval decisions are not available.\n\n');
        return;
      }
      const approvalId = args[1];
      if (!approvalId) {
        this.write(`\nUsage: /tools ${sub} <approvalId>${sub === 'deny' ? ' [reason]' : ''}\n\n`);
        return;
      }
      const reason = sub === 'deny' ? args.slice(2).join(' ').trim() : undefined;
      const result = await this.dashboard.onToolsApprovalDecision({
        approvalId,
        decision: sub === 'approve' ? 'approved' : 'denied',
        actor: 'cli-user',
        reason: reason || undefined,
      });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    if (sub === 'jobs') {
      if (state.jobs.length === 0) {
        this.write('\nNo tool jobs yet.\n\n');
        return;
      }
      const headers = ['Job', 'Tool', 'Status', 'Origin', 'Duration', 'Details'];
      const rows = state.jobs.map((job) => [
        job.id,
        job.toolName,
        job.status,
        job.origin,
        job.durationMs !== undefined ? `${job.durationMs}ms` : '-',
        job.error ?? job.resultPreview ?? '-',
      ]);
      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (sub === 'policy') {
      if (args[1] === 'mode') {
        if (!this.dashboard.onToolsPolicyUpdate) {
          this.write('\nTool policy updates are not available.\n\n');
          return;
        }
        const mode = args[2];
        if (!mode || !['approve_each', 'approve_by_policy', 'autonomous'].includes(mode)) {
          this.write('\nUsage: /tools policy mode <approve_each|approve_by_policy|autonomous>\n\n');
          return;
        }
        const result = this.dashboard.onToolsPolicyUpdate({
          mode: mode as 'approve_each' | 'approve_by_policy' | 'autonomous',
        });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      if (args[1] === 'paths' || args[1] === 'commands' || args[1] === 'domains') {
        if (!this.dashboard.onToolsPolicyUpdate) {
          this.write('\nTool policy updates are not available.\n\n');
          return;
        }
        const field = args[1];
        const csv = args.slice(2).join(' ').trim();
        if (!csv) {
          this.write(`\nUsage: /tools policy ${field} <comma,separated,values>\n\n`);
          return;
        }
        const values = csv.split(',').map((item) => item.trim()).filter(Boolean);
        if (values.length === 0) {
          this.write(`\nUsage: /tools policy ${field} <comma,separated,values>\n\n`);
          return;
        }
        const sandbox = field === 'paths'
          ? { allowedPaths: values }
          : field === 'commands'
          ? { allowedCommands: values }
          : { allowedDomains: values };
        const result = this.dashboard.onToolsPolicyUpdate({ sandbox });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      this.write('\n');
      writeToolNotices();
      this.write(this.bold('Tool Policy\n'));
      this.write(`  Mode: ${state.policy.mode}\n`);
      this.write(`  Allowed paths: ${state.policy.sandbox.allowedPaths.join(', ') || 'none'}\n`);
      this.write(`  Allowed commands: ${state.policy.sandbox.allowedCommands.join(', ') || 'none'}\n`);
      this.write(`  Allowed domains: ${state.policy.sandbox.allowedDomains.join(', ') || 'none'}\n`);
      const overrides = Object.entries(state.policy.toolPolicies);
      if (overrides.length > 0) {
        this.write('  Overrides:\n');
        for (const [tool, value] of overrides) {
          this.write(`    ${tool}: ${value}\n`);
        }
      }
      this.write('\n');
      return;
    }

    if (sub === 'browser') {
      const browserSub = (args[1] ?? '').toLowerCase();
      if (browserSub === 'enable' || browserSub === 'on') {
        if (!this.dashboard.onBrowserConfigUpdate) {
          this.write('\nBrowser config updates are not available.\n\n');
          return;
        }
        const result = this.dashboard.onBrowserConfigUpdate({ enabled: true });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      if (browserSub === 'disable' || browserSub === 'off') {
        if (!this.dashboard.onBrowserConfigUpdate) {
          this.write('\nBrowser config updates are not available.\n\n');
          return;
        }
        const result = this.dashboard.onBrowserConfigUpdate({ enabled: false });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      if (browserSub === 'domains') {
        if (!this.dashboard.onBrowserConfigUpdate) {
          this.write('\nBrowser config updates are not available.\n\n');
          return;
        }
        const csv = args.slice(2).join(' ').trim();
        if (!csv) {
          this.write('\nUsage: /tools browser domains <comma,separated,domains>\n\n');
          return;
        }
        const domains = csv.split(',').map((d) => d.trim()).filter(Boolean);
        const result = this.dashboard.onBrowserConfigUpdate({ allowedDomains: domains });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      // Default: show browser config state
      if (this.dashboard.onBrowserConfigState) {
        const state = this.dashboard.onBrowserConfigState();
        this.write('\n');
        this.write(this.bold('Browser Automation\n'));
        this.write(`  Enabled:          ${state.enabled ? this.green('yes') : this.yellow('no')}\n`);
        this.write(`  Allowed domains:  ${state.allowedDomains.join(', ') || '(uses global tools allowedDomains)'}\n`);
        this.write(`  Idle timeout:     ${state.sessionIdleTimeoutMs / 1000}s\n`);
        this.write(`  Max sessions:     ${state.maxSessions}\n`);
        this.write('\n');
      } else {
        this.write('\nBrowser config is not available.\n\n');
      }
      return;
    }

    if (sub === 'categories') {
      const catSub = (args[1] ?? '').toLowerCase();
      if (catSub === 'enable' || catSub === 'disable') {
        if (!this.dashboard.onToolsCategoryToggle) {
          this.write('\nCategory management is not available.\n\n');
          return;
        }
        const catName = args[2];
        if (!catName) {
          this.write(`\nUsage: /tools categories ${catSub} <category>\n\n`);
          return;
        }
        const result = this.dashboard.onToolsCategoryToggle({
          category: catName as import('../tools/types.js').ToolCategory,
          enabled: catSub === 'enable',
        });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      // Default: show categories table
      const categories = state.categories ?? this.dashboard.onToolsCategories?.();
      if (categories) {
        writeToolNotices();
        const headers = ['Category', 'Label', 'Tools', 'Status', 'Description'];
        const rows = categories.map((cat) => [
          cat.category,
          cat.label,
          String(cat.toolCount),
          cat.enabled ? this.green('enabled') : this.yellow('disabled'),
          cat.disabledReason ? `${cat.description} (${cat.disabledReason})` : cat.description,
        ]);
        this.write('\n');
        this.writeTable(headers, rows);
        this.write('\n');
      } else {
        this.write('\nCategory info is not available.\n\n');
      }
      return;
    }

    this.write('\nUsage: /tools [list|run|approvals|approve|deny|jobs|policy|browser|categories]\n');
    this.write('       /tools policy mode <approve_each|approve_by_policy|autonomous>\n');
    this.write('       /tools policy paths <comma,separated,paths>\n');
    this.write('       /tools policy commands <comma,separated,prefixes>\n');
    this.write('       /tools policy domains <comma,separated,domains>\n');
    this.write('       /tools browser [enable|disable|domains <csv>]\n');
    this.write('       /tools categories [enable|disable <name>]\n\n');
  }

  // ─── /skills ────────────────────────────────────────────────

  private handleSkills(args: string[]): void {
    if (!this.dashboard?.onSkillsState) {
      this.write('\nSkills runtime is not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'list').toLowerCase();
    const state = this.dashboard.onSkillsState();

    if (sub === 'list') {
      if (state.skills.length === 0) {
        this.write('\nNo skills are loaded.\n\n');
        return;
      }
      const headers = ['ID', 'Enabled', 'Provider', 'Risk', 'Description'];
      const rows = state.skills.map((skill) => [
        skill.id,
        skill.enabled ? this.green('yes') : this.yellow('no'),
        skill.requiredManagedProvider
          ? `${skill.requiredManagedProvider}${skill.providerReady ? '' : ' (inactive)'}`
          : '-',
        skill.risk,
        skill.description,
      ]);
      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (sub === 'show') {
      const skillId = args[1];
      if (!skillId) {
        this.write('\nUsage: /skills show <skillId>\n\n');
        return;
      }
      const skill = state.skills.find((entry) => entry.id === skillId);
      if (!skill) {
        this.write(`\nSkill "${skillId}" not found.\n\n`);
        return;
      }
      this.write('\n');
      this.write(this.bold(`${skill.name}\n`));
      this.write(`  ID:                 ${skill.id}\n`);
      this.write(`  Version:            ${skill.version}\n`);
      this.write(`  Enabled:            ${skill.enabled ? this.green('yes') : this.yellow('no')}\n`);
      this.write(`  Risk:               ${skill.risk}\n`);
      this.write(`  Description:        ${skill.description}\n`);
      this.write(`  Tags:               ${skill.tags.length > 0 ? skill.tags.join(', ') : '-'}\n`);
      this.write(`  Required provider:  ${skill.requiredManagedProvider ?? '-'}\n`);
      if (skill.requiredManagedProvider) {
        this.write(`  Provider ready:     ${skill.providerReady ? this.green('yes') : this.yellow('no')}\n`);
      }
      this.write(`  Required caps:      ${skill.requiredCapabilities.length > 0 ? skill.requiredCapabilities.join(', ') : '-'}\n`);
      this.write(`  Suggested tools:    ${skill.tools.length > 0 ? skill.tools.join(', ') : '-'}\n`);
      this.write(`  Root:               ${skill.rootDir}\n`);
      this.write(`  Source:             ${skill.sourcePath}\n`);
      if (skill.disabledReason) {
        this.write(`  Note:               ${this.yellow(skill.disabledReason)}\n`);
      }
      this.write('\n');
      return;
    }

    if (sub === 'enable' || sub === 'disable') {
      if (!this.dashboard.onSkillsUpdate) {
        this.write('\nSkill updates are not available.\n\n');
        return;
      }
      const skillId = args[1];
      if (!skillId) {
        this.write(`\nUsage: /skills ${sub} <skillId>\n\n`);
        return;
      }
      const result = this.dashboard.onSkillsUpdate({ skillId, enabled: sub === 'enable' });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    this.write('\nUsage: /skills [list|show|enable|disable]\n');
    this.write('       /skills show <skillId>\n');
    this.write('       /skills enable <skillId>\n');
    this.write('       /skills disable <skillId>\n\n');
  }

  // ─── /campaign ───────────────────────────────────────────────

  private async handleCampaign(args: string[]): Promise<void> {
    if (!this.dashboard?.onToolsRun) {
      this.write('\nCampaign tools are not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'help').toLowerCase();

    if (sub === 'help') {
      this.write('\n');
      this.write(this.bold('Campaign Commands\n'));
      this.write('  /campaign discover <url> [tagsCsv]\n');
      this.write('  /campaign import <csvPath> [source]\n');
      this.write('  /campaign contacts [limit] [query]\n');
      this.write('  /campaign create <name> | <subjectTemplate> | <bodyTemplate>\n');
      this.write('  /campaign add <campaignId> <contactId[,contactId...]>\n');
      this.write('  /campaign list [limit]\n');
      this.write('  /campaign preview <campaignId> [limit]\n');
      this.write('  /campaign run <campaignId> [maxRecipients]\n');
      this.write('\n');
      this.write('Notes:\n');
      this.write('  - /campaign run is approval-gated before any email is sent.\n');
      this.write('  - Provide Gmail OAuth token via tool args or GOOGLE_OAUTH_ACCESS_TOKEN env var.\n\n');
      return;
    }

    if (sub === 'discover') {
      const url = args[1];
      if (!url) {
        this.write('\nUsage: /campaign discover <url> [tagsCsv]\n\n');
        return;
      }
      const tags = parseCsvList(args[2]);
      await this.runToolFromCLI('contacts_discover_browser', { url, tags });
      return;
    }

    if (sub === 'import') {
      const path = args[1];
      if (!path) {
        this.write('\nUsage: /campaign import <csvPath> [source]\n\n');
        return;
      }
      const source = args.slice(2).join(' ').trim();
      await this.runToolFromCLI('contacts_import_csv', {
        path,
        source: source || undefined,
      });
      return;
    }

    if (sub === 'contacts') {
      const limit = args[1] ? Number.parseInt(args[1], 10) : 25;
      const query = args.slice(2).join(' ').trim();
      await this.runToolFromCLI('contacts_list', {
        limit: Number.isFinite(limit) ? limit : 25,
        query: query || undefined,
      });
      return;
    }

    if (sub === 'create') {
      const raw = args.slice(1).join(' ');
      const parts = raw.split(/\s*\|\s*/).map((part) => part.trim()).filter(Boolean);
      if (parts.length < 3) {
        this.write('\nUsage: /campaign create <name> | <subjectTemplate> | <bodyTemplate>\n\n');
        return;
      }
      await this.runToolFromCLI('campaign_create', {
        name: parts[0],
        subjectTemplate: parts[1],
        bodyTemplate: parts.slice(2).join(' | '),
      });
      return;
    }

    if (sub === 'add') {
      const campaignId = args[1];
      const contactCsv = args[2];
      if (!campaignId || !contactCsv) {
        this.write('\nUsage: /campaign add <campaignId> <contactId[,contactId...]>\n\n');
        return;
      }
      await this.runToolFromCLI('campaign_add_contacts', {
        campaignId,
        contactIds: parseCsvList(contactCsv),
      });
      return;
    }

    if (sub === 'list') {
      const limit = args[1] ? Number.parseInt(args[1], 10) : 25;
      await this.runToolFromCLI('campaign_list', {
        limit: Number.isFinite(limit) ? limit : 25,
      });
      return;
    }

    if (sub === 'preview') {
      const campaignId = args[1];
      if (!campaignId) {
        this.write('\nUsage: /campaign preview <campaignId> [limit]\n\n');
        return;
      }
      const limit = args[2] ? Number.parseInt(args[2], 10) : 10;
      await this.runToolFromCLI('campaign_dry_run', {
        campaignId,
        limit: Number.isFinite(limit) ? limit : 10,
      });
      return;
    }

    if (sub === 'run') {
      const campaignId = args[1];
      if (!campaignId) {
        this.write('\nUsage: /campaign run <campaignId> [maxRecipients]\n\n');
        return;
      }
      const maxRecipients = args[2] ? Number.parseInt(args[2], 10) : 100;
      await this.runToolFromCLI('campaign_run', {
        campaignId,
        maxRecipients: Number.isFinite(maxRecipients) ? maxRecipients : 100,
      });
      return;
    }

    this.write('\nUsage: /campaign help\n\n');
  }

  private async runToolFromCLI(toolName: string, args: Record<string, unknown>): Promise<void> {
    if (!this.dashboard?.onToolsRun) {
      this.write('\nTool execution is not available.\n\n');
      return;
    }

    const result = await this.dashboard.onToolsRun({
      toolName,
      args,
      origin: 'cli',
      agentId: this.activeAgentId ?? this.defaultAgentId,
      userId: this.defaultUserId,
      channel: 'cli',
    });
    this.write(`\n${result.success ? this.green('OK') : this.yellow('INFO')}: ${result.message}\n`);
    this.write(`  Job: ${result.jobId}\n`);
    if (result.approvalId) this.write(`  Approval: ${result.approvalId}\n`);
    if (result.output !== undefined) {
      const rendered = JSON.stringify(result.output, null, 2);
      this.write(`  Output:\n${this.dim(rendered)}\n`);
    }
    this.write('\n');
  }

  // ─── /connectors ─────────────────────────────────────────────

  private async handleConnectors(args: string[]): Promise<void> {
    if (!this.dashboard?.onConnectorsState) {
      this.write('\nConnector framework is not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'status').toLowerCase();
    const state = this.dashboard.onConnectorsState({ limitRuns: 20 });

    if (sub === 'status') {
      this.write('\n');
      this.write(this.bold('Connector Framework\n'));
      this.write(`  Enabled: ${state.summary.enabled ? this.green('true') : this.yellow('false')}\n`);
      this.write(`  Execution mode: ${state.summary.executionMode}\n`);
      this.write(`  Max calls/run: ${state.summary.maxConnectorCallsPerRun}\n`);
      this.write(`  Packs: ${state.summary.enabledPackCount}/${state.summary.packCount} enabled\n`);
      this.write(`  Playbooks: ${state.summary.enabledPlaybookCount}/${state.summary.playbookCount} enabled\n`);
      this.write(`  Runs tracked: ${state.summary.runCount}\n`);
      this.write(`  Dry-run qualified: ${state.summary.dryRunQualifiedCount}\n`);
      this.write('\n');
      this.write(this.bold('Playbook Controls\n'));
      this.write(`  Enabled: ${state.playbooksConfig.enabled}\n`);
      this.write(`  Max steps: ${state.playbooksConfig.maxSteps}\n`);
      this.write(`  Max parallel: ${state.playbooksConfig.maxParallelSteps}\n`);
      this.write(`  Step timeout: ${state.playbooksConfig.defaultStepTimeoutMs}ms\n`);
      this.write(`  Require signed: ${state.playbooksConfig.requireSignedDefinitions}\n`);
      this.write(`  Require dry-run first: ${state.playbooksConfig.requireDryRunOnFirstExecution}\n`);
      this.write('\n');
      return;
    }

    if (sub === 'packs') {
      if (state.packs.length === 0) {
        this.write('\nNo connector packs configured.\n\n');
        return;
      }
      const headers = ['ID', 'Name', 'Enabled', 'Auth', 'Capabilities', 'Hosts'];
      const rows = state.packs.map((pack) => [
        pack.id,
        pack.name,
        String(pack.enabled),
        pack.authMode,
        pack.allowedCapabilities.join(', ') || '-',
        pack.allowedHosts.join(', ') || '-',
      ]);
      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (sub === 'settings') {
      if (!this.dashboard.onConnectorsSettingsUpdate) {
        this.write('\nConnector settings updates are not available.\n\n');
        return;
      }
      const printSettingsUsage = () => {
        this.write('  /connectors settings enable|disable\n');
        this.write('  /connectors settings mode <plan_then_execute|direct_execute>\n');
        this.write('  /connectors settings limit <number>\n');
        this.write('  /connectors settings playbooks <on|off>\n');
        this.write('  /connectors settings playbooks enabled <on|off>\n');
        this.write('  /connectors settings playbooks max-steps <number>\n');
        this.write('  /connectors settings playbooks max-parallel <number>\n');
        this.write('  /connectors settings playbooks timeout-ms <milliseconds>\n');
        this.write('  /connectors settings playbooks require-signed <on|off>\n');
        this.write('  /connectors settings playbooks require-dryrun <on|off>\n');
        this.write('  /connectors settings studio enabled <on|off>\n');
        this.write('  /connectors settings studio mode <read_only|builder>\n');
        this.write('  /connectors settings studio ticket <on|off>\n');
        this.write('  /connectors settings json <json>\n');
      };
      const parseToggle = (value: string | undefined): boolean | null => {
        const lowered = (value ?? '').toLowerCase();
        if (lowered === 'on' || lowered === 'true') return true;
        if (lowered === 'off' || lowered === 'false') return false;
        return null;
      };
      const action = (args[1] ?? '').toLowerCase();
      if (!action) {
        this.write('\nUsage:\n');
        printSettingsUsage();
        this.write('\n');
        return;
      }

      if (action === 'enable' || action === 'disable') {
        const result = this.dashboard.onConnectorsSettingsUpdate({ enabled: action === 'enable' });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }

      if (action === 'mode') {
        const mode = args[2];
        if (!mode || !['plan_then_execute', 'direct_execute'].includes(mode)) {
          this.write('\nUsage: /connectors settings mode <plan_then_execute|direct_execute>\n\n');
          return;
        }
        const result = this.dashboard.onConnectorsSettingsUpdate({
          executionMode: mode as 'plan_then_execute' | 'direct_execute',
        });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }

      if (action === 'limit') {
        const parsed = Number.parseInt(args[2] ?? '', 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          this.write('\nUsage: /connectors settings limit <number>=1\n\n');
          return;
        }
        const result = this.dashboard.onConnectorsSettingsUpdate({ maxConnectorCallsPerRun: parsed });
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }

      if (action === 'json') {
        const raw = args.slice(2).join(' ').trim();
        if (!raw) {
          this.write('\nUsage: /connectors settings json <json>\n\n');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.write('\nInvalid JSON for connector settings update.\n\n');
          return;
        }
        const result = this.dashboard.onConnectorsSettingsUpdate(parsed as Parameters<NonNullable<DashboardCallbacks['onConnectorsSettingsUpdate']>>[0]);
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }

      if (action === 'playbooks') {
        const field = (args[2] ?? '').toLowerCase();
        if (!field) {
          this.write('\nUsage:\n');
          this.write('  /connectors settings playbooks <on|off>\n');
          this.write('  /connectors settings playbooks enabled <on|off>\n');
          this.write('  /connectors settings playbooks max-steps <number>\n');
          this.write('  /connectors settings playbooks max-parallel <number>\n');
          this.write('  /connectors settings playbooks timeout-ms <milliseconds>\n');
          this.write('  /connectors settings playbooks require-signed <on|off>\n');
          this.write('  /connectors settings playbooks require-dryrun <on|off>\n\n');
          return;
        }
        if (field === 'on' || field === 'off' || field === 'true' || field === 'false') {
          const enabled = parseToggle(field);
          const result = this.dashboard.onConnectorsSettingsUpdate({
            playbooks: { enabled: enabled === true },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'enabled') {
          const enabled = parseToggle(args[3]);
          if (enabled === null) {
            this.write('\nUsage: /connectors settings playbooks enabled <on|off>\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({ playbooks: { enabled } });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'max-steps') {
          const parsed = Number.parseInt(args[3] ?? '', 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            this.write('\nUsage: /connectors settings playbooks max-steps <number>=1\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({
            playbooks: { maxSteps: parsed },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'max-parallel') {
          const parsed = Number.parseInt(args[3] ?? '', 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            this.write('\nUsage: /connectors settings playbooks max-parallel <number>=1\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({
            playbooks: { maxParallelSteps: parsed },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'timeout-ms' || field === 'timeout') {
          const parsed = Number.parseInt(args[3] ?? '', 10);
          if (!Number.isFinite(parsed) || parsed < 1000) {
            this.write('\nUsage: /connectors settings playbooks timeout-ms <milliseconds>=1000\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({
            playbooks: { defaultStepTimeoutMs: parsed },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'require-signed') {
          const required = parseToggle(args[3]);
          if (required === null) {
            this.write('\nUsage: /connectors settings playbooks require-signed <on|off>\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({
            playbooks: { requireSignedDefinitions: required },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'require-dryrun' || field === 'require-dry-run') {
          const required = parseToggle(args[3]);
          if (required === null) {
            this.write('\nUsage: /connectors settings playbooks require-dryrun <on|off>\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({
            playbooks: { requireDryRunOnFirstExecution: required },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        this.write('\nUsage:\n');
        this.write('  /connectors settings playbooks <on|off>\n');
        this.write('  /connectors settings playbooks enabled <on|off>\n');
        this.write('  /connectors settings playbooks max-steps <number>\n');
        this.write('  /connectors settings playbooks max-parallel <number>\n');
        this.write('  /connectors settings playbooks timeout-ms <milliseconds>\n');
        this.write('  /connectors settings playbooks require-signed <on|off>\n');
        this.write('  /connectors settings playbooks require-dryrun <on|off>\n\n');
        return;
      }

      if (action === 'studio') {
        const field = (args[2] ?? '').toLowerCase();
        if (!field) {
          this.write('\nUsage:\n');
          this.write('  /connectors settings studio enabled <on|off>\n');
          this.write('  /connectors settings studio mode <read_only|builder>\n');
          this.write('  /connectors settings studio ticket <on|off>\n\n');
          return;
        }
        if (field === 'enabled') {
          const enabled = parseToggle(args[3]);
          if (enabled === null) {
            this.write('\nUsage: /connectors settings studio enabled <on|off>\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({ studio: { enabled } });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'mode') {
          const mode = args[3];
          if (!mode || !['read_only', 'builder'].includes(mode)) {
            this.write('\nUsage: /connectors settings studio mode <read_only|builder>\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({
            studio: { mode: mode as 'read_only' | 'builder' },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        if (field === 'ticket') {
          const enabled = parseToggle(args[3]);
          if (enabled === null) {
            this.write('\nUsage: /connectors settings studio ticket <on|off>\n\n');
            return;
          }
          const result = this.dashboard.onConnectorsSettingsUpdate({
            studio: { requirePrivilegedTicket: enabled },
          });
          this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
          return;
        }
        this.write('\nUsage:\n');
        this.write('  /connectors settings studio enabled <on|off>\n');
        this.write('  /connectors settings studio mode <read_only|builder>\n');
        this.write('  /connectors settings studio ticket <on|off>\n\n');
        return;
      }

      this.write('\nUsage:\n');
      printSettingsUsage();
      this.write('\n');
      return;
    }

    if (sub === 'pack') {
      const action = (args[1] ?? '').toLowerCase();
      if (action === 'upsert') {
        if (!this.dashboard.onConnectorsPackUpsert) {
          this.write('\nConnector pack upsert is not available.\n\n');
          return;
        }
        const raw = args.slice(2).join(' ').trim();
        if (!raw) {
          this.write('\nUsage: /connectors pack upsert <json>\n\n');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.write('\nInvalid JSON. Example:\n');
          this.write('  /connectors pack upsert {"id":"infra-core","name":"Infrastructure Core","enabled":true,"allowedCapabilities":["filesystem.read"],"allowedHosts":["localhost"],"allowedPaths":["./workspace"],"allowedCommands":["ssh"],"authMode":"oauth2","requireHumanApprovalForWrites":true}\n\n');
          return;
        }
        const result = this.dashboard.onConnectorsPackUpsert(parsed as Parameters<NonNullable<DashboardCallbacks['onConnectorsPackUpsert']>>[0]);
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      if (action === 'delete') {
        if (!this.dashboard.onConnectorsPackDelete) {
          this.write('\nConnector pack deletion is not available.\n\n');
          return;
        }
        const packId = args[2];
        if (!packId) {
          this.write('\nUsage: /connectors pack delete <packId>\n\n');
          return;
        }
        const result = this.dashboard.onConnectorsPackDelete(packId);
        this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
        return;
      }
      this.write('\nUsage:\n');
      this.write('  /connectors pack upsert <json>\n');
      this.write('  /connectors pack delete <packId>\n\n');
      return;
    }

    this.write('\nUsage:\n');
    this.write('  /connectors [status|packs|settings|pack]\n');
    this.write('  /connectors settings enable|disable\n');
    this.write('  /connectors settings mode <plan_then_execute|direct_execute>\n');
    this.write('  /connectors settings limit <number>\n');
    this.write('  /connectors settings playbooks <on|off>\n');
    this.write('  /connectors settings playbooks max-steps <number>\n');
    this.write('  /connectors settings playbooks max-parallel <number>\n');
    this.write('  /connectors settings playbooks timeout-ms <milliseconds>\n');
    this.write('  /connectors settings playbooks require-signed <on|off>\n');
    this.write('  /connectors settings playbooks require-dryrun <on|off>\n');
    this.write('  /connectors settings studio enabled <on|off>\n');
    this.write('  /connectors settings studio mode <read_only|builder>\n');
    this.write('  /connectors settings studio ticket <on|off>\n');
    this.write('  /connectors settings json <json>\n');
    this.write('  /connectors pack upsert <json>\n');
    this.write('  /connectors pack delete <packId>\n\n');
  }

  // ─── /playbooks ──────────────────────────────────────────────

  private async handlePlaybooks(args: string[]): Promise<void> {
    if (!this.dashboard?.onConnectorsState) {
      this.write('\nPlaybooks are not available.\n\n');
      return;
    }
    const sub = (args[0] ?? 'list').toLowerCase();
    const state = this.dashboard.onConnectorsState({ limitRuns: 40 });

    if (sub === 'list') {
      if (state.playbooks.length === 0) {
        this.write('\nNo playbooks configured.\n\n');
        return;
      }
      const headers = ['ID', 'Name', 'Mode', 'Enabled', 'Steps'];
      const rows = state.playbooks.map((playbook) => [
        playbook.id,
        playbook.name,
        playbook.mode,
        String(playbook.enabled),
        String(playbook.steps.length),
      ]);
      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (sub === 'runs') {
      if (state.runs.length === 0) {
        this.write('\nNo playbook runs yet.\n\n');
        return;
      }
      const headers = ['Run', 'Playbook', 'Status', 'DryRun', 'Duration', 'Message'];
      const rows = state.runs.map((run) => [
        run.id,
        run.playbookId,
        run.status,
        String(run.dryRun),
        `${run.durationMs}ms`,
        run.message,
      ]);
      this.write('\n');
      this.writeTable(headers, rows);
      this.write('\n');
      return;
    }

    if (sub === 'run') {
      if (!this.dashboard.onPlaybookRun) {
        this.write('\nPlaybook execution is not available.\n\n');
        return;
      }
      const playbookId = args[1];
      if (!playbookId) {
        this.write('\nUsage: /playbooks run <playbookId> [--dry-run]\n\n');
        return;
      }
      const dryRun = args.includes('--dry-run');
      const result = await this.dashboard.onPlaybookRun({
        playbookId,
        dryRun,
        origin: 'cli',
        agentId: this.activeAgentId ?? this.defaultAgentId,
        userId: this.defaultUserId,
        channel: 'cli',
        requestedBy: 'cli-user',
      });
      this.write(`\n${result.success ? this.green('OK') : this.yellow('INFO')}: ${result.message}\n`);
      this.write(`  Run: ${result.run.id}\n`);
      this.write(`  Status: ${result.run.status}\n`);
      this.write(`  Steps: ${result.run.steps.length}\n`);
      const approvals = result.run.steps.filter((step) => !!step.approvalId);
      if (approvals.length > 0) {
        this.write(`  Pending approvals: ${approvals.map((step) => step.approvalId).join(', ')}\n`);
      }
      this.write('\n');
      return;
    }

    if (sub === 'upsert') {
      if (!this.dashboard.onPlaybookUpsert) {
        this.write('\nPlaybook upsert is not available.\n\n');
        return;
      }
      const raw = args.slice(1).join(' ').trim();
      if (!raw) {
        this.write('\nUsage: /playbooks upsert <json>\n\n');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.write('\nInvalid JSON for playbook definition.\n\n');
        return;
      }
      const result = this.dashboard.onPlaybookUpsert(parsed as Parameters<NonNullable<DashboardCallbacks['onPlaybookUpsert']>>[0]);
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    if (sub === 'delete') {
      if (!this.dashboard.onPlaybookDelete) {
        this.write('\nPlaybook deletion is not available.\n\n');
        return;
      }
      const playbookId = args[1];
      if (!playbookId) {
        this.write('\nUsage: /playbooks delete <playbookId>\n\n');
        return;
      }
      const result = this.dashboard.onPlaybookDelete(playbookId);
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    this.write('\nUsage:\n');
    this.write('  /playbooks list\n');
    this.write('  /playbooks runs\n');
    this.write('  /playbooks run <playbookId> [--dry-run]\n');
    this.write('  /playbooks upsert <json>\n');
    this.write('  /playbooks delete <playbookId>\n\n');
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

    // Build a flat numbered list of all models across providers
    const entries: { provider: string; model: string; active: boolean }[] = [];

    this.write('\n');
    for (const p of filtered) {
      this.write(this.bold(`${p.name}`) + ` (${p.type}):\n`);
      const activeModel = p.model;

      if (p.availableModels && p.availableModels.length > 0) {
        for (const m of p.availableModels) {
          const idx = entries.length + 1;
          const active = m === activeModel;
          entries.push({ provider: p.name, model: m, active });
          const marker = active ? this.green(' ← active') : '';
          this.write(`  ${this.dim(`[${idx}]`)} ${m}${marker}\n`);
        }
      } else if (p.connected) {
        const idx = entries.length + 1;
        entries.push({ provider: p.name, model: activeModel, active: true });
        this.write(`  ${this.dim(`[${idx}]`)} ${activeModel}${this.green(' ← active')}\n`);
      } else {
        this.write(`  ${this.dim('Unable to list models — provider not connected')}\n`);
      }
    }

    this.write(`\n${this.dim('Enter a number to switch model, or press Enter to cancel:')}\n`);

    // Prompt for selection
    const choice = await new Promise<string>((resolve) => {
      if (!this.rl) { resolve(''); return; }
      this.rl.question('  > ', (answer) => resolve(answer.trim()));
    });

    if (!choice) {
      this.write('\n');
      this.rl?.prompt();
      return;
    }

    const num = parseInt(choice, 10);
    if (isNaN(num) || num < 1 || num > entries.length) {
      this.write(`\n${this.red('Invalid selection.')} Enter a number between 1 and ${entries.length}.\n\n`);
      this.rl?.prompt();
      return;
    }

    const selected = entries[num - 1];
    if (selected.active) {
      this.write(`\n${selected.model} is already the active model.\n\n`);
      this.rl?.prompt();
      return;
    }

    // Apply the model change
    if (this.dashboard?.onConfigUpdate) {
      const result = await this.dashboard.onConfigUpdate({
        llm: { [selected.provider]: { model: selected.model } },
      });
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
    } else {
      this.write(`\nTo switch: /config set ${selected.provider} model ${selected.model}\n\n`);
    }
    this.rl?.prompt();
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

  // ─── /factory-reset ─────────────────────────────────────────

  private async handleFactoryReset(args: string[]): Promise<void> {
    const scope = args[0]?.toLowerCase() as 'data' | 'config' | 'all' | undefined;

    if (!scope || !['data', 'config', 'all'].includes(scope)) {
      this.write('\n');
      this.write(this.bold('Factory Reset\n'));
      this.write('  /factory-reset data              Clear all data (keep config)\n');
      this.write('  /factory-reset config            Reset config to defaults (keep data)\n');
      this.write('  /factory-reset all               Clear everything (data + config)\n');
      this.write('\n');
      return;
    }

    if (!this.dashboard?.onFactoryReset) {
      this.write('\nFactory reset is not available.\n\n');
      return;
    }

    // Build confirmation display
    const lines: string[] = [];
    if (scope === 'data' || scope === 'all') {
      lines.push(
        '  • Conversation history (all agents/sessions)',
        '  • Analytics database',
        '  • Agent knowledge base memories',
        '  • Audit log (tamper-evident chain)',
        '  • Device inventory',
        '  • Scheduled tasks',
        '  • Network baseline & traffic data',
      );
    }
    if (scope === 'config' || scope === 'all') {
      lines.push('  • Configuration (reset to defaults)');
    }

    const preserveNote = scope === 'data'
      ? '  Configuration will be preserved.'
      : scope === 'config'
        ? '  All runtime data will be preserved.'
        : '  Nothing will be preserved.';

    const title = scope === 'data'
      ? 'FACTORY RESET — Clear All Data'
      : scope === 'config'
        ? 'FACTORY RESET — Reset Configuration'
        : 'FACTORY RESET — Clear Everything';

    this.write('\n');
    this.write('  ┌──────────────────────────────────────────────────┐\n');
    this.write(`  │  ${this.red(title).padEnd(58)}│\n`);
    this.write('  ├──────────────────────────────────────────────────┤\n');
    this.write('  │  This will permanently delete:                   │\n');
    this.write('  │                                                  │\n');
    for (const l of lines) {
      this.write(`  │  ${l.padEnd(48)}│\n`);
    }
    this.write('  │                                                  │\n');
    this.write(`  │  ${preserveNote.padEnd(48)}│\n`);
    this.write('  └──────────────────────────────────────────────────┘\n');
    this.write('\n');

    // Prompt for confirmation
    const confirmed = await new Promise<boolean>((resolve) => {
      if (!this.rl) { resolve(false); return; }
      this.rl.question('  Type "RESET" to confirm, or anything else to cancel: ', (answer) => {
        resolve(answer.trim() === 'RESET');
      });
    });

    if (!confirmed) {
      this.write(`\n${this.green('Cancelled')} — no changes were made.\n\n`);
      return;
    }

    this.write('\n  Resetting...\n');
    const result = await this.dashboard.onFactoryReset({ scope });

    if (result.success) {
      this.write(`\n${this.green('OK')}: ${result.message}\n`);
      if (result.deletedFiles.length > 0) {
        this.write(`  Deleted ${result.deletedFiles.length} item(s):\n`);
        for (const f of result.deletedFiles) {
          this.write(`    • ${f}\n`);
        }
      }
      if (result.errors.length > 0) {
        this.write(`  ${this.yellow('Warnings')} (${result.errors.length}):\n`);
        for (const e of result.errors) {
          this.write(`    • ${e}\n`);
        }
      }
      if (scope === 'all') {
        this.write(`\n  ${this.red('Shutting down...')}\n\n`);
        this.rl?.close();
        if (this.dashboard?.onKillswitch) {
          this.dashboard.onKillswitch();
        }
        return;
      }
      if (scope === 'data') {
        this.write(`\n  ${this.yellow('Restart recommended')} to reinitialize services.\n`);
      }
    } else {
      this.write(`\n${this.red('FAIL')}: ${result.message}\n`);
    }
    this.write('\n');
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

  // ─── /google ─────────────────────────────────────────────────

  private async handleGoogle(args: string[]): Promise<void> {
    if (!this.dashboard?.onGwsStatus) {
      this.write('\nGoogle Workspace integration is not available.\n\n');
      return;
    }

    const sub = (args[0] ?? 'status').toLowerCase();

    if (sub === 'status') {
      const status = await this.dashboard.onGwsStatus();
      this.write('\n');
      this.write(this.bold('Google Workspace\n'));
      this.write(`  Installed:       ${status.installed ? this.green('yes') : this.red('no')}${status.version ? ` (${status.version})` : ''}\n`);
      this.write(`  Authenticated:   ${status.authenticated ? this.green('yes') : this.red('no')}${status.authMethod ? ` (${status.authMethod})` : ''}\n`);
      this.write(`  Provider:        ${status.enabled ? this.green('enabled') : this.dim('disabled')}\n`);
      this.write(`  Services:        ${status.services.length ? status.services.join(', ') : this.dim('none')}\n`);
      if (!status.authenticated) {
        this.write(`\n  Run ${this.cyan('/google login')} to connect your Google account.\n`);
      }
      this.write('\n');
      return;
    }

    if (sub === 'login') {
      const services = args.length > 1 ? args.slice(1) : undefined;
      this.write('\nStarting Google Workspace authentication...\n');
      this.write(this.dim('This will open a browser window for OAuth consent.\n\n'));
      const result = await this.dashboard.onGwsLogin!(services);
      this.write(`${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    if (sub === 'logout') {
      const result = await this.dashboard.onGwsLogout!();
      this.write(`\n${result.success ? this.green('OK') : this.red('FAIL')}: ${result.message}\n\n`);
      return;
    }

    this.write('\nUsage: /google [status|login|logout]\n');
    this.write('  /google status                  Show connection status\n');
    this.write('  /google login [services...]     Authenticate with Google (opens browser)\n');
    this.write('  /google logout                  Clear saved credentials\n\n');
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

  // ─── /version ────────────────────────────────────────────────

  private handleVersion(): void {
    this.write(`\nGuardianAgent v${this.version}\n\n`);
  }

  // ─── /diag ──────────────────────────────────────────────────

  private async handleDiag(): Promise<void> {
    this.write('\n');
    this.write(this.bold('System Diagnostics\n'));
    this.write(`  Version:     v${this.version}\n`);
    this.write(`  Node.js:     ${process.version}\n`);
    this.write(`  Platform:    ${process.platform} ${process.arch}\n`);
    this.write(`  Config:      ${this.configPath || 'default'}\n`);

    // Agent and status info
    if (this.onStatus) {
      const status = this.onStatus();
      this.write(`  Guardian:    ${status.guardianEnabled ? this.green('active') : this.red('disabled')}\n`);
      this.write(`  Agents:      ${status.agentCount} registered\n`);
      this.write(`  Providers:   ${status.providers.join(', ') || 'none'}\n`);
    }

    // Provider connectivity
    if (this.dashboard?.onProviders) {
      this.write('\n');
      this.write(this.bold('Provider Connectivity\n'));
      const providers = this.dashboard.onProviders();
      for (const p of providers) {
        const statusIcon = p.connected ? this.green('OK') : this.red('FAIL');
        this.write(`  ${p.name} (${p.type}/${p.model}): ${statusIcon}\n`);
      }
    }

    this.write('\n');
  }

  // ─── Startup banner ────────────────────────────────────────

  private writeBanner(): void {
    const lb = (t: string) => `\x1b[38;5;75m${t}\x1b[0m`;
    const blue = (t: string) => `\x1b[38;5;33m${t}\x1b[0m`;
    const db = (t: string) => `\x1b[38;5;27m${t}\x1b[0m`;
    const dm = (t: string) => `\x1b[2m${t}\x1b[0m`;

    this.write('\n');
    this.write(lb(' ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ ██╗ █████╗ ███╗   ██╗') + '\n');
    this.write(lb('██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗██║██╔══██╗████╗  ██║') + '\n');
    this.write(blue('██║  ███╗██║   ██║███████║██████╔╝██║  ██║██║███████║██╔██╗ ██║') + '\n');
    this.write(blue('██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║██║██╔══██║██║╚██╗██║') + '\n');
    this.write(db('╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝██║██║  ██║██║ ╚████║') + '\n');
    this.write(db(' ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝') + '\n');
    this.write('\n');
    this.write(lb('      █████╗  ██████╗ ███████╗███╗   ██╗████████╗') + '\n');
    this.write(lb('     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝') + '\n');
    this.write(blue('     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║') + '\n');
    this.write(blue('     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║') + '\n');
    this.write(db('     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║') + '\n');
    this.write(db('     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝') + '\n');
    this.write('\n');

    const s = this.startupStatus;
    if (s) {
      const gn = (t: string) => `\x1b[32m${t}\x1b[0m`;
      const dc = (t: string) => `\x1b[36m${t}\x1b[0m`;
      const dg = (t: string) => `\x1b[38;5;22m${t}\x1b[0m`;
      const yl = (t: string) => `\x1b[33m${t}\x1b[0m`;
      const W = 37;

      // ── Boot sequence ──
      this.write(dg('  ┌──────────────────────────────────────────────────┐') + '\n');
      this.write(dg('  │') + yl('           INITIALIZING') + ' '.repeat(27) + dg('│') + '\n');
      this.write(dg('  ├──────────────────────────────────────────────────┤') + '\n');
      this.write(dg('  │') + dc('  Guardian:  ') + this.pad(s.guardianEnabled !== false ? yl('Awaken') : this.red('DISABLED'), W) + dg('│') + '\n');
      this.write(dg('  │') + dc('  Defenses:  ') + this.pad(yl('Shields raised'), W) + dg('│') + '\n');
      this.write(dg('  │') + dc('  LLM:       ') + this.pad(yl('Neural link established'), W) + dg('│') + '\n');
      this.write(dg('  │') + dc('  Channels:  ') + this.pad(yl('Frequencies locked'), W) + dg('│') + '\n');
      this.write(dg('  │') + dc('  Watchdog:  ') + this.pad(yl('Eyes open'), W) + dg('│') + '\n');
      this.write(dg('  └──────────────────────────────────────────────────┘') + '\n');
      this.write('\n');

      // ── Operational status ──
      const guardian = s.guardianEnabled !== false ? gn('ACTIVE') + ' (3-layer defense)' : this.red('DISABLED');
      const provider = s.providerName ?? 'ollama';
      const channels = s.channels?.join(', ') ?? 'cli';
      const dashUrl = s.dashboardUrl ?? 'disabled';

      this.write(dg('  ┌──────────────────────────────────────────────────┐') + '\n');
      this.write(dg('  │') + gn('           SYSTEM OPERATIONAL') + ' '.repeat(21) + dg('│') + '\n');
      this.write(dg('  ├──────────────────────────────────────────────────┤') + '\n');
      this.write(dg('  │') + dc('  Guardian:  ') + this.pad(guardian, W) + dg('│') + '\n');
      this.write(dg('  │') + dc('  Channels:  ') + this.pad(channels, W) + dg('│') + '\n');
      this.write(dg('  │') + dc('  LLM:       ') + this.pad(gn(provider), W) + dg('│') + '\n');
      this.write(dg('  │') + dc('  Dashboard: ') + this.pad(gn(dashUrl), W) + dg('│') + '\n');
      if (s.authToken) {
        this.write(dg('  │') + dc('  Token:     ') + this.pad(dm(s.authToken), W) + dg('│') + '\n');
      }
      this.write(dg('  └──────────────────────────────────────────────────┘') + '\n');
      this.write('\n');
      if (s.warnings?.length) {
        for (const warning of s.warnings) {
          this.write(`${yl('  Warning:')} ${warning}\n`);
        }
        this.write('\n');
      }
    }

    this.write(dm('  /help') + ' — list all commands  ' + dm('|') + '  ' + dm('/kill') + ' — shutdown all services\n');
    this.write('\n');
  }

  // ─── /clear ──────────────────────────────────────────────────

  private handleClear(): void {
    this.write('\x1b[2J\x1b[H');
  }

  // ─── Formatting helpers ──────────────────────────────────────

  /** Pad a string (stripping ANSI codes for visible width) to `width` characters. */
  private pad(text: string, width: number): string {
    // eslint-disable-next-line no-control-regex
    const visible = text.replace(/\x1b\[[0-9;]*m/g, '').length;
    const padding = Math.max(0, width - visible);
    return text + ' '.repeat(padding);
  }

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

  private formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return `${hours}h ${remMin}m`;
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

  // ─── Post-start greeting / setup wizard ─────────────────────

  /**
   * Called after `runtime.start()` completes.
   * If the LLM provider is reachable, requests an AI greeting.
   * Otherwise, launches an interactive setup wizard.
   */
  postStart(options: {
    providerReady: boolean;
    onGreeting: () => Promise<string>;
    onSetupApply: (input: SetupApplyInput) => Promise<{ success: boolean; message: string }>;
  }): void {
    if (options.providerReady) {
      // Fire-and-forget greeting
      options.onGreeting().then((greeting) => {
        this.write(`\nassistant> ${greeting}\n\n`);
        this.rl?.prompt();
      }).catch(() => {
        this.write(`\nassistant> Guardian Agent is online and ready.\n\n`);
        this.rl?.prompt();
      });
    } else {
      this.runSetupWizard(options.onSetupApply, options.onGreeting);
    }
  }

  private async runSetupWizard(
    onSetupApply: (input: SetupApplyInput) => Promise<{ success: boolean; message: string }>,
    onGreeting: () => Promise<string>,
  ): Promise<void> {
    this.write('\n');
    this.write(this.yellow('  No LLM provider is reachable. Let\'s set one up.\n'));
    this.write('\n');
    this.write('  Which LLM would you like to use?\n');
    this.write(`    ${this.cyan('1)')} Ollama  ${this.dim('(local, free — requires Ollama running)')}\n`);
    this.write(`    ${this.cyan('2)')} Anthropic  ${this.dim('(Claude API — requires API key)')}\n`);
    this.write(`    ${this.cyan('3)')} OpenAI  ${this.dim('(GPT API — requires API key)')}\n`);
    this.write('\n');

    const choice = (await this.askQuestion('  Choice [1/2/3]: ', '1')).trim();

    let input: SetupApplyInput;

    if (choice === '2') {
      // Anthropic
      const apiKey = (await this.askQuestion('  Anthropic API key: ')).trim();
      if (!apiKey) {
        this.write(`\n${this.red('  Error:')} API key is required.\n\n`);
        this.rl?.prompt();
        return;
      }
      const model = (await this.askQuestion('  Model [claude-sonnet-4-20250514]: ', 'claude-sonnet-4-20250514')).trim();
      input = {
        llmMode: 'external',
        providerName: 'anthropic',
        providerType: 'anthropic',
        model,
        apiKey,
        setDefaultProvider: true,
        setupCompleted: true,
      };
    } else if (choice === '3') {
      // OpenAI
      const apiKey = (await this.askQuestion('  OpenAI API key: ')).trim();
      if (!apiKey) {
        this.write(`\n${this.red('  Error:')} API key is required.\n\n`);
        this.rl?.prompt();
        return;
      }
      const model = (await this.askQuestion('  Model [gpt-4o]: ', 'gpt-4o')).trim();
      input = {
        llmMode: 'external',
        providerName: 'openai',
        providerType: 'openai',
        model,
        apiKey,
        setDefaultProvider: true,
        setupCompleted: true,
      };
    } else {
      // Ollama (default)
      const baseUrl = (await this.askQuestion('  Ollama URL [http://127.0.0.1:11434]: ', 'http://127.0.0.1:11434')).trim();
      const model = (await this.askQuestion('  Model [llama3.2]: ', 'llama3.2')).trim();
      input = {
        llmMode: 'ollama',
        providerName: 'ollama',
        providerType: 'ollama',
        model,
        baseUrl,
        setDefaultProvider: true,
        setupCompleted: true,
      };
    }

    this.write('\n  Applying configuration...\n');

    try {
      const result = await onSetupApply(input);
      if (result.success) {
        this.write(`  ${this.green('✓')} ${result.message}\n\n`);
        // Attempt greeting through newly configured provider
        try {
          const greeting = await onGreeting();
          this.write(`assistant> ${greeting}\n\n`);
        } catch {
          this.write(`assistant> Guardian Agent is online and ready.\n\n`);
        }
      } else {
        this.write(`  ${this.red('✗')} ${result.message}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.write(`  ${this.red('✗')} Setup failed: ${msg}\n\n`);
    }

    this.rl?.prompt();
  }

  private askQuestion(prompt: string, defaultValue?: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve(defaultValue ?? '');
        return;
      }
      this.rl.question(prompt, (answer) => {
        resolve(answer || defaultValue || '');
      });
    });
  }
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
