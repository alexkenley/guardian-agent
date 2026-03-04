import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSessionManager,
  isPrivateHost,
  validateBrowserAction,
  validateBrowserUrl,
  validateElementRef,
} from './browser-session.js';

describe('BrowserSessionManager', () => {
  const managers: BrowserSessionManager[] = [];

  function createManager(overrides?: Partial<Parameters<typeof BrowserSessionManager>[0]>) {
    const mgr = new BrowserSessionManager(
      { enabled: true, ...overrides },
      () => Date.now(),
    );
    managers.push(mgr);
    return mgr;
  }

  afterEach(async () => {
    for (const mgr of managers.splice(0)) {
      await mgr.dispose();
    }
  });

  it('creates a session with UUID-based session ID', () => {
    const mgr = createManager();
    const session = mgr.getOrCreateSession('user1:cli');
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.sessionKey).toBe('user1:cli');
    expect(mgr.sessionCount).toBe(1);
  });

  it('returns existing session for same key', () => {
    const mgr = createManager();
    const s1 = mgr.getOrCreateSession('user1:cli');
    const s2 = mgr.getOrCreateSession('user1:cli');
    expect(s1.sessionId).toBe(s2.sessionId);
    expect(mgr.sessionCount).toBe(1);
  });

  it('creates separate sessions for different keys', () => {
    const mgr = createManager();
    const s1 = mgr.getOrCreateSession('user1:cli');
    const s2 = mgr.getOrCreateSession('user2:web');
    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(mgr.sessionCount).toBe(2);
  });

  it('evicts oldest session when maxSessions exceeded', () => {
    const mgr = createManager({ maxSessions: 2 });
    mgr.getOrCreateSession('a:cli');
    mgr.getOrCreateSession('b:cli');
    expect(mgr.sessionCount).toBe(2);
    mgr.getOrCreateSession('c:cli');
    // Oldest (a:cli) should be evicted
    expect(mgr.sessionCount).toBe(2);
    expect(mgr.getSession('a:cli')).toBeUndefined();
    expect(mgr.getSession('b:cli')).toBeDefined();
    expect(mgr.getSession('c:cli')).toBeDefined();
  });

  it('tracks approved domains per session', () => {
    const mgr = createManager();
    mgr.getOrCreateSession('user1:cli');
    expect(mgr.isDomainApproved('user1:cli', 'example.com')).toBe(false);
    mgr.approveDomain('user1:cli', 'example.com');
    expect(mgr.isDomainApproved('user1:cli', 'example.com')).toBe(true);
    expect(mgr.isDomainApproved('user1:cli', 'Example.COM')).toBe(true);
    expect(mgr.isDomainApproved('user1:cli', 'other.com')).toBe(false);
  });

  it('clears sessions on dispose', async () => {
    const mgr = createManager();
    mgr.getOrCreateSession('user1:cli');
    mgr.getOrCreateSession('user2:web');
    expect(mgr.sessionCount).toBe(2);
    await mgr.dispose();
    expect(mgr.sessionCount).toBe(0);
  });

  it('closeSession removes specific session', async () => {
    const mgr = createManager();
    mgr.getOrCreateSession('user1:cli');
    mgr.getOrCreateSession('user2:web');
    await mgr.closeSession('user1:cli');
    expect(mgr.sessionCount).toBe(1);
    expect(mgr.getSession('user1:cli')).toBeUndefined();
    expect(mgr.getSession('user2:web')).toBeDefined();
  });

  it('checkInstalled throws helpful error when binary not found', async () => {
    const mgr = createManager({ binaryPath: 'nonexistent-browser-tool-xyz' });
    await expect(mgr.checkInstalled()).rejects.toThrow('agent-browser binary not found');
    await expect(mgr.checkInstalled()).rejects.toThrow('npm install agent-browser');
  });

  it('idle cleanup removes stale sessions', async () => {
    let now = 1000;
    const mgr = new BrowserSessionManager(
      { enabled: true, sessionIdleTimeoutMs: 100 },
      () => now,
    );
    managers.push(mgr);

    mgr.getOrCreateSession('user1:cli');
    expect(mgr.sessionCount).toBe(1);

    // Advance time past idle threshold
    now = 2000;
    // Trigger cleanup manually (normally runs on interval)
    // Access private method via any cast for testing
    (mgr as any).cleanupIdleSessions();
    expect(mgr.sessionCount).toBe(0);
  });
});

describe('validateBrowserUrl', () => {
  it('accepts valid HTTP URLs', () => {
    const url = validateBrowserUrl('https://example.com');
    expect(url.hostname).toBe('example.com');
  });

  it('accepts HTTP protocol', () => {
    const url = validateBrowserUrl('http://example.com/page');
    expect(url.protocol).toBe('http:');
  });

  it('rejects non-HTTP protocols', () => {
    expect(() => validateBrowserUrl('ftp://example.com')).toThrow('Only HTTP/HTTPS');
    expect(() => validateBrowserUrl('file:///etc/passwd')).toThrow('Only HTTP/HTTPS');
    expect(() => validateBrowserUrl('javascript:alert(1)')).toThrow('Only HTTP/HTTPS');
  });

  it('rejects invalid URLs', () => {
    expect(() => validateBrowserUrl('not-a-url')).toThrow('Invalid URL');
    expect(() => validateBrowserUrl('')).toThrow('Invalid URL');
  });
});

describe('validateElementRef', () => {
  it('accepts valid refs', () => {
    expect(validateElementRef('@e1')).toBe('@e1');
    expect(validateElementRef('@btn_submit')).toBe('@btn_submit');
    expect(validateElementRef('@nav-link')).toBe('@nav-link');
    expect(validateElementRef('@A123')).toBe('@A123');
  });

  it('rejects invalid refs', () => {
    expect(() => validateElementRef('e1')).toThrow('Invalid element reference');
    expect(() => validateElementRef('@')).toThrow('Invalid element reference');
    expect(() => validateElementRef('@e1 ; rm -rf')).toThrow('Invalid element reference');
    expect(() => validateElementRef('@e1$(command)')).toThrow('Invalid element reference');
    expect(() => validateElementRef('')).toThrow('Invalid element reference');
    expect(() => validateElementRef('@ spaces')).toThrow('Invalid element reference');
  });
});

describe('validateBrowserAction', () => {
  it('accepts valid actions', () => {
    expect(validateBrowserAction('click')).toBe('click');
    expect(validateBrowserAction('fill')).toBe('fill');
    expect(validateBrowserAction('select')).toBe('select');
    expect(validateBrowserAction('press')).toBe('press');
    expect(validateBrowserAction('scroll')).toBe('scroll');
    expect(validateBrowserAction('hover')).toBe('hover');
  });

  it('normalizes case', () => {
    expect(validateBrowserAction('CLICK')).toBe('click');
    expect(validateBrowserAction('Fill')).toBe('fill');
  });

  it('rejects invalid actions', () => {
    expect(() => validateBrowserAction('delete')).toThrow('Invalid browser action');
    expect(() => validateBrowserAction('execute')).toThrow('Invalid browser action');
    expect(() => validateBrowserAction('')).toThrow('Invalid browser action');
  });
});

describe('isPrivateHost', () => {
  it('blocks localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.0.0.2')).toBe(true);
  });

  it('blocks private IPv4 ranges', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('169.254.1.1')).toBe(true);
  });

  it('blocks IPv6 private', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
  });

  it('allows public hosts', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
  });
});
