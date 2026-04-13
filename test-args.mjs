import { resolveExplicitRemoteProfileId } from './dist/runtime/routed-tool-execution.js';

const requestText = "In the current coding workspace, run `npm ci` in the remote sandbox using the Daytona profile for this coding session, then run `npm test` in the same remote sandbox.";

console.log(resolveExplicitRemoteProfileId(null, requestText));
