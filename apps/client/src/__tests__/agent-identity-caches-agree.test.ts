/**
 * The literal keys `useAgentsSync` sweeps really are the caches they name.
 *
 * `entities/mesh` may not import `entities/agent`'s `agentKeys` or
 * `entities/team`'s `TEAM_ROSTER_KEY` — the first would close a cycle
 * (`entities/agent` already imports `entities/mesh`, and `import-x/no-cycle`
 * runs at `error` over `entities/**`), the second is a sibling entity's
 * constant. So the sweep spells them by hand, and a factory that moved would
 * leave the sync hook quietly invalidating a cache nothing reads: the sidebar
 * would go back to lying until reload, with every test still green.
 *
 * The app shell may import any layer, which is why the comparison lives up here
 * — the same shape as `one-config-query-key.test.ts`.
 *
 * @module __tests__/agent-identity-caches-agree
 */
import { describe, it, expect } from 'vitest';
import { AGENT_IDENTITY_CACHES } from '@/layers/entities/mesh';
import { agentKeys } from '@/layers/entities/agent';
import { TEAM_ROSTER_KEY, memberRoomsKey } from '@/layers/entities/team';

describe('useAgentsSync sweeps the real caches', () => {
  it('its `agents` prefix is the one `agentKeys` is rooted at', () => {
    const target = AGENT_IDENTITY_CACHES.find((t) => t.queryKey[0] === 'agents');
    expect(target?.queryKey).toEqual([...agentKeys.all]);
    // A prefix, deliberately: `byPath` and `resolved` both have to go.
    expect(target?.exact).toBeFalsy();
    expect(agentKeys.byPath('/some/path').slice(0, 1)).toEqual([...agentKeys.all]);
    expect(agentKeys.resolved(['/a']).slice(0, 1)).toEqual([...agentKeys.all]);
  });

  it('its `team` key is the roster key, swept as a PREFIX like its siblings', () => {
    const target = AGENT_IDENTITY_CACHES.find((t) => t.queryKey[0] === 'team');
    expect(target?.queryKey).toEqual([...TEAM_ROSTER_KEY]);
    // A prefix, so one member's rooms refresh with the roster — which
    // `entities/team` documents as the intent, and which the three mesh
    // mutations that sweep `['team']` have always done.
    expect(target?.exact).toBeFalsy();
    expect(memberRoomsKey('m1').slice(0, 1)).toEqual([...TEAM_ROSTER_KEY]);
  });

  it('its `mesh` prefix covers the key the sidebar actually draws rows from', () => {
    // The whole bug: the sidebar reads `['mesh','agent-paths']`, and a sweep of
    // `['mesh','agents']` alone left its rows stale for 30 seconds.
    const target = AGENT_IDENTITY_CACHES.find((t) => t.queryKey[0] === 'mesh');
    expect(target?.queryKey).toEqual(['mesh']);
    expect(target?.exact).toBeFalsy();
  });
});
