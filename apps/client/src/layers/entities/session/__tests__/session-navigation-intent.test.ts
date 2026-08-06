import { describe, it, expect } from 'vitest';
import type { InPlaceNavigationState } from '@/layers/shared/model';
import {
  beginSessionNavigation,
  sessionDestination,
  type CockpitLocation,
} from '../lib/session-navigation-intent';

/**
 * Mirror of the state `useInPlaceNavigate` stamps onto a rewrite: the
 * destination the in-place chain hangs off, seeded from the current location on
 * the first hop and carried forward on later hops (`prev.inPlaceBase ??
 * current`). Kept in lockstep with the helper so the guard is exercised against
 * the exact history-state shape the helper writes — this is the whole contract
 * DOR-931 turns on.
 *
 * @param current - The location the rewrite starts from.
 * @param patch - The search params this rewrite writes (a value of `undefined`
 *   clears a param, exactly as a close does).
 * @param to - An optional route the rewrite also names (the thread sync does).
 */
function rewriteInPlace(
  current: CockpitLocation,
  patch: Record<string, unknown>,
  to?: string
): CockpitLocation {
  const inPlaceBase = (current.state as InPlaceNavigationState | undefined)?.inPlaceBase ?? {
    pathname: current.pathname,
    search: current.search,
  };
  const state: InPlaceNavigationState = { inPlaceBase };
  return {
    pathname: to ?? current.pathname,
    search: { ...current.search, ...patch },
    state,
  };
}

/** Mirror of a genuine navigation: TanStack resets history state to `{}`. */
function navigateGenuine(pathname: string, search: Record<string, unknown>): CockpitLocation {
  return { pathname, search, state: {} };
}

/** A location reader over a mutable slot, the way the guard reads the router. */
function reader(slot: { at: CockpitLocation }): () => CockpitLocation {
  return () => slot.at;
}

describe('sessionDestination', () => {
  it('reads the destination the in-place stamp names, not the live URL', () => {
    const base = navigateGenuine('/session', { dir: '/p' });
    const opened = rewriteInPlace(base, { settings: 'open' });
    // The URL grew a param, but the reported destination is unchanged.
    expect(sessionDestination(opened)).toBe(sessionDestination(base));
  });

  it('sorts params so parse order does not change the key', () => {
    const a = navigateGenuine('/session', { dir: '/p', session: 's1' });
    const b = navigateGenuine('/session', { session: 's1', dir: '/p' });
    expect(sessionDestination(a)).toBe(sessionDestination(b));
  });

  it('drops cleared params from the live key', () => {
    const withParam = navigateGenuine('/session', { dir: '/p', gone: undefined });
    const without = navigateGenuine('/session', { dir: '/p' });
    expect(sessionDestination(withParam)).toBe(sessionDestination(without));
  });
});

describe('beginSessionNavigation — in-place rewrites survive (positive)', () => {
  // Each real in-place family drives a rewrite through the self-declaring stamp
  // and the lookup started before it must still be wanted afterwards.
  const families: ReadonlyArray<{ name: string; patch: Record<string, unknown>; to?: string }> = [
    { name: 'settings open', patch: { settings: 'open' } },
    { name: 'settings section', patch: { settingsSection: 'models' } },
    { name: 'tasks open', patch: { tasks: 'open' } },
    { name: 'thread select', patch: { thread: 't1' }, to: '/channels' },
    { name: 'runtime pick', patch: { runtime: 'codex' } },
    { name: 'onboarding stage', patch: { onboarding: 'welcome' } },
  ];

  for (const { name, patch, to } of families) {
    it(`stays wanted through an in-place ${name}`, () => {
      const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
      const isWanted = beginSessionNavigation(reader(slot));
      slot.at = rewriteInPlace(slot.at, patch, to);
      expect(isWanted()).toBe(true);
    });
  }

  it('stays wanted across a chain of in-place rewrites (open → tab → section)', () => {
    const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
    const isWanted = beginSessionNavigation(reader(slot));
    slot.at = rewriteInPlace(slot.at, { settings: 'open' });
    slot.at = rewriteInPlace(slot.at, { settings: 'models' });
    slot.at = rewriteInPlace(slot.at, { settingsSection: 'anthropic' });
    expect(isWanted()).toBe(true);
  });

  it('stays wanted when an in-place close removes a param mid-lookup', () => {
    // Settings is open (via an in-place chain) when the lookup starts; closing it
    // while the lookup is out must not read as a departure.
    const opened = rewriteInPlace(navigateGenuine('/session', { dir: '/p' }), { settings: 'open' });
    const slot = { at: opened };
    const isWanted = beginSessionNavigation(reader(slot));
    slot.at = rewriteInPlace(slot.at, { settings: undefined });
    expect(isWanted()).toBe(true);
  });
});

describe('beginSessionNavigation — the DOR-931 discriminator (unclassified param)', () => {
  it('stays wanted through an in-place rewrite of a param the guard has never heard of', () => {
    // The heart of DOR-931: classification is by DECLARED INTENT, not a name the
    // guard keeps. `inspector` appears in no list anywhere — the rewrite that
    // writes it is what declares it in-place.
    const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
    const isWanted = beginSessionNavigation(reader(slot));
    slot.at = rewriteInPlace(slot.at, { inspector: 'open', somethingNew: '1' });
    expect(isWanted()).toBe(true);
  });

  it('the same param WITHOUT the in-place declaration is a departure', () => {
    // The other side of the discriminator, and what the pre-DOR-931 guard did to
    // EVERY unclassified param: an undeclared change to `inspector` moves the key
    // and cancels the lookup. Declared intent is the only difference.
    const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
    const isWanted = beginSessionNavigation(reader(slot));
    slot.at = navigateGenuine('/session', { dir: '/p', session: 's1', inspector: 'open' });
    expect(isWanted()).toBe(false);
  });
});

describe('beginSessionNavigation — genuine departures still cancel (negative)', () => {
  it('cancels on a genuine navigation to another page', () => {
    const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
    const isWanted = beginSessionNavigation(reader(slot));
    slot.at = navigateGenuine('/channels', { id: 'c1' });
    expect(isWanted()).toBe(false);
  });

  it('cancels on a genuine change of the session param', () => {
    const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
    const isWanted = beginSessionNavigation(reader(slot));
    slot.at = navigateGenuine('/session', { dir: '/p', session: 's2' });
    expect(isWanted()).toBe(false);
  });

  it('cancels on a genuine hop even when an in-place rewrite follows it', () => {
    // Genuine-then-in-place: navigate to a channel, then open Settings on it. The
    // last hop is in-place, but the destination genuinely changed in between, so
    // the lookup must still be abandoned. This is why the stamp carries the whole
    // base destination rather than a bare "last hop was in-place" flag.
    const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
    const isWanted = beginSessionNavigation(reader(slot));
    slot.at = navigateGenuine('/channels', { id: 'c1' });
    slot.at = rewriteInPlace(slot.at, { settings: 'open' });
    expect(isWanted()).toBe(false);
  });

  it('a later lookup supersedes an earlier one at the same location', () => {
    // The counter half: two lookups begin at the same destination, so location
    // cannot order them — the later one wins and the earlier goes quiet.
    const slot = { at: navigateGenuine('/session', { dir: '/p', session: 's1' }) };
    const first = beginSessionNavigation(reader(slot));
    const second = beginSessionNavigation(reader(slot));
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
