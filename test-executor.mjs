import { ToolExecutor } from './dist/tools/executor.js';

// We just need to know if executeModelTool drops 'profile' somewhere.
// It shouldn't, unless profile is considered a special field that gets stripped?
// Let's check `code_remote_exec` implementation in `coding-tools.ts`.
