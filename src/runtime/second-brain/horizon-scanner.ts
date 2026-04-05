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

interface SupportedRoutineCron {
  minute: number;
  hour: number;
  daysOfWeek: number[] | null;
}

function parseCronInteger(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function parseCronDaysOfWeek(field: string): number[] | null {
  if (field === '*') return null;
  if (/^\d+$/.test(field)) {
    const value = Number(field);
    if (value < 0 || value > 7) return null;
    return [value === 7 ? 0 : value];
  }
  const rangeMatch = field.match(/^(\d)-(\d)$/);
  if (!rangeMatch) return null;
  const start = Number(rangeMatch[1]);
  const end = Number(rangeMatch[2]);
  if (start < 0 || end > 7 || start > end) return null;
  const days: number[] = [];
  for (let day = start; day <= end; day += 1) {
    days.push(day === 7 ? 0 : day);
  }
  return days;
}

function parseSupportedRoutineCron(cron: string): SupportedRoutineCron | null {
  const parts = cron.trim().split(/\s+/g);
  if (parts.length !== 5) return null;
  if (parts[2] !== '*' || parts[3] !== '*') return null;
  const minute = parseCronInteger(parts[0], 0, 59);
  const hour = parseCronInteger(parts[1], 0, 23);
  const daysOfWeek = parseCronDaysOfWeek(parts[4]);
  if (minute == null || hour == null || (parts[4] !== '*' && !daysOfWeek)) {
    return null;
  }
  return { minute, hour, daysOfWeek };
}

function latestCronOccurrenceAtOrBefore(now: number, cron: string): number | null {
  const parsed = parseSupportedRoutineCron(cron);
  if (!parsed) return null;

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setDate(candidate.getDate() - offset);
    candidate.setHours(parsed.hour, parsed.minute, 0, 0);
    if (candidate.getTime() > now) {
      continue;
    }
    if (parsed.daysOfWeek && !parsed.daysOfWeek.includes(candidate.getDay())) {
      continue;
    }
    return candidate.getTime();
  }

  return null;
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
    if (morningRoutine && this.shouldRunCronRoutine(scannedAt, morningRoutine)) {
      const brief = await this.briefingService.generateMorningBrief();
      this.secondBrainService.markRoutineRun(morningRoutine.id, scannedAt);
      triggeredRoutines.push(morningRoutine.id);
      generatedBriefIds.push(brief.id);
    }

    const weeklyReviewRoutine = routines.find((routine) => routine.id === 'weekly-review');
    if (weeklyReviewRoutine && this.shouldRunCronRoutine(scannedAt, weeklyReviewRoutine)) {
      this.secondBrainService.markRoutineRun(weeklyReviewRoutine.id, scannedAt);
      triggeredRoutines.push(weeklyReviewRoutine.id);
    }

    const radarRoutine = routines.find((routine) => routine.id === 'next-24-hours-radar');
    if (radarRoutine) {
      const horizonMinutes = radarRoutine.trigger.mode === 'horizon' && Number.isFinite(radarRoutine.trigger.lookaheadMinutes)
        ? Number(radarRoutine.trigger.lookaheadMinutes)
        : 1440;
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
      const lookaheadMinutes = preMeetingRoutine.trigger.mode === 'event' && Number.isFinite(preMeetingRoutine.trigger.lookaheadMinutes)
        ? Number(preMeetingRoutine.trigger.lookaheadMinutes)
        : 60;
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
      const lookbackMinutes = followUpRoutine.trigger.mode === 'event' && Number.isFinite(followUpRoutine.trigger.lookaheadMinutes)
        ? Number(followUpRoutine.trigger.lookaheadMinutes)
        : 1440;
      const recentEvents = this.secondBrainService.listEvents({
        includePast: true,
        fromTime: 0,
        limit: 50,
      }).filter((event) => {
        const endedAt = event.endsAt ?? event.startsAt;
        return endedAt < scannedAt && endedAt >= scannedAt - (lookbackMinutes * 60 * 1000);
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

  private shouldRunCronRoutine(now: number, routine: ReturnType<SecondBrainService['listRoutines']>[number]): boolean {
    if (routine.trigger.mode !== 'cron' || !routine.trigger.cron) return false;
    const scheduledAt = latestCronOccurrenceAtOrBefore(now, routine.trigger.cron);
    if (scheduledAt == null) return false;
    const baseline = routine.lastRunAt
      ?? (this.secondBrainService.isSeededBuiltInRoutine(routine.id) ? 0 : routine.createdAt);
    return scheduledAt > baseline;
  }
}
