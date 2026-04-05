import { createLogger } from '../../util/logging.js';
import type { GoogleService } from '../../google/google-service.js';
import type { MicrosoftService } from '../../microsoft/microsoft-service.js';
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

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
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

  async syncAll(reason = 'manual'): Promise<SecondBrainSyncSummary> {
    const startedAt = this.now();
    const providers = await Promise.all([
      this.syncGoogleWorkspace(),
      this.syncMicrosoft365(),
    ]);
    return {
      startedAt,
      finishedAt: this.now(),
      reason,
      providers,
    };
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
          const start = parseTimestamp((item.start as Record<string, unknown> | undefined)?.dateTime)
            ?? parseTimestamp((item.start as Record<string, unknown> | undefined)?.date);
          if (start == null) continue;
          const end = parseTimestamp((item.end as Record<string, unknown> | undefined)?.dateTime)
            ?? parseTimestamp((item.end as Record<string, unknown> | undefined)?.date);
          this.secondBrainService.upsertEvent({
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
          throw new Error(contactsResult.error || 'Google contacts sync failed');
        }

        const connections = asArray<Record<string, unknown>>((contactsResult.data as { connections?: unknown })?.connections);
        for (const person of connections) {
          const names = asArray<Record<string, unknown>>(person.names);
          const emails = asArray<Record<string, unknown>>(person.emailAddresses);
          const organizations = asArray<Record<string, unknown>>(person.organizations);
          const biographies = asArray<Record<string, unknown>>(person.biographies);
          const email = textOrUndefined(emails[0]?.value);
          const name = textOrUndefined(names[0]?.displayName) ?? email;
          if (!name) continue;
          this.secondBrainService.upsertPerson({
            id: `google:person:${String(person.resourceName ?? person.etag ?? peopleSynced)}`,
            name,
            email,
            title: textOrUndefined(organizations[0]?.title),
            company: textOrUndefined(organizations[0]?.name),
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

      this.secondBrainService.recordUsage({
        featureArea: 'maintenance',
        provider: 'google',
        locality: 'external',
        promptTokens: 0,
        completionTokens: 0,
        connectorCalls,
      });

      return {
        provider: 'google',
        skipped: false,
        eventsSynced,
        peopleSynced,
        connectorCalls,
      };
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
          const start = parseTimestamp((item.start as Record<string, unknown> | undefined)?.dateTime);
          if (start == null) continue;
          const end = parseTimestamp((item.end as Record<string, unknown> | undefined)?.dateTime);
          const location = item.location && typeof item.location === 'object'
            ? textOrUndefined((item.location as Record<string, unknown>).displayName)
            : undefined;
          this.secondBrainService.upsertEvent({
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
          const email = textOrUndefined(emailAddresses[0]?.address);
          const name = textOrUndefined(contact.displayName) ?? email;
          if (!name) continue;
          this.secondBrainService.upsertPerson({
            id: `microsoft:person:${String(contact.id ?? peopleSynced)}`,
            name,
            email,
            title: textOrUndefined(contact.jobTitle),
            company: textOrUndefined(contact.companyName),
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
