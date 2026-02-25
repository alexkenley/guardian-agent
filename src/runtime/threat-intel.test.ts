import { describe, it, expect } from 'vitest';
import { ThreatIntelService } from './threat-intel.js';
import type { ForumConnector } from './forum-connector.js';

describe('ThreatIntelService', () => {
  it('manages watchlist entries with normalization', () => {
    const intel = new ThreatIntelService({
      enabled: true,
      allowDarkWeb: false,
      responseMode: 'assisted',
      watchlist: [],
      now: () => 1000,
    });

    const add = intel.addWatchTarget('  Example User  ');
    expect(add.success).toBe(true);
    expect(intel.listWatchlist()).toEqual(['example user']);

    const duplicate = intel.addWatchTarget('example user');
    expect(duplicate.success).toBe(false);
  });

  it('runs scans and creates findings', async () => {
    const intel = new ThreatIntelService({
      enabled: true,
      allowDarkWeb: true,
      responseMode: 'assisted',
      watchlist: ['target'],
      now: () => 2000,
    });

    const result = await intel.scan({ includeDarkWeb: true });
    expect(result.success).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(intel.getSummary().findings.total).toBe(result.findings.length);
  });

  it('supports status updates and action drafts', async () => {
    const intel = new ThreatIntelService({
      enabled: true,
      allowDarkWeb: false,
      responseMode: 'manual',
      watchlist: ['deepfake impersonation'],
      now: () => 3000,
    });

    const scan = await intel.scan();
    const finding = scan.findings[0];
    expect(finding).toBeDefined();

    const status = intel.updateFindingStatus(finding.id, 'triaged');
    expect(status.success).toBe(true);

    const drafted = intel.draftAction(finding.id, 'report');
    expect(drafted.success).toBe(true);
    expect(drafted.action?.requiresApproval).toBe(true);
  });

  it('blocks publish_response for hostile forum connectors without active publishing permission', async () => {
    const forumConnector: ForumConnector = {
      id: 'moltbook',
      sourceType: 'forum',
      allowsActivePublishing: () => false,
      status: () => ({ id: 'moltbook', enabled: true, hostile: true, mode: 'mock' }),
      scan: async (targets) => [
        {
          target: targets[0],
          summary: `Moltbook post about ${targets[0]} with impersonation signals.`,
          url: 'https://moltbook.com/post/1',
          severity: 'high',
          confidence: 0.8,
          labels: ['moltbook', 'hostile_site', 'impersonation'],
        },
      ],
    };

    const intel = new ThreatIntelService({
      enabled: true,
      allowDarkWeb: false,
      responseMode: 'assisted',
      watchlist: ['target-person'],
      forumConnectors: [forumConnector],
      now: () => 4000,
    });

    const scan = await intel.scan({ sources: ['forum'] });
    expect(scan.findings.length).toBe(1);
    const publishDraft = intel.draftAction(scan.findings[0].id, 'publish_response');
    expect(publishDraft.success).toBe(false);
    expect(publishDraft.message).toContain('blocked');
  });
});
