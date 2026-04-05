export function normalizeRunTimelineContextAssembly(value) {
  if (!value || typeof value !== 'object') return null;
  const selectedMemoryEntries = Array.isArray(value.selectedMemoryEntries)
    ? value.selectedMemoryEntries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const category = typeof entry.category === 'string' ? entry.category.trim() : '';
        const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt.trim() : '';
        const preview = typeof entry.preview === 'string' ? entry.preview.trim() : '';
        const scope = entry.scope === 'global' || entry.scope === 'coding_session' ? entry.scope : '';
        const renderMode = entry.renderMode === 'full' || entry.renderMode === 'summary'
          ? entry.renderMode
          : null;
        const queryScore = Number.isFinite(entry.queryScore) ? Number(entry.queryScore) : 0;
        if (!category || !createdAt || !preview || !renderMode) return null;
        return {
          scope,
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
    codingMemoryLoaded: typeof value.codingMemoryLoaded === 'boolean' ? value.codingMemoryLoaded : null,
    codingMemoryChars: Number.isFinite(value.codingMemoryChars) ? Number(value.codingMemoryChars) : 0,
    knowledgeBaseQueryPreview: typeof value.knowledgeBaseQueryPreview === 'string' ? value.knowledgeBaseQueryPreview.trim() : '',
    continuityKey: typeof value.continuityKey === 'string' ? value.continuityKey.trim() : '',
    linkedSurfaceCount: Number.isFinite(value.linkedSurfaceCount) ? Number(value.linkedSurfaceCount) : 0,
    skillInstructionSkillIds: Array.isArray(value.skillInstructionSkillIds)
      ? value.skillInstructionSkillIds.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 4)
      : [],
    skillResourceSkillIds: Array.isArray(value.skillResourceSkillIds)
      ? value.skillResourceSkillIds.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 4)
      : [],
    skillResourcePaths: Array.isArray(value.skillResourcePaths)
      ? value.skillResourcePaths.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 4)
      : [],
    skillPromptCacheHitCount: Number.isFinite(value.skillPromptCacheHitCount) ? Number(value.skillPromptCacheHitCount) : 0,
    skillPromptCacheHits: Array.isArray(value.skillPromptCacheHits)
      ? value.skillPromptCacheHits.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 6)
      : [],
    skillPromptLoadReasons: Array.isArray(value.skillPromptLoadReasons)
      ? value.skillPromptLoadReasons.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 3)
      : [],
    skillArtifactReferences: Array.isArray(value.skillArtifactReferences)
      ? value.skillArtifactReferences
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const skillId = typeof entry.skillId === 'string' ? entry.skillId.trim() : '';
          const scope = entry.scope === 'global' || entry.scope === 'coding_session' ? entry.scope : '';
          const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
          const title = typeof entry.title === 'string' ? entry.title.trim() : '';
          const sourceClass = typeof entry.sourceClass === 'string' ? entry.sourceClass.trim() : '';
          if (!skillId || !scope || !slug || !title || !sourceClass) return null;
          return { skillId, scope, slug, title, sourceClass };
        })
        .filter(Boolean)
        .slice(0, 3)
      : [],
    contextCompactionApplied: value.contextCompactionApplied === true,
    contextCharsBeforeCompaction: Number.isFinite(value.contextCharsBeforeCompaction)
      ? Number(value.contextCharsBeforeCompaction)
      : 0,
    contextCharsAfterCompaction: Number.isFinite(value.contextCharsAfterCompaction)
      ? Number(value.contextCharsAfterCompaction)
      : 0,
    contextCompactionStages: Array.isArray(value.contextCompactionStages)
      ? value.contextCompactionStages.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 3)
      : [],
    compactedSummaryPreview: typeof value.compactedSummaryPreview === 'string' ? value.compactedSummaryPreview.trim() : '',
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
    || contextAssembly.skillInstructionSkillIds.length > 0
    || contextAssembly.skillResourcePaths.length > 0
    || contextAssembly.skillArtifactReferences.length > 0
    || contextAssembly.contextCompactionApplied
    || contextAssembly.linkedSurfaceCount > 0
    || contextAssembly.selectedMemoryEntries.length > 0
    || typeof contextAssembly.knowledgeBaseLoaded === 'boolean'
    || typeof contextAssembly.codingMemoryLoaded === 'boolean'
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
  if (context.codingMemoryLoaded === true) pills.push('coding memory loaded');
  if (context.codingMemoryLoaded === false) pills.push('coding memory empty');
  if (context.codingMemoryLoaded === true && context.codingMemoryChars > 0) pills.push(`${context.codingMemoryChars} coding chars`);
  if (context.skillInstructionSkillIds.length > 0) pills.push(`${context.skillInstructionSkillIds.length} skill L2`);
  if (context.skillResourcePaths.length > 0) pills.push(`${context.skillResourcePaths.length} skill L3`);
  if (context.skillArtifactReferences.length > 0) pills.push(`${context.skillArtifactReferences.length} skill artifact${context.skillArtifactReferences.length === 1 ? '' : 's'}`);
  if (context.skillPromptCacheHitCount > 0) pills.push(`${context.skillPromptCacheHitCount} skill cache hit${context.skillPromptCacheHitCount === 1 ? '' : 's'}`);
  if (context.contextCompactionApplied) pills.push('context compacted');
  if (context.contextCompactionApplied && context.contextCharsBeforeCompaction > 0 && context.contextCharsAfterCompaction > 0) {
    pills.push(`${context.contextCharsBeforeCompaction} -> ${context.contextCharsAfterCompaction} chars`);
  }
  if (context.linkedSurfaceCount > 0) pills.push(`${context.linkedSurfaceCount} linked surface${context.linkedSurfaceCount === 1 ? '' : 's'}`);
  if (context.omittedMemoryEntryCount > 0) pills.push(`${context.omittedMemoryEntryCount} omitted`);

  return `
    <div style="margin-top:0.45rem;padding:0.5rem 0.6rem;border:1px solid var(--border);border-radius:0;background:rgba(255,255,255,0.03)">
      <div class="ops-task-sub" style="margin-bottom:0.3rem">Context Assembly</div>
      ${pills.length > 0
        ? `<div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:${context.knowledgeBaseQueryPreview || context.selectedMemoryEntries.length > 0 ? '0.4rem' : '0'}">
            ${pills.map((pill) => `<span style="display:inline-flex;align-items:center;padding:0.12rem 0.42rem;border:1px solid var(--border);border-radius:0;font-size:0.75rem;color:var(--text-secondary)">${esc(pill)}</span>`).join('')}
          </div>`
        : ''}
      ${context.knowledgeBaseQueryPreview
        ? `<div style="color:var(--text-secondary);margin-top:0.2rem"><strong>Query:</strong> ${esc(context.knowledgeBaseQueryPreview)}</div>`
        : ''}
      ${context.skillInstructionSkillIds.length > 0
        ? `<div style="color:var(--text-secondary);margin-top:0.2rem"><strong>Skill instructions:</strong> ${esc(context.skillInstructionSkillIds.join(' | '))}</div>`
        : ''}
      ${context.skillResourcePaths.length > 0
        ? `<div style="color:var(--text-secondary);margin-top:0.2rem"><strong>Skill resources:</strong> ${esc(context.skillResourcePaths.join(' | '))}</div>`
        : ''}
      ${context.skillPromptLoadReasons.length > 0
        ? `<div style="color:var(--text-secondary);margin-top:0.2rem"><strong>Skill loading:</strong> ${esc(context.skillPromptLoadReasons.join(' | '))}</div>`
        : ''}
      ${context.compactedSummaryPreview
        ? `<div style="color:var(--text-secondary);margin-top:0.2rem"><strong>Compaction:</strong> ${esc(context.compactedSummaryPreview)}</div>`
        : ''}
      ${Array.isArray(context.contextCompactionStages) && context.contextCompactionStages.length > 0
        ? `<div class="ops-task-sub" style="margin-top:0.2rem">Stages: ${esc(context.contextCompactionStages.join(' | '))}</div>`
        : ''}
      ${Array.isArray(context.selectedMemoryEntries) && context.selectedMemoryEntries.length > 0
        ? `<div style="margin-top:0.45rem;display:flex;flex-direction:column;gap:0.32rem">
            ${context.selectedMemoryEntries.map((entry) => `
              <div style="padding:0.35rem 0.45rem;border:1px solid var(--border);border-radius:0;background:var(--bg-secondary)">
                <div style="display:flex;gap:0.4rem;justify-content:space-between;align-items:center;flex-wrap:wrap">
                  <strong>${esc(entry.category)}</strong>
                  <span class="ops-task-sub">${esc(`${entry.scope === 'coding_session' ? 'coding' : 'global'} | ${entry.renderMode}${entry.isContextFlush ? ' | context flush' : ''}`)}</span>
                </div>
                <div style="margin-top:0.2rem;color:var(--text-secondary)">${esc(entry.preview)}</div>
                ${Array.isArray(entry.matchReasons) && entry.matchReasons.length > 0
                  ? `<div class="ops-task-sub" style="margin-top:0.2rem">Matched: ${esc(entry.matchReasons.join(' | '))}</div>`
                  : ''}
              </div>
            `).join('')}
          </div>`
        : ''}
      ${Array.isArray(context.skillArtifactReferences) && context.skillArtifactReferences.length > 0
        ? `<div style="margin-top:0.45rem;display:flex;flex-direction:column;gap:0.32rem">
            ${context.skillArtifactReferences.map((entry) => `
              <div style="padding:0.35rem 0.45rem;border:1px solid var(--border);border-radius:0;background:var(--bg-secondary)">
                <div style="display:flex;gap:0.4rem;justify-content:space-between;align-items:center;flex-wrap:wrap">
                  <strong>${esc(entry.title)}</strong>
                  <span class="ops-task-sub">${esc(`${entry.skillId} | ${entry.scope === 'coding_session' ? 'coding' : 'global'} | ${entry.sourceClass}`)}</span>
                </div>
                <div class="ops-task-sub" style="margin-top:0.2rem">${esc(entry.slug)}</div>
              </div>
            `).join('')}
          </div>`
        : ''}
    </div>
  `;
}
