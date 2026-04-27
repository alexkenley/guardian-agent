import { describe, expect, it } from 'vitest';
import {
  getMemoryMutationToolClass,
  getMemoryMutationIntentDeniedMessage,
  parseDirectMemoryReadRequest,
  isDirectMemorySaveRequest,
  isDirectMemoryMutationToolName,
  isElevatedMemoryMutationToolName,
  isMemoryMutationToolName,
  parseDirectMemorySaveRequest,
  resolveAffirmativeMemoryContinuationFromHistory,
  shouldAllowModelMemoryMutation,
} from './memory-intent.js';

describe('memory intent helpers', () => {
  it('detects explicit remember/save requests', () => {
    expect(shouldAllowModelMemoryMutation('Please remember that I prefer concise updates.')).toBe(true);
    expect(shouldAllowModelMemoryMutation('Save this preference for later.')).toBe(true);
    expect(isDirectMemorySaveRequest('Remember globally that my test marker is cedar-47.')).toBe(true);
    expect(isDirectMemorySaveRequest('Save this to memory for later.')).toBe(true);
    expect(isDirectMemorySaveRequest('Can you remember things?')).toBe(false);
    expect(shouldAllowModelMemoryMutation('Search my memory for prior notes.')).toBe(false);
  });

  it('resolves affirmative replies back to the prior explicit memory request', () => {
    expect(resolveAffirmativeMemoryContinuationFromHistory('Yes', [
      { role: 'user', content: 'Remember globally that my test marker is global-memory-marker-cedar-47.' },
      { role: 'assistant', content: 'Would you like me to store that in global memory?' },
    ])).toBe('Remember globally that my test marker is global-memory-marker-cedar-47.');

    expect(resolveAffirmativeMemoryContinuationFromHistory('Yes', [
      { role: 'user', content: 'Check my inbox.' },
      { role: 'assistant', content: 'Would you like me to proceed?' },
    ])).toBeNull();
  });

  it('parses direct memory-save requests into scope and content', () => {
    expect(parseDirectMemorySaveRequest('Remember globally that my test marker is cedar-47.')).toEqual({
      scope: 'global',
      content: 'my test marker is cedar-47.',
    });

    expect(parseDirectMemorySaveRequest('For this coding session only, remember code-session-marker-onyx-91. Save it to code-session memory, not global.')).toEqual({
      scope: 'code_session',
      content: 'code-session-marker-onyx-91',
    });

    expect(parseDirectMemorySaveRequest('For this coding session only, remember code-session-marker-rivet-22. Save it to code-session     memory, not global.')).toEqual({
      scope: 'code_session',
      content: 'code-session-marker-rivet-22',
    });

    expect(parseDirectMemorySaveRequest('Remember this exact manual test marker: SMOKE-MEM-42801. Reply only with: stored')).toEqual({
      scope: 'global',
      content: 'this exact manual test marker: SMOKE-MEM-42801',
    });

    expect(parseDirectMemorySaveRequest('Save this to memory for later.')).toBeNull();
  });

  it('parses direct memory read/search requests into scope and query intent', () => {
    expect(parseDirectMemoryReadRequest('What do you remember about global-memory-marker-maple-58?')).toEqual({
      mode: 'search',
      query: 'global-memory-marker-maple-58',
      separateScopes: false,
      labelSources: false,
    });

    expect(parseDirectMemoryReadRequest('Recall global memory and code-session memory separately for global-memory-marker-maple-58 and code-session-marker-onyx-91.')).toEqual({
      mode: 'search',
      query: 'global-memory-marker-maple-58 and code-session-marker-onyx-91',
      scope: 'both',
      separateScopes: true,
      labelSources: false,
    });

    expect(parseDirectMemoryReadRequest('Search persistent memory across both scopes for global-memory-marker-maple-58 and code-session-marker-onyx-91, and label which scope each result came from.')).toEqual({
      mode: 'search',
      query: 'global-memory-marker-maple-58 and code-session-marker-onyx-91',
      scope: 'both',
      separateScopes: false,
      labelSources: true,
    });

    expect(parseDirectMemoryReadRequest('Search memory for UI-MEM-91827 and reply with only the marker if you find it.')).toEqual({
      mode: 'search',
      query: 'UI-MEM-91827',
      separateScopes: false,
      labelSources: false,
    });

    expect(parseDirectMemoryReadRequest(`Recall global memory and code-session memory separately
for global-memory-marker-maple-58
and code-session-marker-onyx-91.`)).toEqual({
      mode: 'search',
      query: 'global-memory-marker-maple-58\nand code-session-marker-onyx-91',
      scope: 'both',
      separateScopes: true,
      labelSources: false,
    });
  });

  it('classifies mutating memory tools separately from read-only memory tools', () => {
    expect(isMemoryMutationToolName('memory_save')).toBe(true);
    expect(isMemoryMutationToolName('memory_import')).toBe(true);
    expect(isMemoryMutationToolName('memory_recall')).toBe(false);
    expect(isMemoryMutationToolName('memory_search')).toBe(false);
    expect(isDirectMemoryMutationToolName('memory_save')).toBe(true);
    expect(isElevatedMemoryMutationToolName('memory_import')).toBe(true);
    expect(getMemoryMutationToolClass('memory_save')).toBe('direct_write');
    expect(getMemoryMutationToolClass('memory_import')).toBe('elevated');
  });

  it('returns a stable denial message for model-authored memory saves', () => {
    expect(getMemoryMutationIntentDeniedMessage('memory_save')).toContain('explicit remember/save');
  });
});
