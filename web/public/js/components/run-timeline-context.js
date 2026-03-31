export function normalizeRunTimelineContextAssembly(value) {
  if (!value || typeof value !== 'object') return null;
  const selectedMemoryEntries = Array.isArray(value.selectedMemoryEntries)
    ? value.selectedMemoryEntries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const category = typeof entry.category === 'string' ? entry.category.trim() : '';
        const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt.trim() : '';
        const preview = typeof entry.preview === 'string' ? entry.preview.trim() : '';
        const renderMode = entry.renderMode === 'full' || entry.renderMode === 'summary'
          ? entry.renderMode
          : null;
        const queryScore = Number.isFinite(entry.queryScore) ? Number(entry.queryScore) : 0;
        if (!category || !createdAt || !preview || !renderMode) return null;
        return {
          category,
          createdAt,
          preview,
          renderMode,
          queryScore,
          isContextFlush: entry.isContextFlush === true,
          matchReasons: Array.isArray(entry.matchReasons)
            ? entry.matchReasons.filter((value) => typeof value === 'string' && value.trim()).slice(0, 3)
            : [],
        };
      })
      .filter(Boolean)
    : [];
  const contextAssembly = {
    summary: typeof value.summary === 'string' ? value.summary.trim() : '',
    detail: typeof value.detail === 'string' ? value.detail.trim() : '',
    memoryScope: value.memoryScope === 'global' || value.memoryScope === 'coding_session' || value.memoryScope === 'none'
      ? value.memoryScope
      : '',
    knowledgeBaseLoaded: typeof value.knowledgeBaseLoaded === 'boolean' ? value.knowledgeBaseLoaded : null,
    knowledgeBaseQueryPreview: typeof value.knowledgeBaseQueryPreview === 'string' ? value.knowledgeBaseQueryPreview.trim() : '',
    continuityKey: typeof value.continuityKey === 'string' ? value.continuityKey.trim() : '',
    linkedSurfaceCount: Number.isFinite(value.linkedSurfaceCount) ? Number(value.linkedSurfaceCount) : 0,
    selectedMemoryEntryCount: Number.isFinite(value.selectedMemoryEntryCount)
      ? Number(value.selectedMemoryEntryCount)
      : selectedMemoryEntries.length,
    omittedMemoryEntryCount: Number.isFinite(value.omittedMemoryEntryCount) ? Number(value.omittedMemoryEntryCount) : 0,
    selectedMemoryEntries,
  };
  return contextAssembly.summary
    || contextAssembly.detail
    || contextAssembly.memoryScope
    || contextAssembly.knowledgeBaseQueryPreview
    || contextAssembly.continuityKey
    || contextAssembly.linkedSurfaceCount > 0
    || contextAssembly.selectedMemoryEntries.length > 0
    || typeof contextAssembly.knowledgeBaseLoaded === 'boolean'
    ? contextAssembly
    : null;
}

function formatMemoryScopeLabel(scope) {
  if (scope === 'coding_session') return 'Coding memory';
  if (scope === 'global') return 'Global memory';
  if (scope === 'none') return 'No memory';
  return 'Memory';
}

export function renderRunTimelineContextAssembly(contextAssembly, esc) {
  const context = normalizeRunTimelineContextAssembly(contextAssembly);
  if (!context || typeof esc !== 'function') return '';
  const pills = [];
  if (context.memoryScope) pills.push(formatMemoryScopeLabel(context.memoryScope));
  if (context.knowledgeBaseLoaded === true) pills.push('memory loaded');
  if (context.knowledgeBaseLoaded === false) pills.push('memory empty');
  if (context.linkedSurfaceCount > 0) pills.push(`${context.linkedSurfaceCount} linked surface${context.linkedSurfaceCount === 1 ? '' : 's'}`);
  if (context.omittedMemoryEntryCount > 0) pills.push(`${context.omittedMemoryEntryCount} omitted`);

  return `
    <div style="margin-top:0.45rem;padding:0.5rem 0.6rem;border:1px solid var(--border);border-radius:var(--radius);background:rgba(255,255,255,0.03)">
      <div class="ops-task-sub" style="margin-bottom:0.3rem">Context Assembly</div>
      ${pills.length > 0
        ? `<div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:${context.knowledgeBaseQueryPreview || context.selectedMemoryEntries.length > 0 ? '0.4rem' : '0'}">
            ${pills.map((pill) => `<span style="display:inline-flex;align-items:center;padding:0.12rem 0.42rem;border:1px solid var(--border);border-radius:999px;font-size:0.75rem;color:var(--text-secondary)">${esc(pill)}</span>`).join('')}
          </div>`
        : ''}
      ${context.knowledgeBaseQueryPreview
        ? `<div style="color:var(--text-secondary);margin-top:0.2rem"><strong>Query:</strong> ${esc(context.knowledgeBaseQueryPreview)}</div>`
        : ''}
      ${Array.isArray(context.selectedMemoryEntries) && context.selectedMemoryEntries.length > 0
        ? `<div style="margin-top:0.45rem;display:flex;flex-direction:column;gap:0.32rem">
            ${context.selectedMemoryEntries.map((entry) => `
              <div style="padding:0.35rem 0.45rem;border:1px solid var(--border);border-radius:var(--radius-sm, 8px);background:var(--bg-secondary)">
                <div style="display:flex;gap:0.4rem;justify-content:space-between;align-items:center;flex-wrap:wrap">
                  <strong>${esc(entry.category)}</strong>
                  <span class="ops-task-sub">${esc(`${entry.renderMode}${entry.isContextFlush ? ' | context flush' : ''}`)}</span>
                </div>
                <div style="margin-top:0.2rem;color:var(--text-secondary)">${esc(entry.preview)}</div>
                ${Array.isArray(entry.matchReasons) && entry.matchReasons.length > 0
                  ? `<div class="ops-task-sub" style="margin-top:0.2rem">Matched: ${esc(entry.matchReasons.join(' | '))}</div>`
                  : ''}
              </div>
            `).join('')}
          </div>`
        : ''}
    </div>
  `;
}
