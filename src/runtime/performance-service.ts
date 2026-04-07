import { randomUUID } from 'node:crypto';
import { performance as perfHooksPerformance } from 'node:perf_hooks';

import type { AuditEvent, AuditLog } from '../guardian/audit-log.js';
import type {
  GuardianAgentConfig,
  PerformanceConfig,
  PerformanceLatencyTarget,
  PerformanceProfileConfig,
} from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import type {
  ApprovedPerformanceAction,
  PerformanceActionHistoryEntry,
  PerformanceActionPreview,
  PerformanceActionPreviewTarget,
  PerformanceLatencyStatus,
  PerformanceProcessSummary,
  PerformanceProfileSummary,
  PerformanceStatus,
} from '../channels/web-types.js';
import type { PerformanceAdapter } from './performance-adapters/types.js';

const PREVIEW_TTL_MS = 10 * 60_000;
const HISTORY_LIMIT = 20;
const LATENCY_TIMEOUT_MS = 1_500;
const PERFORMANCE_ACTION_RUN_AUDIT_TYPE = 'performance.action_run';
const PERFORMANCE_PROFILE_APPLIED_AUDIT_TYPE = 'performance.profile_applied';
const BACKGROUND_APP_PROCESSES = new Set([
  'discord',
  'spotify',
  'slack',
  'teams',
  'msteams',
  'telegram',
  'whatsapp',
  'signal',
  'zoom',
  'webex',
  'steam',
  'steamwebhelper',
  'epicgameslauncher',
  'epicwebhelper',
  'battlenet',
  'battle.net',
  'riotclientservices',
  'riotclientux',
  'ubisoftconnect',
  'onedrive',
  'googledrivefs',
  'dropbox',
  'notion',
  'obsidian',
  'postman',
  'music',
  'applemusic',
]);
const DEVELOPMENT_PROCESSES = new Set([
  'code',
  'code-insiders',
  'cursor',
  'windsurf',
  'devenv',
  'idea64',
  'studio64',
  'rider64',
  'webstorm64',
  'phpstorm64',
  'pycharm64',
  'goland64',
  'clion64',
  'rubymine64',
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'git',
  'bash',
  'zsh',
  'sh',
  'pwsh',
  'powershell',
  'cmd',
  'wsl',
  'docker',
  'dockerdesktop',
  'com.docker.backend',
  'com.docker.frontend',
  'ollama',
  'tmux',
  'screen',
]);
const SYSTEM_PROCESSES = new Set([
  'system',
  'system idle process',
  'svchost',
  'services',
  'lsass',
  'wininit',
  'winlogon',
  'dwm',
  'explorer',
  'csrss',
  'smss',
  'registry',
  'taskhostw',
  'searchindexer',
  'searchhost',
  'securityhealthservice',
  'fontdrvhost',
  'spoolsv',
  'memorycompression',
  'init',
  'systemd',
  'launchd',
  'kernel_task',
  'windowserver',
  'loginwindow',
]);
const BROWSER_PROCESSES = new Set([
  'chrome',
  'msedge',
  'firefox',
  'safari',
  'arc',
  'brave',
  'opera',
  'edgewebview2',
]);

interface PerformanceServiceOptions {
  adapter: PerformanceAdapter;
  getConfig: () => GuardianAgentConfig;
  auditLog?: AuditLog;
}

interface StoredPreview {
  actionId: string;
  createdAt: number;
  processTargets: PerformanceActionPreviewTarget[];
  cleanupTargets: PerformanceActionPreviewTarget[];
  processes: PerformanceProcessSummary[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeProcessName(value: string | undefined): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized.endsWith('.exe') ? normalized.slice(0, -4) : normalized;
}

function dedupeStrings(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function trimSelection(values: string[] | undefined): string[] {
  return dedupeStrings(values);
}

function toProfileSummary(profile: PerformanceProfileConfig): PerformanceProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    powerMode: profile.powerMode,
    autoActionsEnabled: profile.autoActions?.enabled ?? false,
    allowedActionIds: dedupeStrings(profile.autoActions?.allowedActionIds),
    terminateProcessNames: dedupeStrings(profile.processRules?.terminate),
    protectProcessNames: dedupeStrings(profile.processRules?.protect),
    latencyTargets: (profile.latencyTargets ?? []).map((target) => ({
      id: target.id,
      kind: target.kind,
      target: target.target?.trim() || undefined,
      targetRef: target.targetRef?.trim() || undefined,
    })),
  };
}

function describeLatencyTarget(target: PerformanceLatencyTarget): string {
  if (target.kind === 'internet') {
    return `Internet: ${target.id}`;
  }
  return `API: ${target.id}`;
}

function toHistoryEntryFromAuditEvent(event: AuditEvent): PerformanceActionHistoryEntry | null {
  const actionId = String(event.details.actionId ?? '').trim();
  const message = String(event.details.message ?? '').trim();
  const success = event.details.success !== false;
  const selectedProcessCount = Number(event.details.selectedProcessCount);
  const selectedCleanupCount = Number(event.details.selectedCleanupCount);

  if (!actionId || !message) {
    return null;
  }

  return {
    id: event.id,
    actionId,
    executedAt: event.timestamp,
    success,
    message,
    selectedProcessCount: Number.isFinite(selectedProcessCount) ? selectedProcessCount : 0,
    selectedCleanupCount: Number.isFinite(selectedCleanupCount) ? selectedCleanupCount : 0,
  };
}

function historySequence(entry: PerformanceActionHistoryEntry): number {
  const match = entry.id.match(/-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function previewRiskForProcess(processInfo: PerformanceProcessSummary): 'low' | 'medium' | 'high' {
  const cpuPercent = processInfo.cpuPercent ?? 0;
  const memoryMb = processInfo.memoryMb ?? 0;
  if (cpuPercent >= 20 || memoryMb >= 900) return 'high';
  if (cpuPercent >= 10 || memoryMb >= 500) return 'medium';
  return 'low';
}

function previewScoreForProcess(processInfo: PerformanceProcessSummary): number {
  const cpuPercent = processInfo.cpuPercent ?? 0;
  const memoryMb = processInfo.memoryMb ?? 0;
  return Math.min(cpuPercent * 2, 80) + Math.min(memoryMb / 32, 60);
}

function shouldSuppressHeuristicProcess(name: string): boolean {
  return DEVELOPMENT_PROCESSES.has(name) || SYSTEM_PROCESSES.has(name) || BROWSER_PROCESSES.has(name);
}

function describeHeuristicProcessTarget(processInfo: PerformanceProcessSummary): {
  suggestedReason: string;
  score: number;
  checkedByDefault: boolean;
} | null {
  const normalizedName = normalizeProcessName(processInfo.name);
  if (shouldSuppressHeuristicProcess(normalizedName)) {
    return null;
  }

  const cpuPercent = processInfo.cpuPercent ?? 0;
  const memoryMb = processInfo.memoryMb ?? 0;
  const isBackgroundApp = BACKGROUND_APP_PROCESSES.has(normalizedName);
  const heavyCpu = cpuPercent >= 8;
  const heavyMemory = memoryMb >= 500;

  if (!isBackgroundApp && !heavyCpu && !heavyMemory) {
    return null;
  }

  if (isBackgroundApp) {
    return {
      suggestedReason: 'Looks like a non-essential background app that is usually safe to close during focused work.',
      score: 120 + previewScoreForProcess(processInfo),
      checkedByDefault: previewRiskForProcess(processInfo) !== 'high',
    };
  }

  if (heavyCpu && heavyMemory) {
    return {
      suggestedReason: 'Using notable CPU and memory without being protected by the active profile.',
      score: 85 + previewScoreForProcess(processInfo),
      checkedByDefault: false,
    };
  }

  if (heavyCpu) {
    return {
      suggestedReason: 'Using notable CPU without being protected by the active profile.',
      score: 70 + previewScoreForProcess(processInfo),
      checkedByDefault: false,
    };
  }

  return {
    suggestedReason: 'Using notable memory without being protected by the active profile.',
    score: 65 + previewScoreForProcess(processInfo),
    checkedByDefault: false,
  };
}

export class PerformanceService {
  private activeProfileId: string | null = null;
  private readonly previews = new Map<string, StoredPreview>();
  private readonly history: PerformanceActionHistoryEntry[] = [];
  private latencyCache: { generatedAt: number; entries: PerformanceLatencyStatus[] } | null = null;

  constructor(private readonly options: PerformanceServiceOptions) {}

  private get config(): GuardianAgentConfig {
    return this.options.getConfig();
  }

  private get performanceConfig(): PerformanceConfig {
    return this.config.assistant.performance ?? structuredClone(DEFAULT_CONFIG.assistant.performance!);
  }

  private getProfiles(): PerformanceProfileConfig[] {
    return this.performanceConfig.profiles ?? [];
  }

  private ensureActiveProfileId(): string {
    const profiles = this.getProfiles();
    const configured = profiles.find((profile) => profile.id === this.activeProfileId);
    if (configured) return configured.id;

    const fallbackProfileId = profiles[0]?.id ?? 'balanced';
    this.activeProfileId = fallbackProfileId;
    return fallbackProfileId;
  }

  private getActiveProfile(): PerformanceProfileConfig | null {
    const activeProfileId = this.ensureActiveProfileId();
    return this.getProfiles().find((profile) => profile.id === activeProfileId) ?? null;
  }

  private getProtectionReasons(profile: PerformanceProfileConfig | null): Map<string, string> {
    const reasons = new Map<string, string>();
    for (const name of dedupeStrings(this.performanceConfig.protectedProcesses?.names)) {
      reasons.set(normalizeProcessName(name), 'Protected by global performance policy.');
    }
    for (const name of dedupeStrings(profile?.processRules?.protect)) {
      reasons.set(normalizeProcessName(name), 'Protected by the active profile.');
    }
    reasons.set(normalizeProcessName(process.title), 'Protected because it is the running Guardian process.');
    reasons.set(normalizeProcessName(process.argv0), 'Protected because it is the running Guardian process.');
    reasons.set('node', reasons.get('node') ?? 'Protected by global performance policy.');
    return reasons;
  }

  private decorateProcess(processInfo: PerformanceProcessSummary, protectionReasons: Map<string, string>): PerformanceProcessSummary {
    const reason = protectionReasons.get(normalizeProcessName(processInfo.name));
    return {
      ...processInfo,
      protected: Boolean(reason),
      protectionReason: reason,
    };
  }

  private buildProcessPreviewTargets(
    processes: PerformanceProcessSummary[],
    profile: PerformanceProfileConfig | null,
  ): PerformanceActionPreviewTarget[] {
    const protectionReasons = this.getProtectionReasons(profile);
    const terminateNames = dedupeStrings(profile?.processRules?.terminate);
    const terminateSet = new Set(terminateNames.map((name) => normalizeProcessName(name)));
    const explicitCandidates: Array<{
      processInfo: PerformanceProcessSummary;
      suggestedReason: string;
      checkedByDefault: boolean;
      risk: 'low' | 'medium' | 'high';
      score: number;
    }> = [];
    const heuristicCandidates: Array<{
      processInfo: PerformanceProcessSummary;
      suggestedReason: string;
      checkedByDefault: boolean;
      risk: 'low' | 'medium' | 'high';
      score: number;
    }> = [];

    for (const processInfo of processes) {
      const decoratedProcess = this.decorateProcess(processInfo, protectionReasons);
      const normalizedName = normalizeProcessName(processInfo.name);
      const risk = previewRiskForProcess(decoratedProcess);
      const blockedReason = decoratedProcess.protectionReason;

      if (terminateSet.has(normalizedName)) {
        explicitCandidates.push({
          processInfo: decoratedProcess,
          suggestedReason: 'Matched an active profile terminate rule.',
          checkedByDefault: !blockedReason,
          risk,
          score: 1_000 + previewScoreForProcess(decoratedProcess),
        });
        continue;
      }

      const heuristic = describeHeuristicProcessTarget(decoratedProcess);
      if (!heuristic) {
        continue;
      }

      heuristicCandidates.push({
        processInfo: decoratedProcess,
        suggestedReason: heuristic.suggestedReason,
        checkedByDefault: heuristic.checkedByDefault && !blockedReason,
        risk,
        score: heuristic.score,
      });
    }

    const rankedCandidates = [
      ...explicitCandidates.sort((left, right) => right.score - left.score),
      ...heuristicCandidates
        .sort((left, right) => right.score - left.score)
        .slice(0, explicitCandidates.length > 0 ? 4 : 6),
    ];

    const seen = new Set<string>();
    return rankedCandidates
      .filter((candidate) => {
        if (seen.has(candidate.processInfo.targetId)) return false;
        seen.add(candidate.processInfo.targetId);
        return true;
      })
      .slice(0, 8)
      .map((candidate) => {
        const processInfo = candidate.processInfo;
        const blockedReason = processInfo.protectionReason;
        return {
          targetId: processInfo.targetId,
          name: processInfo.name,
          label: processInfo.name,
          pid: processInfo.pid,
          cpuPercent: processInfo.cpuPercent,
          memoryMb: processInfo.memoryMb,
          suggestedReason: candidate.suggestedReason,
          checkedByDefault: candidate.checkedByDefault && !blockedReason,
          selectable: !blockedReason,
          blockedReason,
          risk: candidate.risk,
        } satisfies PerformanceActionPreviewTarget;
      });
  }

  private prunePreviews(): void {
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const [previewId, preview] of this.previews) {
      if (preview.createdAt < cutoff) {
        this.previews.delete(previewId);
      }
    }
  }

  private async probeLatencyTarget(
    target: PerformanceLatencyTarget,
    config: GuardianAgentConfig,
  ): Promise<PerformanceLatencyStatus> {
    const resolvedTarget = target.target?.trim()
      ? target.target.trim()
      : this.resolveLatencyTargetRef(target.targetRef, config);

    if (!resolvedTarget) {
      return {
        id: target.id,
        kind: target.kind,
        label: describeLatencyTarget(target),
        state: 'disabled',
        detail: target.targetRef
          ? `Could not resolve latency target ref '${target.targetRef}'.`
          : 'No latency target was configured.',
      };
    }

    if (typeof fetch !== 'function') {
      return {
        id: target.id,
        kind: target.kind,
        label: describeLatencyTarget(target),
        target: resolvedTarget,
        state: 'idle',
        detail: 'Latency probing is unavailable in this runtime.',
      };
    }

    const startedAt = perfHooksPerformance.now();
    try {
      const response = await fetch(resolvedTarget, {
        method: 'HEAD',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(LATENCY_TIMEOUT_MS),
      });
      if (response.body) {
        void response.body.cancel().catch(() => undefined);
      }
      return {
        id: target.id,
        kind: target.kind,
        label: describeLatencyTarget(target),
        target: resolvedTarget,
        state: 'ok',
        latencyMs: round(perfHooksPerformance.now() - startedAt),
        detail: response.ok ? undefined : `Responded with HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        id: target.id,
        kind: target.kind,
        label: describeLatencyTarget(target),
        target: resolvedTarget,
        state: 'error',
        detail: error instanceof Error ? error.message : 'Latency probe failed.',
      };
    }
  }

  private resolveLatencyTargetRef(targetRef: string | undefined, config: GuardianAgentConfig): string | undefined {
    if (!targetRef?.trim()) return undefined;
    if (targetRef === 'defaultProvider') {
      const provider = config.llm[config.defaultProvider];
      return provider?.baseUrl?.trim() || undefined;
    }
    return undefined;
  }

  private async getLatencyStatuses(): Promise<PerformanceLatencyStatus[]> {
    const sampleIntervalMs = Math.max(1, this.performanceConfig.sampleIntervalSec) * 1000;
    const now = Date.now();
    if (this.latencyCache && (now - this.latencyCache.generatedAt) < sampleIntervalMs) {
      return this.latencyCache.entries;
    }

    const activeProfile = this.getActiveProfile();
    const targets = activeProfile?.latencyTargets ?? [];
    if (targets.length === 0) {
      this.latencyCache = { generatedAt: now, entries: [] };
      return [];
    }

    const entries = await Promise.all(targets.map((target) => this.probeLatencyTarget(target, this.config)));
    this.latencyCache = { generatedAt: now, entries };
    return entries;
  }

  async getStatus(): Promise<PerformanceStatus> {
    const profile = this.getActiveProfile();
    const activeProfileId = profile?.id ?? this.ensureActiveProfileId();
    const snapshot = await this.options.adapter.collectSnapshot();
    const protectionReasons = this.getProtectionReasons(profile);
    const topProcesses = (snapshot.topProcesses ?? []).map((processInfo) => this.decorateProcess(processInfo, protectionReasons));

    const latencyTargets = await this.getLatencyStatuses();
    return {
      activeProfile: activeProfileId,
      os: process.platform,
      snapshot: {
        ...snapshot,
        activeProfile: activeProfileId,
        topProcesses,
      },
      capabilities: this.options.adapter.getCapabilities(),
      profiles: this.getProfiles().map(toProfileSummary),
      latencyTargets,
      history: this.getHistoryEntries(),
    };
  }

  async getProcesses(): Promise<PerformanceProcessSummary[]> {
    const profile = this.getActiveProfile();
    const protectionReasons = this.getProtectionReasons(profile);
    const processes = await this.options.adapter.listProcesses();
    return processes.map((processInfo) => this.decorateProcess(processInfo, protectionReasons));
  }

  private getHistoryEntries(): PerformanceActionHistoryEntry[] {
    if (!this.options.auditLog) {
      return [...this.history];
    }

    const actionEvents = this.options.auditLog.query({
      type: PERFORMANCE_ACTION_RUN_AUDIT_TYPE,
      limit: HISTORY_LIMIT,
    });
    const profileEvents = this.options.auditLog.query({
      type: PERFORMANCE_PROFILE_APPLIED_AUDIT_TYPE,
      limit: HISTORY_LIMIT,
    });

    return [...actionEvents, ...profileEvents]
      .map(toHistoryEntryFromAuditEvent)
      .filter((entry): entry is PerformanceActionHistoryEntry => entry !== null)
      .sort((a, b) => (b.executedAt - a.executedAt) || (historySequence(b) - historySequence(a)))
      .slice(0, HISTORY_LIMIT);
  }

  private pushHistoryEntry(
    entry: PerformanceActionHistoryEntry,
    auditType: typeof PERFORMANCE_ACTION_RUN_AUDIT_TYPE | typeof PERFORMANCE_PROFILE_APPLIED_AUDIT_TYPE,
    details: Record<string, unknown> = {},
  ): void {
    this.history.unshift(entry);
    this.history.splice(HISTORY_LIMIT);

    this.options.auditLog?.record({
      type: auditType,
      severity: entry.success ? 'info' : 'warn',
      agentId: 'performance-service',
      controller: 'PerformanceService',
      details: {
        actionId: entry.actionId,
        success: entry.success,
        message: entry.message,
        selectedProcessCount: entry.selectedProcessCount,
        selectedCleanupCount: entry.selectedCleanupCount,
        ...details,
      },
    });
  }

  async previewAction(actionId: string): Promise<PerformanceActionPreview> {
    if (!this.performanceConfig.enabled) {
      throw new Error('Performance management is disabled in configuration.');
    }
    if (actionId !== 'cleanup') {
      throw new Error(`Unknown performance action '${actionId}'.`);
    }

    this.prunePreviews();
    const profile = this.getActiveProfile();
    const processes = await this.options.adapter.listProcesses();
    const processTargets = this.buildProcessPreviewTargets(processes, profile);
    const previewId = randomUUID();
    this.previews.set(previewId, {
      actionId,
      createdAt: Date.now(),
      processTargets,
      cleanupTargets: [],
      processes,
    });

    return {
      previewId,
      profileId: profile?.id,
      processTargets,
      cleanupTargets: [],
    };
  }

  async runAction(action: ApprovedPerformanceAction): Promise<{ success: boolean; message: string }> {
    this.prunePreviews();
    const preview = this.previews.get(action.previewId);
    if (!preview) {
      return {
        success: false,
        message: 'This performance preview expired. Generate a fresh preview before running actions.',
      };
    }

    const selectedProcessIds = new Set(trimSelection(action.selectedProcessTargetIds));
    const selectedCleanupIds = new Set(trimSelection(action.selectedCleanupTargetIds));
    if (selectedProcessIds.size === 0 && selectedCleanupIds.size === 0) {
      return {
        success: false,
        message: 'Select at least one process or cleanup target before running the action.',
      };
    }

    const processTargetLookup = new Map(preview.processTargets.map((target) => [target.targetId, target]));
    const invalidProcessIds = [...selectedProcessIds].filter((targetId) => !processTargetLookup.get(targetId)?.selectable);
    if (invalidProcessIds.length > 0) {
      return {
        success: false,
        message: 'The selected process list is no longer valid. Generate a new preview and try again.',
      };
    }

    const selectedProcesses = preview.processes.filter((processInfo) => selectedProcessIds.has(processInfo.targetId));
    const messages: string[] = [];
    let success = true;

    if (selectedProcesses.length > 0) {
      const processResult = await this.options.adapter.terminateProcesses(selectedProcesses);
      success = success && processResult.success;
      messages.push(processResult.message);
    }

    if (selectedCleanupIds.size > 0) {
      const cleanupResult = await this.options.adapter.runCleanupActions([...selectedCleanupIds]);
      success = success && cleanupResult.success;
      messages.push(cleanupResult.message);
    }

    const message = messages.filter(Boolean).join(' ');
    this.pushHistoryEntry({
      id: randomUUID(),
      actionId: preview.actionId,
      executedAt: Date.now(),
      success,
      message,
      selectedProcessCount: selectedProcesses.length,
      selectedCleanupCount: selectedCleanupIds.size,
    }, PERFORMANCE_ACTION_RUN_AUDIT_TYPE, {
      previewId: action.previewId,
      profileId: preview.actionId === 'cleanup' ? this.getActiveProfile()?.id : undefined,
      selectedProcessTargetIds: [...selectedProcessIds],
      selectedCleanupTargetIds: [...selectedCleanupIds],
    });

    this.previews.delete(action.previewId);
    return {
      success,
      message,
    };
  }

  async applyProfile(profileId: string): Promise<{ success: boolean; message: string }> {
    if (!this.performanceConfig.enabled) {
      return {
        success: false,
        message: 'Performance management is disabled in configuration.',
      };
    }

    const profile = this.getProfiles().find((entry) => entry.id === profileId);
    if (!profile) {
      return {
        success: false,
        message: `Unknown performance profile '${profileId}'.`,
      };
    }

    this.activeProfileId = profile.id;
    this.latencyCache = null;

    const adapterResult = await this.options.adapter.applyProfile(profile);
    const message = `Active profile set to ${profile.name}. ${adapterResult.message}`.trim();
    this.pushHistoryEntry({
      id: randomUUID(),
      actionId: 'apply_profile',
      executedAt: Date.now(),
      success: true,
      message,
      selectedProcessCount: 0,
      selectedCleanupCount: 0,
    }, PERFORMANCE_PROFILE_APPLIED_AUDIT_TYPE, {
      profileId: profile.id,
      profileName: profile.name,
      hostProfileApplied: adapterResult.success,
    });
    return {
      success: true,
      message,
    };
  }
}
