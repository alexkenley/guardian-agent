import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
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
              companyName: 'Contoso',
              jobTitle: 'Director',
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
    expect(service.getUsageSummary().totalConnectorCalls).toBe(4);
    expect(service.getSyncCursorById('google:calendar')?.lastSyncAt).toBe(now());
    expect(service.getSyncCursorById('microsoft:contacts')?.lastSyncAt).toBe(now());
  });
});
