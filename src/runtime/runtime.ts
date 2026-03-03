/**
 * Runtime — main orchestrator for the event-driven agent system.
 *
 * Wires together: config → LLM providers → Registry → EventBus →
 * Guardian → AuditLog → OutputGuardian → Budget → Watchdog → Scheduler → Channels.
 *
 * Guardian is enforced inline:
 *   Layer 1 (Proactive): Input sanitization, capability checks, rate limiting
 *   Layer 2 (Output):    Secret scanning/redaction on responses and event payloads
 */

import type { GuardianAgentConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import type { LLMProvider } from '../llm/types.js';
import { createProviders, createFailoverProvider } from '../llm/provider.js';
import type { FailoverProvider, ProviderCircuitState } from '../llm/failover-provider.js';
import { AuditPersistence } from '../guardian/audit-persistence.js';
import { AgentRegistry } from '../agent/registry.js';
import { LifecycleManager } from '../agent/lifecycle.js';
import type { AgentDefinition, AgentContext, ScheduleContext, UserMessage, AgentResponse } from '../agent/types.js';
import { AgentState } from '../agent/types.js';
import { EventBus } from '../queue/event-bus.js';
import type { AgentEvent } from '../queue/event-bus.js';
import { Guardian } from '../guardian/guardian.js';
import { AuditLog } from '../guardian/audit-log.js';
import { OutputGuardian } from '../guardian/output-guardian.js';
import { BudgetTracker } from './budget.js';
import { Watchdog } from './watchdog.js';
import { CronScheduler } from './scheduler.js';
import { GuardedLLMProvider } from '../llm/guarded-provider.js';
import { createLogger } from '../util/logging.js';

const log = createLogger('runtime');

export class Runtime {
  readonly registry: AgentRegistry;
  readonly lifecycle: LifecycleManager;
  readonly eventBus: EventBus;
  readonly guardian: Guardian;
  readonly auditLog: AuditLog;
  readonly outputGuardian: OutputGuardian;
  readonly budget: BudgetTracker;
  readonly watchdog: Watchdog;
  readonly scheduler: CronScheduler;
  readonly providers: Map<string, LLMProvider>;

  private config: GuardianAgentConfig;
  private running = false;
  private guardianEnabled: boolean;
  private outputScanningEnabled: boolean;
  private redactSecrets: boolean;
  private auditPersistence?: AuditPersistence;
  private failoverProvider?: FailoverProvider;

  constructor(config?: Partial<GuardianAgentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.lifecycle = new LifecycleManager();
    this.registry = new AgentRegistry(this.lifecycle);
    this.eventBus = new EventBus();

    // Guardian configuration
    const guardianConfig = this.config.guardian;
    this.guardianEnabled = guardianConfig.enabled;
    this.outputScanningEnabled = guardianConfig.outputScanning?.enabled ?? true;
    this.redactSecrets = guardianConfig.outputScanning?.redactSecrets ?? true;

    this.guardian = Guardian.createDefault({
      logDenials: guardianConfig.logDenials,
      additionalSecretPatterns: guardianConfig.additionalSecretPatterns,
      deniedPaths: guardianConfig.deniedPaths,
      inputSanitization: guardianConfig.inputSanitization,
      rateLimit: guardianConfig.rateLimit,
      allowedCommands: this.config.assistant?.tools?.allowedCommands,
    });

    this.auditLog = new AuditLog(guardianConfig.auditLog?.maxEvents ?? 10_000);

    // Audit persistence — hash-chained JSONL storage
    if (guardianConfig.auditLog?.persistenceEnabled !== false) {
      this.auditPersistence = new AuditPersistence(guardianConfig.auditLog?.auditDir);
    }

    this.outputGuardian = new OutputGuardian(guardianConfig.additionalSecretPatterns);

    this.budget = new BudgetTracker();
    this.watchdog = new Watchdog(
      this.registry,
      this.config.runtime.maxStallDurationMs,
      this.auditLog,
    );
    this.scheduler = new CronScheduler();

    // Create individual providers
    this.providers = createProviders(this.config.llm);

    // Create failover wrapper if enabled and multiple providers configured
    if (this.config.failover?.enabled && this.providers.size > 1) {
      this.failoverProvider = createFailoverProvider(this.config.llm, this.config.failover);
    }
  }

  /** Register an agent with the runtime. */
  registerAgent(definition: AgentDefinition): void {
    const agentId = definition.agent.id;
    const instance = this.registry.register(definition);

    // Assign LLM provider
    const providerName = definition.providerName ?? this.config.defaultProvider;
    instance.provider = this.providers.get(providerName);

    // Initialize: Created → Ready
    this.registry.initialize(agentId);

    // Subscribe to events if agent handles them
    if (definition.agent.capabilities.handleEvents) {
      this.eventBus.subscribe(agentId, async (event) => {
        await this.dispatchEvent(agentId, event);
      });
    }

    // Set up cron schedule if defined
    if (definition.schedule && definition.agent.capabilities.handleSchedule) {
      this.scheduler.schedule(agentId, definition.schedule, async () => {
        await this.dispatchSchedule(agentId, definition.schedule!);
      });
    }

    log.info({ agentId, providerName }, 'Agent registered');
  }

  /** Unregister an agent. */
  unregisterAgent(agentId: string): void {
    this.scheduler.unschedule(agentId);
    this.eventBus.removeHandlersForAgent(agentId);
    this.registry.unregister(agentId);
    log.info({ agentId }, 'Agent unregistered');
  }

  /** States that cannot accept new work. */
  private static readonly INACTIVE_STATES = new Set([
    AgentState.Dead,
    AgentState.Errored,
    AgentState.Stalled,
    AgentState.Paused,
  ]);

  /** Check if an agent is in an executable state. Throws if not. */
  private assertExecutable(agentId: string, instance: { state: AgentState }): void {
    if (Runtime.INACTIVE_STATES.has(instance.state)) {
      throw new Error(`Agent '${agentId}' cannot accept work in state '${instance.state}'`);
    }
  }

  /** Dispatch a user message to an agent and get a response. */
  async dispatchMessage(agentId: string, message: UserMessage): Promise<AgentResponse> {
    const instance = this.registry.get(agentId);
    if (!instance) {
      throw new Error(`Agent '${agentId}' not found`);
    }

    this.assertExecutable(agentId, instance);

    if (!instance.agent.onMessage) {
      return { content: 'This agent does not handle messages.' };
    }

    const capabilities = Object.freeze([...instance.definition.grantedCapabilities]);

    // LAYER 1: Proactive Guardian — check message dispatch
    if (this.guardianEnabled) {
      const guardianResult = this.guardian.check({
        type: 'message_dispatch',
        agentId,
        capabilities,
        params: {
          content: message.content,
          userId: message.userId,
          channel: message.channel,
        },
      });

      if (!guardianResult.allowed) {
        this.auditLog.record({
          type: 'action_denied',
          severity: 'warn',
          agentId,
          userId: message.userId,
          channel: message.channel,
          controller: guardianResult.controller,
          details: {
            actionType: 'message_dispatch',
            reason: guardianResult.reason,
          },
        });
        return { content: `[Message blocked: ${guardianResult.reason}]` };
      }

      // If action was mutated (e.g., invisible chars stripped), use mutated content
      if (guardianResult.mutatedAction) {
        const mutatedContent = guardianResult.mutatedAction.params['content'] as string;
        if (mutatedContent !== message.content) {
          this.auditLog.record({
            type: 'input_sanitized',
            severity: 'info',
            agentId,
            userId: message.userId,
            channel: message.channel,
            controller: 'InputSanitizer',
            details: { originalLength: message.content.length, sanitizedLength: mutatedContent.length },
          });
          message = { ...message, content: mutatedContent };
        }
      }
    }

    const ctx = this.createAgentContext(agentId);
    const limits = instance.definition.resourceLimits;
    const budgetMs = limits.maxInvocationBudgetMs;

    // Check resource limits before invocation
    this.checkTokenRateLimit(agentId, limits.maxTokensPerMinute);
    this.checkConcurrentLimit(agentId, limits.maxConcurrentTools);
    this.checkQueueDepth(agentId, limits.maxQueueDepth);

    // Transition to Running if needed
    this.ensureRunning(agentId);
    this.budget.startInvocation(agentId, budgetMs, 'message');
    this.watchdog.recordActivity(agentId);

    try {
      const response = await this.withBudgetTimeout(
        () => instance.agent.onMessage!(message, ctx),
        agentId,
        budgetMs,
      );
      this.watchdog.clearErrors(agentId);
      this.watchdog.recordActivity(agentId);

      // LAYER 2: Output Guardian — scan response for secrets
      if (this.outputScanningEnabled) {
        const scanResult = this.outputGuardian.scanResponse(response.content);
        if (!scanResult.clean) {
          // Always record secret_detected for Sentinel analysis
          this.auditLog.record({
            type: 'secret_detected',
            severity: 'warn',
            agentId,
            userId: message.userId,
            channel: message.channel,
            details: {
              source: 'response_scan',
              secretCount: scanResult.secrets.length,
              patterns: scanResult.secrets.map(s => s.pattern),
            },
          });

          if (this.redactSecrets) {
            this.auditLog.record({
              type: 'output_redacted',
              severity: 'warn',
              agentId,
              userId: message.userId,
              channel: message.channel,
              details: {
                secretCount: scanResult.secrets.length,
                patterns: scanResult.secrets.map(s => s.pattern),
              },
            });
            response.content = scanResult.sanitized;
          } else {
            // Block entirely
            this.auditLog.record({
              type: 'output_blocked',
              severity: 'warn',
              agentId,
              userId: message.userId,
              channel: message.channel,
              details: {
                secretCount: scanResult.secrets.length,
                patterns: scanResult.secrets.map(s => s.pattern),
              },
            });
            this.tryTransition(agentId, AgentState.Idle, 'message handled (output blocked)');
            return { content: '[Response blocked: credential leak detected]' };
          }
        }
      }

      // Back to Idle
      this.tryTransition(agentId, AgentState.Idle, 'message handled');

      return response;
    } catch (err) {
      this.handleAgentError(agentId, err);
      throw err;
    } finally {
      this.budget.endInvocation(agentId);
    }
  }

  /** Dispatch an event to an agent. */
  async dispatchEvent(agentId: string, event: AgentEvent): Promise<void> {
    const instance = this.registry.get(agentId);
    if (!instance) return;

    if (Runtime.INACTIVE_STATES.has(instance.state)) return;

    if (!instance.agent.onEvent) return;

    const ctx = this.createAgentContext(agentId);
    const limits = instance.definition.resourceLimits;
    const budgetMs = limits.maxInvocationBudgetMs;

    this.checkTokenRateLimit(agentId, limits.maxTokensPerMinute);
    this.checkConcurrentLimit(agentId, limits.maxConcurrentTools);
    this.checkQueueDepth(agentId, limits.maxQueueDepth);

    this.ensureRunning(agentId);
    this.budget.startInvocation(agentId, budgetMs, 'event');
    this.watchdog.recordActivity(agentId);

    try {
      await this.withBudgetTimeout(
        () => instance.agent.onEvent!(event, ctx),
        agentId,
        budgetMs,
      );
      this.watchdog.clearErrors(agentId);
      this.watchdog.recordActivity(agentId);
      this.tryTransition(agentId, AgentState.Idle, 'event handled');
    } catch (err) {
      this.handleAgentError(agentId, err);
    } finally {
      this.budget.endInvocation(agentId);
    }
  }

  /** Dispatch a scheduled invocation to an agent. */
  async dispatchSchedule(agentId: string, schedule: string): Promise<void> {
    const instance = this.registry.get(agentId);
    if (!instance) return;

    if (Runtime.INACTIVE_STATES.has(instance.state)) return;

    if (!instance.agent.onSchedule) return;

    const ctx: ScheduleContext = {
      ...this.createAgentContext(agentId),
      schedule,
      auditLog: this.auditLog,
    };
    const limits = instance.definition.resourceLimits;
    const budgetMs = limits.maxInvocationBudgetMs;

    this.checkTokenRateLimit(agentId, limits.maxTokensPerMinute);
    this.checkConcurrentLimit(agentId, limits.maxConcurrentTools);

    this.ensureRunning(agentId);
    this.budget.startInvocation(agentId, budgetMs, 'schedule');
    this.watchdog.recordActivity(agentId);

    try {
      await this.withBudgetTimeout(
        () => instance.agent.onSchedule!(ctx),
        agentId,
        budgetMs,
      );
      this.watchdog.clearErrors(agentId);
      this.watchdog.recordActivity(agentId);
      this.tryTransition(agentId, AgentState.Idle, 'schedule handled');
    } catch (err) {
      this.handleAgentError(agentId, err);
    } finally {
      this.budget.endInvocation(agentId);
    }
  }

  /** Emit an event to the event bus (with payload scanning). */
  async emit(event: AgentEvent): Promise<boolean> {
    // OUTPUT GUARD: scan payload for secrets (same as ctx.emit)
    if (this.outputScanningEnabled) {
      const payloadSecrets = this.outputGuardian.scanPayload(event.payload);
      if (payloadSecrets.length > 0) {
        this.auditLog.record({
          type: 'secret_detected',
          severity: 'warn',
          agentId: event.sourceAgentId,
          details: {
            source: 'event_payload',
            secretCount: payloadSecrets.length,
            patterns: payloadSecrets.map(s => s.pattern),
          },
        });
        this.auditLog.record({
          type: 'event_blocked',
          severity: 'warn',
          agentId: event.sourceAgentId,
          details: {
            targetAgentId: event.targetAgentId,
            eventType: event.type,
            secretCount: payloadSecrets.length,
            patterns: payloadSecrets.map(s => s.pattern),
          },
        });
        throw new Error('Event blocked: secrets detected in payload');
      }
    }
    return this.eventBus.emit(event);
  }

  /** Get circuit breaker states for all providers (for monitoring). */
  getCircuitStates(): ProviderCircuitState[] {
    return this.failoverProvider?.getCircuitStates() ?? [];
  }

  /** Start the runtime. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initialize audit persistence
    if (this.auditPersistence) {
      try {
        await this.auditPersistence.init();
        this.auditLog.setPersistence(this.auditPersistence);
        log.info('Audit persistence initialized');
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to initialize audit persistence');
      }
    }

    // Start all agents (call onStart)
    for (const instance of this.registry.getAll()) {
      if (instance.state === AgentState.Ready && instance.agent.onStart) {
        try {
          const ctx = this.createAgentContext(instance.agent.id);
          await instance.agent.onStart(ctx);
          this.tryTransition(instance.agent.id, AgentState.Running, 'started');
          this.tryTransition(instance.agent.id, AgentState.Idle, 'awaiting work');
        } catch (err) {
          this.handleAgentError(instance.agent.id, err);
        }
      }
    }

    this.watchdog.start(this.config.runtime.watchdogIntervalMs);
    this.scheduler.start();

    log.info('Runtime started');
  }

  /** Stop the runtime gracefully. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.scheduler.stop();
    this.watchdog.stop();

    // Stop all agents (call onStop)
    for (const instance of this.registry.getAll()) {
      if (instance.state !== AgentState.Dead && instance.agent.onStop) {
        try {
          await instance.agent.onStop();
        } catch (err) {
          log.error({ agentId: instance.agent.id, err }, 'Error stopping agent');
        }
      }
    }

    this.eventBus.removeAllHandlers();

    log.info('Runtime stopped');
  }

  /** Whether the runtime is running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get a provider by name. */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /** Get the default provider. */
  getDefaultProvider(): LLMProvider | undefined {
    return this.providers.get(this.config.defaultProvider);
  }

  /**
   * Apply updated LLM/default-provider configuration at runtime.
   *
   * Rebuilds provider clients and rebinds providers on all registered agents.
   */
  applyLLMConfiguration(config: Pick<GuardianAgentConfig, 'llm' | 'defaultProvider'>): void {
    this.config = {
      ...this.config,
      llm: config.llm,
      defaultProvider: config.defaultProvider,
    };

    this.providers.clear();
    const rebuilt = createProviders(config.llm);
    for (const [name, provider] of rebuilt) {
      this.providers.set(name, provider);
    }

    for (const instance of this.registry.getAll()) {
      const providerName = instance.definition.providerName ?? this.config.defaultProvider;
      instance.provider = this.providers.get(providerName);
    }

    log.info(
      { providerCount: this.providers.size, defaultProvider: this.config.defaultProvider },
      'Applied updated LLM configuration',
    );
  }

  // ─── Internals ──────────────────────────────────────────────

  private createAgentContext(agentId: string, options?: { enableDispatch?: boolean }): AgentContext {
    const instance = this.registry.get(agentId);
    const capabilities = Object.freeze([...(instance?.definition.grantedCapabilities ?? [])]);

    const ctx: AgentContext = {
      agentId,
      capabilities,
      // Dispatch: allows orchestration agents to invoke sub-agents
      // All sub-agent calls pass through the full Guardian admission pipeline
      dispatch: options?.enableDispatch !== false
        ? (targetAgentId: string, message: UserMessage) => this.dispatchMessage(targetAgentId, message)
        : undefined,
      emit: async (partial) => {
        // OUTPUT GUARD: scan event payload for secrets
        if (this.outputScanningEnabled) {
          const payloadSecrets = this.outputGuardian.scanPayload(partial.payload);
          if (payloadSecrets.length > 0) {
            this.auditLog.record({
              type: 'secret_detected',
              severity: 'warn',
              agentId,
              details: {
                source: 'event_payload',
                secretCount: payloadSecrets.length,
                patterns: payloadSecrets.map(s => s.pattern),
              },
            });
            this.auditLog.record({
              type: 'event_blocked',
              severity: 'warn',
              agentId,
              details: {
                targetAgentId: partial.targetAgentId,
                eventType: partial.type,
                secretCount: payloadSecrets.length,
                patterns: payloadSecrets.map(s => s.pattern),
              },
            });
            throw new Error('Event blocked: secrets detected in payload');
          }
        }

        const event: AgentEvent = {
          ...partial,
          sourceAgentId: agentId,
          timestamp: Date.now(),
        };
        await this.eventBus.emit(event);
      },
      checkAction: (action) => {
        if (!this.guardianEnabled) return;

        const result = this.guardian.check({
          type: action.type,
          agentId,
          capabilities,
          params: action.params,
        });

        if (!result.allowed) {
          this.auditLog.record({
            type: 'action_denied',
            severity: 'warn',
            agentId,
            controller: result.controller,
            details: {
              actionType: action.type,
              reason: result.reason,
            },
          });
          throw new Error(`Action denied: ${result.reason}`);
        }

        // Record allowed action for audit trail
        this.auditLog.record({
          type: 'action_allowed',
          severity: 'info',
          agentId,
          controller: result.controller,
          details: { actionType: action.type },
        });
      },
      llm: instance?.provider
        ? new GuardedLLMProvider({
            provider: instance.provider,
            agentId,
            outputGuardian: this.outputGuardian,
            budget: this.budget,
            auditLog: this.auditLog,
            redactSecrets: this.redactSecrets,
          })
        : undefined,
    };

    return Object.freeze(ctx);
  }

  private ensureRunning(agentId: string): void {
    const instance = this.registry.get(agentId);
    if (!instance) return;

    if (instance.state === AgentState.Ready || instance.state === AgentState.Idle) {
      this.tryTransition(agentId, AgentState.Running, 'invocation');
    }
  }

  private tryTransition(agentId: string, to: AgentState, reason: string): void {
    try {
      this.registry.transitionState(agentId, to, reason);
    } catch {
      // Invalid transition — ignore
    }
  }

  private handleAgentError(agentId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ agentId, err: message }, 'Agent invocation error');

    this.auditLog.record({
      type: 'agent_error',
      severity: 'warn',
      agentId,
      details: { error: message },
    });

    this.watchdog.recordError(agentId);
    this.tryTransition(agentId, AgentState.Errored, `error: ${message}`);
  }

  /** Check concurrent invocation limit. Throws if exceeded. */
  private checkConcurrentLimit(agentId: string, maxConcurrentTools: number): void {
    if (maxConcurrentTools <= 0) return;
    const current = this.budget.getConcurrentCount(agentId);
    if (current >= maxConcurrentTools) {
      this.auditLog.record({
        type: 'rate_limited',
        severity: 'warn',
        agentId,
        details: { reason: 'concurrent_limit', current, limit: maxConcurrentTools },
      });
      throw new Error(`Agent '${agentId}' exceeded concurrent invocation limit (${current}/${maxConcurrentTools})`);
    }
  }

  /** Check queue depth for an agent. Throws if exceeded. */
  private checkQueueDepth(agentId: string, maxQueueDepth: number): void {
    if (maxQueueDepth <= 0) return;
    const pending = this.eventBus.pending;
    if (pending >= maxQueueDepth) {
      this.auditLog.record({
        type: 'rate_limited',
        severity: 'warn',
        agentId,
        details: { reason: 'queue_depth', pending, limit: maxQueueDepth },
      });
      throw new Error(`Agent '${agentId}' event queue depth exceeded (${pending}/${maxQueueDepth})`);
    }
  }

  /** Check token rate limit before invocation. Throws if exceeded. */
  private checkTokenRateLimit(agentId: string, maxTokensPerMinute: number): void {
    if (maxTokensPerMinute <= 0) return;
    const used = this.budget.getTokensPerMinute(agentId);
    if (used >= maxTokensPerMinute) {
      this.auditLog.record({
        type: 'rate_limited',
        severity: 'warn',
        agentId,
        details: { reason: 'token_rate_limit', used, limit: maxTokensPerMinute },
      });
      throw new Error(`Agent '${agentId}' exceeded token rate limit (${used}/${maxTokensPerMinute} tokens/min)`);
    }
  }

  /** Wrap an async handler with budget timeout enforcement. */
  private async withBudgetTimeout<T>(
    fn: () => Promise<T>,
    agentId: string,
    budgetMs: number,
  ): Promise<T> {
    if (budgetMs <= 0) return fn();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.auditLog.record({
          type: 'agent_error',
          severity: 'warn',
          agentId,
          details: { error: 'budget_timeout', budgetMs },
        });
        reject(new Error(`Agent '${agentId}' exceeded budget timeout (${budgetMs}ms)`));
      }, budgetMs);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
