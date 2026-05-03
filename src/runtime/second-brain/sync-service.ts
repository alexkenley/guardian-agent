import { createLogger } from '../../util/logging.js';
import type { GoogleService } from '../../google/google-service.js';
import type { MicrosoftService } from '../../microsoft/microsoft-service.js';
import type {
  WorkspaceIntegrationProvider,
  WorkspaceIntegrationSyncHealth,
} from '../workspace-sync-health.js';
import type { SecondBrainService } from './second-brain-service.js';
import type { SecondBrainSyncCursorRecord } from './types.js';

const log = createLogger('second-brain-sync');

interface SyncServiceOptions {
  now?: () => number;
  getGoogleService?: () => GoogleService | undefined;
  getMicrosoftService?: () => MicrosoftService | undefined;
}

export interface ProviderSyncResult {
  provider: 'google' | 'microsoft';
  skipped: boolean;
  reason?: string;
  eventsSynced: number;
  peopleSynced: number;
  connectorCalls: number;
  error?: string;
}

export interface SecondBrainSyncSummary {
  startedAt: number;
  finishedAt: number;
  reason: string;
  providers: ProviderSyncResult[];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const TIME_ZONE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const normalized = timeZone.trim();
  if (!normalized) return null;
  const cached = TIME_ZONE_FORMATTER_CACHE.get(normalized);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: normalized,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    TIME_ZONE_FORMATTER_CACHE.set(normalized, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function parseIsoDateTimeParts(value: string): ZonedDateTimeParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/);
  if (!match) return null;
  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
    hour: Number.parseInt(match[4], 10),
    minute: Number.parseInt(match[5], 10),
    second: Number.parseInt(match[6] ?? '0', 10),
    millisecond: Number.parseInt((match[7] ?? '0').padEnd(3, '0'), 10),
  };
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function readWallClockParts(timestamp: number, timeZone: string): ZonedDateTimeParts | null {
  const formatter = getTimeZoneFormatter(timeZone);
  if (!formatter) return null;
  const parts = formatter.formatToParts(new Date(timestamp));
  const lookup = (type: Intl.DateTimeFormatPartTypes): number | null => {
    const part = parts.find((entry) => entry.type === type)?.value;
    if (!part) return null;
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  const hour = lookup('hour');
  const minute = lookup('minute');
  const second = lookup('second');
  if (year == null || month == null || day == null || hour == null || minute == null || second == null) {
    return null;
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: new Date(timestamp).getUTCMilliseconds(),
  };
}

function compareWallClockParts(a: ZonedDateTimeParts, b: ZonedDateTimeParts): number {
  return Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second, a.millisecond)
    - Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, b.second, b.millisecond);
}

function parseTimestamp(value: unknown, timeZone?: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : '';
  if (!zone || hasExplicitOffset(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const target = parseIsoDateTimeParts(trimmed);
  if (target) {
    let candidate = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      target.hour,
      target.minute,
      target.second,
      target.millisecond,
    );
    for (let i = 0; i < 4; i += 1) {
      const actual = readWallClockParts(candidate, zone);
      if (!actual) break;
      const delta = compareWallClockParts(target, actual);
      if (delta === 0) {
        return candidate;
      }
      candidate += delta;
    }
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function richTextOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return textOrUndefined(
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' '),
  );
}

export class SyncService {
  private readonly now: () => number;
  private readonly getGoogleService: () => GoogleService | undefined;
  private readonly getMicrosoftService: () => MicrosoftService | undefined;
  private lastSummary?: SecondBrainSyncSummary;

  constructor(
    private readonly secondBrainService: SecondBrainService,
    options: SyncServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.getGoogleService = options.getGoogleService ?? (() => undefined);
    this.getMicrosoftService = options.getMicrosoftService ?? (() => undefined);
  }

  async start(): Promise<void> {
    await this.syncAll('startup').catch((error) => {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'Initial Second Brain sync failed');
    });
  }

  getLastSummary(): SecondBrainSyncSummary | undefined {
    return this.lastSummary ? cloneSummary(this.lastSummary) : undefined;
  }

  getProviderSyncHealth(provider: WorkspaceIntegrationProvider): WorkspaceIntegrationSyncHealth | undefined {
    const summary = this.lastSummary;
    const providerResult = summary?.providers.find((entry) => entry.provider === provider);
    if (!summary || !providerResult) return undefined;
    return {
      provider,
      status: providerResult.skipped ? 'skipped' : (providerResult.error ? 'warning' : 'healthy'),
      lastSyncStartedAt: summary.startedAt,
      lastSyncFinishedAt: summary.finishedAt,
      reason: summary.reason,
      skipped: providerResult.skipped,
      skipReason: providerResult.reason,
      eventsSynced: providerResult.eventsSynced,
      peopleSynced: providerResult.peopleSynced,
      connectorCalls: providerResult.connectorCalls,
      error: providerResult.error,
    };
  }

  async syncAll(reason = 'manual'): Promise<SecondBrainSyncSummary> {
    const startedAt = this.now();
    const providers = await Promise.all([
      this.syncGoogleWorkspace(),
      this.syncMicrosoft365(),
    ]);
    const summary = {
      startedAt,
      finishedAt: this.now(),
      reason,
      providers,
    };
    this.lastSummary = cloneSummary(summary);
    return summary;
  }

  async syncGoogleWorkspace(): Promise<ProviderSyncResult> {
    const service = this.getGoogleService();
    if (!service) {
      return {
        provider: 'google',
        skipped: true,
        reason: 'service_unavailable',
        eventsSynced: 0,
        peopleSynced: 0,
        connectorCalls: 0,
      };
    }
    if (!service.isAuthenticated()) {
      return {
        provider: 'google',
        skipped: true,
        reason: 'not_authenticated',
        eventsSynced: 0,
        peopleSynced: 0,
        connectorCalls: 0,
      };
    }

    try {
      let connectorCalls = 0;
      let eventsSynced = 0;
      let peopleSynced = 0;
      let contactSyncError: string | undefined;

      if (service.isServiceEnabled('calendar')) {
        connectorCalls += 1;
        const eventsResult = await service.execute({
          service: 'calendar',
          resource: 'events',
          method: 'list',
          params: {
            calendarId: 'primary',
            timeMin: new Date(this.now() - (60 * 60 * 1000)).toISOString(),
            maxResults: 25,
            singleEvents: true,
            orderBy: 'startTime',
          },
        });
        if (!eventsResult.success) {
          throw new Error(eventsResult.error || 'Google Calendar sync failed');
        }

        const items = asArray<Record<string, unknown>>((eventsResult.data as { items?: unknown })?.items);
        for (const item of items) {
          const startRecord = item.start as Record<string, unknown> | undefined;
          const endRecord = item.end as Record<string, unknown> | undefined;
          const start = parseTimestamp(startRecord?.dateTime, startRecord?.timeZone)
            ?? parseTimestamp((item.start as Record<string, unknown> | undefined)?.date);
          if (start == null) continue;
          const end = parseTimestamp(endRecord?.dateTime, endRecord?.timeZone)
            ?? parseTimestamp((item.end as Record<string, unknown> | undefined)?.date);
          this.secondBrainService.upsertSyncedEvent({
            id: `google:event:${String(item.id ?? start)}`,
            title: textOrUndefined(item.summary) ?? 'Google Calendar Event',
            description: textOrUndefined(item.description),
            startsAt: start,
            endsAt: end ?? undefined,
            source: 'google',
            location: textOrUndefined((item.location as unknown)),
          });
          eventsSynced += 1;
        }
        this.updateCursor({
          id: 'google:calendar',
          provider: 'google',
          entity: 'calendar',
          cursor: null,
        });
      }

      if (service.isServiceEnabled('contacts')) {
        connectorCalls += 1;
        const contactsResult = await service.execute({
          service: 'contacts',
          resource: 'people connections',
          method: 'list',
          params: {
            resourceName: 'people/me',
            pageSize: 50,
            personFields: 'names,emailAddresses,organizations,biographies',
          },
        });
        if (!contactsResult.success) {
          contactSyncError = contactsResult.error || 'Google contacts sync failed';
          log.warn({ err: contactSyncError }, 'Google contacts Second Brain sync skipped');
        } else {
          const connections = asArray<Record<string, unknown>>((contactsResult.data as { connections?: unknown })?.connections);
          for (const person of connections) {
            const names = asArray<Record<string, unknown>>(person.names);
            const emails = asArray<Record<string, unknown>>(person.emailAddresses);
            const phoneNumbers = asArray<Record<string, unknown>>(person.phoneNumbers);
            const organizations = asArray<Record<string, unknown>>(person.organizations);
            const biographies = asArray<Record<string, unknown>>(person.biographies);
            const locations = asArray<Record<string, unknown>>(person.locations);
            const email = textOrUndefined(emails[0]?.value);
            const name = textOrUndefined(names[0]?.displayName) ?? email;
            if (!name) continue;
            this.secondBrainService.upsertPerson({
              id: `google:person:${String(person.resourceName ?? person.etag ?? peopleSynced)}`,
              name,
              email,
              phone: textOrUndefined(phoneNumbers[0]?.value),
              title: textOrUndefined(organizations[0]?.title),
              company: textOrUndefined(organizations[0]?.name),
              location: textOrUndefined(locations[0]?.value),
              notes: textOrUndefined(biographies[0]?.value),
              relationship: 'work',
            });
            peopleSynced += 1;
          }
          this.updateCursor({
            id: 'google:contacts',
            provider: 'google',
            entity: 'contacts',
            cursor: null,
          });
        }
      }

      this.secondBrainService.recordUsage({
        featureArea: 'maintenance',
        provider: 'google',
        locality: 'external',
        promptTokens: 0,
        completionTokens: 0,
        connectorCalls,
      });

      const result: ProviderSyncResult = {
        provider: 'google',
        skipped: false,
        eventsSynced,
        peopleSynced,
        connectorCalls,
      };
      if (contactSyncError) result.error = contactSyncError;
      return result;
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'Google Workspace Second Brain sync failed');
      return {
        provider: 'google',
        skipped: false,
        eventsSynced: 0,
        peopleSynced: 0,
        connectorCalls: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async syncMicrosoft365(): Promise<ProviderSyncResult> {
    const service = this.getMicrosoftService();
    if (!service) {
      return {
        provider: 'microsoft',
        skipped: true,
        reason: 'service_unavailable',
        eventsSynced: 0,
        peopleSynced: 0,
        connectorCalls: 0,
      };
    }
    if (!service.isAuthenticated()) {
      return {
        provider: 'microsoft',
        skipped: true,
        reason: 'not_authenticated',
        eventsSynced: 0,
        peopleSynced: 0,
        connectorCalls: 0,
      };
    }

    try {
      let connectorCalls = 0;
      let eventsSynced = 0;
      let peopleSynced = 0;

      if (service.isServiceEnabled('calendar')) {
        connectorCalls += 1;
        const eventsResult = await service.execute({
          service: 'calendar',
          resource: 'me/calendarView',
          method: 'list',
          params: {
            startDateTime: new Date(this.now() - (60 * 60 * 1000)).toISOString(),
            endDateTime: new Date(this.now() + (7 * 24 * 60 * 60 * 1000)).toISOString(),
            $top: 25,
            $select: 'id,subject,start,end,location,lastModifiedDateTime',
          },
        });
        if (!eventsResult.success) {
          throw new Error(eventsResult.error || 'Microsoft calendar sync failed');
        }

        const items = asArray<Record<string, unknown>>((eventsResult.data as { value?: unknown })?.value);
        for (const item of items) {
          const startRecord = item.start as Record<string, unknown> | undefined;
          const endRecord = item.end as Record<string, unknown> | undefined;
          const start = parseTimestamp(startRecord?.dateTime, startRecord?.timeZone);
          if (start == null) continue;
          const end = parseTimestamp(endRecord?.dateTime, endRecord?.timeZone);
          const location = item.location && typeof item.location === 'object'
            ? textOrUndefined((item.location as Record<string, unknown>).displayName)
            : undefined;
          this.secondBrainService.upsertSyncedEvent({
            id: `microsoft:event:${String(item.id ?? start)}`,
            title: textOrUndefined(item.subject) ?? 'Microsoft Calendar Event',
            description: textOrUndefined(item.bodyPreview)
              ?? richTextOrUndefined((item.body as Record<string, unknown> | undefined)?.content),
            startsAt: start,
            endsAt: end ?? undefined,
            source: 'microsoft',
            location,
          });
          eventsSynced += 1;
        }
        this.updateCursor({
          id: 'microsoft:calendar',
          provider: 'microsoft',
          entity: 'calendar',
          cursor: null,
        });
      }

      if (service.isServiceEnabled('contacts')) {
        connectorCalls += 1;
        const contactsResult = await service.execute({
          service: 'contacts',
          resource: 'me/contacts',
          method: 'list',
          params: {
            $top: 50,
            $select: 'id,displayName,emailAddresses,companyName,jobTitle',
          },
        });
        if (!contactsResult.success) {
          throw new Error(contactsResult.error || 'Microsoft contacts sync failed');
        }

        const contacts = asArray<Record<string, unknown>>((contactsResult.data as { value?: unknown })?.value);
        for (const contact of contacts) {
          const emailAddresses = asArray<Record<string, unknown>>(contact.emailAddresses);
          const businessPhones = asArray<unknown>(contact.businessPhones);
          const email = textOrUndefined(emailAddresses[0]?.address);
          const phone = textOrUndefined(contact.mobilePhone) ?? textOrUndefined(businessPhones[0]);
          const name = textOrUndefined(contact.displayName) ?? email;
          if (!name) continue;
          this.secondBrainService.upsertPerson({
            id: `microsoft:person:${String(contact.id ?? peopleSynced)}`,
            name,
            email,
            phone,
            title: textOrUndefined(contact.jobTitle),
            company: textOrUndefined(contact.companyName),
            location: textOrUndefined(contact.officeLocation),
            relationship: 'work',
          });
          peopleSynced += 1;
        }
        this.updateCursor({
          id: 'microsoft:contacts',
          provider: 'microsoft',
          entity: 'contacts',
          cursor: null,
        });
      }

      this.secondBrainService.recordUsage({
        featureArea: 'maintenance',
        provider: 'microsoft',
        locality: 'external',
        promptTokens: 0,
        completionTokens: 0,
        connectorCalls,
      });

      return {
        provider: 'microsoft',
        skipped: false,
        eventsSynced,
        peopleSynced,
        connectorCalls,
      };
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'Microsoft 365 Second Brain sync failed');
      return {
        provider: 'microsoft',
        skipped: false,
        eventsSynced: 0,
        peopleSynced: 0,
        connectorCalls: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private updateCursor(input: Pick<SecondBrainSyncCursorRecord, 'id' | 'provider' | 'entity' | 'cursor'>): void {
    const existing = this.secondBrainService.getSyncCursorById(input.id);
    const timestamp = this.now();
    this.secondBrainService.saveSyncCursor({
      id: input.id,
      provider: input.provider,
      entity: input.entity,
      cursor: input.cursor ?? null,
      lastSyncAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }
}

function cloneSummary(summary: SecondBrainSyncSummary): SecondBrainSyncSummary {
  return {
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    reason: summary.reason,
    providers: summary.providers.map((provider) => ({ ...provider })),
  };
}
