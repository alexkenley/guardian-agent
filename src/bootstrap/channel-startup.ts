import { randomUUID } from 'node:crypto';
import { CLIChannel } from '../channels/cli.js';
import { TelegramChannel } from '../channels/telegram.js';
import { WebChannel, type WebAuthRuntimeConfig } from '../channels/web.js';
import type { DashboardCallbacks } from '../channels/web-types.js';
import type { GuardianAgentConfig } from '../config/types.js';
import { CodingBackendService } from '../runtime/coding-backend-service.js';
import type {
  IncomingDispatchMessage,
  PrepareIncomingDispatch,
} from '../runtime/incoming-dispatch.js';
import type { LocalSecretStore } from '../runtime/secret-store.js';
import type { Runtime } from '../runtime/runtime.js';
import type { BootstrapChannelStopEntry } from './shutdown.js';

export type BootstrapCliChannel = Pick<CLIChannel, 'start' | 'stop' | 'send' | 'postStart'>;
export type BootstrapTelegramChannel = Pick<TelegramChannel, 'start' | 'stop' | 'send' | 'getKnownChatIds'>;
export type BootstrapWebChannel = Pick<
  WebChannel,
  'start' | 'stop' | 'send' | 'setAuthConfig' | 'getCodingBackendTerminalControl' | 'emitDashboardInvalidation'
>;

interface LoggerLike {
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
}

interface DispatchRuntimeLike {
  dispatchMessage: Runtime['dispatchMessage'];
}

function createChannelDispatchHandler(args: {
  channelDefault: string | undefined;
  prepareIncomingDispatch: PrepareIncomingDispatch;
  dashboardCallbacks: DashboardCallbacks;
  runtime: DispatchRuntimeLike;
}): (msg: IncomingDispatchMessage) => Promise<{ content: string; metadata?: Record<string, unknown> }> {
  return async (msg) => {
    const prepared = await args.prepareIncomingDispatch(args.channelDefault, msg);
    if (args.dashboardCallbacks.onDispatch) {
      return args.dashboardCallbacks.onDispatch(
        prepared.decision.agentId,
        prepared.routedMessage,
        prepared.decision,
        { requestId: prepared.requestId },
        prepared.gateway,
      );
    }
    const channel = msg.channel?.trim() || 'web';
    const userId = msg.userId?.trim() || `${channel}-user`;
    return args.runtime.dispatchMessage(prepared.decision.agentId, {
      ...msg,
      id: msg.requestId ?? randomUUID(),
      userId,
      channel,
      timestamp: Date.now(),
      metadata: prepared.routedMessage.metadata,
    });
  };
}

function upsertChannelStop(
  channels: BootstrapChannelStopEntry[],
  name: string,
  stop: () => Promise<void>,
): void {
  const idx = channels.findIndex((entry) => entry.name === name);
  if (idx >= 0) {
    channels[idx] = { name, stop };
    return;
  }
  channels.push({ name, stop });
}

export async function startBootstrapChannels(args: {
  config: GuardianAgentConfig;
  configRef: { current: GuardianAgentConfig };
  configPath: string;
  defaultAgentId: string;
  effectiveToken?: string;
  configuredToken?: string;
  rotateOnStartup: boolean;
  webAuthStateRef: { current: WebAuthRuntimeConfig };
  dashboardCallbacks: DashboardCallbacks;
  runtime: DispatchRuntimeLike;
  channels: BootstrapChannelStopEntry[];
  prepareIncomingDispatch: PrepareIncomingDispatch;
  resolveConfiguredAgentId?: (agentId?: string) => string | undefined;
  secretStore: LocalSecretStore;
  resolveCanonicalTelegramUserId: (channelUserId: string) => string;
  resolveTelegramBotToken: (config: GuardianAgentConfig, secretStore: LocalSecretStore) => string | undefined;
  formatGuideForTelegram: () => string;
  generateSecureToken: () => string;
  previewTokenForLog: (token: string) => string;
  staticDir: string;
  codingBackendServiceRef: { current: CodingBackendService | null };
  codingBackendsDefaultConfig: NonNullable<GuardianAgentConfig['assistant']['tools']['codingBackends']>;
  toolExecutor: { getRuntimeNotices: () => Array<{ message: string }>; setCodingBackendService: (service: CodingBackendService | undefined) => void };
  listAgents: () => Array<{
    id: string;
    name: string;
    state: string;
    capabilities: readonly string[];
    internal: boolean;
  }>;
  getRuntimeStatus: () => {
    running: boolean;
    agentCount: number;
    guardianEnabled: boolean;
    providers: string[];
  };
  log: LoggerLike;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  createCliChannel?: (options: ConstructorParameters<typeof CLIChannel>[0]) => BootstrapCliChannel;
  createTelegramChannel?: (options: ConstructorParameters<typeof TelegramChannel>[0]) => BootstrapTelegramChannel;
  createWebChannel?: (options: ConstructorParameters<typeof WebChannel>[0]) => BootstrapWebChannel;
  createCodingBackendService?: (
    options: ConstructorParameters<typeof CodingBackendService>[0],
  ) => CodingBackendService;
}): Promise<{
  cliChannel: BootstrapCliChannel | null;
  webChannel: BootstrapWebChannel | null;
  getTelegramChannel: () => BootstrapTelegramChannel | null;
}> {
  let cliChannel: BootstrapCliChannel | null = null;
  let activeTelegram: BootstrapTelegramChannel | null = null;
  let webChannel: BootstrapWebChannel | null = null;

  const createCliChannel = args.createCliChannel ?? ((options) => new CLIChannel(options));
  const createTelegramChannel = args.createTelegramChannel ?? ((options) => new TelegramChannel(options));
  const createWebChannel = args.createWebChannel ?? ((options) => new WebChannel(options));
  const createCodingBackendService = args.createCodingBackendService
    ?? ((options) => new CodingBackendService(options));
  const resolveConfiguredAgentId = args.resolveConfiguredAgentId
    ?? ((agentId?: string) => (typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined));

  const canStartInteractiveCli = !!args.stdinIsTTY && !!args.stdoutIsTTY;
  if (args.config.channels.cli?.enabled && canStartInteractiveCli) {
    const cliDefaultAgent = resolveConfiguredAgentId(args.config.channels.cli.defaultAgent) ?? args.defaultAgentId;
    const enabledChannels: string[] = ['cli'];
    if (args.config.channels.web?.enabled) enabledChannels.push('web');
    if (args.config.channels.telegram?.enabled) enabledChannels.push('telegram');

    const cli = createCliChannel({
      defaultAgent: cliDefaultAgent,
      defaultUserId: 'cli',
      dashboard: args.dashboardCallbacks,
      version: '1.0.0',
      configPath: args.configPath,
      startupStatus: {
        guardianEnabled: args.config.guardian.enabled,
        providerName: args.config.defaultProvider,
        channels: enabledChannels,
        dashboardUrl: args.config.channels.web?.enabled
          ? `http://${args.config.channels.web.host ?? 'localhost'}:${args.config.channels.web.port ?? 3000}`
          : undefined,
        authToken: args.effectiveToken,
        warnings: args.toolExecutor.getRuntimeNotices().map((notice) => notice.message),
      },
      onAgents: args.listAgents,
      onStatus: args.getRuntimeStatus,
    });
    await cli.start(createChannelDispatchHandler({
      channelDefault: cliDefaultAgent,
      prepareIncomingDispatch: args.prepareIncomingDispatch,
      dashboardCallbacks: args.dashboardCallbacks,
      runtime: args.runtime,
    }));
    cliChannel = cli;
    args.channels.push({ name: 'cli', stop: () => cli.stop() });
  } else if (args.config.channels.cli?.enabled) {
    args.log.info({
      stdinIsTTY: !!args.stdinIsTTY,
      stdoutIsTTY: !!args.stdoutIsTTY,
    }, 'CLI channel skipped because stdio is not interactive');
  }

  const startTelegram = async (): Promise<void> => {
    const tgConfig = args.configRef.current.channels.telegram;
    const botToken = args.resolveTelegramBotToken(args.configRef.current, args.secretStore);
    if (!tgConfig?.enabled || !botToken) return;
    const telegramDefaultAgent = resolveConfiguredAgentId(tgConfig.defaultAgent) ?? args.defaultAgentId;
    const telegram = createTelegramChannel({
      botToken,
      allowedChatIds: tgConfig.allowedChatIds,
      defaultAgent: telegramDefaultAgent,
      guideText: args.formatGuideForTelegram(),
      resolveCanonicalUserId: args.resolveCanonicalTelegramUserId,
      onQuickAction: async ({ actionId, details, userId, channel, agentId }) => {
        if (!args.dashboardCallbacks.onQuickActionRun) {
          return { content: 'Quick actions are not available.' };
        }
        return args.dashboardCallbacks.onQuickActionRun({ actionId, details, userId, channel, agentId });
      },
      onThreatIntelSummary: args.dashboardCallbacks.onThreatIntelSummary
        ? () => args.dashboardCallbacks.onThreatIntelSummary!()
        : undefined,
      onThreatIntelScan: args.dashboardCallbacks.onThreatIntelScan
        ? (input) => args.dashboardCallbacks.onThreatIntelScan!(input)
        : undefined,
      onThreatIntelFindings: args.dashboardCallbacks.onThreatIntelFindings
        ? (input) => args.dashboardCallbacks.onThreatIntelFindings!(input)
        : undefined,
      onAnalyticsTrack: (event) => args.dashboardCallbacks.onAnalyticsTrack?.(event),
      onToolsApprovalDecision: args.dashboardCallbacks.onToolsApprovalDecision
        ? (input) => args.dashboardCallbacks.onToolsApprovalDecision!(input)
        : undefined,
      onDispatch: args.dashboardCallbacks.onDispatch
        ? (agentId, msg) => args.dashboardCallbacks.onDispatch!(agentId, msg)
        : undefined,
      onResetConversation: async ({ userId, agentId }) => {
        if (!args.dashboardCallbacks.onConversationReset) {
          return { success: false, message: 'Conversation reset is not available.' };
        }
        return args.dashboardCallbacks.onConversationReset({
          agentId: agentId ?? telegramDefaultAgent,
          userId,
          channel: 'telegram',
        });
      },
    });
    await telegram.start(createChannelDispatchHandler({
      channelDefault: telegramDefaultAgent,
      prepareIncomingDispatch: args.prepareIncomingDispatch,
      dashboardCallbacks: args.dashboardCallbacks,
      runtime: args.runtime,
    }));
    activeTelegram = telegram;
    upsertChannelStop(args.channels, 'telegram', () => telegram.stop());
  };

  args.dashboardCallbacks.onTelegramReload = async () => {
    try {
      if (activeTelegram) {
        await activeTelegram.stop();
        activeTelegram = null;
        args.log.info('Telegram channel stopped for reload');
      }
      await startTelegram();
      const tgConfig = args.configRef.current.channels.telegram;
      if (tgConfig?.enabled && args.resolveTelegramBotToken(args.configRef.current, args.secretStore)) {
        args.log.info('Telegram channel reloaded');
        return { success: true, message: 'Telegram channel reloaded.' };
      }
      args.log.info('Telegram channel disabled');
      return { success: true, message: 'Telegram channel disabled.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      args.log.error({ err }, 'Telegram reload failed');
      return { success: false, message: `Telegram reload failed: ${message}` };
    }
  };

  try {
    await startTelegram();
  } catch (err) {
    args.log.error({ err }, 'Telegram channel failed to start — continuing without it');
    console.log('  Telegram: FAILED (check bot token) — other channels unaffected');
  }

  if (args.config.channels.web?.enabled) {
    const webDefaultAgent = resolveConfiguredAgentId(args.config.channels.web.defaultAgent) ?? args.defaultAgentId;
    if (args.webAuthStateRef.current.mode === 'bearer_required' && !args.webAuthStateRef.current.token) {
      args.webAuthStateRef.current = {
        ...args.webAuthStateRef.current,
        token: args.generateSecureToken(),
        tokenSource: 'ephemeral',
      };
    }
    if (args.webAuthStateRef.current.mode === 'disabled') {
      args.log.warn(
        {
          mode: args.webAuthStateRef.current.mode,
          host: args.config.channels.web.host ?? 'localhost',
          port: args.config.channels.web.port ?? 3000,
        },
        'Web dashboard bearer authentication is disabled. Only use this on trusted networks.',
      );
      if (process.stdout.isTTY && !process.env['LOG_FILE']) {
        console.log('');
        console.log('  Web Dashboard Auth');
        console.log(`  URL:   http://${args.config.channels.web.host ?? 'localhost'}:${args.config.channels.web.port ?? 3000}`);
        console.log('  Mode:  disabled');
        console.log('  The web dashboard is open without a bearer token. Use only on trusted networks.');
        console.log('');
      }
    } else if (args.webAuthStateRef.current.tokenSource === 'ephemeral') {
      const ephemeralStartupReason = args.configuredToken && args.rotateOnStartup
        ? 'Web auth rotate-on-startup is enabled. Generated a fresh ephemeral token for this run.'
        : 'No web auth token configured. Generated an ephemeral token for this run.';
      args.log.warn(
        {
          tokenPreview: args.webAuthStateRef.current.token
            ? args.previewTokenForLog(args.webAuthStateRef.current.token)
            : undefined,
          mode: args.webAuthStateRef.current.mode,
          host: args.config.channels.web.host ?? 'localhost',
          port: args.config.channels.web.port ?? 3000,
        },
        ephemeralStartupReason,
      );
      if (process.stdout.isTTY && !process.env['LOG_FILE'] && args.webAuthStateRef.current.token) {
        console.log('');
        console.log('  Web Dashboard Auth');
        console.log(`  URL:   http://${args.config.channels.web.host ?? 'localhost'}:${args.config.channels.web.port ?? 3000}`);
        console.log(`  Token: ${args.webAuthStateRef.current.token}`);
        console.log('  This token is runtime-ephemeral for this process. Exchange it for the session cookie on first login.');
        console.log('');
      }
    }

    const web = createWebChannel({
      port: args.config.channels.web.port,
      host: args.config.channels.web.host,
      defaultAgent: webDefaultAgent,
      auth: args.webAuthStateRef.current,
      authToken: args.webAuthStateRef.current.token,
      allowedOrigins: args.config.channels.web.allowedOrigins,
      maxBodyBytes: args.config.channels.web.maxBodyBytes,
      staticDir: args.staticDir,
      dashboard: args.dashboardCallbacks,
    });
    args.codingBackendServiceRef.current = createCodingBackendService({
      config: args.configRef.current.assistant.tools.codingBackends ?? args.codingBackendsDefaultConfig,
      terminalControl: web.getCodingBackendTerminalControl(),
    });
    args.toolExecutor.setCodingBackendService(args.codingBackendServiceRef.current);
    webChannel = web;
    await web.start(createChannelDispatchHandler({
      channelDefault: webDefaultAgent,
      prepareIncomingDispatch: args.prepareIncomingDispatch,
      dashboardCallbacks: args.dashboardCallbacks,
      runtime: args.runtime,
    }));
    args.channels.push({
      name: 'web',
      stop: async () => {
        args.codingBackendServiceRef.current?.dispose();
        await web.stop();
      },
    });

    const webUrl = `http://${args.config.channels.web.host ?? 'localhost'}:${args.config.channels.web.port ?? 3000}`;
    args.log.info({ url: webUrl }, 'Dashboard available at');
  }

  return {
    cliChannel,
    webChannel,
    getTelegramChannel: () => activeTelegram,
  };
}
