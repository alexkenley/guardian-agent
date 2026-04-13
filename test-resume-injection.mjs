import { prepareToolExecutionForIntent } from './dist/runtime/routed-tool-execution.js';

const requestText = "In the current coding workspace, run `npm ci` in the remote sandbox using the Daytona profile for this coding session, then run `npm test` in the same remote sandbox.";

const tc = {
  name: 'code_remote_exec',
  arguments: '{"command":"npm ci","vcpus":4}'
};

const prepared = prepareToolExecutionForIntent({
  toolName: tc.name,
  args: JSON.parse(tc.arguments),
  requestText: requestText,
  referenceTime: Date.now(),
  intentDecision: undefined // Let's see if it works without intentDecision, based on requestText
});

console.log("Without intent decision:", prepared.args);

const intentDecision = {
  route: 'coding_task',
  entities: {
    codingRemoteExecRequested: true,
    profileId: 'Daytona'
  }
};

const prepared2 = prepareToolExecutionForIntent({
  toolName: tc.name,
  args: JSON.parse(tc.arguments),
  requestText: requestText,
  referenceTime: Date.now(),
  intentDecision: intentDecision
});

console.log("With intent decision:", prepared2.args);
