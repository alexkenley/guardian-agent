import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class StorageMock {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

function makeJsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('dashboard api client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    const eventTarget = new EventTarget();
    vi.stubGlobal('window', eventTarget);
    vi.stubGlobal('sessionStorage', new StorageMock());
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a privileged ticket when updating tool policy', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse(200, { ticket: 'ticket-tools' }) as Response)
      .mockResolvedValueOnce(makeJsonResponse(200, { success: true }) as Response);

    const { api, setToken } = await import('../web/public/js/api.js');
    setToken('dashboard-token');

    const result = await api.updateToolPolicy({ sandbox: { allowedDomains: ['example.com'] } });

    expect(result).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [ticketPath, ticketOptions] = fetchMock.mock.calls[0];
    expect(ticketPath).toBe('/api/auth/ticket');
    expect(ticketOptions).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(ticketOptions?.body))).toMatchObject({ action: 'tools.policy' });

    const [policyPath, policyOptions] = fetchMock.mock.calls[1];
    expect(policyPath).toBe('/api/tools/policy');
    expect(policyOptions).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(policyOptions?.body))).toMatchObject({
      sandbox: { allowedDomains: ['example.com'] },
      ticket: 'ticket-tools',
    });
  });

  it('retries one auth-failed request after auth recovery', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse(200, { ticket: 'ticket-tools' }) as Response)
      .mockResolvedValueOnce(makeJsonResponse(401, { error: 'Authentication required' }) as Response)
      .mockResolvedValueOnce(makeJsonResponse(200, { success: true }) as Response);

    const { api, setToken, AUTH_FAILED_EVENT, AUTH_RECOVERED_EVENT } = await import('../web/public/js/api.js');
    setToken('dashboard-token');

    let authFailures = 0;
    window.addEventListener(AUTH_FAILED_EVENT, () => {
      authFailures += 1;
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent(AUTH_RECOVERED_EVENT));
      }, 0);
    });

    const result = await api.updateToolPolicy({ sandbox: { allowedDomains: ['example.com'] } });

    expect(result).toMatchObject({ success: true });
    expect(authFailures).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/tools/policy');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/tools/policy');
  });

  it('uses privileged tickets for other privileged config mutations', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse(200, { ticket: 'ticket-policy' }) as Response)
      .mockResolvedValueOnce(makeJsonResponse(200, { success: true }) as Response)
      .mockResolvedValueOnce(makeJsonResponse(200, { ticket: 'ticket-guardian' }) as Response)
      .mockResolvedValueOnce(makeJsonResponse(200, { success: true }) as Response);

    const { api, setToken } = await import('../web/public/js/api.js');
    setToken('dashboard-token');

    await api.updatePolicy({ enabled: true });
    await api.updateGuardianAgent({ enabled: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/ticket');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: 'policy.config' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/policy/config');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ enabled: true, ticket: 'ticket-policy' });

    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/auth/ticket');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ action: 'guardian.config' });
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/guardian-agent/config');
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({ enabled: true, ticket: 'ticket-guardian' });
  });
});
