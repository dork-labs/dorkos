/**
 * Personality, saved once the operator stops moving it (DOR-1646).
 *
 * The six trait sliders are Radix sliders, and a Radix slider fires
 * `onValueChange` on every step it passes through. The two profile surfaces
 * that show them save on change — there is no Save button on a profile — so a
 * single drag across four steps was four `PATCH /api/agents/current` calls, and
 * every one of those sweeps `['team']`, every agent key, and every open room's
 * roster. A drag is one decision; it should cost one save.
 *
 * Worse than the traffic: the picker is controlled from the server's copy of the
 * manifest, which only catches up a round trip later. Each tick of one drag
 * therefore sent the SAME value, because the thumb never moved off the stored
 * one until a response landed. Holding the operator's choice locally is what
 * makes the slider track the drag at all.
 *
 * A preset click rides the same settle. It is one commit either way, so the
 * delay buys nothing there — but it costs nothing a person can perceive, and one
 * commit path is worth more than a saved fifth of a second.
 *
 * @module features/profile/model/use-personality-commit
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { personalityUpdate } from '../lib/soul-file';
import type { ProfileAgentManifest, ProfileAgentUpdate } from './use-profile-agent';

/**
 * How long the sliders may keep moving before the change is saved.
 *
 * Long enough to swallow a drag (Radix emits a step per pointer move that
 * crosses a boundary, tens of milliseconds apart) and short enough that letting
 * go and closing the popover in one motion still saves through the unmount
 * flush below rather than racing it.
 */
const COMMIT_DELAY_MS = 400;

/** The traits a picker should show, and the one way to change them. */
export interface PersonalityCommit {
  /** What the picker renders — the operator's latest choice, or the stored one. */
  traits: Traits;
  /** Take a new choice. Saved once the sliders settle, or on unmount. */
  onTraitsChange: (traits: Traits) => void;
}

/**
 * Show an agent's personality and save it when it settles.
 *
 * Tolerates a `null` agent so the surfaces that render a skeleton first can call
 * this above their early return; with nothing to write to, a change is held and
 * never sent.
 *
 * **The pending change is flushed on unmount**, which is not a nicety: the
 * personality picker is a popover on the desktop and a drawer on a phone, and
 * letting go of a slider and dismissing it is one gesture. The mutation itself
 * survives the unmount — refusals are announced by the app-wide handler, not by
 * a callback on a component that is gone (see `use-profile-agent`).
 *
 * @param agent - The manifest as read, or `null` while it is not there. Its
 *   `soulContent` is what the trait block gets rewritten into; a change to its
 *   `id` (a different agent's profile in the same panel) drops any local choice
 *   AND the save it had scheduled, so no change can outlive the agent it was
 *   made on.
 * @param update - The profile's save, from `useProfileAgent`.
 */
export function usePersonalityCommit(
  agent: ProfileAgentManifest | null,
  update: (updates: ProfileAgentUpdate) => void
): PersonalityCommit {
  const stored = (agent?.traits ?? DEFAULT_TRAITS) as Traits;
  const [draft, setDraft] = useState<Traits | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Traits | null>(null);
  // Read at flush time, never at schedule time: a flush can fire from an unmount
  // cleanup, after the render that produced these closed over stale values.
  const latest = useRef({ agent, update });
  useEffect(() => {
    latest.current = { agent, update };
  });

  const agentId = agent?.id ?? null;
  useEffect(() => {
    // A different agent's profile is a different personality; the local choice
    // does not follow it across. Same reset-on-key contract `useDebouncedInput`
    // uses for text.
    //
    // **The scheduled save has to go with it, and forgetting that wrote one
    // agent's personality onto another.** The flush reads the CURRENT agent, so
    // a nudge followed within the settle by opening somebody else's profile
    // saved the first agent's traits — manifest and SOUL.md both — into the
    // second. Losing a nudge the operator ended by walking away from is the
    // cheaper of the two failures by a wide margin, so the pending change is
    // dropped rather than redirected.
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- dropping a local choice when a different agent is loaded
    setDraft(null);
  }, [agentId]);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const traits = pending.current;
    pending.current = null;
    if (traits === null) return;
    const { agent: current, update: save } = latest.current;
    // Manifest AND SOUL.md, or the change never reaches a turn — see
    // `personalityUpdate`.
    if (current !== null) save(personalityUpdate(current, traits));
  }, []);

  // `flush` is stable, so this cleanup runs on unmount and nowhere else. Under
  // StrictMode's double mount it runs with nothing pending, which is a no-op.
  useEffect(() => () => flush(), [flush]);

  const onTraitsChange = useCallback(
    (next: Traits) => {
      setDraft(next);
      pending.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, COMMIT_DELAY_MS);
    },
    [flush]
  );

  return { traits: draft ?? stored, onTraitsChange };
}
