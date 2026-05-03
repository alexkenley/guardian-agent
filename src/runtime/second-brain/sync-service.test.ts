import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { SecondBrainService } from './second-brain-service.js';
import { SecondBrainStore } from './second-brain-store.js';
import { SyncService } from './sync-service.js';

function createFixture() {
  const sqlitePath = join(tmpdir(), `guardianagent-second-brain-sync-${randomUUID()}.sqlite`);
  const nowState = { value: Date.parse('2026-04-04T09:00:00Z') };
  const now = () => nowState.value;
  const store = new SecondBrainStore({ sqlitePath, now });
  const service = new SecondBrainService(store, { now });
  return { store, service, now };
}

describe('SyncService', () => {
  it('hydrates shared events and people from Google and Microsoft connectors', async () => {
    const { service, now } = createFixture();
    const googleService = {
      isAuthenticated: () => true,
      isServiceEnabled: (svc: string) => svc === 'calendar' || svc === 'contacts',
      async execute(params: { service: string }) {
        if (params.service === 'calendar') {
          return {
            success: true,
            data: {
              items: [{
                id: 'google-evt-1',
                summary: 'Google Standup',
                description: 'Daily team sync on blockers and decisions.',
                start: { dateTime: '2026-04-04T10:00:00Z' },
                end: { dateTime: '2026-04-04T10:30:00Z' },
                location: 'Meet',
              }],
            },
          };
        }
        return {
          success: true,
          data: {
            connections: [{
              resourceName: 'people/c123',
              names: [{ displayName: 'Alex Google' }],
              emailAddresses: [{ value: 'alex.google@example.com' }],
              phoneNumbers: [{ value: '+61 400 000 111' }],
              locations: [{ value: 'Brisbane' }],
              organizations: [{ title: 'PM', name: 'Example Co' }],
            }],
          },
        };
      },
    };
    const microsoftService = {
      isAuthenticated: () => true,
      isServiceEnabled: (svc: string) => svc === 'calendar' || svc === 'contacts',
      async execute(params: { service: string }) {
        if (params.service === 'calendar') {
          return {
            success: true,
            data: {
              value: [{
                id: 'ms-evt-1',
                subject: 'Microsoft Review',
                bodyPreview: 'Quarterly review with the finance team.',
                start: { dateTime: '2026-04-04T11:00:00Z' },
                end: { dateTime: '2026-04-04T12:00:00Z' },
                location: { displayName: 'Teams' },
              }],
            },
          };
        }
        return {
          success: true,
          data: {
            value: [{
              id: 'ms-contact-1',
              displayName: 'Morgan Microsoft',
              emailAddresses: [{ address: 'morgan.microsoft@example.com' }],
              mobilePhone: '+61 400 000 222',
              companyName: 'Contoso',
              jobTitle: 'Director',
              officeLocation: 'Sydney',
            }],
          },
        };
      },
    };

    const syncService = new SyncService(service, {
      now,
      getGoogleService: () => googleService as any,
      getMicrosoftService: () => microsoftService as any,
    });

    const summary = await syncService.syncAll('test');

    expect(summary.providers).toHaveLength(2);
    expect(service.listEvents({ includePast: true, fromTime: 0, limit: 10 }).map((event) => event.title)).toEqual(expect.arrayContaining([
      'Google Standup',
      'Microsoft Review',
    ]));
    expect(service.listEvents({ includePast: true, fromTime: 0, limit: 10 }).find((event) => event.title === 'Google Standup')?.description)
      .toBe('Daily team sync on blockers and decisions.');
    expect(service.listEvents({ includePast: true, fromTime: 0, limit: 10 }).find((event) => event.title === 'Microsoft Review')?.description)
      .toBe('Quarterly review with the finance team.');
    expect(service.listPeople({ limit: 10 }).map((person) => person.name)).toEqual(expect.arrayContaining([
      'Alex Google',
      'Morgan Microsoft',
    ]));
    expect(service.listPeople({ limit: 10 }).find((person) => person.name === 'Alex Google')).toMatchObject({
      phone: '+61 400 000 111',
      location: 'Brisbane',
    });
    expect(service.listPeople({ limit: 10 }).find((person) => person.name === 'Morgan Microsoft')).toMatchObject({
      phone: '+61 400 000 222',
      location: 'Sydney',
    });
    expect(service.getUsageSummary().totalConnectorCalls).toBe(4);
    expect(service.getSyncCursorById('google:calendar')?.lastSyncAt).toBe(now());
    expect(service.getSyncCursorById('microsoft:contacts')?.lastSyncAt).toBe(now());
  });

  it('preserves Microsoft event wall-clock time when Graph returns dateTime plus timeZone', async () => {
    const { service, now } = createFixture();
    const microsoftService = {
      isAuthenticated: () => true,
      isServiceEnabled: (svc: string) => svc === 'calendar',
      async execute() {
        return {
          success: true,
          data: {
            value: [{
              id: 'ms-evt-zone-1',
              subject: 'Timezone Check',
              start: { dateTime: '2026-04-07T13:00:00', timeZone: 'Pacific/Auckland' },
              end: { dateTime: '2026-04-07T13:30:00', timeZone: 'Pacific/Auckland' },
              location: { displayName: 'Outlook' },
            }],
          },
        };
      },
    };

    const syncService = new SyncService(service, {
      now,
      getMicrosoftService: () => microsoftService as any,
    });

    const summary = await syncService.syncMicrosoft365();
    const event = service.listEvents({ includePast: true, fromTime: 0, limit: 10 })
      .find((entry) => entry.title === 'Timezone Check');

    expect(summary.eventsSynced).toBe(1);
    expect(event).toBeDefined();
    expect(new Date(event!.startsAt).toISOString()).toBe('2026-04-07T01:00:00.000Z');
    expect(new Date(event!.endsAt ?? 0).toISOString()).toBe('2026-04-07T01:30:00.000Z');
  });

  it('keeps Google calendar sync when contacts are unavailable', async () => {
    const { service, now } = createFixture();
    const googleService = {
      isAuthenticated: () => true,
      isServiceEnabled: (svc: string) => svc === 'calendar' || svc === 'contacts',
      async execute(params: { service: string }) {
        if (params.service === 'calendar') {
          return {
            success: true,
            data: {
              items: [{
                id: 'google-evt-partial-1',
                summary: 'Google Partial Sync',
                start: { dateTime: '2026-04-04T14:00:00Z' },
              }],
            },
          };
        }
        return {
          success: false,
          error: 'People API has not been used in project before or it is disabled.',
        };
      },
    };

    const syncService = new SyncService(service, {
      now,
      getGoogleService: () => googleService as any,
    });

    const summary = await syncService.syncGoogleWorkspace();

    expect(summary.skipped).toBe(false);
    expect(summary.eventsSynced).toBe(1);
    expect(summary.peopleSynced).toBe(0);
    expect(summary.connectorCalls).toBe(2);
    expect(summary.error).toContain('People API');
    expect(service.listEvents({ includePast: true, fromTime: 0, limit: 10 }).map((event) => event.title))
      .toContain('Google Partial Sync');
    expect(service.getSyncCursorById('google:calendar')?.lastSyncAt).toBe(now());
    expect(service.getSyncCursorById('google:contacts')).toBeNull();
  });

  it('retains last provider sync health without rerunning connector calls', async () => {
    const { service, now } = createFixture();
    const googleExecute = vi.fn(async (params: { service: string }) => {
      if (params.service === 'calendar') {
        return {
          success: true,
          data: { items: [] },
        };
      }
      return {
        success: false,
        error: 'People API has not been used in project before or it is disabled.',
      };
    });
    const googleService = {
      isAuthenticated: () => true,
      isServiceEnabled: (svc: string) => svc === 'calendar' || svc === 'contacts',
      execute: googleExecute,
    };

    const syncService = new SyncService(service, {
      now,
      getGoogleService: () => googleService as any,
    });

    const summary = await syncService.syncAll('startup');
    const health = syncService.getProviderSyncHealth('google');

    expect(syncService.getLastSummary()).toEqual(summary);
    expect(health).toMatchObject({
      provider: 'google',
      status: 'warning',
      reason: 'startup',
      skipped: false,
      eventsSynced: 0,
      peopleSynced: 0,
      connectorCalls: 2,
      error: expect.stringContaining('People API'),
    });
    expect(health?.lastSyncStartedAt).toBe(now());
    expect(health?.lastSyncFinishedAt).toBe(now());
    expect(googleExecute).toHaveBeenCalledTimes(2);

    syncService.getProviderSyncHealth('google');
    expect(googleExecute).toHaveBeenCalledTimes(2);
  });
});
