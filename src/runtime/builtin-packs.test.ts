import { describe, it, expect, vi } from 'vitest';
import {
  listBuiltinAutomationExamples,
  materializeBuiltinAutomationExample,
} from './builtin-packs.js';
import type { ConnectorPlaybookService } from './connectors.js';

function createMockConnectorService(): ConnectorPlaybookService {
  return {
    getState: vi.fn().mockReturnValue({ packs: [] }),
    updateSettings: vi.fn().mockReturnValue({ success: true, message: 'ok' }),
    upsertPack: vi.fn().mockReturnValue({ success: true, message: 'ok' }),
    upsertPlaybook: vi.fn().mockReturnValue({ success: true, message: 'ok' }),
  } as unknown as ConnectorPlaybookService;
}

describe('builtin automation examples', () => {
  it('includes the host guard starter example', () => {
    const service = createMockConnectorService();
    const templates = listBuiltinAutomationExamples(service);
    const template = templates.find((item) => item.id === 'agent-host-guard');
    expect(template).toBeDefined();
    expect(template?.automationCount).toBe(2);
  });

  it('materializes the host guard starter example workflows', () => {
    const service = createMockConnectorService();
    const result = materializeBuiltinAutomationExample('agent-host-guard', service);
    expect(result.success).toBe(true);
    expect(service.upsertPack).toHaveBeenCalledTimes(1);
    expect(service.upsertPlaybook).toHaveBeenCalledTimes(2);
    expect(service.upsertPlaybook).toHaveBeenCalledWith(expect.objectContaining({
      id: 'host-security-baseline',
      steps: expect.arrayContaining([
        expect.objectContaining({ toolName: 'security_alert_search' }),
        expect.objectContaining({ toolName: 'security_posture_status' }),
      ]),
    }));
  });

  it('includes and materializes the firewall sentry starter example', () => {
    const service = createMockConnectorService();
    const templates = listBuiltinAutomationExamples(service);
    const template = templates.find((item) => item.id === 'firewall-sentry');
    expect(template).toBeDefined();
    expect(template?.automationCount).toBe(2);

    const result = materializeBuiltinAutomationExample('firewall-sentry', service);
    expect(result.success).toBe(true);
    expect(service.upsertPack).toHaveBeenCalledTimes(1);
    expect(service.upsertPlaybook).toHaveBeenCalledTimes(2);
    expect(service.upsertPlaybook).toHaveBeenCalledWith(expect.objectContaining({
      id: 'firewall-posture-watch',
      steps: expect.arrayContaining([
        expect.objectContaining({ toolName: 'security_alert_search' }),
        expect.objectContaining({ toolName: 'security_posture_status' }),
      ]),
    }));
  });
});
