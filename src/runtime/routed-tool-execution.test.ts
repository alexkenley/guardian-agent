import { describe, expect, it } from 'vitest';

import type { IntentGatewayDecision } from './intent-gateway.js';
import {
  buildRoutedIntentAdditionalSection,
  buildToolExecutionCorrectionPrompt,
  prepareToolExecutionForIntent,
} from './routed-tool-execution.js';

function repoDecision(
  overrides: Partial<IntentGatewayDecision> = {},
): IntentGatewayDecision {
  return {
    route: 'coding_task',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Inspect the named repo files.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'chat_synthesis',
    entities: {},
    ...overrides,
  };
}

function complexPlanningDecision(
  overrides: Partial<IntentGatewayDecision> = {},
): IntentGatewayDecision {
  return {
    route: 'complex_planning_task',
    confidence: 'high',
    operation: 'run',
    summary: 'Plan and execute a multi-step task.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'tool_orchestration',
    preferredTier: 'external',
    requiresRepoGrounding: false,
    requiresToolSynthesis: true,
    expectedContextPressure: 'high',
    preferredAnswerPath: 'chat_synthesis',
    entities: {},
    ...overrides,
  };
}

function filesystemDecision(
  overrides: Partial<IntentGatewayDecision> = {},
): IntentGatewayDecision {
  return {
    route: 'filesystem_task',
    confidence: 'high',
    operation: 'save',
    summary: 'Write a file in the active workspace.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'tool_loop',
    entities: {},
    ...overrides,
  };
}

function securityDecision(
  overrides: Partial<IntentGatewayDecision> = {},
): IntentGatewayDecision {
  return {
    route: 'security_task',
    confidence: 'high',
    operation: 'inspect',
    summary: 'Review the relevant source files for security issues.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'security_analysis',
    preferredTier: 'external',
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: 'high',
    preferredAnswerPath: 'chat_synthesis',
    entities: {},
    ...overrides,
  };
}

describe('routed tool execution', () => {
  it('adds repo-grounded tool guidance for coding inspection turns', () => {
    const section = buildRoutedIntentAdditionalSection(repoDecision());

    expect(section?.content).toContain('Prefer native repo tools first: fs_search, code_symbol_search, and fs_read');
    expect(section?.content).toContain('Do not use shell_safe for grep, git grep, cat, sed');
  });

  it('adds external-backend guidance for explicit coding backend requests', () => {
    const section = buildRoutedIntentAdditionalSection(repoDecision({
      operation: 'run',
      preferredTier: 'local',
      preferredAnswerPath: 'tool_loop',
      entities: {
        codingBackend: 'codex',
        codingBackendRequested: true,
      },
    }));

    expect(section?.content).toContain('external coding backend "codex"');
    expect(section?.content).toContain('Use coding_backend_run for the main execution step');
    expect(section?.content).toContain('verify the result with code_git_diff, code_test, code_build, or code_lint');
  });

  it('adds brokered filesystem guidance for explicit complex-planning turns', () => {
    const section = buildRoutedIntentAdditionalSection(complexPlanningDecision());

    expect(section?.content).toContain('brokered complex-planning path');
    expect(section?.content).toContain('fs_read, fs_search, fs_mkdir, and fs_write');
    expect(section?.content).toContain('Do not use code_remote_exec for simple directory creation or text-file writes');
  });

  it('builds a tool-execution correction prompt for repo-grounded coding turns', () => {
    const prompt = buildToolExecutionCorrectionPrompt(repoDecision());

    expect(prompt).toContain('repo-grounded coding request');
    expect(prompt).toContain('fs_search, code_symbol_search, and fs_read');
    expect(prompt).toContain('Only ask the user for approval after a real tool result returns pending_approval');
  });

  it('adds filesystem mutation guidance for workspace write turns', () => {
    const section = buildRoutedIntentAdditionalSection(filesystemDecision());

    expect(section?.content).toContain('filesystem request anchored to the active workspace');
    expect(section?.content).toContain('Use fs_mkdir for directory creation and fs_write for file writes or updates');
    expect(section?.content).toContain('request the path addition through update_tool_policy');
  });

  it('builds a correction prompt for filesystem mutation turns', () => {
    const prompt = buildToolExecutionCorrectionPrompt(filesystemDecision());

    expect(prompt).toContain('workspace filesystem mutation request');
    expect(prompt).toContain('Do not claim that a file or directory was created');
    expect(prompt).toContain('call update_tool_policy to request the path addition');
  });

  it('adds source-backed security guidance for security review turns', () => {
    const section = buildRoutedIntentAdditionalSection(securityDecision());

    expect(section?.content).toContain('security analysis request');
    expect(section?.content).toContain('Inspect the relevant source files before citing exact files');
    expect(section?.content).toContain('Do not fabricate file paths, tool outputs, or security findings');
  });

  it('builds a correction prompt for source-backed security review turns', () => {
    const prompt = buildToolExecutionCorrectionPrompt(securityDecision());

    expect(prompt).toContain('source-backed security review request');
    expect(prompt).toContain('Do not fabricate file paths, tool results, or findings');
    expect(prompt).toContain('After collecting evidence, synthesize the findings');
  });

  it('denies grep-style shell inspection during repo-grounded coding review turns', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'shell_safe',
      args: {
        command: 'git grep -n "approval" -- src/tools/executor.ts',
      },
      requestText: 'Review security implications across src/tools/executor.ts and src/runtime/pending-actions.ts. Highest-risk issue first.',
      referenceTime: Date.now(),
      intentDecision: repoDecision(),
      toolDefinition: { category: 'shell', risk: 'mutating' },
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
    expect(prepared.immediateResult?.message).toContain('Use fs_search, code_symbol_search, and fs_read instead of shell_safe');
  });

  it('denies git diff inspection when explicit files are named but the user did not ask for diff output', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'shell_safe',
      args: {
        command: 'git diff -- src/runtime/intent-gateway.ts src/runtime/execution-profiles.ts',
      },
      requestText: 'Inspect src/runtime/intent-gateway.ts and src/runtime/execution-profiles.ts. Review the routing uplift for regressions and missing tests.',
      referenceTime: Date.now(),
      intentDecision: repoDecision(),
      toolDefinition: { category: 'shell', risk: 'mutating' },
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
  });

  it('strips model-invented remote execution profiles when the user did not explicitly name one', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'pwd',
        profile: 'daytona-main',
      },
      requestText: 'Run pwd in the remote sandbox for this workspace. Do not make changes.',
      referenceTime: Date.now(),
      intentDecision: repoDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingRemoteExecRequested: true,
        },
      }),
    });

    expect(prepared.args).toEqual({
      command: 'pwd',
    });
  });

  it('pins code_remote_exec to the explicit intent profile when the user named one', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'pwd',
        profile: 'daytona-main',
      },
      requestText: 'Run pwd in the remote sandbox using profileId vercel-prod. Do not make changes.',
      referenceTime: Date.now(),
      intentDecision: repoDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingRemoteExecRequested: true,
          profileId: 'vercel-prod',
        },
      }),
    });

    expect(prepared.args).toEqual({
      command: 'pwd',
      profile: 'vercel-prod',
    });
  });

  it('adds sequential reuse guidance for explicit remote sandbox turns', () => {
    const section = buildRoutedIntentAdditionalSection(repoDecision({
      operation: 'run',
      preferredAnswerPath: 'tool_loop',
      entities: {
        codingRemoteExecRequested: true,
        profileId: 'Daytona',
      },
    }));

    expect(section?.content).toContain('issue exactly one remote sandbox tool call at a time');
    expect(section?.content).toContain('CRITICAL: The user explicitly named the remote execution profile "Daytona". You MUST include `profile: "Daytona"` in the arguments of EVERY remote sandbox tool call');
  });

  it('pins code_remote_exec to the explicit request profile even when gateway metadata is unavailable', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'pwd',
        profile: 'daytona-main',
      },
      requestText: 'Run pwd in the remote sandbox using profileId vercel-prod. Do not make changes.',
      referenceTime: Date.now(),
      intentDecision: null,
    });

    expect(prepared.args).toEqual({
      command: 'pwd',
      profile: 'vercel-prod',
    });
  });

  it('pins code_remote_exec when the user names a remote provider profile naturally', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'pwd',
      },
      requestText: 'Run pwd in the remote sandbox using the Daytona profile for this coding session.',
      referenceTime: Date.now(),
      intentDecision: null,
    });

    expect(prepared.args).toEqual({
      command: 'pwd',
      profile: 'Daytona',
    });
  });

  it('strips model-invented remote verification profiles when the user did not explicitly name one', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_test',
      args: {
        cwd: '/repo',
        command: 'npm test',
        remoteProfile: 'daytona-main',
      },
      requestText: 'Run the project tests. Do not make changes.',
      referenceTime: Date.now(),
      intentDecision: repoDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
      }),
    });

    expect(prepared.args).toEqual({
      cwd: '/repo',
      command: 'npm test',
    });
  });

  it('forces remote-required isolation for explicit remote sandbox verification turns', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_test',
      args: {
        cwd: '/repo',
        command: 'npm test',
      },
      requestText: 'Run the project tests in the remote sandbox and report the exact stdout/stderr.',
      referenceTime: Date.now(),
      intentDecision: repoDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingRemoteExecRequested: true,
        },
      }),
    });

    expect(prepared.args).toEqual({
      cwd: '/repo',
      command: 'npm test',
      isolation: 'remote_required',
    });
  });

  it('pins remote verification to the explicit request profile', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_test',
      args: {
        cwd: '/repo',
        command: 'npm test',
        remoteProfile: 'daytona-main',
      },
      requestText: 'Run the project tests in the remote sandbox using profileId vercel-prod and report the exact stdout/stderr.',
      referenceTime: Date.now(),
      intentDecision: repoDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingRemoteExecRequested: true,
          profileId: 'vercel-prod',
        },
      }),
    });

    expect(prepared.args).toEqual({
      cwd: '/repo',
      command: 'npm test',
      isolation: 'remote_required',
      remoteProfile: 'vercel-prod',
    });
  });

  it('denies shell_safe during explicit remote sandbox turns', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'shell_safe',
      args: {
        command: 'pwd',
      },
      requestText: 'Run pwd in the remote sandbox for this workspace. Do not make changes.',
      referenceTime: Date.now(),
      intentDecision: repoDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingRemoteExecRequested: true,
        },
      }),
      toolDefinition: { category: 'shell', risk: 'mutating' },
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
    expect(prepared.immediateResult?.message).toContain('explicitly requested remote sandbox execution');
  });

  it('denies package_install during explicit remote sandbox turns', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'package_install',
      args: {
        command: 'npm install',
      },
      requestText: 'Run npm install in the remote sandbox for this workspace.',
      referenceTime: Date.now(),
      intentDecision: repoDecision({
        operation: 'run',
        preferredAnswerPath: 'tool_loop',
        entities: {
          codingRemoteExecRequested: true,
        },
      }),
      toolDefinition: { category: 'shell', risk: 'mutating' },
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
    expect(prepared.immediateResult?.message).toContain('Do not use package_install here');
  });

  it('denies mkdir-style code_remote_exec during complex-planning turns without explicit remote sandbox intent', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'mkdir -p tmp/manual-dag-smoke-3',
      },
      requestText: 'Use your complex-planning path for this request. In tmp/manual-dag-smoke-3, create notes1.txt and summary1.md.',
      referenceTime: Date.now(),
      intentDecision: complexPlanningDecision(),
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
    expect(prepared.immediateResult?.message).toContain('Prefer fs_mkdir');
  });

  it('denies shell-style text writes through code_remote_exec during complex-planning turns without explicit remote sandbox intent', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'printf "1. Summary\\n2. Risks\\n3. Next steps\\n" > tmp/planner-summary.md',
      },
      requestText: 'Use your complex-planning path for this request. Read src/chat-agent.ts and write a 3-line summary to tmp/planner-summary.md.',
      referenceTime: Date.now(),
      intentDecision: complexPlanningDecision(),
    });

    expect(prepared.immediateResult).toMatchObject({
      success: false,
      status: 'denied',
    });
    expect(prepared.immediateResult?.message).toContain('fs_write');
  });

  it('allows code_remote_exec for trivial filesystem commands when the user explicitly requested remote sandbox execution', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'mkdir -p tmp/manual-dag-smoke-3',
      },
      requestText: 'Use your complex-planning path for this request and run the steps in the remote sandbox.',
      referenceTime: Date.now(),
      intentDecision: complexPlanningDecision({
        entities: {
          codingRemoteExecRequested: true,
        },
      }),
    });

    expect(prepared.immediateResult).toBeUndefined();
  });

  it('treats named managed sandbox wording as explicit remote intent for trivial remote file writes', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'printf "daytona resumed ok\\n" > tmp/daytona-resume-smoke.txt',
      },
      requestText: 'In the Guardian workspace, using the existing Daytona sandbox for this coding session, create tmp/daytona-resume-smoke.txt containing exactly "daytona resumed ok". Reuse the current managed sandbox if it exists; do not create a new one.',
      referenceTime: Date.now(),
      intentDecision: complexPlanningDecision(),
    });

    expect(prepared.immediateResult).toBeUndefined();
  });

  it('treats a named remote profile as explicit remote intent for trivial remote file writes', () => {
    const prepared = prepareToolExecutionForIntent({
      toolName: 'code_remote_exec',
      args: {
        command: 'printf "ok\\n" > tmp/profile-pinned.txt',
      },
      requestText: 'Using the Daytona profile for this coding session, create tmp/profile-pinned.txt in the remote sandbox.',
      referenceTime: Date.now(),
      intentDecision: complexPlanningDecision(),
    });

    expect(prepared.immediateResult).toBeUndefined();
    expect(prepared.args).toEqual({
      command: 'printf "ok\\n" > tmp/profile-pinned.txt',
      profile: 'Daytona',
    });
  });
});
