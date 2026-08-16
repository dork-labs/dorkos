/**
 * @vitest-environment jsdom
 *
 * The docked profile's memory (spec `profile-unification` §1.6).
 *
 * What is pinned here is the difference between "the panel remembers where you
 * were while you flip tabs" and "the panel drops you back where you stopped
 * yesterday". The first is the whole reason the store exists; the second is the
 * thing it must never do.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAppStore } from '@/layers/shared/model';
import { useProfileStore } from '../model/profile-store';
import { useProfileLeaveGuard } from '../model/profile-leave-guard';
import { ProfileScope } from '../model/profile-scope';

const AGENT = '/repo/warden';
const OTHER = '/repo/scout';

beforeEach(() => {
  useProfileStore.setState({ dockedEntries: {}, sheetChain: [] });
  useAppStore.setState({
    rightPanelOpen: false,
    activeRightPanelTab: null,
    explicitAgentPath: null,
    rightPanelLayoutKey: null,
  });
  localStorage.clear();
});

/** What is pushed on top of one agent's docked profile. */
const entriesFor = (path: string) => useProfileStore.getState().dockedEntries[path] ?? [];

describe('opening the docked profile', () => {
  it('does all four things "open" means, not three of them', () => {
    // `openHub` used to name the agent and stop there; every caller then
    // repeated the other two lines, and the one that forgot read as a dead
    // click. There is one call now, and it opens the panel.
    useProfileStore.getState().openProfileDocked(AGENT);

    expect(useAppStore.getState().explicitAgentPath).toBe(AGENT);
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(entriesFor(AGENT)).toEqual([]);
  });

  it('opens straight onto a page when the link named one', () => {
    useProfileStore.getState().openProfileDocked(AGENT, 'sessions');

    expect(entriesFor(AGENT)).toEqual([{ kind: 'page', page: 'sessions' }]);
  });

  it('lands on the root even when the last visit ended on a page', () => {
    useProfileStore.getState().openProfileDocked(AGENT, 'sessions');

    useProfileStore.getState().openProfileDocked(AGENT);

    expect(entriesFor(AGENT)).toEqual([]);
  });
});

describe('opening over an editor nobody has saved', () => {
  /** Mount a dirty editor in the docked panel, and hand back its unmount. */
  function draftInTheDock() {
    const { unmount } = renderHook(() => useProfileLeaveGuard(true), {
      wrapper: ({ children }) => (
        <ProfileScope home="docked" memberId="agent-warden">
          {children}
        </ProfileScope>
      ),
    });
    return unmount;
  }

  it('leaves the page where it is rather than discarding a draft silently', () => {
    // Every other way out of an editor stops to ask. This one cannot — it is a
    // store action with no dialog to raise, reached from a click in another
    // surface or from a link the URL changed underneath you — so it does the
    // thing that needs no question and loses nothing.
    useProfileStore.getState().setDockedEntries(AGENT, [{ kind: 'page', page: 'instructions' }]);
    const unmount = draftInTheDock();

    useProfileStore.getState().openProfileDocked(AGENT);

    expect(entriesFor(AGENT)).toEqual([{ kind: 'page', page: 'instructions' }]);
    unmount();
  });

  it('still goes where a caller explicitly asked to go', () => {
    // Naming a page is a request to travel, not a reset on the way past — and
    // the page you land on has its own guarded way back.
    useProfileStore.getState().setDockedEntries(AGENT, [{ kind: 'page', page: 'instructions' }]);
    const unmount = draftInTheDock();

    useProfileStore.getState().openProfileDocked(AGENT, 'rooms');

    expect(entriesFor(AGENT)).toEqual([{ kind: 'page', page: 'rooms' }]);
    unmount();
  });

  it('resets to the root as usual once the draft is gone', () => {
    useProfileStore.getState().setDockedEntries(AGENT, [{ kind: 'page', page: 'instructions' }]);
    draftInTheDock()();

    useProfileStore.getState().openProfileDocked(AGENT);

    expect(entriesFor(AGENT)).toEqual([]);
  });
});

describe('what each agent remembers', () => {
  it('keeps one stack per agent, so switching agents does not move you', () => {
    useProfileStore.getState().setDockedEntries(AGENT, [{ kind: 'page', page: 'rooms' }]);
    useProfileStore.getState().setDockedEntries(OTHER, [{ kind: 'page', page: 'manages' }]);

    expect(entriesFor(AGENT)).toEqual([{ kind: 'page', page: 'rooms' }]);
    expect(entriesFor(OTHER)).toEqual([{ kind: 'page', page: 'manages' }]);
  });

  it('forgets everything when the panel closes', () => {
    useProfileStore.getState().setDockedEntries(AGENT, [{ kind: 'page', page: 'rooms' }]);

    useProfileStore.getState().clearDockedStacks();

    expect(entriesFor(AGENT)).toEqual([]);
  });

  it('drops the least recently touched stack rather than growing forever', () => {
    // The map is emptied on close, so this only bounds one very long sitting —
    // but an unbounded map is still a leak, and the agent you touched last is
    // the one worth keeping.
    for (let i = 0; i < 12; i++) {
      useProfileStore
        .getState()
        .setDockedEntries(`/repo/agent-${i}`, [{ kind: 'page', page: 'rooms' }]);
    }

    const kept = Object.keys(useProfileStore.getState().dockedEntries);
    // Exactly the cap, not "at most" it: twelve went in, so a bound that also
    // passed for four would not notice the map being emptied by mistake.
    expect(kept).toHaveLength(8);
    expect(kept).toContain('/repo/agent-11');
    expect(kept).not.toContain('/repo/agent-0');
  });

  it('re-touching a stack keeps it alive past newer ones', () => {
    for (let i = 0; i < 8; i++) {
      useProfileStore.getState().setDockedEntries(`/repo/agent-${i}`, []);
    }
    useProfileStore.getState().setDockedEntries('/repo/agent-0', [{ kind: 'page', page: 'rooms' }]);
    useProfileStore.getState().setDockedEntries('/repo/agent-8', []);

    const kept = Object.keys(useProfileStore.getState().dockedEntries);
    expect(kept).toContain('/repo/agent-0');
    expect(kept).not.toContain('/repo/agent-1');
  });
});

describe('the sheet’s chain', () => {
  it('records what a chained profile was opened FROM, and gives it back', () => {
    useProfileStore.getState().pushSheetChain('person-dorian');
    expect(useProfileStore.getState().sheetChain).toEqual(['person-dorian']);

    useProfileStore.getState().popSheetChain();
    expect(useProfileStore.getState().sheetChain).toEqual([]);
  });

  it('clears in one step when the sheet closes', () => {
    useProfileStore.getState().pushSheetChain('a');
    useProfileStore.getState().pushSheetChain('b');

    useProfileStore.getState().clearSheetChain();

    expect(useProfileStore.getState().sheetChain).toEqual([]);
  });
});
