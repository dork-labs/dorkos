// @vitest-environment jsdom
/**
 * `useSessionSearch` is an ALLOW-LIST, and a param it forgets is dropped in
 * silence.
 *
 * Nothing catches that on its own: the hook returns `Partial<SessionSearch>`, so
 * a caller destructuring a field the hook never copies compiles cleanly and
 * reads `undefined` on every render. That is exactly how `?seed=dorkbot-help`
 * reached the router, the route schema and the page — and then stopped, one line
 * short of the chat model.
 *
 * So the guard below reads the schema's OWN key list and subtracts an explicit,
 * commented exclusion set. A key added to `sessionSearchSchema` and to neither
 * the hook nor that set fails here, which is the only shape of this test that
 * can catch the thing it is named for.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

let mockSearch: Record<string, unknown> = {};
vi.mock('@/layers/shared/model', () => ({
  useSafeSearch: () => mockSearch,
}));

import { useSessionSearch } from '../model/use-session-search';
import { sessionSearchSchema } from '@/router';

/**
 * Schema keys `useSessionSearch` deliberately does not forward.
 *
 * Every one is read somewhere else, so passing it through here would be a second
 * source for the same fact:
 *
 * - `continuedFrom` — the `/clear` "linked back" reference, read off the router
 *   by the surface that draws the link.
 * - the ten `dialogSearchSchema` keys `mergeDialogSearch` folds in
 *   (`settings`, `settingsSection`, `agent`, `agentPath`, `panel`, `hubTab`,
 *   `profile`, `profilePage`, `tasks`, `relay`) — these belong to `useSettingsDeepLink`,
 *   `useProfileDeepLink` and their siblings, which own opening and closing the
 *   dialogs. A session hook forwarding them would invite a second opener.
 *
 * Adding a key here is a decision, and the point is that it has to be made.
 */
const DELIBERATELY_NOT_FORWARDED = new Set([
  'continuedFrom',
  'settings',
  'settingsSection',
  'agent',
  'agentPath',
  'panel',
  'hubTab',
  'profile',
  'profilePage',
  'tasks',
  'relay',
]);

/** Every key the `/session` route's schema declares. */
function schemaKeys(): string[] {
  return Object.keys(sessionSearchSchema.shape);
}

describe('useSessionSearch', () => {
  it('forwards every schema key that is not deliberately excluded', () => {
    const shouldForward = schemaKeys().filter((key) => !DELIBERATELY_NOT_FORWARDED.has(key));
    // A string value for every key, so "did it come out" is answerable without
    // knowing each key's shape. The enumerated ones need their legal literal.
    const literals: Record<string, string> = { send: '1', seed: 'dorkbot-help' };
    mockSearch = Object.fromEntries(
      shouldForward.map((key) => [key, literals[key] ?? `value-for-${key}`])
    );

    const { result } = renderHook(() => useSessionSearch());

    const dropped = shouldForward.filter(
      (key) => result.current[key as keyof typeof result.current] === undefined
    );
    expect(dropped).toEqual([]);
  });

  it('names its exclusions rather than losing them by accident', () => {
    // The other half of the guard: an excluded key must still BE a schema key.
    // Without this, a rename in the schema turns an exclusion into a typo and
    // the set silently stops excluding anything.
    const declared = new Set(schemaKeys());
    const stale = [...DELIBERATELY_NOT_FORWARDED].filter((key) => !declared.has(key));
    expect(stale).toEqual([]);

    // And they really are absent from the hook's answer.
    mockSearch = Object.fromEntries([...DELIBERATELY_NOT_FORWARDED].map((key) => [key, 'x']));
    const { result } = renderHook(() => useSessionSearch());
    for (const key of DELIBERATELY_NOT_FORWARDED) {
      expect(result.current[key as keyof typeof result.current]).toBeUndefined();
    }
  });

  it('carries the launch params, values and all', () => {
    mockSearch = {
      session: 's1',
      dir: '/projects/alpha',
      runtime: 'codex',
      prompt: 'summarize this',
      send: '1',
      seed: 'dorkbot-help',
    };

    const { result } = renderHook(() => useSessionSearch());

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
});
