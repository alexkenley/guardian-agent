/**
 * Unit tests for MessageRouter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageRouter } from './message-router.js';

describe('MessageRouter', () => {
  let router: MessageRouter;

  // ─── Keyword strategy (default) ────────────────────────────

  describe('keyword strategy', () => {
    beforeEach(() => {
      router = new MessageRouter({ strategy: 'keyword' });
    });

    it('should route by regex pattern match', () => {
      router.registerAgent('local', ['read_files', 'write_files'], {
        patterns: ['\\b(file|folder|directory)\\b'],
        priority: 5,
      });
      router.registerAgent('external', ['network_access'], {
        patterns: ['\\b(web|search|browse)\\b'],
        priority: 5,
      });

      const result = router.route('create a new file in the project');
      expect(result.agentId).toBe('local');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('pattern matched');
    });

    it('should route web queries to external agent', () => {
      router.registerAgent('local', ['read_files'], {
        patterns: ['\\b(file|folder)\\b'],
      });
      router.registerAgent('external', ['network_access'], {
        patterns: ['\\b(web|search|browse|internet)\\b'],
      });

      const result = router.route('search the web for latest CVEs');
      expect(result.agentId).toBe('external');
      expect(result.confidence).toBe('high');
    });

    it('should fall back to domain heuristic when no pattern matches', () => {
      router.registerAgent('local', ['read_files', 'write_files'], {
        patterns: ['\\bspecific_keyword\\b'],
        domains: ['filesystem'],
      });
      router.registerAgent('external', ['network_access'], {
        patterns: ['\\bother_keyword\\b'],
        domains: ['network'],
      });

      // "save a document" doesn't match patterns, but "save" matches filesystem domain
      const result = router.route('save a document to disk');
      expect(result.agentId).toBe('local');
      // score >= 4 (domain match 3 + capability overlap 2+2 = 7), so 'high'
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('domain match');
    });

    it('should use fallback when nothing matches', () => {
      router.registerAgent('local', ['read_files'], {
        patterns: ['\\bfile\\b'],
      });
      router.registerAgent('external', ['network_access'], {
        patterns: ['\\bweb\\b'],
      });

      const result = router.route('hello how are you');
      expect(result.agentId).toBe('local'); // first registered = fallback
      expect(result.confidence).toBe('low');
      expect(result.reason).toContain('fallback');
    });

    it('should respect priority ordering on pattern tie', () => {
      router.registerAgent('agent-a', [], {
        patterns: ['\\btest\\b'],
        priority: 10,
      });
      router.registerAgent('agent-b', [], {
        patterns: ['\\btest\\b'],
        priority: 5,
      });

      const result = router.route('run the test suite');
      expect(result.agentId).toBe('agent-b'); // lower priority number wins
    });
  });

  // ─── Domain heuristic matching ─────────────────────────────

  describe('domain heuristic', () => {
    beforeEach(() => {
      router = new MessageRouter({ strategy: 'keyword' });
    });

    it('should route "create a file" to agent with filesystem capabilities', () => {
      router.registerAgent('local', ['read_files', 'write_files'], {
        domains: ['filesystem'],
      });
      router.registerAgent('external', ['network_access'], {
        domains: ['network'],
      });

      const result = router.route('create a file called notes.txt');
      expect(result.agentId).toBe('local');
    });

    it('should route "send an email" to agent with email capabilities', () => {
      router.registerAgent('local', ['read_files'], {
        domains: ['filesystem'],
      });
      router.registerAgent('external', ['send_email', 'read_email'], {
        domains: ['email'],
      });

      const result = router.route('send an email to the team');
      expect(result.agentId).toBe('external');
    });

    it('should route calendar tasks to agent with workspace capabilities', () => {
      router.registerAgent('local', ['read_files'], {
        domains: ['filesystem'],
      });
      router.registerAgent('workspace', ['read_calendar', 'write_calendar'], {
        domains: ['workspace'],
      });

      const result = router.route('schedule a calendar event for tomorrow');
      expect(result.agentId).toBe('workspace');
    });

    it('should route docs and sheets tasks to agent with workspace capabilities', () => {
      router.registerAgent('local', ['read_files'], {
        domains: ['filesystem'],
      });
      router.registerAgent('workspace', ['read_docs', 'write_sheets'], {
        domains: ['workspace'],
      });

      const result = router.route('update the spreadsheet and summarize the document');
      expect(result.agentId).toBe('workspace');
    });

    it('should route "git commit" to agent with code capabilities', () => {
      router.registerAgent('local', ['execute_commands'], {
        domains: ['code'],
      });
      router.registerAgent('external', ['network_access'], {
        domains: ['network'],
      });

      const result = router.route('git commit my changes');
      expect(result.agentId).toBe('local');
    });

    it('should pick best scoring agent for ambiguous messages', () => {
      router.registerAgent('local', ['read_files', 'write_files', 'execute_commands'], {
        domains: ['filesystem', 'code'],
      });
      router.registerAgent('external', ['network_access'], {
        domains: ['network'],
      });

      // "download" matches network, "file" matches filesystem — local has more filesystem coverage
      const result = router.route('download a file from the internet');
      // Both agents match; external has network domain + capability, local has filesystem
      // external: network domain(3) + network_access cap(2) = 5
      // local: filesystem domain(3) + read_files cap(2) + write_files cap(2) = 7
      expect(result.agentId).toBe('local');
    });
  });

  // ─── Capability strategy ───────────────────────────────────

  describe('capability strategy', () => {
    beforeEach(() => {
      router = new MessageRouter({ strategy: 'capability' });
    });

    it('should ignore regex patterns and use domain heuristics only', () => {
      router.registerAgent('local', ['read_files'], {
        patterns: ['\\bweb\\b'], // this pattern matches, but capability strategy should ignore patterns
        domains: ['filesystem'],
      });
      router.registerAgent('external', ['network_access'], {
        domains: ['network'],
      });

      // "search the web" — pattern would match local, but domain matches external
      const result = router.route('search the web for docs');
      expect(result.agentId).toBe('external');
    });

    it('should fall back when no domain matches', () => {
      router.registerAgent('agent-a', ['read_files'], { domains: ['filesystem'] });

      const result = router.route('tell me a joke');
      expect(result.agentId).toBe('agent-a'); // fallback to first
      expect(result.confidence).toBe('low');
    });
  });

  // ─── Explicit strategy ─────────────────────────────────────

  describe('explicit strategy', () => {
    it('should always return fallback agent', () => {
      router = new MessageRouter({ strategy: 'explicit', fallbackAgent: 'agent-b' });
      router.registerAgent('agent-a', [], {});
      router.registerAgent('agent-b', [], {});

      const r1 = router.route('create a file');
      expect(r1.agentId).toBe('agent-b');
      expect(r1.confidence).toBe('high');

      const r2 = router.route('search the web');
      expect(r2.agentId).toBe('agent-b');
    });

    it('should fall back to first agent if configured fallback is missing', () => {
      router = new MessageRouter({ strategy: 'explicit', fallbackAgent: 'nonexistent' });
      router.registerAgent('real-agent', [], {});

      const result = router.route('anything');
      expect(result.agentId).toBe('real-agent');
    });
  });

  // ─── Fallback behavior ─────────────────────────────────────

  describe('fallback', () => {
    it('should return configured fallback agent', () => {
      router = new MessageRouter({ strategy: 'keyword', fallbackAgent: 'external' });
      router.registerAgent('local', [], {});
      router.registerAgent('external', [], {});

      const result = router.route('hello there');
      expect(result.agentId).toBe('external');
      expect(result.confidence).toBe('low');
    });

    it('should return "default" when no agents registered', () => {
      router = new MessageRouter({ strategy: 'keyword' });

      const result = router.route('anything');
      expect(result.agentId).toBe('default');
      expect(result.confidence).toBe('low');
    });
  });

  // ─── Register / Unregister ─────────────────────────────────

  describe('register/unregister', () => {
    beforeEach(() => {
      router = new MessageRouter({ strategy: 'keyword' });
    });

    it('should list registered agent IDs', () => {
      router.registerAgent('a', [], {});
      router.registerAgent('b', [], {});
      expect(router.getAgentIds()).toEqual(['a', 'b']);
    });

    it('should remove agent on unregister', () => {
      router.registerAgent('a', [], {});
      router.registerAgent('b', [], {});
      router.unregisterAgent('a');
      expect(router.getAgentIds()).toEqual(['b']);
      expect(router.hasAgent('a')).toBe(false);
    });

    it('should update fallback after unregister', () => {
      router = new MessageRouter({ strategy: 'keyword', fallbackAgent: 'a' });
      router.registerAgent('a', [], {});
      router.registerAgent('b', [], {});
      router.unregisterAgent('a');

      const result = router.route('hello');
      expect(result.agentId).toBe('b'); // fallback 'a' gone, uses first remaining
    });
  });

  // ─── Default config ────────────────────────────────────────

  describe('default config', () => {
    it('should default to keyword strategy when no config provided', () => {
      router = new MessageRouter();
      router.registerAgent('local', ['read_files'], {
        patterns: ['\\bfile\\b'],
      });

      const result = router.route('read a file');
      expect(result.agentId).toBe('local');
      expect(result.confidence).toBe('high');
    });
  });

  // ─── Tier routing ──────────────────────────────────────────

  describe('tier routing', () => {
    beforeEach(() => {
      router = new MessageRouter({ strategy: 'keyword' });
      router.registerAgent('local', ['read_files', 'write_files'], {
        domains: ['filesystem', 'code'],
        patterns: ['\\b(file|folder)\\b'],
        priority: 5,
      }, 'local');
      router.registerAgent('external', ['network_access'], {
        domains: ['network'],
        patterns: ['\\b(web|search|browse)\\b'],
        priority: 5,
      }, 'external');
    });

    it('should route simple messages to local in auto mode', () => {
      const result = router.routeWithTier('hello there', 'auto', 0.5);
      expect(result.agentId).toBe('local');
      expect(result.tier).toBe('local');
      expect(result.complexityScore).toBeDefined();
      expect(result.complexityScore!).toBeLessThan(0.5);
    });

    it('should route complex messages to external in auto mode', () => {
      const result = router.routeWithTier(
        'Explain why the async middleware pipeline architecture has latency trade-offs compared to synchronous patterns. Analyze the best approach for migrating the API schema, but not the legacy endpoints, unless backward compatibility is required. First assess the current design, then recommend improvements.',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('external');
      expect(result.tier).toBe('external');
      expect(result.complexityScore).toBeDefined();
      expect(result.complexityScore!).toBeGreaterThanOrEqual(0.5);
    });

    it('should route complex automation requests to external in auto mode', () => {
      const result = router.routeWithTier(
        'Build a weekday lead research workflow that reads a CSV of company names from the workspace, researches each company’s website and public presence, scores them against a simple ICP, writes the results to a new CSV in the workspace, and creates a short summary report.',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('external');
      expect(result.tier).toBe('external');
      expect(result.reason).toContain('automation complexity');
      expect(result.fallbackAgentId).toBe('local');
    });

    it('should set fallbackAgentId to opposite tier in auto mode', () => {
      const simple = router.routeWithTier('hi', 'auto', 0.5);
      expect(simple.agentId).toBe('local');
      expect(simple.fallbackAgentId).toBe('external');

      const complex = router.routeWithTier(
        'Explain why the async middleware pipeline architecture has latency trade-offs compared to synchronous patterns. Analyze the best approach for migrating the API schema, but not the legacy endpoints, unless backward compatibility is required. First assess the current design, then recommend improvements.',
        'auto',
        0.5,
      );
      expect(complex.agentId).toBe('external');
      expect(complex.fallbackAgentId).toBe('local');
    });

    it('should force local agent in local-only mode', () => {
      const result = router.routeWithTier(
        'Explain complex architecture trade-offs for microservice JWT pipeline',
        'local-only',
      );
      expect(result.agentId).toBe('local');
      expect(result.tier).toBe('local');
      expect(result.fallbackAgentId).toBeUndefined();
    });

    it('should force external agent in managed-cloud-only mode', () => {
      const result = router.routeWithTier('hello', 'managed-cloud-only');
      expect(result.agentId).toBe('external');
      expect(result.tier).toBe('external');
      expect(result.fallbackAgentId).toBeUndefined();
      expect(result.reason).toContain('managed-cloud-only');
    });

    it('should force external agent in frontier-only mode', () => {
      const result = router.routeWithTier('hello', 'frontier-only');
      expect(result.agentId).toBe('external');
      expect(result.tier).toBe('external');
      expect(result.fallbackAgentId).toBeUndefined();
      expect(result.reason).toContain('frontier-only');
    });

    it('should handle single-tier gracefully (only local)', () => {
      const singleRouter = new MessageRouter({ strategy: 'keyword' });
      singleRouter.registerAgent('local', ['read_files'], {}, 'local');

      const result = singleRouter.routeWithTier('explain complex patterns', 'auto', 0.5);
      expect(result.agentId).toBe('local');
      expect(result.fallbackAgentId).toBeUndefined();
    });

    it('should not label local-only as local when only external exists', () => {
      const singleRouter = new MessageRouter({ strategy: 'keyword' });
      singleRouter.registerAgent('external', ['network_access'], {}, 'external');

      const result = singleRouter.routeWithTier('hello', 'local-only', 0.5);
      expect(result.agentId).toBe('external');
      expect(result.tier).toBe('external');
      expect(result.reason).toContain('local-only unavailable');
    });

    it('should handle single-tier gracefully (only external)', () => {
      const singleRouter = new MessageRouter({ strategy: 'keyword' });
      singleRouter.registerAgent('external', ['network_access'], {}, 'external');

      const result = singleRouter.routeWithTier('hello', 'auto', 0.5);
      expect(result.agentId).toBe('external');
      expect(result.fallbackAgentId).toBeUndefined();
    });

    it('should not label managed-cloud-only as external when only local exists', () => {
      const singleRouter = new MessageRouter({ strategy: 'keyword' });
      singleRouter.registerAgent('local', ['read_files'], {}, 'local');

      const result = singleRouter.routeWithTier('hello', 'managed-cloud-only', 0.5);
      expect(result.agentId).toBe('local');
      expect(result.tier).toBe('local');
      expect(result.reason).toContain('managed-cloud-only unavailable');
    });

    it('should not label frontier-only as external when only local exists', () => {
      const singleRouter = new MessageRouter({ strategy: 'keyword' });
      singleRouter.registerAgent('local', ['read_files'], {}, 'local');

      const result = singleRouter.routeWithTier('hello', 'frontier-only', 0.5);
      expect(result.agentId).toBe('local');
      expect(result.tier).toBe('local');
      expect(result.reason).toContain('frontier-only unavailable');
    });

    it('should fall through to plain route() when no role-tagged agents exist', () => {
      const plainRouter = new MessageRouter({ strategy: 'keyword' });
      plainRouter.registerAgent('agent-a', ['read_files'], {
        patterns: ['\\bfile\\b'],
      });

      const result = plainRouter.routeWithTier('read a file', 'auto', 0.5);
      expect(result.agentId).toBe('agent-a');
      expect(result.tier).toBeUndefined(); // no tier info — plain route used
    });

    it('should let high-confidence pattern match override tier scoring', () => {
      // "search the web" matches external's pattern → pattern wins
      const result = router.routeWithTier('search the web for docs', 'auto', 0.5);
      expect(result.agentId).toBe('external');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('pattern matched');
      // But fallback should still be set to the opposite tier
      expect(result.fallbackAgentId).toBe('local');
    });

    it('should route explicit external coding backend requests to the local tier when local patterns match', () => {
      router.registerAgent('local-coded', ['execute_commands'], {
        patterns: ['\\b(codex|claude\\s+code|gemini\\s+cli|aider|coding backend|coding assistant)\\b'],
        priority: 1,
      }, 'local');

      const result = router.routeWithTier(
        'Use Codex to say hello and confirm you are working. Just respond with a brief confirmation message. Do not change any files.',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('local-coded');
      expect(result.tier).toBe('local');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('pattern matched');
      expect(result.fallbackAgentId).toBe('external');
    });

    it('should route coding backend intent to the local tier without relying on raw-text patterns', () => {
      const result = router.routeWithTierFromIntent(
        {
          route: 'coding_task',
          confidence: 'high',
          operation: 'run',
          summary: 'Run Codex for a coding task.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {
            codingBackend: 'codex',
            codingBackendRequested: true,
          },
        },
        'Use Codex to say hello and confirm you are working.',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('local');
      expect(result.tier).toBe('local');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('coding backend=codex');
      expect(result.fallbackAgentId).toBe('external');
    });

    it('should route email intent to the external tier from the gateway decision', () => {
      const result = router.routeWithTierFromIntent(
        {
          route: 'email_task',
          confidence: 'high',
          operation: 'read',
          summary: 'Check email.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
        'Check my email.',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('external');
      expect(result.tier).toBe('external');
      expect(result.reason).toContain('intent route=email_task');
      expect(result.fallbackAgentId).toBe('local');
    });

    it('should route memory intent to the local tier from the gateway decision', () => {
      const result = router.routeWithTierFromIntent(
        {
          route: 'memory_task',
          confidence: 'high',
          operation: 'save',
          summary: 'Save an explicit memory item.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
        'Remember globally that my test marker is cedar-47.',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('local');
      expect(result.tier).toBe('local');
      expect(result.reason).toContain('intent route=memory_task');
      expect(result.fallbackAgentId).toBe('external');
    });

    it('should route personal assistant intent to the local tier from the gateway decision', () => {
      const result = router.routeWithTierFromIntent(
        {
          route: 'personal_assistant_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Show the Second Brain overview.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {
            personalItemType: 'overview',
          },
        },
        'What do I have due today?',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('local');
      expect(result.tier).toBe('local');
      expect(result.reason).toContain('intent route=personal_assistant_task');
      expect(result.fallbackAgentId).toBe('external');
    });

    it('should degrade cleanly when the preferred intent tier is unavailable', () => {
      const singleRouter = new MessageRouter({ strategy: 'keyword' });
      singleRouter.registerAgent('external', ['network_access'], {}, 'external');

      const result = singleRouter.routeWithTierFromIntent(
        {
          route: 'coding_task',
          confidence: 'high',
          operation: 'run',
          summary: 'Run Codex for a coding task.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {
            codingBackend: 'codex',
            codingBackendRequested: true,
          },
        },
        'Use Codex to say hello and confirm you are working.',
        'auto',
        0.5,
      );
      expect(result.agentId).toBe('external');
      expect(result.tier).toBe('external');
      expect(result.fallbackAgentId).toBeUndefined();
      expect(result.reason).toContain('coding backend=codex');
    });

    it('should find agents by role', () => {
      expect(router.findAgentByRole('local')?.id).toBe('local');
      expect(router.findAgentByRole('external')?.id).toBe('external');
      expect(router.findAgentByRole('general')).toBeUndefined();
    });
  });
});
