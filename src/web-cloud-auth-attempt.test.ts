import { describe, expect, it, vi, afterEach } from 'vitest';

import { startCloudAuthAttempt } from '../web/public/js/cloud-auth-attempt.js';

describe('cloud auth attempt helper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels and reports an abandoned attempt when the popup is blocked', async () => {
    const cancelPendingAuth = vi.fn(async () => {});
    const onAbandoned = vi.fn(async () => {});

    startCloudAuthAttempt({
      popupWindow: null,
      cancelPendingAuth,
      onAbandoned,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(cancelPendingAuth).toHaveBeenCalledOnce();
    expect(onAbandoned).toHaveBeenCalledWith('popup_blocked', null);
  });

  it('resets the attempt when the popup closes before authentication completes', async () => {
    vi.useFakeTimers();
    const popupWindow = { closed: false };
    const pollStatus = vi.fn(async () => ({ authenticated: false }));
    const cancelPendingAuth = vi.fn(async () => {});
    const onAbandoned = vi.fn(async () => {});

    startCloudAuthAttempt({
      popupWindow,
      pollStatus,
      cancelPendingAuth,
      onAbandoned,
      popupCheckIntervalMs: 250,
      pollIntervalMs: 10_000,
    });

    popupWindow.closed = true;
    await vi.advanceTimersByTimeAsync(250);

    expect(cancelPendingAuth).toHaveBeenCalledOnce();
    expect(onAbandoned).toHaveBeenCalledWith('popup_closed', { authenticated: false });
  });

  it('completes successfully when polling sees an authenticated status', async () => {
    vi.useFakeTimers();
    const popupWindow = { closed: false };
    const pollStatus = vi.fn(async () => ({ authenticated: true, tokenExpiry: 123 }));
    const cancelPendingAuth = vi.fn(async () => {});
    const onAuthenticated = vi.fn(async () => {});
    const onAbandoned = vi.fn(async () => {});

    startCloudAuthAttempt({
      popupWindow,
      pollStatus,
      cancelPendingAuth,
      onAuthenticated,
      onAbandoned,
      pollIntervalMs: 250,
      popupCheckIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(onAuthenticated).toHaveBeenCalledWith({ authenticated: true, tokenExpiry: 123 });
    expect(cancelPendingAuth).not.toHaveBeenCalled();
    expect(onAbandoned).not.toHaveBeenCalled();
  });
});
