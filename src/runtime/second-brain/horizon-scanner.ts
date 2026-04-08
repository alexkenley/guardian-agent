import type { ScheduledTaskService } from '../scheduled-tasks.js';
import type { SecondBrainService } from './second-brain-service.js';
import type { BriefingService } from './briefing-service.js';
import type { SyncService, SecondBrainSyncSummary } from './sync-service.js';
import type { SecondBrainDeliveryChannel, SecondBrainRoutineRecord, SecondBrainRoutineSchedule, SecondBrainRoutineWeekday } from './types.js';

interface HorizonScannerOptions {
  now?: () => number;
  onOutcome?: (outcome: HorizonRoutineOutcome) => Promise<void> | void;
}

export interface HorizonScanSummary {
  scannedAt: number;
  sync: SecondBrainSyncSummary;
  triggeredRoutines: string[];
  generatedBriefIds: string[];
}

export interface HorizonRoutineOutcome {
  routineId: string;
  channels: readonly SecondBrainDeliveryChannel[];
  kind: 'brief' | 'draft' | 'signal' | 'sync_result' | 'none';
  title?: string;
  summary?: string;
  text: string;
  importance: 'silent' | 'useful' | 'urgent';
  deliveryMode?: 'save_only' | 'web_notice' | 'telegram_notice' | 'multi_channel';
  followUpActions?: Array<'open_brief' | 'dismiss' | 'snooze' | 'regenerate' | 'run_now'>;
  artifactIds?: string[];
}

function matchesFocusQuery(value: string, focusQuery: string | undefined): boolean {
  const normalizedHaystack = value.toLowerCase();
  const normalizedQuery = focusQuery?.trim().toLowerCase() ?? '';
  if (!normalizedQuery) return true;
  return normalizedHaystack.includes(normalizedQuery);
}

function parseCronInteger(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function cronDayToWeekday(field: string): SecondBrainRoutineWeekday | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  const weekdayMap: SecondBrainRoutineWeekday[] = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  return weekdayMap[value === 7 ? 0 : value] ?? null;
}

function weekdayToDayNumber(weekday: SecondBrainRoutineWeekday | undefined): number | null {
  const weekdayMap: SecondBrainRoutineWeekday[] = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  return weekday ? weekdayMap.indexOf(weekday) : null;
}

function parseRoutineScheduleFromCron(cron: string): SecondBrainRoutineSchedule | null {
  const parts = cron.trim().split(/\s+/g);
  if (parts.length !== 5) return null;
  const minute = parseCronInteger(parts[0], 0, 59);
  if (minute == null || parts[3] !== '*') {
    return null;
  }
  if (parts[1] === '*' && parts[2] === '*' && parts[4] === '*') {
    return { cadence: 'hourly', minute };
  }
  const hour = parseCronInteger(parts[1], 0, 23);
  if (hour == null) return null;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (/^\d+$/.test(parts[2]) && parts[4] === '*') {
    const dayOfMonth = Number(parts[2]);
    if (dayOfMonth < 1 || dayOfMonth > 31) return null;
    return { cadence: 'monthly', dayOfMonth, time };
  }
  if (parts[2] !== '*') return null;
  if (parts[4] === '*') {
    return { cadence: 'daily', time };
  }
  if (parts[4] === '1-5') {
    return { cadence: 'weekdays', time };
  }
  const dayOfWeek = cronDayToWeekday(parts[4]);
  if (!dayOfWeek) return null;
  return { cadence: 'weekly', dayOfWeek, time };
}

function latestScheduledOccurrenceAtOrBefore(
  now: number,
  schedule: SecondBrainRoutineSchedule,
  anchorAt?: number,
): number | null {
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);

  if (schedule.cadence === 'hourly') {
    const minute = Number.isFinite(schedule.minute) ? Number(schedule.minute) : 0;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    candidate.setMinutes(minute, 0, 0);
    if (candidate.getTime() > now) {
      candidate.setHours(candidate.getHours() - 1);
    }
    return candidate.getTime();
  }

  const timeMatch = String(schedule.time ?? '').match(/^(\d{2}):(\d{2})$/);
  if (!timeMatch) return null;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

  if (schedule.cadence === 'daily' || schedule.cadence === 'weekdays') {
    for (let offset = 0; offset <= 7; offset += 1) {
      const dayCandidate = new Date(now);
      dayCandidate.setSeconds(0, 0);
      dayCandidate.setDate(dayCandidate.getDate() - offset);
      dayCandidate.setHours(hour, minute, 0, 0);
      if (dayCandidate.getTime() > now) continue;
      if (schedule.cadence === 'weekdays' && (dayCandidate.getDay() === 0 || dayCandidate.getDay() === 6)) {
        continue;
      }
      return dayCandidate.getTime();
    }
    return null;
  }

  if (schedule.cadence === 'weekly' || schedule.cadence === 'fortnightly') {
    const targetDay = weekdayToDayNumber(schedule.dayOfWeek);
    if (targetDay == null) return null;
    for (let offset = 0; offset <= 21; offset += 1) {
      const dayCandidate = new Date(now);
      dayCandidate.setSeconds(0, 0);
      dayCandidate.setDate(dayCandidate.getDate() - offset);
      dayCandidate.setHours(hour, minute, 0, 0);
      if (dayCandidate.getTime() > now || dayCandidate.getDay() !== targetDay) {
        continue;
      }
      if (schedule.cadence === 'fortnightly') {
        const anchor = Number.isFinite(anchorAt) ? Number(anchorAt) : dayCandidate.getTime();
        const elapsedDays = Math.floor((startOfLocalDay(dayCandidate.getTime()) - startOfLocalDay(anchor)) / (24 * 60 * 60 * 1000));
        if (elapsedDays < 0 || (Math.floor(elapsedDays / 7) % 2) !== 0) {
          continue;
        }
      }
      return dayCandidate.getTime();
    }
    return null;
  }

  if (schedule.cadence === 'monthly') {
    const targetDay = Number.isFinite(schedule.dayOfMonth) ? Number(schedule.dayOfMonth) : NaN;
    if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) return null;
    for (let offset = 0; offset <= 12; offset += 1) {
      const monthCandidate = new Date(now);
      monthCandidate.setSeconds(0, 0);
      monthCandidate.setDate(1);
      monthCandidate.setMonth(monthCandidate.getMonth() - offset);
      monthCandidate.setHours(hour, minute, 0, 0);
      const daysInMonth = new Date(monthCandidate.getFullYear(), monthCandidate.getMonth() + 1, 0).getDate();
      if (targetDay > daysInMonth) {
        continue;
      }
      monthCandidate.setDate(targetDay);
      if (monthCandidate.getTime() <= now) {
        return monthCandidate.getTime();
      }
    }
  }

  return null;
}

function startOfLocalDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function occursInSameMinute(left: number, right: number): boolean {
  return Math.floor(left / 60_000) === Math.floor(right / 60_000);
}

export class HorizonScanner {
  private readonly now: () => number;
  private onOutcome: ((outcome: HorizonRoutineOutcome) => Promise<void> | void) | null;

  constructor(
    private readonly scheduledTaskService: ScheduledTaskService,
    private readonly secondBrainService: SecondBrainService,
    private readonly syncService: SyncService,
    private readonly briefingService: BriefingService,
    options: HorizonScannerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onOutcome = options.onOutcome ?? null;
  }

  setOutcomeDelivery(onOutcome: ((outcome: HorizonRoutineOutcome) => Promise<void> | void) | null): void {
    this.onOutcome = onOutcome;
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
    const routines = this.secondBrainService.listRoutineRecords().filter((routine) => routine.enabled);
    const triggeredRoutines: string[] = [];
    const generatedBriefIds: string[] = [];

    const morningRoutines = routines.filter((routine) => (routine.templateId ?? routine.id) === 'morning-brief');
    for (const morningRoutine of morningRoutines) {
      if (!this.shouldRunCronRoutine(scannedAt, morningRoutine)) {
        continue;
      }
      const focusQuery = morningRoutine.config?.focusQuery?.trim() || undefined;
      const brief = await this.briefingService.generateMorningBrief({ routineId: morningRoutine.id, focusQuery });
      this.secondBrainService.markRoutineRun(morningRoutine.id, scannedAt);
      triggeredRoutines.push(morningRoutine.id);
      generatedBriefIds.push(brief.id);
      await this.emitOutcome({
        routineId: morningRoutine.id,
        channels: morningRoutine.deliveryDefaults,
        kind: 'brief',
        title: brief.title,
        summary: focusQuery ? `Your morning brief for "${focusQuery}" is ready.` : 'Your morning brief is ready.',
        importance: 'useful',
        deliveryMode: morningRoutine.deliveryDefaults.length > 1 ? 'multi_channel' : 'telegram_notice',
        followUpActions: ['open_brief', 'regenerate'],
        artifactIds: [brief.id],
        text: `${focusQuery ? `Your morning brief for "${focusQuery}" is ready.` : 'Your morning brief is ready.'}\n\n${brief.title}`,
      });
    }

    const weeklyReviewRoutines = routines.filter((routine) => (routine.templateId ?? routine.id) === 'weekly-review');
    for (const weeklyReviewRoutine of weeklyReviewRoutines) {
      if (!this.shouldRunCronRoutine(scannedAt, weeklyReviewRoutine)) {
        continue;
      }
      const focusQuery = weeklyReviewRoutine.config?.focusQuery?.trim() || undefined;
      const brief = await this.briefingService.generateWeeklyReview({ routineId: weeklyReviewRoutine.id, focusQuery });
      this.secondBrainService.markRoutineRun(weeklyReviewRoutine.id, scannedAt);
      triggeredRoutines.push(weeklyReviewRoutine.id);
      generatedBriefIds.push(brief.id);
      await this.emitOutcome({
        routineId: weeklyReviewRoutine.id,
        channels: weeklyReviewRoutine.deliveryDefaults,
        kind: 'brief',
        title: brief.title,
        summary: focusQuery ? `Your weekly review for "${focusQuery}" is ready.` : 'Your weekly review is ready.',
        importance: 'useful',
        deliveryMode: weeklyReviewRoutine.deliveryDefaults.length > 1 ? 'multi_channel' : 'telegram_notice',
        followUpActions: ['open_brief', 'regenerate'],
        artifactIds: [brief.id],
        text: `${focusQuery ? `Your weekly review for "${focusQuery}" is ready.` : 'Your weekly review is ready.'}\n\n${brief.title}`,
      });
    }

    const radarRoutines = routines.filter((routine) => (routine.templateId ?? routine.id) === 'next-24-hours-radar');
    for (const radarRoutine of radarRoutines) {
      const horizonMinutes = radarRoutine.trigger.mode === 'horizon' && Number.isFinite(radarRoutine.trigger.lookaheadMinutes)
        ? Number(radarRoutine.trigger.lookaheadMinutes)
        : 1440;
      const focusQuery = radarRoutine.config?.focusQuery?.trim() || undefined;
      const upcomingEvents = this.secondBrainService.listEvents({
        fromTime: scannedAt,
        includePast: false,
        limit: 10,
      }).filter((event) => (
        event.startsAt <= scannedAt + (horizonMinutes * 60 * 1000)
        && matchesFocusQuery([event.title, event.description, event.location].filter(Boolean).join(' '), focusQuery)
      ));
      const openTasks = this.secondBrainService.listTasks({ status: 'open', limit: 10 })
        .filter((task) => matchesFocusQuery([task.title, task.details].filter(Boolean).join(' '), focusQuery));
      if (
        (upcomingEvents.length > 0 || openTasks.length > 0)
        && (radarRoutine.lastRunAt == null || (scannedAt - radarRoutine.lastRunAt) >= 6 * 60 * 60 * 1000)
      ) {
        this.secondBrainService.markRoutineRun(radarRoutine.id, scannedAt);
        triggeredRoutines.push(radarRoutine.id);
        await this.emitOutcome({
          routineId: radarRoutine.id,
          channels: radarRoutine.deliveryDefaults,
          kind: 'signal',
          title: radarRoutine.name,
          summary: `${focusQuery ? `Your daily agenda check for "${focusQuery}" found` : 'Your daily agenda check found'} ${upcomingEvents.length} upcoming event${upcomingEvents.length === 1 ? '' : 's'} and ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} in the next 24 hours.`,
          importance: 'useful',
          deliveryMode: radarRoutine.deliveryDefaults.length > 1 ? 'multi_channel' : 'telegram_notice',
          followUpActions: ['dismiss'],
          text: `${focusQuery ? `Your daily agenda check for "${focusQuery}" found` : 'Your daily agenda check found'} ${upcomingEvents.length} upcoming event${upcomingEvents.length === 1 ? '' : 's'} and ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} in the next 24 hours.`,
        });
      }
    }

    const preMeetingRoutines = routines.filter((routine) => (routine.templateId ?? routine.id) === 'pre-meeting-brief');
    for (const preMeetingRoutine of preMeetingRoutines) {
      const lookaheadMinutes = preMeetingRoutine.trigger.mode === 'event' && Number.isFinite(preMeetingRoutine.trigger.lookaheadMinutes)
        ? Number(preMeetingRoutine.trigger.lookaheadMinutes)
        : 60;
      const focusQuery = preMeetingRoutine.config?.focusQuery?.trim() || undefined;
      const upcomingEvents = this.secondBrainService.listEvents({
        fromTime: scannedAt,
        includePast: false,
        limit: 25,
      }).filter((event) => (
        event.startsAt <= scannedAt + (lookaheadMinutes * 60 * 1000)
        && matchesFocusQuery([event.title, event.description, event.location].filter(Boolean).join(' '), focusQuery)
      ));
      let triggered = false;
      for (const event of upcomingEvents) {
        const briefId = preMeetingRoutine.id === 'pre-meeting-brief'
          ? `brief:pre_meeting:${event.id}`
          : `brief:pre_meeting:${preMeetingRoutine.id}:${event.id}`;
        const brief = this.secondBrainService.getBriefById(briefId);
        if (brief && brief.updatedAt >= event.updatedAt) continue;
        const generated = await this.briefingService.generatePreMeetingBrief(event.id, {
          routineId: preMeetingRoutine.id,
          focusQuery,
        });
        generatedBriefIds.push(generated.id);
        triggered = true;
        await this.emitOutcome({
          routineId: preMeetingRoutine.id,
          channels: preMeetingRoutine.deliveryDefaults,
          kind: 'brief',
          title: generated.title,
          summary: focusQuery
            ? `I prepared a pre-meeting brief for "${event.title}" related to "${focusQuery}".`
            : `I prepared a pre-meeting brief for "${event.title}".`,
          importance: 'useful',
          deliveryMode: preMeetingRoutine.deliveryDefaults.length > 1 ? 'multi_channel' : 'telegram_notice',
          followUpActions: ['open_brief'],
          artifactIds: [generated.id, event.id],
          text: focusQuery
            ? `I prepared a pre-meeting brief for "${event.title}" related to "${focusQuery}".`
            : `I prepared a pre-meeting brief for "${event.title}".`,
        });
      }
      if (triggered) {
        this.secondBrainService.markRoutineRun(preMeetingRoutine.id, scannedAt);
        triggeredRoutines.push(preMeetingRoutine.id);
      }
    }

    const followUpRoutines = routines.filter((routine) => (routine.templateId ?? routine.id) === 'follow-up-watch');
    for (const followUpRoutine of followUpRoutines) {
      const lookbackMinutes = followUpRoutine.trigger.mode === 'event' && Number.isFinite(followUpRoutine.trigger.lookaheadMinutes)
        ? Number(followUpRoutine.trigger.lookaheadMinutes)
        : 1440;
      const focusQuery = followUpRoutine.config?.focusQuery?.trim() || undefined;
      const recentEvents = this.secondBrainService.listEvents({
        includePast: true,
        fromTime: 0,
        limit: 50,
      }).filter((event) => {
        const endedAt = event.endsAt ?? event.startsAt;
        return endedAt < scannedAt
          && endedAt >= scannedAt - (lookbackMinutes * 60 * 1000)
          && matchesFocusQuery([event.title, event.description, event.location].filter(Boolean).join(' '), focusQuery);
      });
      let triggered = false;
      for (const event of recentEvents) {
        const briefId = followUpRoutine.id === 'follow-up-watch'
          ? `brief:follow_up:${event.id}`
          : `brief:follow_up:${followUpRoutine.id}:${event.id}`;
        const brief = this.secondBrainService.getBriefById(briefId);
        if (brief) continue;
        const generated = await this.briefingService.draftFollowUp(event.id, {
          routineId: followUpRoutine.id,
          focusQuery,
        });
        generatedBriefIds.push(generated.id);
        triggered = true;
        await this.emitOutcome({
          routineId: followUpRoutine.id,
          channels: followUpRoutine.deliveryDefaults,
          kind: 'draft',
          title: generated.title,
          summary: focusQuery
            ? `I drafted a follow-up for "${event.title}" related to "${focusQuery}".`
            : `I drafted a follow-up for "${event.title}".`,
          importance: 'useful',
          deliveryMode: followUpRoutine.deliveryDefaults.length > 1 ? 'multi_channel' : 'telegram_notice',
          followUpActions: ['open_brief'],
          artifactIds: [generated.id, event.id],
          text: focusQuery
            ? `I drafted a follow-up for "${event.title}" related to "${focusQuery}".`
            : `I drafted a follow-up for "${event.title}".`,
        });
      }
      if (triggered) {
        this.secondBrainService.markRoutineRun(followUpRoutine.id, scannedAt);
        triggeredRoutines.push(followUpRoutine.id);
      }
    }

    const topicWatchRoutines = routines.filter((routine) => (routine.templateId ?? routine.id) === 'topic-watch');
    for (const routine of topicWatchRoutines) {
      if (!this.shouldRunCronRoutine(scannedAt, routine)) {
        continue;
      }
      const generated = await this.briefingService.generateTopicWatchBrief(routine.id, {
        onlySince: routine.lastRunAt ?? routine.createdAt,
      });
      this.secondBrainService.markRoutineRun(routine.id, scannedAt);
      if (!generated) {
        continue;
      }
      triggeredRoutines.push(routine.id);
      generatedBriefIds.push(generated.id);
      await this.emitOutcome({
        routineId: routine.id,
        channels: routine.deliveryDefaults,
        kind: 'brief',
        title: generated.title,
        summary: `Your topic watch for "${routine.config?.topicQuery ?? routine.name}" found new matching context.`,
        importance: 'useful',
        deliveryMode: routine.deliveryDefaults.length > 1 ? 'multi_channel' : 'telegram_notice',
        followUpActions: ['open_brief'],
        artifactIds: [generated.id],
        text: `Your topic watch for "${routine.config?.topicQuery ?? routine.name}" found new matching context.`,
      });
    }

    const deadlineWatchRoutines = routines.filter((routine) => (routine.templateId ?? routine.id) === 'deadline-watch');
    for (const routine of deadlineWatchRoutines) {
      if (!this.shouldRunCronRoutine(scannedAt, routine)) {
        continue;
      }
      const generated = await this.briefingService.generateDeadlineWatchBrief(routine.id, {
        onlySince: routine.lastRunAt ?? routine.createdAt,
      });
      this.secondBrainService.markRoutineRun(routine.id, scannedAt);
      if (!generated) {
        continue;
      }
      triggeredRoutines.push(routine.id);
      generatedBriefIds.push(generated.id);
      await this.emitOutcome({
        routineId: routine.id,
        channels: routine.deliveryDefaults,
        kind: 'brief',
        title: generated.title,
        summary: `Your deadline watch found new task pressure in the next ${Number(routine.config?.dueWithinHours ?? 24)} hours${routine.config?.includeOverdue === false ? '.' : ' and overdue tasks.'}`,
        importance: 'useful',
        deliveryMode: routine.deliveryDefaults.length > 1 ? 'multi_channel' : 'telegram_notice',
        followUpActions: ['open_brief'],
        artifactIds: [generated.id],
        text: `Your deadline watch found new task pressure in the next ${Number(routine.config?.dueWithinHours ?? 24)} hours${routine.config?.includeOverdue === false ? '.' : ' and overdue tasks.'}`,
      });
    }

    return {
      scannedAt,
      sync,
      triggeredRoutines,
      generatedBriefIds,
    };
  }

  private async emitOutcome(outcome: HorizonRoutineOutcome): Promise<void> {
    if (!this.onOutcome) {
      return;
    }
    await this.onOutcome(outcome);
  }

  private shouldRunCronRoutine(now: number, routine: SecondBrainRoutineRecord): boolean {
    if (routine.trigger.mode !== 'cron' || !routine.trigger.cron) return false;
    const schedule = routine.trigger.schedule ?? parseRoutineScheduleFromCron(routine.trigger.cron);
    if (!schedule) return false;
    const scheduledAt = latestScheduledOccurrenceAtOrBefore(now, schedule, routine.trigger.anchorAt ?? routine.createdAt);
    if (scheduledAt == null) return false;
    const baseline = routine.lastRunAt
      ?? (this.secondBrainService.isSeededBuiltInRoutine(routine.id) ? 0 : routine.createdAt);
    if (scheduledAt > baseline) {
      return true;
    }
    return routine.lastRunAt == null
      && !this.secondBrainService.isSeededBuiltInRoutine(routine.id)
      && occursInSameMinute(scheduledAt, routine.createdAt);
  }
}
