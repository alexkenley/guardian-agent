import type { ToolExecutionRequest } from './types.js';

export interface ToolContextRequestSignals {
  requestText?: string;
}

export interface ToolContextCloudProfileSummary {
  family: 'cpanel' | 'vercel' | 'cloudflare' | 'aws' | 'gcp' | 'azure';
  id: string;
  label: string;
  line: string;
  keywords: string[];
}

export interface ToolContextInput {
  request?: Partial<ToolExecutionRequest> & ToolContextRequestSignals;
  workspaceRoot: string;
  policyMode: string;
  enabledCategories: string[];
  allowedPaths: string[];
  allowedCommands: string[];
  allowedDomains: string[];
  browserAllowedDomains: string[];
  browserUsesDedicatedAllowlist: boolean;
  browserAvailable: boolean;
  browserReadBackend?: string;
  browserInteractBackend?: string;
  dependencyLines: string[];
  deferredInventoryLines: string[];
  providerContextLines: string[];
  googleContextLines: string[];
  cloudEnabled: boolean;
  cloudSummaryLines: string[];
  cloudProfileLines: ToolContextCloudProfileSummary[];
  codeWorkspaceRoot?: string;
  policyUpdateActions: string;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatCompactInventory(values: string[], maxInlineItems: number): string {
  const unique = uniqueNonEmpty(values);
  if (unique.length === 0) return '';
  const shown = unique.slice(0, maxInlineItems);
  const suffix = unique.length > maxInlineItems
    ? ` (+${unique.length - maxInlineItems} more)`
    : '';
  return `${shown.join(', ')}${suffix}`;
}

function normalizeSignalText(value: string | undefined): string {
  return String(value ?? '').toLowerCase();
}

function readToolContextMode(
  request: (Partial<ToolExecutionRequest> & ToolContextRequestSignals) | undefined,
): 'tight' | 'standard' {
  return request?.toolContextMode === 'standard' ? 'standard' : 'tight';
}

function pickRelevantValues(values: string[], signalText: string, limit: number): string[] {
  const unique = uniqueNonEmpty(values);
  if (!signalText.trim()) return unique;
  const matched = unique.filter((value) => signalText.includes(value.toLowerCase()));
  if (matched.length > 0) {
    return [...matched, ...unique.filter((value) => !matched.includes(value))].slice(0, Math.max(limit, matched.length));
  }
  return unique;
}

function buildRelevantInventoryLine(label: string, values: string[], signalText: string, maxInlineItems: number): string {
  const unique = uniqueNonEmpty(values);
  if (unique.length === 0) return `${label} (0): (none)`;
  const prioritized = pickRelevantValues(unique, signalText, maxInlineItems);
  const matched = prioritized.filter((value) => signalText.includes(value.toLowerCase()));
  const summary = formatCompactInventory(prioritized, maxInlineItems) || '(none)';
  return matched.length > 0
    ? `${label} (${unique.length}, relevant: ${matched.join(', ')}): ${summary}`
    : `${label} (${unique.length}): ${summary}`;
}

function familyKeywords(family: ToolContextCloudProfileSummary['family']): string[] {
  switch (family) {
    case 'cpanel':
      return ['cpanel', 'whm', 'hosting'];
    case 'vercel':
      return ['vercel'];
    case 'cloudflare':
      return ['cloudflare', 'cf'];
    case 'aws':
      return ['aws'];
    case 'gcp':
      return ['gcp', 'google cloud'];
    case 'azure':
      return ['azure'];
  }
}

function pickRelevantCloudProfiles(
  profiles: ToolContextCloudProfileSummary[],
  signalText: string,
  maxCount: number,
): ToolContextCloudProfileSummary[] {
  if (!signalText.trim()) return profiles.slice(0, maxCount);
  const scored = profiles.map((profile) => {
    let score = 0;
    for (const keyword of [...profile.keywords, ...familyKeywords(profile.family)]) {
      if (keyword && signalText.includes(keyword.toLowerCase())) score += 1;
    }
    return { profile, score };
  });
  const matched = scored.filter((entry) => entry.score > 0).map((entry) => entry.profile);
  if (matched.length > 0) return matched.slice(0, Math.max(maxCount, matched.length));
  return profiles.slice(0, maxCount);
}

function buildBrowserContextLines(input: ToolContextInput, signalText: string): string[] {
  if (!input.browserAvailable) {
    return ['Browser automation: unavailable'];
  }

  const relevantDomains = pickRelevantValues(input.browserAllowedDomains, signalText, 6);
  const matched = relevantDomains.filter((value) => signalText.includes(value.toLowerCase()));
  return [
    `Browser automation: available (read=${input.browserReadBackend ?? 'none'}, interact=${input.browserInteractBackend ?? 'none'})`,
    matched.length > 0
      ? `Browser allowed domains (${input.browserAllowedDomains.length}, relevant: ${matched.join(', ')}): ${formatCompactInventory(relevantDomains, 6) || '(none)'}${input.browserUsesDedicatedAllowlist ? '' : ' (inherits general allowedDomains)'}`
      : `Browser allowed domains: ${formatCompactInventory(relevantDomains, 6) || '(none)'}${input.browserUsesDedicatedAllowlist ? '' : ' (inherits general allowedDomains)'}`,
    'Use Guardian-native browser tools first: browser_capabilities, browser_navigate, browser_read, browser_links, browser_extract, browser_state, and browser_act.',
    'browser_interact remains available as a compatibility shim; prefer browser_state/browser_act for new flows and saved automations.',
  ];
}

function buildCloudContextLines(input: ToolContextInput, signalText: string): string[] {
  if (!input.cloudEnabled) {
    return ['Cloud tools: disabled'];
  }

  const lines = [
    'Cloud tools: enabled',
    'Cloud tool families available via find_tools: cpanel_*, whm_*, vercel_*, cf_*, aws_*, gcp_*, azure_*',
    'Use configured cloud profile ids exactly as listed below when calling cloud tools. If a matching profile is listed, do not ask the user to repeat host or credential details.',
    ...input.cloudSummaryLines,
  ];
  const relevantProfiles = pickRelevantCloudProfiles(input.cloudProfileLines, signalText, 6);
  lines.push(...relevantProfiles.map((profile) => profile.line));
  if (input.cloudProfileLines.length > relevantProfiles.length) {
    lines.push(`... (+${input.cloudProfileLines.length - relevantProfiles.length} more cloud profiles)`);
  }
  return lines.slice(0, 12);
}

export function buildToolContext(input: ToolContextInput): string {
  const signalText = normalizeSignalText(input.request?.requestText);
  const toolContextMode = readToolContextMode(input.request);
  const compactPathItems = toolContextMode === 'tight' ? 4 : 6;
  const compactCommandItems = toolContextMode === 'tight' ? 6 : 10;
  const compactDomainItems = toolContextMode === 'tight' ? 5 : 8;
  const providerContextLines = toolContextMode === 'tight'
    ? input.providerContextLines.slice(0, 1)
    : input.providerContextLines;
  const googleContextLines = toolContextMode === 'tight'
    ? input.googleContextLines.slice(0, 3)
    : input.googleContextLines;
  const lines: string[] = [
    `Workspace root (default for file operations): ${input.workspaceRoot}`,
    `Policy mode: ${input.policyMode}`,
    buildRelevantInventoryLine('Allowed paths', input.allowedPaths, signalText, compactPathItems) || 'Allowed paths (0): (workspace root only)',
    buildRelevantInventoryLine('Allowed commands', input.allowedCommands, signalText, compactCommandItems) || 'Allowed commands (0): (none)',
    'Execution identity policy: inline interpreter eval, shell-expression launchers, and package launchers such as npx/npm exec are blocked even when the base command prefix is allowlisted.',
    'Execution mode: simple direct-binary commands run without shell parsing when possible; shell fallback is reserved for shell-builtins, chained commands, redirects, and platform wrapper cases.',
    `Enabled tool categories: ${input.enabledCategories.join(', ') || '(none)'}`,
    input.policyUpdateActions,
    'Provider/model management via find_tools: llm_provider_list, llm_provider_models, llm_provider_update.',
    'Performance operations via find_tools: performance_status_get, performance_action_preview, performance_action_run, performance_profile_apply.',
    'Additional tools may be hidden by deferred loading. Use find_tools to discover tools that are not currently visible.',
  ];

  if (input.codeWorkspaceRoot) {
    lines.push(
      `Active coding session workspace: ${input.codeWorkspaceRoot}`,
      'For this coding-session request, the workspace root above is already trusted. Do not call update_tool_policy to add that same path unless the user explicitly wants to widen the persistent global allowlist.',
    );
  }

  lines.push(...input.dependencyLines);
  lines.push(...input.deferredInventoryLines);
  if (input.allowedDomains.length > 0) {
    lines.push(buildRelevantInventoryLine('Allowed domains', input.allowedDomains, signalText, compactDomainItems));
  }
  lines.push(...providerContextLines);
  lines.push(...buildBrowserContextLines(input, signalText));
  lines.push(...googleContextLines);
  lines.push(...buildCloudContextLines(input, signalText));
  return lines.join('\n');
}
