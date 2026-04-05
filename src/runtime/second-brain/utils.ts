export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags ?? []) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

export function taskPriorityOrder(priority: 'high' | 'medium' | 'low'): number {
  switch (priority) {
    case 'high':
      return 0;
    case 'medium':
      return 1;
    default:
      return 2;
  }
}
