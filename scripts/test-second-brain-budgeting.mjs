import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const distRuntimeRoot = path.join(projectRoot, 'dist', 'runtime', 'second-brain');

async function loadSecondBrainModules() {
  const required = [
    path.join(distRuntimeRoot, 'second-brain-store.js'),
    path.join(distRuntimeRoot, 'second-brain-service.js'),
    path.join(distRuntimeRoot, 'sync-service.js'),
  ];
  for (const entry of required) {
    assert(fs.existsSync(entry), `Missing ${path.relative(projectRoot, entry)}. Run \`npm run build\` first.`);
  }

  const [{ SecondBrainStore }, { SecondBrainService }, { SyncService }] = await Promise.all([
    import(pathToFileURL(path.join(distRuntimeRoot, 'second-brain-store.js')).href),
    import(pathToFileURL(path.join(distRuntimeRoot, 'second-brain-service.js')).href),
    import(pathToFileURL(path.join(distRuntimeRoot, 'sync-service.js')).href),
  ]);
  return { SecondBrainStore, SecondBrainService, SyncService };
}

async function main() {
  const { SecondBrainStore, SecondBrainService, SyncService } = await loadSecondBrainModules();
  const sqlitePath = path.join(os.tmpdir(), `guardian-second-brain-budget-${Date.now()}.sqlite`);
  const nowValue = Date.parse('2026-04-04T09:00:00Z');
  const now = () => nowValue;
  const store = new SecondBrainStore({ sqlitePath, now });

  try {
    const service = new SecondBrainService(store, { now });
    service.recordUsage({
      featureArea: 'routine',
      featureId: 'manual-local',
      locality: 'local',
      promptTokens: 120,
      completionTokens: 30,
    });
    service.recordUsage({
      featureArea: 'draft',
      featureId: 'manual-external',
      provider: 'microsoft',
      locality: 'external',
      promptTokens: 200,
      completionTokens: 50,
      connectorCalls: 1,
      outboundAction: 'email_draft',
    });

    const syncService = new SyncService(service, {
      now,
      getGoogleService: () => ({
        isAuthenticated: () => true,
        isServiceEnabled: (svc) => svc === 'calendar' || svc === 'contacts',
        async execute(params) {
          if (params.service === 'calendar') {
            return {
              success: true,
              data: {
                items: [{
                  id: 'evt-1',
                  summary: 'Budget Sync',
                  start: { dateTime: '2026-04-04T10:00:00Z' },
                }],
              },
            };
          }
          return {
            success: true,
            data: {
              connections: [{
                resourceName: 'people/test',
                names: [{ displayName: 'Budget Contact' }],
              }],
            },
          };
        },
      }),
    });

    await syncService.syncAll('budget-harness');
    const usage = service.getUsageSummary();

    assert.equal(usage.localTokens, 150);
    assert.equal(usage.externalTokens, 250);
    assert.equal(usage.totalConnectorCalls, 3);
    assert(usage.monthlyBudget > 0);
    assert(usage.dailyBudget > 0);

    console.log(`PASS second brain budgeting test (${usage.localTokens} local, ${usage.externalTokens} external, ${usage.totalConnectorCalls} connector calls)`);
  } finally {
    store.close();
    try { fs.unlinkSync(sqlitePath); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
