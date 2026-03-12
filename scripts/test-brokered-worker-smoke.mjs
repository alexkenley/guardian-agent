import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const workerEntry = path.join(projectRoot, 'dist', 'worker', 'worker-entry.js');

function waitFor(predicate, timeoutMs, intervalMs = 25) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const result = predicate();
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!existsSync(workerEntry)) {
    console.error(`Missing worker entry build artifact: ${workerEntry}`);
    console.error('Run `npm run build` first.');
    process.exit(1);
  }

  const worker = spawn(process.execPath, [workerEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CAPABILITY_TOKEN: 'smoke-test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  const notifications = [];

  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          notifications.push(JSON.parse(line));
        } catch {
          notifications.push({ parseError: line });
        }
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
  });

  const send = (message) => {
    worker.stdin.write(`${JSON.stringify(message)}\n`);
  };

  try {
    await sleep(200);

    send({
      jsonrpc: '2.0',
      method: 'worker.initialize',
      params: {
        agentId: 'local',
        sessionId: 'smoke-session',
        alwaysLoadedTools: [],
      },
    });

    await waitFor(
      () => notifications.find((message) => message.method === 'worker.ready'),
      5_000,
    );

    send({
      jsonrpc: '2.0',
      method: 'message.handle',
      params: {
        message: {
          id: 'smoke-message',
          userId: 'tester',
          channel: 'web',
          content: 'Reply with OK only.',
          timestamp: Date.now(),
        },
        llmMessages: [
          { role: 'system', content: 'Reply with OK only.' },
          { role: 'user', content: 'Reply with OK only.' },
        ],
        llmConfig: {
          endpoint: 'http://127.0.0.1:11434',
          apiKey: 'not-used',
          model: 'llama3.2',
        },
      },
    });

    const response = await waitFor(
      () => notifications.find((message) => message.method === 'message.response'),
      5_000,
    );

    const content = response?.params?.content;
    if (content === 'Simulated LLM response from worker') {
      console.error('FAIL: worker returned the hard-coded stub response instead of running a real provider/tool loop.');
      console.error(`Observed response: ${content}`);
      process.exitCode = 1;
      return;
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      console.error('FAIL: worker did not return a usable message.response payload.');
      console.error(JSON.stringify(response, null, 2));
      process.exitCode = 1;
      return;
    }

    console.log('PASS: worker produced a non-stub response.');
  } catch (error) {
    console.error('FAIL: brokered worker smoke test did not complete successfully.');
    console.error(error instanceof Error ? error.message : String(error));
    if (notifications.length > 0) {
      console.error('notifications seen before failure:');
      console.error(JSON.stringify(notifications, null, 2));
    }
    if (stderrBuffer.trim()) {
      console.error('stderr:');
      console.error(stderrBuffer.trim());
    }
    process.exitCode = 1;
  } finally {
    worker.kill('SIGKILL');
  }
}

await main();
