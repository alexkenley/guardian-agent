import { describe, expect, it } from 'vitest';
import {
  buildPagedListContinuationState,
  resolvePagedListContinuationRoute,
  resolvePagedListWindow,
} from './list-continuation.js';

describe('list-continuation', () => {
  it('advances to the requested additional page size for follow-up list requests', () => {
    const window = resolvePagedListWindow({
      continuityThread: {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: buildPagedListContinuationState('automation_catalog_list', {
          offset: 0,
          limit: 20,
          total: 45,
        }),
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      continuationKind: 'automation_catalog_list',
      content: 'Can you list the additional 25 automations?',
      total: 45,
      turnRelation: 'follow_up',
    });

    expect(window).toEqual({
      offset: 20,
      limit: 25,
      total: 45,
    });
  });

  it('returns the remaining items when the follow-up asks for the rest', () => {
    const window = resolvePagedListWindow({
      continuityThread: {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: buildPagedListContinuationState('automation_catalog_list', {
          offset: 0,
          limit: 20,
          total: 45,
        }),
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      continuationKind: 'automation_catalog_list',
      content: 'Show me the remaining automations.',
      total: 45,
      turnRelation: 'follow_up',
    });

    expect(window).toEqual({
      offset: 20,
      limit: 25,
      total: 45,
    });
  });

  it('continues natural follow-up wording even when the gateway turn relation is fresh', () => {
    const window = resolvePagedListWindow({
      continuityThread: {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: buildPagedListContinuationState('gmail_unread_list', {
          offset: 0,
          limit: 3,
          total: 5,
        }),
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      continuationKind: 'gmail_unread_list',
      content: 'Show me 2 more emails.',
      total: 5,
      turnRelation: 'new_request',
    });

    expect(window).toEqual({
      offset: 3,
      limit: 2,
      total: 5,
    });
  });

  it('treats "show the other N" as a paged-list follow-up', () => {
    const window = resolvePagedListWindow({
      continuityThread: {
        continuityKey: 'chat:owner',
        scope: { assistantId: 'chat', userId: 'owner' },
        linkedSurfaces: [],
        continuationState: buildPagedListContinuationState('automation_catalog_list', {
          offset: 0,
          limit: 20,
          total: 47,
        }),
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
      continuationKind: 'automation_catalog_list',
      content: 'Show the other 27 automations.',
      total: 47,
      turnRelation: 'new_request',
    });

    expect(window).toEqual({
      offset: 20,
      limit: 27,
      total: 47,
    });
  });

  it('maps active paged-list continuation state to the owning route for follow-up turns', () => {
    expect(resolvePagedListContinuationRoute({
      continuationStateKind: 'automation_catalog_list',
      content: 'And the rest',
      turnRelation: 'follow_up',
    })).toBe('automation_control');
    expect(resolvePagedListContinuationRoute({
      continuationStateKind: 'm365_unread_list',
      content: 'Show the next 10',
      turnRelation: 'follow_up',
    })).toBe('email_task');
    expect(resolvePagedListContinuationRoute({
      continuationStateKind: 'browser_links_list',
      content: 'More',
      turnRelation: 'follow_up',
    })).toBe('browser_task');
  });

  it('does not map paged-list continuation state for standalone new requests', () => {
    expect(resolvePagedListContinuationRoute({
      continuationStateKind: 'automation_catalog_list',
      content: 'Search this workspace for the REST API implementation.',
      turnRelation: 'new_request',
    })).toBeNull();
  });
});
