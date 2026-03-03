/**
 * Unit tests for complexity scorer.
 */

import { describe, it, expect } from 'vitest';
import { scoreComplexity, type ComplexityResult } from './complexity-scorer.js';

describe('scoreComplexity', () => {
  // ─── Edge cases ─────────────────────────────────────────────

  it('should return score 0 for empty string', () => {
    const result = scoreComplexity('');
    expect(result.score).toBe(0);
    expect(result.tier).toBe('local');
  });

  it('should return score 0 for whitespace-only string', () => {
    const result = scoreComplexity('   \n\t  ');
    expect(result.score).toBe(0);
    expect(result.tier).toBe('local');
  });

  it('should always clamp score to [0, 1]', () => {
    // Even with many signals, score should not exceed 1
    const extreme = `
      First, explain why the API architecture uses async middleware pipelines with JWT
      authentication. Then compare trade-offs between microservice and monolith patterns.
      Finally, analyze the security implications of the OAuth implementation, but not the
      legacy SAML flow, unless the client requires backward compatibility. However,
      recommend the best approach for a Kubernetes deployment with gRPC and protobuf
      serialization.
      \`\`\`typescript
      const pipeline = async (ctx: Context) => {
        await authenticate(ctx);
        await authorize(ctx);
        return ctx.next();
      };
      \`\`\`
    `;
    const result = scoreComplexity(extreme);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  // ─── Simple messages → low score ───────────────────────────

  it('should score simple greetings below 0.2', () => {
    expect(scoreComplexity('hello').score).toBeLessThan(0.2);
    expect(scoreComplexity('hi there').score).toBeLessThan(0.2);
    expect(scoreComplexity('hey').score).toBeLessThan(0.2);
    expect(scoreComplexity('good morning').score).toBeLessThan(0.2);
  });

  it('should score simple commands in 0.0-0.4 range', () => {
    const result = scoreComplexity('list files in /tmp');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(0.4);
    expect(result.tier).toBe('local');
  });

  it('should route "what time is it" to local', () => {
    const result = scoreComplexity('what time is it');
    expect(result.tier).toBe('local');
    expect(result.score).toBeLessThan(0.5);
  });

  // ─── Complex messages → high score ─────────────────────────

  it('should score complex analytical questions above 0.5', () => {
    const result = scoreComplexity(
      'Explain why microservice architecture introduces latency trade-offs compared to monolith, and analyze the best approach for a team migrating from a legacy SQL database to a distributed NoSQL system.'
    );
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.tier).toBe('external');
  });

  it('should score multi-step instructions with code blocks above 0.4', () => {
    const result = scoreComplexity(
      'First, set up the API endpoint. Then add JWT authentication middleware. Finally, write integration tests. Here is the current code:\n```typescript\napp.get("/users", handler);\n```\nBut not the admin routes, unless they need the same auth flow.',
      0.4,
    );
    expect(result.score).toBeGreaterThan(0.4);
    expect(result.tier).toBe('external');
  });

  it('should score comparison requests as complex', () => {
    const result = scoreComplexity(
      'Compare the trade-offs between JWT and session-based authentication for a high-security API. Why should I choose one over the other? Explain the latency, security, and scalability considerations, and recommend the best approach for a microservice architecture.'
    );
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.tier).toBe('external');
  });

  // ─── Threshold parameter ───────────────────────────────────

  it('should flip tier based on threshold parameter', () => {
    const content = 'How does the async pipeline work with the middleware?';
    const low = scoreComplexity(content, 0.1);
    const high = scoreComplexity(content, 0.9);

    // Same score, different tiers
    expect(low.score).toBe(high.score);
    expect(low.tier).toBe('external'); // score >= 0.1
    expect(high.tier).toBe('local');   // score < 0.9
  });

  it('should use 0.5 as default threshold', () => {
    // A message that scores around 0.3 should be local with default threshold
    const simple = scoreComplexity('show me the config');
    expect(simple.tier).toBe('local');
  });

  // ─── Signal breakdown ─────────────────────────────────────

  it('should return all 9 signal values in [0, 1]', () => {
    const result = scoreComplexity('Explain the trade-offs of async API design patterns');
    const signalNames = [
      'messageLength', 'sentenceCount', 'questionDepth', 'technicalDensity',
      'multiStepMarkers', 'abstractionMarkers', 'codeBlockPresence', 'constraintComplexity',
      'webSearchIntent',
    ];
    for (const name of signalNames) {
      expect(result.signals[name]).toBeGreaterThanOrEqual(0);
      expect(result.signals[name]).toBeLessThanOrEqual(1);
    }
  });

  it('should detect technical density', () => {
    const techResult = scoreComplexity('Configure the API endpoint with JWT auth and async middleware pipeline');
    const plainResult = scoreComplexity('Tell me a funny joke about cats');
    expect(techResult.signals.technicalDensity).toBeGreaterThan(plainResult.signals.technicalDensity);
  });

  it('should detect question depth (why/how vs what/list)', () => {
    const deep = scoreComplexity('Why does the algorithm fail on edge cases?');
    const shallow = scoreComplexity('What is the current status?');
    expect(deep.signals.questionDepth).toBeGreaterThan(shallow.signals.questionDepth);
  });

  it('should detect multi-step markers', () => {
    const multi = scoreComplexity('First do this, then do that, finally wrap up');
    const single = scoreComplexity('Do this one thing');
    expect(multi.signals.multiStepMarkers).toBeGreaterThan(single.signals.multiStepMarkers);
  });

  it('should detect code blocks', () => {
    const withCode = scoreComplexity('Here is the code:\n```js\nconsole.log("hi")\n```');
    const noCode = scoreComplexity('Here is the output: hello world');
    expect(withCode.signals.codeBlockPresence).toBeGreaterThan(noCode.signals.codeBlockPresence);
  });

  it('should detect constraint complexity', () => {
    const constrained = scoreComplexity('Do everything except the admin panel, but not the auth module, unless required');
    const simple = scoreComplexity('Do everything');
    expect(constrained.signals.constraintComplexity).toBeGreaterThan(simple.signals.constraintComplexity);
  });

  it('should detect abstraction markers', () => {
    const abstract = scoreComplexity('What is the best approach? Recommend a design pattern with trade-offs');
    const concrete = scoreComplexity('Run the test suite');
    expect(abstract.signals.abstractionMarkers).toBeGreaterThan(concrete.signals.abstractionMarkers);
  });

  // ─── Inline code vs fenced blocks ─────────────────────────

  it('should score fenced code blocks higher than inline', () => {
    const fenced = scoreComplexity('Look at this:\n```\ncode here\n```');
    const inline = scoreComplexity('Look at `code` here');
    expect(fenced.signals.codeBlockPresence).toBeGreaterThan(inline.signals.codeBlockPresence);
  });

  // ─── Web search intent ─────────────────────────────────────

  it('should detect web search intent', () => {
    const search = scoreComplexity('Search for the best restaurants nearby');
    const noSearch = scoreComplexity('Refactor the database module');
    expect(search.signals.webSearchIntent).toBeGreaterThan(noSearch.signals.webSearchIntent);
  });

  it('should not detect web search intent for filesystem queries', () => {
    const result = scoreComplexity('Find the file config.json in the directory');
    expect(result.signals.webSearchIntent).toBe(0);
  });

  it('should detect web search intent for "how to" questions', () => {
    const result = scoreComplexity('How to configure nginx for reverse proxy');
    expect(result.signals.webSearchIntent).toBeGreaterThan(0);
  });

  it('should give higher web search score for multiple search signals', () => {
    const single = scoreComplexity('Search for something');
    const multi = scoreComplexity('Search for the latest news about weather');
    expect(multi.signals.webSearchIntent).toBeGreaterThanOrEqual(single.signals.webSearchIntent);
  });
});
