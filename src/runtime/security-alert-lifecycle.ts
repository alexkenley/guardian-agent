export type SecurityAlertStatus = 'active' | 'acknowledged' | 'resolved' | 'suppressed';

export interface SecurityAlertLifecycle {
  acknowledged: boolean;
  status: SecurityAlertStatus;
  lastStateChangedAt: number;
  suppressedUntil?: number;
  suppressionReason?: string;
  resolvedAt?: number;
  resolutionReason?: string;
}

export interface SecurityAlertListOptions {
  includeAcknowledged?: boolean;
  includeInactive?: boolean;
  limit?: number;
}

export interface SecurityAlertStateResult {
  success: boolean;
  message: string;
}

type AlertWithLifecycle = {
  lastSeenAt: number;
} & Partial<SecurityAlertLifecycle>;

export function isSecurityAlertStatus(value: string): value is SecurityAlertStatus {
  return value === 'active'
    || value === 'acknowledged'
    || value === 'resolved'
    || value === 'suppressed';
}

export function ensureSecurityAlertLifecycle<T extends AlertWithLifecycle>(alert: T): T & SecurityAlertLifecycle {
  const status: SecurityAlertStatus = isSecurityAlertStatus(String(alert.status ?? ''))
    ? String(alert.status) as SecurityAlertStatus
    : alert.acknowledged
      ? 'acknowledged'
      : 'active';
  const lifecycle = {
    acknowledged: status === 'acknowledged',
    status,
    lastStateChangedAt: Number.isFinite(alert.lastStateChangedAt) ? Number(alert.lastStateChangedAt) : alert.lastSeenAt,
    suppressedUntil: typeof alert.suppressedUntil === 'number' ? alert.suppressedUntil : undefined,
    suppressionReason: typeof alert.suppressionReason === 'string' && alert.suppressionReason.trim()
      ? alert.suppressionReason.trim()
      : undefined,
    resolvedAt: typeof alert.resolvedAt === 'number' ? alert.resolvedAt : undefined,
    resolutionReason: typeof alert.resolutionReason === 'string' && alert.resolutionReason.trim()
      ? alert.resolutionReason.trim()
      : undefined,
  } satisfies SecurityAlertLifecycle;
  return Object.assign(alert, lifecycle);
}

export function isSecurityAlertSuppressed<T extends AlertWithLifecycle>(alert: T, now: number): boolean {
  const normalized = ensureSecurityAlertLifecycle(alert);
  return normalized.status === 'suppressed'
    && typeof normalized.suppressedUntil === 'number'
    && normalized.suppressedUntil > now;
}

export function maybeExpireSecurityAlertSuppression<T extends AlertWithLifecycle>(alert: T, now: number): boolean {
  const normalized = ensureSecurityAlertLifecycle(alert);
  if (normalized.status !== 'suppressed') return false;
  if (typeof normalized.suppressedUntil === 'number' && normalized.suppressedUntil > now) return false;
  reactivateSecurityAlert(alert, now);
  return true;
}

export function isSecurityAlertVisible<T extends AlertWithLifecycle>(alert: T, now: number, opts?: SecurityAlertListOptions): boolean {
  const normalized = ensureSecurityAlertLifecycle(alert);
  if (normalized.status === 'suppressed' && typeof normalized.suppressedUntil === 'number' && normalized.suppressedUntil <= now) {
    reactivateSecurityAlert(alert, now);
  }

  if (opts?.includeInactive) return true;
  if (normalized.status === 'active') return true;
  if (normalized.status === 'acknowledged') return !!opts?.includeAcknowledged;
  return false;
}

export function acknowledgeSecurityAlert<T extends AlertWithLifecycle>(alert: T, now: number): void {
  const normalized = ensureSecurityAlertLifecycle(alert);
  normalized.acknowledged = true;
  normalized.status = 'acknowledged';
  normalized.lastStateChangedAt = now;
}

export function resolveSecurityAlert<T extends AlertWithLifecycle>(alert: T, now: number, reason?: string): void {
  const normalized = ensureSecurityAlertLifecycle(alert);
  normalized.acknowledged = false;
  normalized.status = 'resolved';
  normalized.lastStateChangedAt = now;
  normalized.resolvedAt = now;
  normalized.resolutionReason = reason?.trim() || undefined;
  normalized.suppressedUntil = undefined;
  normalized.suppressionReason = undefined;
}

export function suppressSecurityAlert<T extends AlertWithLifecycle>(alert: T, now: number, until: number, reason?: string): void {
  const normalized = ensureSecurityAlertLifecycle(alert);
  normalized.acknowledged = false;
  normalized.status = 'suppressed';
  normalized.lastStateChangedAt = now;
  normalized.suppressedUntil = until;
  normalized.suppressionReason = reason?.trim() || undefined;
  normalized.resolvedAt = undefined;
  normalized.resolutionReason = undefined;
}

export function reactivateSecurityAlert<T extends AlertWithLifecycle>(alert: T, now: number): void {
  const normalized = ensureSecurityAlertLifecycle(alert);
  normalized.acknowledged = false;
  normalized.status = 'active';
  normalized.lastStateChangedAt = now;
  normalized.suppressedUntil = undefined;
  normalized.suppressionReason = undefined;
  normalized.resolvedAt = undefined;
  normalized.resolutionReason = undefined;
}

export function listSecurityAlerts<T extends AlertWithLifecycle>(
  alerts: Iterable<T>,
  now: number,
  opts?: SecurityAlertListOptions,
): T[] {
  const limit = Math.max(1, opts?.limit ?? 100);
  return [...alerts]
    .map((alert) => {
      maybeExpireSecurityAlertSuppression(alert, now);
      return ensureSecurityAlertLifecycle(alert);
    })
    .filter((alert) => isSecurityAlertVisible(alert, now, opts))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, limit);
}
