const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const HARNESS_PORT = 3000;
const HARNESS_TOKEN = `test-web-approvals-${Date.now()}`;
const BASE_URL = `http://localhost:${HARNESS_PORT}`;
const TEST_DIR = `/tmp/harness-web-approvals-test`;
const LOG_FILE = `/tmp/guardian-web-approvals-harness.log`;

let appProcess;

async function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + path, {
      method,
      headers: {
        'Authorization': `Bearer ${HARNESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  const userConfig = `${process.env.HOME}/.guardianagent/config.yaml`;
  let configStr = '';
  if (fs.existsSync(userConfig)) {
    configStr = fs.readFileSync(userConfig, 'utf8') + `\nchannels:\n  cli:\n    enabled: false\n  web:\n    enabled: true\n    port: ${HARNESS_PORT}\n    authToken: "${HARNESS_TOKEN}"\n`;
  } else {
    console.log("No config found, exiting");
    return;
  }
  fs.writeFileSync('/tmp/harness-web-approvals-config.yaml', configStr);

  console.log("[web-approvals] Starting GuardianAgent...");
  appProcess = spawn('npx', ['tsx', 'src/index.ts', '/tmp/harness-web-approvals-config.yaml']);
  
  // Wait for health
  let healthy = false;
  for(let i=0; i<60; i++) {
    try {
      const h = await request('GET', '/health');
      if (h.status === 'ok') { healthy = true; break; }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!healthy) {
    console.log("Failed to start");
    process.exit(1);
  }
  console.log("[web-approvals] App is healthy");

  await request('POST', '/api/tools/policy', { mode: 'approve_by_policy', sandbox: { allowedPaths: ['.'], allowedCommands: ['node'] } });

  console.log("[web-approvals] Web UI Simulation: Out of Bounds Write");
  const resp1 = await request('POST', '/api/message', {
    content: `Write a file named 'web-ui-test.txt' to ${TEST_DIR} with content 'hello world'`,
    userId: 'harness', channel: 'web'
  });

  const approvalId = resp1.metadata?.pendingApprovals?.[0]?.id;
  const toolName = resp1.metadata?.pendingApprovals?.[0]?.toolName;

  if (!approvalId) {
    console.log("FAIL: No pending approval metadata", resp1);
    process.exit(1);
  }
  console.log(`  PASS: received pendingApprovals metadata (${toolName}: ${approvalId})`);

  console.log(`[web-approvals] Simulating Web UI approving ${toolName} (${approvalId})`);
  const decision = await request('POST', '/api/tools/approvals/decision', {
    approvalId, decision: 'approved', actor: 'web-user'
  });

  if (!decision.success) {
    console.log("FAIL: API approval decision failed", decision);
    process.exit(1);
  }
  console.log("  PASS: API accepted approval decision");

  const continuationMsg = `[User approved the pending tool action(s). Result: ${toolName}: ${decision.message}] Please continue with the original task.`;
  console.log("[web-approvals] Sending continuation: " + continuationMsg);

  const resp2 = await request('POST', '/api/message', {
    content: continuationMsg, userId: 'harness', channel: 'web'
  });

  const newApproval = resp2.metadata?.pendingApprovals?.[0]?.toolName;
  if (newApproval === toolName || /loop|again|I need your approval/i.test(resp2.content)) {
    console.log("FAIL: LLM is stuck in a loop. Response: ", resp2.content);
    process.exit(1);
  }

  console.log("  PASS: continuation successful");
  console.log("[web-approvals] LLM Final Response: ", resp2.content);
  appProcess.kill();
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  if(appProcess) appProcess.kill();
  process.exit(1);
});
