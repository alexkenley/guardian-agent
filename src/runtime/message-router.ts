/**
 * Message Router — routes user messages to the appropriate agent.
 *
 * Supports three strategies:
 * - keyword: regex pattern matching per agent, with domain heuristic fallback
 * - capability: domain heuristic matching only (no regex)
 * - explicit: always returns fallback agent
 *
 * Tier routing layer (auto/local-only/external-only) uses complexity scoring
 * to pick the right tier, with optional fallback to the opposite tier.
 *
 * Pure synchronous router — no LLM calls.
 */

import type { RoutingConfig, RoutingRuleConfig } from '../config/types.js';
import { scoreAutomationOrchestration, scoreComplexity } from './complexity-scorer.js';

/** Confidence level for a routing decision. */
export type RouteConfidence = 'high' | 'medium' | 'low';

/** Result of routing a message. */
export interface RouteDecision {
  agentId: string;
  confidence: RouteConfidence;
  reason: string;
  /** Agent to try if the primary agent fails. */
  fallbackAgentId?: string;
  /** Complexity score (0-1) when tier routing was used. */
  complexityScore?: number;
  /** Tier the message was assigned to. */
  tier?: 'local' | 'external';
}

/** Registered agent info used by the router. */
export interface RouterAgent {
  id: string;
  capabilities: readonly string[];
  patterns: RegExp[];
  domains: string[];
  priority: number;
  /** Role tag for tier routing. */
  role?: 'local' | 'external' | 'general';
}

/** Built-in domain keyword groups mapped to capability strings. */
const DOMAIN_KEYWORDS: Record<string, { keywords: RegExp; capabilities: string[] }> = {
  filesystem: {
    keywords: /\b(file|folder|directory|path|read|write|create|delete|move|copy|rename|mkdir|rmdir|save|open|ls|dir)\b/i,
    capabilities: ['read_files', 'write_files'],
  },
  code: {
    keywords: /\b(code|compile|build|run|execute|script|git|commit|branch|merge|pull|push|test|debug|lint|npm|node|package|deploy)\b/i,
    capabilities: ['execute_commands'],
  },
  network: {
    keywords: /\b(web|http|https|url|api|fetch|download|upload|browse|search|scrape|curl|request|website|internet|online|cve|vulnerability|threat)\b/i,
    capabilities: ['network_access'],
  },
  email: {
    keywords: /\b(email|mail|inbox|send|draft|compose|reply|forward|attachment|gmail|outlook|smtp|imap)\b/i,
    capabilities: ['read_email', 'send_email', 'draft_email'],
  },
  workspace: {
    keywords: /\b(calendar|meeting|schedule|event|invite|drive|folder|docs|document|sheets|spreadsheet|worksheet)\b/i,
    capabilities: [
      'read_calendar',
      'write_calendar',
      'read_drive',
      'write_drive',
      'read_docs',
      'write_docs',
      'read_sheets',
      'write_sheets',
    ],
  },
};

export class MessageRouter {
  private agents: Map<string, RouterAgent> = new Map();
  private strategy: RoutingConfig['strategy'];
  private fallbackAgentId: string | undefined;

  constructor(config?: RoutingConfig) {
    this.strategy = config?.strategy ?? 'keyword';
    this.fallbackAgentId = config?.fallbackAgent;
  }

  /** Register an agent with the router, optionally tagging its role. */
  registerAgent(
    id: string,
    capabilities: readonly string[],
    rule?: RoutingRuleConfig,
    role?: 'local' | 'external' | 'general',
  ): void {
    const patterns = (rule?.patterns ?? []).map(p => new RegExp(p, 'i'));
    const domains = rule?.domains ?? [];
    const priority = rule?.priority ?? 10;
    this.agents.set(id, { id, capabilities, patterns, domains, priority, role });
  }

  /** Unregister an agent from the router. */
  unregisterAgent(id: string): void {
    this.agents.delete(id);
  }

  /** Get the fallback agent ID (configured or first registered). */
  private getFallbackId(): string {
    if (this.fallbackAgentId && this.agents.has(this.fallbackAgentId)) {
      return this.fallbackAgentId;
    }
    const first = this.agents.keys().next();
    return first.done ? 'default' : first.value;
  }

  /** Route a message to the best agent (original strategy, no tier logic). */
  route(content: string): RouteDecision {
    if (this.agents.size === 0) {
      return { agentId: 'default', confidence: 'low', reason: 'no agents registered' };
    }

    if (this.strategy === 'explicit') {
      const fallback = this.getFallbackId();
      return { agentId: fallback, confidence: 'high', reason: 'explicit strategy — using fallback agent' };
    }

    // Keyword strategy: try regex patterns first
    if (this.strategy === 'keyword') {
      const patternMatch = this.matchByPatterns(content);
      if (patternMatch) return patternMatch;
    }

    // Both keyword and capability strategies use domain heuristics
    const domainMatch = this.matchByDomain(content);
    if (domainMatch) return domainMatch;

    // No match — use fallback
    const fallback = this.getFallbackId();
    return { agentId: fallback, confidence: 'low', reason: 'no pattern or domain match — using fallback' };
  }

  /**
   * Route with tier-aware complexity scoring.
   *
   * - 'local-only'    → force local agent when available
   * - 'external-only' → force external agent when available
   * - 'auto'          → score complexity, pick tier, set fallback to opposite
   *
   * High-confidence pattern matches override tier scoring.
   */
  routeWithTier(
    content: string,
    tierMode: 'auto' | 'local-only' | 'external-only',
    threshold = 0.5,
  ): RouteDecision {
    const localAgent = this.findAgentByRole('local');
    const externalAgent = this.findAgentByRole('external');

    // If no role-tagged agents exist, fall through to plain route()
    if (!localAgent && !externalAgent) {
      return this.route(content);
    }

    // Forced modes
    if (tierMode === 'local-only') {
      if (localAgent) {
        return {
          agentId: localAgent.id,
          confidence: 'high',
          reason: 'tier mode: local-only',
          tier: 'local',
        };
      }
      return {
        agentId: externalAgent!.id,
        confidence: 'medium',
        reason: 'tier mode: local-only unavailable; only external tier available',
        tier: 'external',
      };
    }

    if (tierMode === 'external-only') {
      if (externalAgent) {
        return {
          agentId: externalAgent.id,
          confidence: 'high',
          reason: 'tier mode: external-only',
          tier: 'external',
        };
      }
      return {
        agentId: localAgent!.id,
        confidence: 'medium',
        reason: 'tier mode: external-only unavailable; only local tier available',
        tier: 'local',
      };
    }

    const automationScore = scoreAutomationOrchestration(content);
    if (automationScore >= 0.75 && externalAgent) {
      return {
        agentId: externalAgent.id,
        confidence: 'high',
        reason: `automation complexity=${automationScore.toFixed(2)} → tier external`,
        fallbackAgentId: localAgent?.id,
        complexityScore: automationScore,
        tier: 'external',
      };
    }

    // Auto mode — check for high-confidence pattern match first
    if (this.strategy === 'keyword') {
      const patternMatch = this.matchByPatterns(content);
      if (patternMatch && patternMatch.confidence === 'high') {
        // Attach fallback info but respect the pattern's choice
        const primaryRole = this.agents.get(patternMatch.agentId)?.role;
        const fallbackAgent = primaryRole === 'local' ? externalAgent
          : primaryRole === 'external' ? localAgent
          : undefined;
        return {
          ...patternMatch,
          fallbackAgentId: fallbackAgent?.id,
          tier: primaryRole === 'local' || primaryRole === 'external' ? primaryRole : undefined,
        };
      }
    }

    // Score complexity
    const { score, tier } = scoreComplexity(content, threshold);

    // Only one tier available — use it, no fallback
    if (!localAgent) {
      return {
        agentId: externalAgent!.id,
        confidence: 'medium',
        reason: `only external tier available (complexity=${score.toFixed(2)})`,
        complexityScore: score,
        tier: 'external',
      };
    }
    if (!externalAgent) {
      return {
        agentId: localAgent.id,
        confidence: 'medium',
        reason: `only local tier available (complexity=${score.toFixed(2)})`,
        complexityScore: score,
        tier: 'local',
      };
    }

    // Both tiers available — route by complexity, set fallback to opposite
    const primary = tier === 'local' ? localAgent : externalAgent;
    const fallback = tier === 'local' ? externalAgent : localAgent;

    return {
      agentId: primary.id,
      confidence: score >= 0.7 || score <= 0.2 ? 'high' : 'medium',
      reason: `complexity=${score.toFixed(2)} → tier ${tier}`,
      fallbackAgentId: fallback.id,
      complexityScore: score,
      tier,
    };
  }

  /** Find the first agent with the given role. */
  findAgentByRole(role: 'local' | 'external' | 'general'): RouterAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.role === role) return agent;
    }
    return undefined;
  }

  /** Match message against agent regex patterns. Returns first match by priority. */
  private matchByPatterns(content: string): RouteDecision | null {
    const matches: { agent: RouterAgent; pattern: string }[] = [];

    for (const agent of this.agents.values()) {
      for (const pattern of agent.patterns) {
        if (pattern.test(content)) {
          matches.push({ agent, pattern: pattern.source });
          break; // one match per agent is enough
        }
      }
    }

    if (matches.length === 0) return null;

    // Sort by priority (lower = higher priority)
    matches.sort((a, b) => a.agent.priority - b.agent.priority);
    const best = matches[0];
    return {
      agentId: best.agent.id,
      confidence: 'high',
      reason: `pattern matched: /${best.pattern}/`,
    };
  }

  /** Match message against domain keyword groups, score agents by capability overlap. */
  private matchByDomain(content: string): RouteDecision | null {
    // Find which domains are active in this message
    const activeDomains: string[] = [];
    const activeCapabilities = new Set<string>();

    for (const [domain, { keywords, capabilities }] of Object.entries(DOMAIN_KEYWORDS)) {
      if (keywords.test(content)) {
        activeDomains.push(domain);
        for (const cap of capabilities) {
          activeCapabilities.add(cap);
        }
      }
    }

    if (activeDomains.length === 0) return null;

    // Score each agent by how many active capabilities it has + domain config overlap
    const scores: { agent: RouterAgent; score: number }[] = [];

    for (const agent of this.agents.values()) {
      let score = 0;

      // Score by capability overlap
      for (const cap of agent.capabilities) {
        if (activeCapabilities.has(cap)) score += 2;
      }

      // Score by configured domain overlap
      for (const domain of agent.domains) {
        if (activeDomains.includes(domain)) score += 3;
      }

      if (score > 0) {
        scores.push({ agent, score });
      }
    }

    if (scores.length === 0) return null;

    // Sort by score descending, then by priority ascending (lower = higher)
    scores.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.agent.priority - b.agent.priority;
    });

    const best = scores[0];
    const confidence: RouteConfidence = best.score >= 4 ? 'high' : 'medium';
    return {
      agentId: best.agent.id,
      confidence,
      reason: `domain match: [${activeDomains.join(', ')}] → score ${best.score}`,
    };
  }

  /** Get all registered agent IDs. */
  getAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  /** Check if an agent is registered. */
  hasAgent(id: string): boolean {
    return this.agents.has(id);
  }
}
