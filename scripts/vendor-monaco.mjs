import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const source = resolve(repoRoot, 'node_modules', 'monaco-editor', 'min', 'vs');
const destination = resolve(repoRoot, 'web', 'public', 'vendor', 'monaco', 'vs');

if (!existsSync(source)) {
  process.exit(0);
}

mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, {
  recursive: true,
  force: true,
});
