// @vitest-environment jsdom
/**
 * `useSessionSearch` is an ALLOW-LIST, and a param it forgets is dropped in
 * silence.
 *
 * Nothing catches that: the hook returns `Partial<SessionSearch>`, so a caller
 * destructuring a field the hook never copies compiles cleanly and reads
 * `undefined` on every render. That is exactly how `?seed=dorkbot-help` reached
 * the router, the route schema and the page — and then stopped, one line short
 * of the chat model. So the list is pinned here against the schema itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

let mockSearch: Record<string, unknown> = {};
vi.mock('@/layers/shared/model', () => ({
  useSafeSearch: () => mockSearch,
}));

import { useSessionSearch } from '../model/use-session-search';
import { sessionSearchSchema } from '@/router';

describe('useSessionSearch', () => {
  it('forwards every param the /session schema declares', () => {
    mockSearch = {
      session: 's1',
      dir: '/projects/alpha',
      runtime: 'codex',
      prompt: 'summarize this',
      send: '1',
      seed: 'dorkbot-help',
      continuedFrom: 's0',
    };

    const { result } = renderHook(() => useSessionSearch());

    // The launch params, which is what this hook exists to carry.
    expect(result.current).toMatchObject({
      session: 's1',
      dir: '/projects/alpha',
      runtime: 'codex',
      prompt: 'summarize this',
      send: '1',
      seed: 'dorkbot-help',
    });
  });

  it('narrows the enumerated params to their one legal value', () => {
    mockSearch = { send: 'please', seed: 'delete-everything' };

    const { result } = renderHook(() => useSessionSearch());

    expect(result.current.send).toBeUndefined();
    expect(result.current.seed).toBeUndefined();
  });

  it('carries every launch param the schema has, so a new one cannot be forgotten', () => {
    // The failure this file exists for: a param lands in `sessionSearchSchema`,
    // every type still checks, and the hook quietly returns `undefined` for it.
    // `runtime`, `prompt`, `send` and `seed` all change what a turn does, so the
    // list is asserted rather than trusted.
    const declared = Object.keys(sessionSearchSchema.shape ?? {});
    const launchParams = declared.filter((key) =>
      ['runtime', 'prompt', 'send', 'seed'].includes(key)
    );
    expect(launchParams.sort()).toEqual(['prompt', 'runtime', 'seed', 'send']);

    mockSearch = { runtime: 'codex', prompt: 'p', send: '1', seed: 'dorkbot-help' };
    const { result } = renderHook(() => useSessionSearch());
    for (const key of launchParams) {
      expect(result.current[key as keyof typeof result.current]).toBeDefined();
    }
  });
});
