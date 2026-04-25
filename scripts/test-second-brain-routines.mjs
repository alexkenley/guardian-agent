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
    path.join(distRuntimeRoot, 'briefing-service.js'),
    path.join(distRuntimeRoot, 'horizon-scanner.js'),
  ];
  for (const entry of required) {
    assert(fs.existsSync(entry), `Missing ${path.relative(projectRoot, entry)}. Run \`npm run build\` first.`);
  }

  const [{ SecondBrainStore }, { SecondBrainService }, { BriefingService }, { HorizonScanner }] = await Promise.all([
    import(pathToFileURL(path.join(distRuntimeRoot, 'second-brain-store.js')).href),
    import(pathToFileURL(path.join(distRuntimeRoot, 'second-brain-service.js')).href),
    import(pathToFileURL(path.join(distRuntimeRoot, 'briefing-service.js')).href),
    import(pathToFileURL(path.join(distRuntimeRoot, 'horizon-scanner.js')).href),
  ]);
  return { SecondBrainStore, SecondBrainService, BriefingService, HorizonScanner };
}

async function main() {
  const { SecondBrainStore, SecondBrainService, BriefingService, HorizonScanner } = await loadSecondBrainModules();
  const sqlitePath = path.join(os.tmpdir(), `guardian-second-brain-routines-${Date.now()}.sqlite`);
  const nowValue = Date.parse('2026-04-04T09:00:00Z');
  const now = () => nowValue;
  const store = new SecondBrainStore({ sqlitePath, now });

  try {
    const service = new SecondBrainService(store, { now });
    const briefing = new BriefingService(service, { now });
    const seededRoutineIds = new Set(service.listRoutines().map((routine) => routine.id));
    assert(seededRoutineIds.has('pre-meeting-brief'), 'expected Pre-Meeting Brief to be seeded');
    assert(seededRoutineIds.has('follow-up-watch'), 'expected Follow-Up Draft to be seeded');
    service.upsertTask({ title: 'Finalize board deck', priority: 'high' });
    service.upsertSyncedEvent({
      id: 'board-sync',
      title: 'Board Sync',
      startsAt: Date.parse('2026-04-04T09:30:00Z'),
      endsAt: Date.parse('2026-04-04T10:00:00Z'),
      source: 'google',
    });
    service.upsertSyncedEvent({
      id: 'client-checkin',
      title: 'Client Check-In',
      startsAt: Date.parse('2026-04-04T07:00:00Z'),
      endsAt: Date.parse('2026-04-04T07:30:00Z'),
      source: 'microsoft',
    });

    const scheduledTaskService = {
      created: [],
      list() {
        return [];
      },
      create(input) {
        this.created.push(input);
        return { success: true, message: 'created' };
      },
      update() {
        return { success: true, message: 'updated' };
      },
    };
    const syncService = {
      async syncAll(reason) {
        return {
          startedAt: now(),
          finishedAt: now(),
          reason,
          providers: [],
        };
      },
    };

    const scanner = new HorizonScanner(
      scheduledTaskService,
      service,
      syncService,
      briefing,
      { now },
    );

    scanner.start();
    assert.equal(scheduledTaskService.created[0]?.target, 'second_brain_horizon_scan');

    const summary = await scanner.runScan('harness');
    const storedBriefIds = service.listBriefs({ limit: 10 }).map((brief) => brief.id);

    assert(summary.triggeredRoutines.includes('morning-brief'));
    assert(summary.triggeredRoutines.includes('pre-meeting-brief'));
    assert(summary.triggeredRoutines.includes('follow-up-watch'));
    assert(storedBriefIds.includes('brief:morning:2026-04-04'));
    assert(storedBriefIds.includes('brief:pre_meeting:board-sync'));
    assert(storedBriefIds.includes('brief:follow_up:client-checkin'));

    console.log(`PASS second brain routines test (${summary.triggeredRoutines.length} routines, ${summary.generatedBriefIds.length} briefs)`);
  } finally {
    store.close();
    try { fs.unlinkSync(sqlitePath); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
