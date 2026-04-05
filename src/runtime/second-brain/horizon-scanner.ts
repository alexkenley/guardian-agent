import type { ScheduledTaskService } from '../scheduled-tasks.js';
import type { SecondBrainService } from './second-brain-service.js';
import type { BriefingService } from './briefing-service.js';
import type { SyncService, SecondBrainSyncSummary } from './sync-service.js';

interface HorizonScannerOptions {
  now?: () => number;
}

export interface HorizonScanSummary {
  scannedAt: number;
  sync: SecondBrainSyncSummary;
  triggeredRoutines: string[];
  generatedBriefIds: string[];
}

function startOfLocalDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export class HorizonScanner {
  private readonly now: () => number;

  constructor(
    private readonly scheduledTaskService: ScheduledTaskService,
    private readonly secondBrainService: SecondBrainService,
    private readonly syncService: SyncService,
    private readonly briefingService: BriefingService,
    options: HorizonScannerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    const existing = this.scheduledTaskService.list().find((task) => (
      task.target === 'second_brain_horizon_scan' || task.target === 'horizon-scanner'
    ));
    if (existing) {
      if (existing.target !== 'second_brain_horizon_scan') {
        this.scheduledTaskService.update(existing.id, {
          target: 'second_brain_horizon_scan',
          name: 'Second Brain Horizon Scan',
          description: 'Periodic deterministic checks for Second Brain routines and sync.',
          args: { source: 'scheduled' },
          enabled: true,
        });
      }
      return;
    }

    this.scheduledTaskService.create({
      name: 'Second Brain Horizon Scan',
      description: 'Periodic deterministic checks for Second Brain routines and sync.',
      type: 'tool',
      target: 'second_brain_horizon_scan',
      cron: '*/15 * * * *',
      enabled: true,
      args: { source: 'scheduled' },
    });
  }

  async runScan(source = 'manual'): Promise<HorizonScanSummary> {
    const scannedAt = this.now();
    const sync = await this.syncService.syncAll(`horizon:${source}`);
    const routines = this.secondBrainService.listRoutines().filter((routine) => routine.enabled);
    const triggeredRoutines: string[] = [];
    const generatedBriefIds: string[] = [];

    const morningRoutine = routines.find((routine) => routine.id === 'morning-brief');
    if (morningRoutine && this.shouldRunMorningBrief(scannedAt, morningRoutine.lastRunAt ?? null)) {
      const brief = await this.briefingService.generateMorningBrief();
      this.secondBrainService.markRoutineRun(morningRoutine.id, scannedAt);
      triggeredRoutines.push(morningRoutine.id);
      generatedBriefIds.push(brief.id);
    }

    const radarRoutine = routines.find((routine) => routine.id === 'next-24-hours-radar');
    if (radarRoutine) {
      const horizonMinutes = radarRoutine.trigger.lookaheadMinutes ?? 1440;
      const upcomingEvents = this.secondBrainService.listEvents({
        fromTime: scannedAt,
        includePast: false,
        limit: 10,
      }).filter((event) => event.startsAt <= scannedAt + (horizonMinutes * 60 * 1000));
      const openTasks = this.secondBrainService.listTasks({ status: 'open', limit: 10 });
      if (
        (upcomingEvents.length > 0 || openTasks.length > 0)
        && (radarRoutine.lastRunAt == null || (scannedAt - radarRoutine.lastRunAt) >= 6 * 60 * 60 * 1000)
      ) {
        this.secondBrainService.markRoutineRun(radarRoutine.id, scannedAt);
        triggeredRoutines.push(radarRoutine.id);
      }
    }

    const preMeetingRoutine = routines.find((routine) => routine.id === 'pre-meeting-brief');
    if (preMeetingRoutine) {
      const lookaheadMinutes = preMeetingRoutine.trigger.lookaheadMinutes ?? 60;
      const upcomingEvents = this.secondBrainService.listEvents({
        fromTime: scannedAt,
        includePast: false,
        limit: 25,
      }).filter((event) => event.startsAt <= scannedAt + (lookaheadMinutes * 60 * 1000));
      let triggered = false;
      for (const event of upcomingEvents) {
        const brief = this.secondBrainService.getBriefById(`brief:pre_meeting:${event.id}`);
        if (brief && brief.updatedAt >= event.updatedAt) continue;
        const generated = await this.briefingService.generatePreMeetingBrief(event.id);
        generatedBriefIds.push(generated.id);
        triggered = true;
      }
      if (triggered) {
        this.secondBrainService.markRoutineRun(preMeetingRoutine.id, scannedAt);
        triggeredRoutines.push(preMeetingRoutine.id);
      }
    }

    const followUpRoutine = routines.find((routine) => routine.id === 'follow-up-watch');
    if (followUpRoutine) {
      const recentEvents = this.secondBrainService.listEvents({
        includePast: true,
        fromTime: 0,
        limit: 50,
      }).filter((event) => {
        const endedAt = event.endsAt ?? event.startsAt;
        return endedAt < scannedAt && endedAt >= scannedAt - (24 * 60 * 60 * 1000);
      });
      let triggered = false;
      for (const event of recentEvents) {
        const brief = this.secondBrainService.getBriefById(`brief:follow_up:${event.id}`);
        if (brief) continue;
        const generated = await this.briefingService.draftFollowUp(event.id);
        generatedBriefIds.push(generated.id);
        triggered = true;
      }
      if (triggered) {
        this.secondBrainService.markRoutineRun(followUpRoutine.id, scannedAt);
        triggeredRoutines.push(followUpRoutine.id);
      }
    }

    return {
      scannedAt,
      sync,
      triggeredRoutines,
      generatedBriefIds,
    };
  }

  private shouldRunMorningBrief(now: number, lastRunAt: number | null): boolean {
    const date = new Date(now);
    if (date.getHours() < 5) return false;
    if (lastRunAt == null) return true;
    return startOfLocalDay(lastRunAt) < startOfLocalDay(now);
  }
}
