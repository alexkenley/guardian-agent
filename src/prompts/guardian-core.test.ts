import { describe, expect, it } from 'vitest';
import { composeGuardianSystemPrompt, GUARDIAN_CORE_SYSTEM_PROMPT } from './guardian-core.js';

describe('guardian-core prompt', () => {
  it('returns core prompt when no custom prompt is provided', () => {
    expect(composeGuardianSystemPrompt()).toBe(GUARDIAN_CORE_SYSTEM_PROMPT);
  });

  it('prepends core prompt before custom role instructions', () => {
    const combined = composeGuardianSystemPrompt('You specialize in software engineering tasks.');
    expect(combined).toContain('You are Guardian Agent, a security-first personal assistant.');
    expect(combined).toContain('Additional role instructions:');
    expect(combined).toContain('You specialize in software engineering tasks.');
  });

  it('injects soul guidance without replacing runtime safety precedence', () => {
    const combined = composeGuardianSystemPrompt(undefined, 'Act calm and methodical.');
    expect(combined).toContain('SOUL profile (identity/intent guidance):');
    expect(combined).toContain('Act calm and methodical.');
    expect(combined).toContain('must never override non-negotiable Guardian safety rules');
  });

  it('adds response-style guidance when enabled', () => {
    const combined = composeGuardianSystemPrompt(undefined, undefined, { enabled: true, level: 'strong' });
    expect(combined).toContain('Configured response-style preference:');
    expect(combined).toContain('Minimize token usage aggressively while preserving correctness.');
  });

  it('omits response-style guidance when disabled', () => {
    const combined = composeGuardianSystemPrompt(undefined, undefined, { enabled: false, level: 'strong' });
    expect(combined).not.toContain('Configured response-style preference:');
  });

  it('tells the model not to narrate tool availability or schemas', () => {
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('Do not narrate tool availability, argument schemas, or internal parameter names');
  });

  it('tells the model to answer CLI command questions from the shared command guide', () => {
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('<cli-command-guide>');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('Do not invent slash commands or hidden subcommands');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('Prefer /help <command> for exact syntax and /guide for broader operator workflows');
  });

  it('tells the model to answer product-usage questions from the shared reference guide', () => {
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('<reference-guide>');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('navigate the app, or understand product capabilities');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('GitHub Repository page in the guide');
  });

  it('tells the model to use configured cloud profiles from tool context', () => {
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('inspect <tool-context> for configured cloud profiles before asking follow-up questions');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('use that profile id directly');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('prefer a provider read-only status/list tool first');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('call find_tools with keywords such as cloud, hosting, whm, cpanel, vercel, cloudflare, aws, gcp, or azure');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('S Drive Development');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('filesystem access roots, not as proof of an active or resumable coding session');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('answer from the literal executed tool records');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('Do not use memory_save for transient operational notes');
  });

  it('tells general chat agents how to handle explicit external coding backend requests', () => {
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('When the user explicitly asks to use an external coding backend such as Codex, Claude Code, Gemini CLI, or Aider, use the coding_backend_run tool');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('Coding Workspace / code session must be attached first');
  });

  it('distinguishes local Second Brain requests from explicit Google Workspace or Microsoft 365 requests', () => {
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('Unqualified Guardian / Second Brain requests for notes, tasks, contacts, library items, briefs, routines, or calendar CRUD stay local');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('When the user explicitly targets Google Workspace surfaces');
    expect(GUARDIAN_CORE_SYSTEM_PROMPT).toContain('When the user explicitly targets Microsoft 365 / Outlook surfaces');
  });
});
