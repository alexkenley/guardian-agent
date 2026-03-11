import { describe, it, expect, vi } from 'vitest';
import { listTemplates, installTemplate } from './builtin-packs.js';
import type { ConnectorPlaybookService } from './connectors.js';

function createMockConnectorService(): ConnectorPlaybookService {
  return {
    getState: vi.fn().mockReturnValue({ packs: [] }),
    updateSettings: vi.fn().mockReturnValue({ success: true, message: 'ok' }),
    upsertPack: vi.fn().mockReturnValue({ success: true, message: 'ok' }),
    upsertPlaybook: vi.fn().mockReturnValue({ success: true, message: 'ok' }),
  } as unknown as ConnectorPlaybookService;
}

describe('builtin pack templates', () => {
  it('includes the host guard template', () => {
    const service = createMockConnectorService();
    const templates = listTemplates(service);
    const template = templates.find((item) => item.id === 'agent-host-guard');
    expect(template).toBeDefined();
    expect(template?.playbookCount).toBe(2);
  });

  it('installs the host guard template playbooks', () => {
    const service = createMockConnectorService();
    const result = installTemplate('agent-host-guard', service);
    expect(result.success).toBe(true);
    expect(service.upsertPack).toHaveBeenCalledTimes(1);
    expect(service.upsertPlaybook).toHaveBeenCalledTimes(2);
  });
});
