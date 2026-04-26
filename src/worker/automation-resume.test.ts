import { describe, expect, it } from 'vitest';

import type { UserMessage } from '../agent/types.js';
import {
  attachWorkerAutomationAuthoringResumeMetadata,
  buildWorkerAutomationAuthoringResume,
  buildWorkerAutomationAuthoringResumeMessage,
  readWorkerAutomationAuthoringResumeMetadata,
} from './automation-resume.js';

function message(): UserMessage {
  return {
    id: 'msg-1',
    userId: 'user-1',
    principalId: 'principal-1',
    principalRole: 'owner',
    channel: 'web',
    surfaceId: 'web-guardian-chat',
    content: 'Create an automation that writes the daily summary.',
    metadata: {
      codeContext: {
        workspaceRoot: 'S:/Development/GuardianAgent',
        sessionId: 'code-1',
      },
    },
    timestamp: 1,
  };
}

describe('worker automation authoring resume metadata', () => {
  it('round-trips a brokered automation resume payload without worker session state', () => {
    const originalMessage = message();
    const resume = buildWorkerAutomationAuthoringResume(originalMessage);
    const metadata = attachWorkerAutomationAuthoringResumeMetadata({ approvalContinuation: true }, resume);
    const decoded = readWorkerAutomationAuthoringResumeMetadata(metadata);

    expect(decoded).toEqual(resume);

    const continuationMessage = buildWorkerAutomationAuthoringResumeMessage({
      ...originalMessage,
      id: 'continuation-1',
      content: '',
      metadata: {},
    }, decoded!);

    expect(continuationMessage).toMatchObject({
      id: 'msg-1',
      userId: 'user-1',
      principalId: 'principal-1',
      channel: 'web',
      surfaceId: 'web-guardian-chat',
      content: 'Create an automation that writes the daily summary.',
      metadata: {
        codeContext: {
          workspaceRoot: 'S:/Development/GuardianAgent',
          sessionId: 'code-1',
        },
      },
    });
  });
});
