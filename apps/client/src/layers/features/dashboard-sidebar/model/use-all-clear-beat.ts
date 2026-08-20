/**
 * The all-clear beat: Heads up settles before it folds away (BC-50).
 *
 * ## One drain, one sound, two pictures — the rule, in one place
 *
 * Three things react to the same moment (the last thing waiting is answered),
 * and it took DOR-1391 to say out loud why that is three and not a bug:
 *
 * 1. **This beat**, in the sidebar's Heads up zone.
 * 2. **The Inbox popover's beat** (`widgets/inbox-bell`'s `usePinnedDrainBeat`),
 *    which fires only while that popover is open.
 * 3. **The settle chime** (`features/notifications`' `NotificationCenter`),
 *    app-wide and gated on the sound setting.
 *
 * **The two VISUAL beats may both play, because they are in two places.** A
 * check mark in the panel on the left and a check mark inside a popover in the
 * top right are one answer told where each was asked; neither is a repeat of
 * the other, and a person looking at one cannot see the other without moving
 * their eyes.
 *
 * **The SOUND is app-wide and belongs to exactly one of them, and it is neither
 * of the beats.** Audio is the one channel that cannot be "somewhere else": two
 * chimes for one drain is a stutter, and a chime attached to a beat would be
 * missing precisely when it matters most — the popover shut, the answer given
 * from a phone banner or a keyboard shortcut. So the chime hangs off the queue
 * draining rather than off anything being drawn.
 *
 * Neither this hook nor the bell's touches the sound family. If a beat ever
 * needs to make a noise, the answer is to move the moment into
 * `NotificationCenter`, never to add a second player here.
 *
 * @module features/dashboard-sidebar/model/use-all-clear-beat
 */
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import type { SidebarModel } from './build-sidebar-model';

/**
 * How long "All clear ✓" stays before the zone folds away.
 *
 * 2.5 seconds, from BC-50 — long enough to register as an answer to the work
 * just finished, short enough that nobody waits for it.
 */
export const ALL_CLEAR_BEAT_MS = 2_500;

/**
 * How many things in Heads up actually need the operator.
 *
 * **Read off the model, which now publishes it.** This used to walk the zone's
 * rows and count the ones whose target was `attention` — the same question
 * asked a second way, and it answered a subtly different number: the rows are
 * capped at five (BC-8), so a fleet with seven blocked agents counted three.
 * Only zero-ness is read below, so the two agreed on every transition, but one
 * fact computed twice is one fact that can drift. `needsYouCount` is the
 * uncapped truth and the number BC-11 announces.
 *
 * The working rollup is not one of them either way: a zone holding only
 * "6 working" has nothing waiting in it, so its rows draining to zero is not a
 * queue being finished and must not produce a beat.
 *
 * @param model - The model as built.
 */
function needsYouCount(model: SidebarModel): number {
  return model.zones.find((zone) => zone.id === 'now')?.needsYouCount ?? 0;
}

/**
 * Whether Heads up should be showing its all-clear beat right now.
 *
 * The beat exists because a zone that simply vanishes gives an operator no
 * moment of having finished; the sidebar's own disappearance is the reward, and
 * it needs half a breath to be read as one.
 *
 * Fires on ONE transition and no other: the last needs-you row leaving while
 * nothing else keeps the zone alive. In particular it does not fire when Heads up
 * was only ever a working rollup, and it cannot fire on first paint — there is
 * no previous frame to have held anything, which is what makes "an empty
 * fixture renders zero DOM nodes" (P2 AC-1) true on mount as well as at rest.
 *
 * **Under `prefers-reduced-motion` it never fires at all.** The beat is a
 * flourish about something that already happened, not information the operator
 * would otherwise be missing, so suppressing it costs nothing (spec R2).
 *
 * @param model - The model as built, this frame.
 */
export function useAllClearBeat(model: SidebarModel): boolean {
  const reducedMotion = useReducedMotion();
  const [beating, setBeating] = useState(false);
  const previousCount = useRef(needsYouCount(model));

  const count = needsYouCount(model);
  const hasNowZone = model.zones.some((zone) => zone.id === 'now');

  useEffect(() => {
    const before = previousCount.current;
    previousCount.current = count;
    const shouldBeat = reducedMotion !== true && before > 0 && count === 0 && !hasNowZone;

    // **Every path that is not a beat puts the flag down, and that is the whole
    // fix.** React runs this effect's cleanup before re-running it, so a re-run
    // that took an early return had already cancelled the timer that was going
    // to lower the flag — leaving `beating` stuck true with nothing left to
    // clear it. The stuck flag was invisible while the zone slot was occupied
    // and then rendered "All clear ✓" forever the moment it freed up, which
    // breaks the zone's own zero-DOM-when-empty promise (P2 AC-1, BC-50).
    //
    // The interleaving that reaches it is the ordinary one: resolve the last
    // approval, and an agent starts a turn inside the next 2.5 seconds. Heads up
    // comes straight back holding only "1 working", so `count` is still 0 while
    // `hasNowZone` flips true.
    if (!shouldBeat) {
      setBeating(false);
      return;
    }

    // Abandoned rather than resumed when that happens. The beat is an
    // announcement that the zone is going away, and a zone that came back has
    // not gone away — replaying it after the turn ends would say "all clear"
    // about a queue that was cleared minutes ago.
    setBeating(true);
    const timer = setTimeout(() => setBeating(false), ALL_CLEAR_BEAT_MS);
    return () => clearTimeout(timer);
  }, [count, hasNowZone, reducedMotion]);

  return beating;
}
