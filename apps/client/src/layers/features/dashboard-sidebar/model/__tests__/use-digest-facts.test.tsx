// @vitest-environment jsdom
/**
 * "While you were away…" — the four gates, the latch and the dissolve (BC-22).
 *
 * The row itself is a pure rule (`build-digest-row.ts`, tested in
 * `today-rules.test.ts`). What lives here is everything that rule cannot see:
 * whether there was an absence at all, whether anything finished during it, and
 * the one write the digest makes.
 *
 * @module features/dashboard-sidebar/model/__tests__/use-digest-facts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { Session } from '@dorkos/shared/types';
import type { SidebarPrefs } from '@dorkos/shared/config-schema';

/** The prefs writer, recorded so the once-a-day write can be inspected. */
const update = vi.fn();

/** The welcome-back setting, mutated per test before the hook mounts. */
const welcomeBack = {
  enabled: true,
  absenceThresholdMinutes: 240,
  maxPosts: 3,
  offersEnabled: false,
  setEnabled: vi.fn(),
  setOffersEnabled: vi.fn(),
  isAvailable: true,
  isPending: false,
};

vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return {
    ...actual,
    useWelcomeBack: () => welcomeBack,
    useUpdateSidebarPrefs: () => ({ update, updateAsync: vi.fn(), isPending: false }),
  };
});

import { useDigestFacts, type UseDigestFactsInput } from '../use-digest-facts';

/** 09:15 local on 9 August 2026 — the same instant the fixtures reason from. */
const NOW = new Date(2026, 7, 9, 9, 15, 0, 0).getTime();

/** An ISO instant `hours` before {@link NOW}. */
const hoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

/** A session with only the two fields the digest reads. */
const session = (id: string, updatedAt: string): Session =>
  ({ id, title: id, createdAt: hoursAgo(48), updatedAt }) as Session;

/** The default input: a long absence, two things finished inside it. */
function input(overrides: Partial<UseDigestFactsInput> = {}): UseDigestFactsInput {
  return {
    now: NOW,
    sessions: [session('s1', hoursAgo(2)), session('s2', hoursAgo(3))],
    workingSessionIds: [],
    interactions: { 'session:s0': hoursAgo(14) },
    storedLastShownDate: '2026-08-08',
    ...overrides,
  };
}

describe('useDigestFacts — what counts as news (BC-22)', () => {
  beforeEach(() => {
    update.mockClear();
    welcomeBack.enabled = true;
    welcomeBack.isAvailable = true;
    welcomeBack.absenceThresholdMinutes = 240;
  });
  afterEach(() => cleanup());

  it('counts the work that moved while the operator was away', () => {
    const { result } = renderHook(() => useDigestFacts(input()));
    expect(result.current.digest.finishedWhileAwayCount).toBe(2);
  });

  it('does not count work that is still going', () => {
    const { result } = renderHook(() => useDigestFacts(input({ workingSessionIds: ['s1'] })));
    expect(result.current.digest.finishedWhileAwayCount).toBe(1);
  });

  it('does not count work that finished BEFORE the operator left', () => {
    const { result } = renderHook(() =>
      useDigestFacts(input({ sessions: [session('s1', hoursAgo(20))] }))
    );
    expect(result.current.digest.finishedWhileAwayCount).toBe(0);
  });

  it('says nothing when the absence is shorter than the threshold', () => {
    const { result } = renderHook(() =>
      useDigestFacts(input({ interactions: { 'session:s0': hoursAgo(1) } }))
    );
    expect(result.current.digest.finishedWhileAwayCount).toBe(0);
  });

  it('says nothing on a device that has never seen this operator', () => {
    const { result } = renderHook(() => useDigestFacts(input({ interactions: {} })));
    expect(result.current.digest.finishedWhileAwayCount).toBe(0);
  });

  it('says nothing when the operator switched welcome-back off', () => {
    welcomeBack.enabled = false;
    const { result } = renderHook(() => useDigestFacts(input()));
    expect(result.current.digest.finishedWhileAwayCount).toBe(0);
  });

  it('says nothing on an install that has no welcome-back setting at all', () => {
    welcomeBack.isAvailable = false;
    const { result } = renderHook(() => useDigestFacts(input()));
    expect(result.current.digest.finishedWhileAwayCount).toBe(0);
  });
});

describe('useDigestFacts — once a day, per account (BC-22)', () => {
  beforeEach(() => {
    update.mockClear();
    welcomeBack.enabled = true;
    welcomeBack.isAvailable = true;
    welcomeBack.absenceThresholdMinutes = 240;
  });
  afterEach(() => cleanup());

  it('writes today’s date the moment the row would render', () => {
    renderHook(() => useDigestFacts(input()));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0]?.[0] as (prev: SidebarPrefs) => SidebarPrefs;
    const next = patch({ digest: {} } as SidebarPrefs);
    expect(next.digest.lastShownDate).toBe('2026-08-09');
  });

  it('writes nothing when it has already been shown today', () => {
    renderHook(() => useDigestFacts(input({ storedLastShownDate: '2026-08-09' })));
    expect(update).not.toHaveBeenCalled();
  });

  it('writes nothing when there is no news, however long the absence', () => {
    renderHook(() => useDigestFacts(input({ sessions: [] })));
    expect(update).not.toHaveBeenCalled();
  });

  it('writes once and not on every rebuild', () => {
    const { rerender } = renderHook((props: UseDigestFactsInput) => useDigestFacts(props), {
      initialProps: input(),
    });
    rerender(input());
    rerender(input());
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('hands the RULE the date this tab loaded with, so the write cannot erase the row', () => {
    // The point of the latch. Prefs move to today the instant the write lands
    // — that is BC-22's "written the moment it renders" — and the rule must
    // still see yesterday, or the row disappears a frame after appearing.
    const { result, rerender } = renderHook((props: UseDigestFactsInput) => useDigestFacts(props), {
      initialProps: input(),
    });
    expect(result.current.lastShownDate).toBe('2026-08-08');
    rerender(input({ storedLastShownDate: '2026-08-09' }));
    expect(result.current.lastShownDate).toBe('2026-08-08');
    expect(result.current.digest.finishedWhileAwayCount).toBe(2);
  });
});

describe('useDigestFacts — the dissolve (BC-22)', () => {
  beforeEach(() => {
    update.mockClear();
    welcomeBack.enabled = true;
    welcomeBack.isAvailable = true;
    welcomeBack.absenceThresholdMinutes = 240;
  });
  afterEach(() => cleanup());

  it('goes quiet as soon as the operator opens any conversation', () => {
    const { result, rerender } = renderHook((props: UseDigestFactsInput) => useDigestFacts(props), {
      initialProps: input(),
    });
    expect(result.current.digest.finishedWhileAwayCount).toBe(2);

    // Opening something writes a new record, which is a new map identity.
    rerender(input({ interactions: { 'session:s0': hoursAgo(14), 'session:s1': hoursAgo(0) } }));
    expect(result.current.digest.finishedWhileAwayCount).toBe(0);
  });

  it('does not dissolve on a rebuild that changed nothing', () => {
    // The counter-proof, and the reason the dissolve compares VALUES: a caller
    // that hands back a structurally identical map with a new identity has not
    // opened anything, and must not put the row out.
    const { result, rerender } = renderHook((props: UseDigestFactsInput) => useDigestFacts(props), {
      initialProps: input(),
    });
    rerender(input());
    rerender(input({ interactions: { 'session:s0': hoursAgo(14) } }));
    expect(result.current.digest.finishedWhileAwayCount).toBe(2);
  });
});
