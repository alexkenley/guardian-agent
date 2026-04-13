const NAMED_REMOTE_PROFILE_PATTERN = /\b(?:using|with|via)\s+(?:the\s+)?([a-z0-9][a-z0-9._ -]*?)\s+profile\b/i;
const req = "In the current coding workspace, run \`npm ci\` in the remote sandbox using the Daytona profile for this coding session, then run \`npm test\` in the same remote sandbox.";
console.log(req.match(NAMED_REMOTE_PROFILE_PATTERN));
