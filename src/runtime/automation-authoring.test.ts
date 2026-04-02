import { describe, expect, it } from 'vitest';
import {
  compileAutomationAuthoringOutcome,
  compileAutomationAuthoringRequest,
} from './automation-authoring.js';

describe('compileAutomationAuthoringRequest', () => {
  it('compiles open-ended inbox automation requests into scheduled agent tasks', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a daily 7:30 AM automation that checks my high-priority inbox, summarizes anything actionable, drafts replies, and asks for approval before sending anything.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('scheduled_agent');
    expect(compilation?.name).toBe('Daily Gmail Inbox Review');
    expect(compilation?.taskCreate?.cron).toBe('30 7 * * *');
    expect(compilation?.taskCreate?.deliver).toBe(true);
    expect(compilation?.taskCreate?.prompt).toContain('scheduled Guardian automation');
    expect(compilation?.taskCreate?.prompt).toContain('asks for approval before sending');
  });

  it('normalizes scheduled assistant delivery from code-session to web', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a scheduled assistant automation named "Daily Threat Brief". Run it daily at 8:00 AM. Review my saved watchlists and deliver the report to the Guardian web channel.',
      { channel: 'code-session', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('scheduled_agent');
    expect(compilation?.taskCreate?.channel).toBe('web');
    expect(compilation?.taskCreate?.deliver).toBe(true);
  });

  it('defaults weekday automations without a time to 9 AM', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Build a weekday lead research workflow that reads ./companies.csv, researches each company website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ./lead-research-output.csv, and creates ./lead-research-summary.md.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('scheduled_agent');
    expect(compilation?.name).toBe('Weekday Lead Research');
    expect(compilation?.taskCreate?.cron).toBe('0 9 * * 1-5');
    expect(compilation?.taskCreate?.maxRunsPerWindow).toBeGreaterThanOrEqual(5);
  });

  it('does not misname non-inbox automations as Gmail inbox review just because they draft an email', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a daily 8:00 AM automation that reads ./companies.csv, fetches https://example.com, writes a summary report to C:\\Temp\\lead-summary.md, and drafts an email with the summary using built-in Guardian tools only.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('scheduled_agent');
    expect(compilation?.name).toBe('Daily Lead Summary');
  });

  it('normalizes wrapped Windows paths inside scheduled automation prompts', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a daily 8:00 AM automation that reads ./companies.csv, fetches https://example.com, writes a summary report to C:\\Tem    p\\lead-summary.md, and drafts an email with the summary using built-in Guardian tools only.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.name).toBe('Daily Lead Summary');
    expect(compilation?.description).toContain('C:\\Temp\\lead-summary.md');
    expect(compilation?.description).not.toContain('C:\\Tem p\\lead-summary.md');
  });

  it('preserves explicit URLs while normalizing wrapped Windows paths in scheduled automation text', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a daily 8:00 AM automation that reads ./companies.csv, fetches https://example.com, writes a summary report to C:\\Tem    p\\lead-summary.md, drafts an email with the summary, and saves a copy to D:\\\\Reports\\\\lead-summary.md using built-in Guardian tools only.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.description).toContain('https://example.com');
    expect(compilation?.description).not.toContain('https:\\example.com');
    expect(compilation?.description).toContain('C:\\Temp\\lead-summary.md');
    expect(compilation?.description).toContain('D:\\Reports\\lead-summary.md');
    expect(compilation?.taskCreate?.prompt).toContain('https://example.com');
    expect(compilation?.taskCreate?.prompt).not.toContain('https:\\example.com');
  });

  it('hard-bans script generation when the user asks for native Guardian automation only', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a weekday lead research workflow as a Guardian workflow or scheduled task using built-in tools only. Do not create any shell script, Python script, or code file.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.nativeOnly).toBe(true);
    expect(compilation?.forbidCodeArtifacts).toBe(true);
    expect(compilation?.taskCreate?.prompt ?? compilation?.workflowUpsert?.description ?? '').toContain('Do not create shell scripts');
  });

  it('strips web-ui context prefixes from saved descriptions and prompts', () => {
    const compilation = compileAutomationAuthoringRequest(
      '[Context: User is currently viewing the automations panel] Build a weekday lead research workflow that reads ./companies.csv, researches each company website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ./lead-research-output.csv, and creates ./lead-research-summary.md.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.description).not.toContain('[Context:');
    expect(compilation?.taskCreate?.description).not.toContain('[Context:');
    expect(compilation?.taskCreate?.prompt).not.toContain('[Context:');
    expect(compilation?.taskCreate?.prompt).toContain('Operator request:\nBuild a weekday lead research workflow');
  });

  it('compiles explicit deterministic tool requests into workflows', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a Guardian workflow that runs net_ping and then web_fetch every 15 minutes in sequential mode.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.workflowUpsert?.id).toBe('net-ping-web-fetch-workflow');
    expect(compilation?.workflowUpsert?.schedule).toBe('*/15 * * * *');
    expect(compilation?.workflowUpsert?.steps).toHaveLength(2);
    expect(compilation?.workflowUpsert?.steps[0]?.toolName).toBe('net_ping');
    expect(compilation?.workflowUpsert?.steps[1]?.toolName).toBe('web_fetch');
  });

  it('uses the explicit automation name and browser wrapper tools for browser smoke workflows', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create an automation called Browser Read Smoke. When I run it, it should open https://example.com, read the page, list the links, and keep the results in the automation run output only. Do not schedule it yet.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.name).toBe('Browser Read Smoke');
    expect(compilation?.workflowUpsert?.id).toBe('browser-read-smoke');
    expect(compilation?.workflowUpsert?.enabled).toBe(true);
    expect(compilation?.workflowUpsert?.steps).toMatchObject([
      {
        toolName: 'browser_navigate',
        args: { url: 'https://example.com', mode: 'read' },
      },
      {
        toolName: 'browser_read',
        args: { url: 'https://example.com' },
      },
      {
        toolName: 'browser_links',
        args: { url: 'https://example.com' },
      },
    ]);
  });

  it('compiles unscheduled open-ended automation requests into manual assistant automations', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Build a workflow called Company Homepage Collector that reads ./companies.csv, opens each company homepage, extracts the page title and meta description, and writes ./tmp/company-homepages.json. Do not schedule it yet.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('manual_agent');
    expect(compilation?.name).toBe('Company Homepage Collector');
    expect(compilation?.taskCreate).toMatchObject({
      type: 'agent',
      target: 'default',
      eventTrigger: { eventType: 'automation:manual:company-homepage-collector' },
    });
    expect(compilation?.taskCreate?.cron).toBeUndefined();
    expect(compilation?.taskCreate?.prompt).toContain('manual on-demand Guardian automation');
  });

  it('returns a draft instead of guessing when a scheduled assistant task prompt only provides a name', () => {
    const outcome = compileAutomationAuthoringOutcome(
      'Create a scheduled assistant task called Weekly Browser Report...',
      { channel: 'web', userId: 'owner' },
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe('draft');
    if (outcome?.status !== 'draft') return;
    expect(outcome.draft.shape).toBe('scheduled_agent');
    expect(outcome.draft.name).toBe('Weekly Browser Report');
    expect(outcome.draft.missingFields).toEqual([
      expect.objectContaining({ key: 'schedule' }),
      expect.objectContaining({ key: 'goal' }),
    ]);
  });

  it('returns a draft for incomplete named manual automations instead of compiling the wrong shape', () => {
    const outcome = compileAutomationAuthoringOutcome(
      'Build a workflow called Company Homepage Collector ... Do not schedule it yet.',
      { channel: 'web', userId: 'owner' },
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe('draft');
    if (outcome?.status !== 'draft') return;
    expect(outcome.draft.shape).toBe('manual_agent');
    expect(outcome.draft.name).toBe('Company Homepage Collector');
    expect(outcome.draft.missingFields).toEqual([
      expect.objectContaining({ key: 'goal' }),
    ]);
  });

  it('compiles structured browser extraction workflows to browser_extract', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create an automation called Browser Extract Smoke. When I run it, it should open https://github.com, extract structured metadata and a semantic outline, and show me the result. Do not schedule it.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.name).toBe('Browser Extract Smoke');
    expect(compilation?.workflowUpsert?.steps).toMatchObject([
      {
        toolName: 'browser_navigate',
        args: { url: 'https://github.com', mode: 'read' },
      },
      {
        toolName: 'browser_extract',
        args: { url: 'https://github.com', type: 'both' },
      },
    ]);
  });

  it('adds a compose-and-write tail for browser workflows that save an artifact', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a Monday to Friday 7:30 AM automation called News Digest Smoke that opens https://news.ycombinator.com, extracts the top 20 links, and writes a short summary to ./tmp/hn-digest.md. Use built-in Guardian tools only.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.workflowUpsert?.schedule).toBe('30 7 * * 1-5');
    expect(compilation?.workflowUpsert?.steps).toMatchObject([
      {
        toolName: 'browser_navigate',
        args: { url: 'https://news.ycombinator.com', mode: 'read' },
      },
      {
        toolName: 'browser_links',
        args: { url: 'https://news.ycombinator.com', maxItems: 20 },
      },
      {
        type: 'instruction',
      },
      {
        toolName: 'fs_write',
        args: { path: './tmp/hn-digest.md', content: '${compose_output.output}' },
      },
    ]);
  });

  it('recognizes named automation requests even if copied text loses the leading imperative verb', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Monday to Friday 7:30 AM automation called News Digest Smoke that opens https://news.ycombinator.com, extracts the top 20 links, and writes a short summary to ./tmp/hn-digest.md. Use built-in Guardian tools only.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.name).toBe('News Digest Smoke');
    expect(compilation?.workflowUpsert?.schedule).toBe('30 7 * * 1-5');
  });

  it('respects explicit scheduled assistant task wording even when browser verbs are present', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a scheduled assistant task called Weekly Browser Report that runs every Monday at 8:00 AM, opens https://example.com, reads the page, lists the links, and writes ./tmp/weekly-browser-report.md.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('scheduled_agent');
    expect(compilation?.taskCreate?.cron).toBe('0 8 * * 1');
    expect(compilation?.workflowUpsert).toBeUndefined();
  });

  it('compiles simple browser form typing workflows with wrapper tools and deterministic target selection', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create an automation that opens https://httpbin.org/forms/post, lists the inputs, and types "automation smoke test" into the first text field. Run it once.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.workflowUpsert?.steps).toMatchObject([
      {
        toolName: 'browser_navigate',
        args: { url: 'https://httpbin.org/forms/post', mode: 'interactive' },
      },
      {
        toolName: 'browser_state',
        args: { url: 'https://httpbin.org/forms/post' },
      },
      {
        type: 'instruction',
      },
      {
        toolName: 'browser_act',
        args: {
          stateId: '${capture_state.output.stateId}',
          action: 'type',
          ref: '${select_target.output}',
          value: 'automation smoke test',
        },
      },
    ]);
  });

  it('compiles deterministic read-summarize-write requests into native workflows with instruction steps', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a sequential Guardian workflow that first reads ./companies.csv, then runs a fixed summarization step, then writes ./lead-research-summary.md.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.workflowUpsert?.steps).toHaveLength(3);
    expect(compilation?.workflowUpsert?.steps[0]).toMatchObject({
      type: 'tool',
      toolName: 'fs_read',
      args: { path: './companies.csv' },
    });
    expect(compilation?.workflowUpsert?.steps[1]?.type).toBe('instruction');
    expect(compilation?.workflowUpsert?.steps[1]?.instruction).toContain('summarize');
    expect(compilation?.workflowUpsert?.steps[2]).toMatchObject({
      type: 'tool',
      toolName: 'fs_write',
      args: {
        path: './lead-research-summary.md',
        content: '${summarize_content.output}',
      },
    });
  });

  it('compiles deterministic workflows even when copied prompts contain wrapped path spacing', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a sequential Guardian workflow that first reads ./         companies.csv, then runs a fixed summarization step, then          writes ./lead-research-summary.md.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.description).toContain('./companies.csv');
    expect(compilation?.description).not.toContain('./ companies.csv');
    expect(compilation?.workflowUpsert?.steps[0]?.args).toMatchObject({
      path: './companies.csv',
    });
    expect(compilation?.workflowUpsert?.steps[2]?.args).toMatchObject({
      path: './lead-research-summary.md',
    });
  });

  it('links other semantic instruction workflows like analyze into instruction steps', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a sequential Guardian workflow that first reads ./network-scan.txt, then runs a fixed analysis step, then writes ./network-analysis.md.',
      { channel: 'web', userId: 'owner' },
    );

    expect(compilation).not.toBeNull();
    expect(compilation?.shape).toBe('workflow');
    expect(compilation?.workflowUpsert?.steps).toHaveLength(3);
    expect(compilation?.workflowUpsert?.steps[1]?.type).toBe('instruction');
    expect(compilation?.workflowUpsert?.steps[1]?.instruction).toContain('analyze');
    expect(compilation?.workflowUpsert?.steps[2]?.args).toMatchObject({
      path: './network-analysis.md',
      content: '${analyze_content.output}',
    });
  });

  it('returns a deterministic workflow draft instead of silently creating an assistant task for unsupported step-based monitoring requests', () => {
    const outcome = compileAutomationAuthoringOutcome(
      'Create a deterministic scheduled automation named "WHM Social Check Disk Quota". Run it daily at 9:00 AM. Do not create an assistant automation. Create a step-based workflow using built-in tools only. Steps: 1. Query the WHM Social profile for all accounts, including disk used and disk quota. 2. Compute remaining disk space in MB for each account. 3. If any account has 100 MB or less remaining, send an alert to the Guardian web channel. 4. Include username, domain, disk used, disk quota, and remaining MB in the alert. 5. If no accounts are within 100 MB of quota, do not send a notification.',
      { channel: 'code-session', userId: 'owner' },
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe('draft');
    if (outcome?.status !== 'draft') return;
    expect(outcome.draft.shape).toBe('workflow');
    expect(outcome.draft.name).toBe('WHM Social Check Disk Quota');
    expect(outcome.draft.missingFields).toEqual([
      expect.objectContaining({ key: 'workflow_steps' }),
    ]);
  });

  it('returns null when the request is not an automation authoring request', () => {
    const compilation = compileAutomationAuthoringRequest('Read ./companies.csv and tell me what is inside.');
    expect(compilation).toBeNull();
  });
});
