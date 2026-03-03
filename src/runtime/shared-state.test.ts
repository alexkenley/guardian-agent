/**
 * Tests for SharedState — inter-agent data passing.
 */

import { describe, it, expect } from 'vitest';
import { SharedState } from './shared-state.js';

describe('SharedState', () => {
  it('stores and retrieves values', () => {
    const state = new SharedState();
    state.set('key1', 'value1');
    state.set('key2', 42);

    expect(state.get('key1')).toBe('value1');
    expect(state.get<number>('key2')).toBe(42);
    expect(state.get('missing')).toBeUndefined();
  });

  it('tracks key existence', () => {
    const state = new SharedState();
    state.set('exists', true);

    expect(state.has('exists')).toBe(true);
    expect(state.has('missing')).toBe(false);
  });

  it('deletes keys', () => {
    const state = new SharedState();
    state.set('key', 'value');

    expect(state.delete('key')).toBe(true);
    expect(state.has('key')).toBe(false);
    expect(state.delete('missing')).toBe(false);
  });

  it('lists all keys', () => {
    const state = new SharedState();
    state.set('a', 1);
    state.set('b', 2);
    state.set('c', 3);

    expect(state.keys()).toEqual(['a', 'b', 'c']);
  });

  it('returns a snapshot', () => {
    const state = new SharedState();
    state.set('x', 'hello');
    state.set('y', [1, 2, 3]);

    const snapshot = state.snapshot();
    expect(snapshot).toEqual({ x: 'hello', y: [1, 2, 3] });
  });

  it('tracks temp keys and clears them', () => {
    const state = new SharedState();
    state.set('permanent', 'stays');
    state.set('temp:scratch', 'gone');
    state.set('temp:iteration', 5);

    expect(state.size).toBe(3);
    expect(state.has('temp:scratch')).toBe(true);

    state.clearTemp();

    expect(state.size).toBe(1);
    expect(state.has('permanent')).toBe(true);
    expect(state.has('temp:scratch')).toBe(false);
    expect(state.has('temp:iteration')).toBe(false);
  });

  it('clears all state', () => {
    const state = new SharedState();
    state.set('a', 1);
    state.set('temp:b', 2);

    state.clear();

    expect(state.size).toBe(0);
    expect(state.keys()).toEqual([]);
  });

  it('provides a read-only view', () => {
    const state = new SharedState();
    state.set('key', 'value');
    state.set('temp:t', 'temp');

    const view = state.asReadOnly();

    expect(view.get('key')).toBe('value');
    expect(view.has('key')).toBe(true);
    expect(view.has('missing')).toBe(false);
    expect(view.keys()).toEqual(['key', 'temp:t']);
    expect(view.snapshot()).toEqual({ key: 'value', 'temp:t': 'temp' });
  });

  it('handles overwriting values', () => {
    const state = new SharedState();
    state.set('key', 'first');
    state.set('key', 'second');

    expect(state.get('key')).toBe('second');
    expect(state.size).toBe(1);
  });

  it('handles complex values', () => {
    const state = new SharedState();
    const complex = { nested: { array: [1, 2, 3] }, flag: true };
    state.set('data', complex);

    expect(state.get('data')).toEqual(complex);
  });
});
