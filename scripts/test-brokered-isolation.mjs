import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distEntry = path.join(projectRoot, 'dist', 'index.js');
const workerEntry = path.join(projectRoot, 'dist', 'worker', 'worker-entry.js');
const port = 3021;
const token = `brokered-harness-${Date.now()}`;
const baseUrl = `http://127.0.0.1:${port}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      if (body?.status === 'ok') {
        return;
      }
    } catch {
      // Keep polling until deadline.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function request(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

async function main() {
  if (!existsSync(distEntry) || !existsSync(workerEntry)) {
    console.error('Missing build artifacts in dist/. Run `npm run build` first.');
    process.exit(1);
  }

  const tempDir = path.join(os.tmpdir(), `ga-brokered-harness-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  const configPath = path.join(tempDir, 'config.yaml');
  const logPath = path.join(tempDir, 'app.log');
  const errorPath = path.join(tempDir, 'app.err.log');

  writeFileSync(
    configPath,
    [
      'llm:',
      '  ollama:',
      '    provider: ollama',
      '    baseUrl: http://127.0.0.1:11434',
      '    model: llama3.2',
      'defaultProvider: ollama',
      'channels:',
      '  cli:',
      '    enabled: false',
      '  web:',
      `    port: ${port}`,
      '    enabled: true',
      `    authToken: "${token}"`,
      'guardian:',
      '  enabled: true',
      '  auditLog:',
      `    auditDir: ${path.join(tempDir, 'audit')}`,
      'runtime:',
      '  agentIsolation:',
      '    enabled: true',
      '    mode: brokered',
      `    workerEntryPoint: ${workerEntry}`,
      'assistant:',
      '  memory:',
      '    enabled: true',
      `    sqlitePath: ${path.join(tempDir, 'memory.db')}`,
      '  analytics:',
      '    enabled: true',
      `    sqlitePath: ${path.join(tempDir, 'analytics.db')}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const app = spawn(process.execPath, [distEntry, configPath], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      XDG_CONFIG_HOME: tempDir,
      XDG_DATA_HOME: tempDir,
      XDG_CACHE_HOME: tempDir,
    },
  });

  app.stdout.pipe(createWriteStream(logPath, { flags: 'a' }));
  app.stderr.pipe(createWriteStream(errorPath, { flags: 'a' }));

  try {
    await waitForHealth(30_000);

    const message = await request('/api/message', {
      method: 'POST',
      body: JSON.stringify({
        content: 'Reply with OK only.',
        userId: 'brokered-harness',
      }),
    });

    if (message.status !== 200) {
      console.error(`FAIL: /api/message returned HTTP ${message.status}.`);
      console.error(JSON.stringify(message.body, null, 2));
      printLogs(logPath, errorPath);
      process.exitCode = 1;
      return;
    }

    const content = message.body?.content;
    if (content === 'Simulated LLM response from worker') {
      console.error('FAIL: brokered mode surfaced the worker stub response to the user.');
      printLogs(logPath, errorPath);
      process.exitCode = 1;
      return;
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      console.error('FAIL: /api/message returned an empty response payload.');
      console.error(JSON.stringify(message.body, null, 2));
      printLogs(logPath, errorPath);
      process.exitCode = 1;
      return;
    }

    console.log('PASS: brokered web harness returned a non-empty non-stub response.');
  } catch (error) {
    console.error('FAIL: brokered isolation harness did not complete successfully.');
    console.error(error instanceof Error ? error.message : String(error));
    printLogs(logPath, errorPath);
    process.exitCode = 1;
  } finally {
    app.kill('SIGKILL');
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function printLogs(logPath, errorPath) {
  if (existsSync(logPath)) {
    const stdoutLog = readFileSync(logPath, 'utf8').trim();
    if (stdoutLog) {
      console.error('stdout log:');
      console.error(stdoutLog);
    }
  }
  if (existsSync(errorPath)) {
    const stderrLog = readFileSync(errorPath, 'utf8').trim();
    if (stderrLog) {
      console.error('stderr log:');
      console.error(stderrLog);
    }
  }
}

await main();
