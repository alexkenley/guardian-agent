export function startCloudAuthAttempt(input) {
  const {
    popupWindow,
    pollStatus,
    cancelPendingAuth,
    onAuthenticated,
    onAbandoned,
    onError,
    maxAttempts = 60,
    pollIntervalMs = 2000,
    popupCheckIntervalMs = 500,
  } = input ?? {};

  let attempts = 0;
  let stopped = false;
  let pollTimer = null;
  let popupTimer = null;
  let inFlight = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (popupTimer) {
      clearInterval(popupTimer);
      popupTimer = null;
    }
  };

  const completeAuthenticated = async (status) => {
    if (stopped) return;
    stop();
    if (typeof onAuthenticated === 'function') {
      await onAuthenticated(status);
    }
  };

  const abandon = async (reason, status) => {
    if (stopped) return;
    stop();
    try {
      if (typeof cancelPendingAuth === 'function') {
        await cancelPendingAuth();
      }
    } catch (error) {
      if (typeof onError === 'function') {
        await onError(error);
      }
    }
    if (typeof onAbandoned === 'function') {
      await onAbandoned(reason, status);
    }
  };

  const checkStatus = async (fallbackReason) => {
    if (stopped || inFlight || typeof pollStatus !== 'function') return;
    inFlight = true;
    try {
      const status = await pollStatus();
      if (status?.authenticated) {
        await completeAuthenticated(status);
        return;
      }
      if (fallbackReason) {
        await abandon(fallbackReason, status);
      }
    } catch (error) {
      stop();
      if (typeof onError === 'function') {
        await onError(error);
      }
    } finally {
      inFlight = false;
    }
  };

  if (!popupWindow) {
    queueMicrotask(() => {
      void abandon('popup_blocked', null);
    });
    return { stop };
  }

  pollTimer = setInterval(() => {
    attempts += 1;
    if (attempts > maxAttempts) {
      void checkStatus('timed_out');
      return;
    }
    void checkStatus();
  }, pollIntervalMs);

  popupTimer = setInterval(() => {
    if (popupWindow.closed) {
      void checkStatus('popup_closed');
    }
  }, popupCheckIntervalMs);

  return { stop };
}
