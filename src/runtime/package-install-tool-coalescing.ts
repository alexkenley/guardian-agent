import {
  parseManagedPackageInstallCommand,
  type ManagedPackageInstallPlan,
} from './package-install-trust.js';

export interface PackageInstallToolCallLike {
  id: string;
  name: string;
  arguments?: string;
}

interface ParsedPackageInstallToolCall<T extends PackageInstallToolCallLike> {
  toolCall: T;
  args: Record<string, unknown>;
  plan: ManagedPackageInstallPlan;
  key: string;
}

export function coalescePackageInstallToolCalls<T extends PackageInstallToolCallLike>(
  toolCalls: T[] | undefined,
): Array<T & { arguments: string }> | undefined {
  if (!toolCalls?.length) return toolCalls as Array<T & { arguments: string }> | undefined;

  const parsedByIndex = new Map<number, ParsedPackageInstallToolCall<T>>();
  const groupedIndexes = new Map<string, number[]>();

  toolCalls.forEach((toolCall, index) => {
    const parsed = parsePackageInstallToolCall(toolCall);
    if (!parsed) return;
    parsedByIndex.set(index, parsed);
    const indexes = groupedIndexes.get(parsed.key) ?? [];
    indexes.push(index);
    groupedIndexes.set(parsed.key, indexes);
  });

  if (![...groupedIndexes.values()].some((indexes) => indexes.length > 1)) {
    return toolCalls.map((toolCall) => ({
      ...toolCall,
      arguments: toolCall.arguments ?? '{}',
    }));
  }

  const removedIndexes = new Set<number>();
  const mergedByFirstIndex = new Map<number, T & { arguments: string }>();
  for (const indexes of groupedIndexes.values()) {
    if (indexes.length <= 1) continue;
    const firstParsed = parsedByIndex.get(indexes[0]);
    if (!firstParsed) continue;
    const packageSpecs: string[] = [];
    const seenPackageSpecs = new Set<string>();
    for (const index of indexes) {
      const parsed = parsedByIndex.get(index);
      if (!parsed) continue;
      for (const spec of parsed.plan.packageSpecs) {
        if (seenPackageSpecs.has(spec)) continue;
        seenPackageSpecs.add(spec);
        packageSpecs.push(spec);
      }
      if (index !== indexes[0]) {
        removedIndexes.add(index);
      }
    }
    mergedByFirstIndex.set(indexes[0], {
      ...firstParsed.toolCall,
      arguments: JSON.stringify({
        ...firstParsed.args,
        command: formatPackageInstallCommand(firstParsed.plan, packageSpecs),
      }),
    });
  }

  return toolCalls.reduce<Array<T & { arguments: string }>>((acc, toolCall, index) => {
    if (removedIndexes.has(index)) return acc;
    acc.push(mergedByFirstIndex.get(index) ?? {
      ...toolCall,
      arguments: toolCall.arguments ?? '{}',
    });
    return acc;
  }, []);
}

function parsePackageInstallToolCall<T extends PackageInstallToolCallLike>(
  toolCall: T,
): ParsedPackageInstallToolCall<T> | null {
  if (toolCall.name !== 'package_install') return null;
  const args = parseToolCallArguments(toolCall.arguments);
  if (!args) return null;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return null;
  const planned = parseManagedPackageInstallCommand(command);
  if (!planned.success || !planned.plan || planned.plan.packageSpecs.length === 0) {
    return null;
  }
  return {
    toolCall,
    args,
    plan: planned.plan,
    key: buildPackageInstallCoalescingKey(args, planned.plan),
  };
}

function parseToolCallArguments(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildPackageInstallCoalescingKey(
  args: Record<string, unknown>,
  plan: ManagedPackageInstallPlan,
): string {
  return JSON.stringify({
    cwd: typeof args.cwd === 'string' ? args.cwd.trim() : '',
    allowCaution: args.allowCaution === true,
    ecosystem: plan.ecosystem,
    manager: plan.manager,
    runnerPrefix: plan.runnerPrefix,
    action: plan.action,
    installOptionTokens: plan.installOptionTokens,
    stageOptionTokens: plan.stageOptionTokens,
    installTarget: plan.installTarget,
  });
}

function formatPackageInstallCommand(plan: ManagedPackageInstallPlan, packageSpecs: string[]): string {
  return [
    ...plan.runnerPrefix,
    plan.action,
    ...plan.installOptionTokens,
    ...packageSpecs,
  ].map(quoteShellToken).join(' ');
}

function quoteShellToken(token: string): string {
  if (/^[A-Za-z0-9@%_+=:,./~^-]+$/u.test(token)) return token;
  return `"${token.replace(/(["\\$`])/g, '\\$1')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
