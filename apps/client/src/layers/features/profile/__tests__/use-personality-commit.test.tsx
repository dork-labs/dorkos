/**
 * @vitest-environment jsdom
 *
 * The settle between a slider and a save (DOR-1646).
 *
 * The behaviour worth pinning is not "there is a timer" — it is that one drag
 * costs one save, that the save still happens when the popover is dismissed
 * before the timer fires, and that a dismissal with nothing pending sends
 * nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { usePersonalityCommit } from '../model/use-personality-commit';
import type { ProfileAgentManifest, ProfileAgentUpdate } from '../model/use-profile-agent';

/** A manifest with just the fields the commit reads. */
function manifest(id: string, traits: Partial<Traits> = {}): ProfileAgentManifest {
  return {
    id,
    traits: { ...DEFAULT_TRAITS, ...traits },
    soulContent: '<!-- TRAITS:START -->\nold\n<!-- TRAITS:END -->\nBe careful.',
  } as unknown as ProfileAgentManifest;
}

/** Traits with one dial moved, so each step is distinguishable. */
const at = (verbosity: number): Traits => ({ ...DEFAULT_TRAITS, verbosity });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePersonalityCommit', () => {
  it('sends one save for a whole drag, carrying the value it ended on', () => {
    const update = vi.fn();
    const { result } = renderHook(() => usePersonalityCommit(manifest('warden'), update));

    act(() => {
      result.current.onTraitsChange(at(2));
      result.current.onTraitsChange(at(3));
      result.current.onTraitsChange(at(4));
    });
    // Still nothing: the sliders are moving.
    expect(update).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ traits: at(4) });
  });

  it('shows every step while the save waits, so the thumb tracks the drag', () => {
    // The picker is controlled from the SERVER's copy, which does not move until
    // a round trip lands. Without a local choice, every tick of one drag sends
    // the same value and the thumb never leaves the stored one.
    const { result } = renderHook(() => usePersonalityCommit(manifest('warden'), vi.fn()));

    expect(result.current.traits.verbosity).toBe(3);
    act(() => result.current.onTraitsChange(at(5)));

    expect(result.current.traits.verbosity).toBe(5);
  });

  it('writes SOUL.md alongside the manifest', () => {
    // The manifest alone does not reach a turn unless the file already carries
    // the markers — the reason `personalityUpdate` exists (DOR-1253).
    const update = vi.fn();
    const { result } = renderHook(() => usePersonalityCommit(manifest('warden'), update));

    act(() => result.current.onTraitsChange(at(5)));
    act(() => vi.advanceTimersByTime(1000));

    const patch = update.mock.calls[0][0] as ProfileAgentUpdate;
    expect(patch.soulContent).toContain('TRAITS:END');
    // …and the prose already in the file is still under it.
    expect(patch.soulContent).toContain('Be careful.');
  });

  it('saves a change the operator made just before dismissing the popover', () => {
    // Letting go of a slider and closing the panel is one gesture. Losing the
    // change to the unmount is the failure the settle would otherwise introduce.
    const update = vi.fn();
    const { result, unmount } = renderHook(() => usePersonalityCommit(manifest('warden'), update));

    act(() => result.current.onTraitsChange(at(1)));
    act(() => unmount());

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ traits: at(1) });
  });

  it('sends nothing when a popover is opened and closed untouched', () => {
    const update = vi.fn();
    const { unmount } = renderHook(() => usePersonalityCommit(manifest('warden'), update));

    act(() => unmount());

    expect(update).not.toHaveBeenCalled();
  });

  it('drops a local choice when the panel moves to a different agent', () => {
    // One panel, two profiles: the choice made for one is not a choice made for
    // the other, and showing it there would be showing an unsaved lie.
    //
    // **The timers are advanced past the settle deliberately.** Clearing the
    // shown value is only half of it, and the half that reads correct: the
    // SCHEDULED save also has to go, or it fires later and reads whichever agent
    // is loaded by then. This test passed without asserting that, which is
    // exactly how the bug below got in.
    const update = vi.fn();
    const { result, rerender } = renderHook(
      ({ agent }: { agent: ProfileAgentManifest }) => usePersonalityCommit(agent, update),
      { initialProps: { agent: manifest('warden') } }
    );

    act(() => result.current.onTraitsChange(at(5)));
    act(() => rerender({ agent: manifest('scout', { verbosity: 2 }) }));
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.traits.verbosity).toBe(2);
    expect(update).not.toHaveBeenCalled();
  });

  it('never writes one agent’s personality onto another', () => {
    // Nudge a slider, open somebody else's profile within the settle. The flush
    // reads the CURRENT agent, so a change that outlives its own agent lands on
    // the wrong one — and `personalityUpdate` rewrites SOUL.md, so the wrong
    // agent's prose gets the wrong trait block too. The plainest statement of
    // the invariant, asserted on the payload rather than on the call count.
    const update = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ agent }: { agent: ProfileAgentManifest }) => usePersonalityCommit(agent, update),
      { initialProps: { agent: manifest('warden') } }
    );

    act(() => result.current.onTraitsChange(at(5)));
    act(() => rerender({ agent: manifest('scout', { verbosity: 2 }) }));
    act(() => vi.advanceTimersByTime(1000));
    // …and the unmount flush is the other door into the same room.
    act(() => unmount());

    expect(update).not.toHaveBeenCalled();
  });

  it('holds a change made before the manifest arrives rather than saving nowhere', () => {
    const update = vi.fn();
    const { result } = renderHook(() => usePersonalityCommit(null, update));

    act(() => result.current.onTraitsChange(at(5)));
    act(() => vi.advanceTimersByTime(1000));

    expect(update).not.toHaveBeenCalled();
  });
});
