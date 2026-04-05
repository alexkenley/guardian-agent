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
  ];
  for (const entry of required) {
    assert(fs.existsSync(entry), `Missing ${path.relative(projectRoot, entry)}. Run \`npm run build\` first.`);
  }

  const [{ SecondBrainStore }, { SecondBrainService }, { BriefingService }] = await Promise.all([
    import(pathToFileURL(path.join(distRuntimeRoot, 'second-brain-store.js')).href),
    import(pathToFileURL(path.join(distRuntimeRoot, 'second-brain-service.js')).href),
    import(pathToFileURL(path.join(distRuntimeRoot, 'briefing-service.js')).href),
  ]);
  return { SecondBrainStore, SecondBrainService, BriefingService };
}

async function main() {
  const { SecondBrainStore, SecondBrainService, BriefingService } = await loadSecondBrainModules();
  const sqlitePath = path.join(os.tmpdir(), `guardian-second-brain-smoke-${Date.now()}.sqlite`);
  const nowValue = Date.parse('2026-04-04T09:00:00Z');
  const now = () => nowValue;
  const store = new SecondBrainStore({ sqlitePath, now });

  try {
    const service = new SecondBrainService(store, { now });
    const briefing = new BriefingService(service, { now });

    service.upsertTask({
      title: 'Prepare launch review',
      priority: 'high',
      dueAt: Date.parse('2026-04-04T11:00:00Z'),
    });
    service.upsertNote({
      title: 'Launch notes',
      content: 'Confirm pricing and rollout sequencing before the review.',
    });
    service.upsertPerson({
      name: 'Jordan Review',
      email: 'jordan.review@example.com',
      company: 'Example Co',
      title: 'Director',
    });
    const localReference = service.upsertLink({
      title: 'Launch runbook',
      url: '/tmp/launch runbook.md',
      kind: 'file',
    });
    const event = service.upsertSyncedEvent({
      id: 'launch-review',
      title: 'Launch Review',
      startsAt: Date.parse('2026-04-04T10:00:00Z'),
      endsAt: Date.parse('2026-04-04T10:30:00Z'),
      source: 'google',
      location: 'Meet',
    });

    const overviewBefore = service.getOverview();
    assert.equal(overviewBefore.counts.tasks, 1);
    assert.equal(overviewBefore.counts.notes, 1);
    assert.equal(overviewBefore.nextEvent?.id, event.id);

    const brief = await briefing.generatePreMeetingBrief(event.id);
    const editedBrief = service.updateBrief({
      id: brief.id,
      content: `${brief.content}\n\nEdited note: confirm the final pricing call.`,
    });
    const overviewAfter = service.getOverview();

    assert.equal(brief.kind, 'pre_meeting');
    assert.equal(brief.eventId, event.id);
    assert.match(brief.content, /Launch Review/);
    assert.match(brief.content, /Prepare launch review/);
    assert.equal(localReference.url, 'file:///tmp/launch%20runbook.md');
    assert.match(editedBrief.content, /Edited note/);
    assert.ok(overviewAfter.briefCount >= 1, 'expected generated brief to be counted in the overview');

    console.log(`PASS second brain smoke test (${overviewAfter.counts.tasks} tasks, ${overviewAfter.counts.notes} notes, ${overviewAfter.briefCount} briefs)`);
  } finally {
    store.close();
    try { fs.unlinkSync(sqlitePath); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
