import { describe, expect, it } from 'vitest';
import {
  buildTaskUpdateForCompiledAutomation,
  compileAutomationAuthoringRequest,
  findMatchingScheduledAutomationTask,
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
      },
      {
        toolName: 'browser_links',
      },
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
        args: { type: 'both' },
      },
    ]);
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

  it('returns null when the request is not an automation authoring request', () => {
    const compilation = compileAutomationAuthoringRequest('Read ./companies.csv and tell me what is inside.');
    expect(compilation).toBeNull();
  });
});

describe('scheduled automation dedupe helpers', () => {
  it('matches an existing scheduled agent task by native automation identity', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Build a weekday lead research workflow that reads ./companies.csv, researches each company website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ./lead-research-output.csv, and creates ./lead-research-summary.md.',
      { channel: 'web', userId: 'owner' },
    );
    expect(compilation?.taskCreate).toBeTruthy();

    const match = findMatchingScheduledAutomationTask(
      [
        {
          id: 'task-1',
          name: 'Weekday Lead Research',
          type: 'agent',
          target: 'default',
          cron: '0 9 * * 1-5',
          channel: 'web',
          deliver: true,
        },
      ],
      compilation!,
    );

    expect(match?.id).toBe('task-1');
  });

  it('builds a task update from compiled agent automation state', () => {
    const compilation = compileAutomationAuthoringRequest(
      'Create a daily 7:30 AM automation that checks my high-priority inbox, summarizes anything actionable, drafts replies, and asks for approval before sending anything.',
      { channel: 'web', userId: 'owner' },
    );
    const update = buildTaskUpdateForCompiledAutomation('task-1', compilation!, { channel: 'web', userId: 'owner' });

    expect(update).toMatchObject({
      taskId: 'task-1',
      type: 'agent',
      target: 'default',
      channel: 'web',
      deliver: true,
      cron: '30 7 * * *',
    });
    expect(update?.description).toBe(compilation?.description);
  });
});
