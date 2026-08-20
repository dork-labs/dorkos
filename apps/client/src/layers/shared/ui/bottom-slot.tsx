/**
 * One pinned slot at the bottom of a sidebar, showing one card at a time.
 *
 * Four things used to compete for the bottom of the cockpit's panel: the
 * getting-started progress card, the update pill, the profile prompt and a
 * promo — and the promo sat INSIDE the scroller, so a long list pushed it below
 * the fold for good while the other three stacked in the footer (spec
 * `sidebar-simplification` D4). This is the one place they arbitrate: a sibling
 * of the scroller, pinned above the footer, highest priority wins, and the next
 * card waits its turn.
 *
 * **It decides nothing about who qualifies.** Callers hand it an ordered list
 * and it renders the first whose `show` is true. That keeps the arbiter in
 * `shared/` — the cockpit's candidates come from three different features, and
 * the Obsidian embed's list is one promo — without this layer knowing what any
 * of them are.
 *
 * @module shared/ui/bottom-slot
 */
import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { TOUCH_TARGET_MIN_H } from './touch-target';

/** How long a card takes to rise into the slot, or collapse out of it. */
const SLOT_TRANSITION_S = 0.16;

/**
 * The thumb floor for every control inside a bottom card, applied here rather
 * than card by card.
 *
 * The slot puts cards on a phone that had never been there before: the cockpit
 * sidebar is replaced wholesale by the mobile tabs, so `ProgressCard`, the
 * update pill and the profile prompt were desktop-only until this existed, and
 * every one of them is sized for a pointer. Their dismiss controls are an 18px
 * glyph with 2px of padding, which `mobile-touch.spec.ts` measures and rejects
 * against its 40px bar — it found the promo card's at 18.99px.
 *
 * **One rule at the seam, so the next card cannot forget it.** The alternative,
 * `isMobile && TOUCH_TARGET_MIN_H` on each control of each card, is the same fix
 * written a dozen times and correct only until somebody adds a fifth card. Every
 * control the slot can ever show passes through this element.
 *
 * Height only, matching {@link TOUCH_TARGET_MIN_H}'s own rule: the sweep
 * measures vertical reach through `elementFromPoint`, and widening an
 * absolutely-positioned dismiss to 44px would lay a hit area over the card's own
 * text and swallow the press that opens it.
 */
const TOUCH_FLOOR = `[&_button]:${TOUCH_TARGET_MIN_H}`;

/** One card the slot may show. Order in the array IS the priority. */
export interface BottomSlotCandidate {
  /**
   * Stable identity for this card, used as the animation key. A candidate whose
   * id changes is treated as a different card, which is what makes one promo
   * replacing another animate rather than swap silently.
   */
  id: string;
  /** Whether this card qualifies right now. */
  show: boolean;
  /** Draws the card. Called only when this candidate wins the slot. */
  render: () => ReactNode;
}

/** Props for {@link BottomSlot}. */
export interface BottomSlotProps {
  /** The cards this surface may show, highest priority first. */
  candidates: BottomSlotCandidate[];
  /**
   * Whether the facts behind `candidates` have answered at least once.
   *
   * This is what keeps the slot off the list of things that assemble themselves
   * in front of the user on boot (design-decisions §6, item 9). Every candidate
   * here is gated on a server read, so on a cold start the slot is empty for a
   * beat and then a card qualifies — which, without this, is indistinguishable
   * from a card arriving later and would animate up in the middle of first
   * paint. Whatever is true at the moment this first turns true is simply
   * THERE; only a card that qualifies after that rises.
   */
  ready: boolean;
  /** Extra classes for the slot container. */
  className?: string;
}

/**
 * The bottom slot: zero or one card, pinned, with an honest entrance.
 *
 * The container is always in the DOM — `empty:p-0` collapses it to nothing when
 * no card qualifies — so the panel's layout does not depend on whether there is
 * anything to say, and a test can assert the slot's POSITION without a card
 * having to qualify first.
 */
export function BottomSlot({ candidates, ready, className }: BottomSlotProps) {
  const shouldReduceMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const winner = candidates.find((candidate) => candidate.show);

  // **Which card was on screen at boot**, latched once, in an effect — so the
  // render in which `ready` first turns true still reads `undefined` and cannot
  // animate. `null` records "nothing qualified at boot", which is a different
  // fact from "boot has not happened".
  //
  // The latch is the WINNER's id rather than a plain boolean on purpose. A
  // boolean flips to `true` one render after boot, and a card already on screen
  // would then be re-rendered asking for an entrance it should never play —
  // harmless with the real library, which reads `initial` only at mount, but
  // only by accident. Comparing ids makes the rule say what it means: a card
  // animates when it is not the one boot painted.
  const [bootWinnerId, setBootWinnerId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (ready && bootWinnerId === undefined) setBootWinnerId(winner?.id ?? null);
  }, [ready, bootWinnerId, winner]);

  const animates = bootWinnerId !== undefined && winner?.id !== bootWinnerId && !shouldReduceMotion;

  return (
    <div
      data-slot="sidebar-bottom-slot"
      className={cn('shrink-0 px-2 pb-2 empty:p-0', isMobile && TOUCH_FLOOR, className)}
    >
      <AnimatePresence initial={false}>
        {winner !== undefined && (
          <motion.div
            key={winner.id}
            initial={animates ? { height: 0, opacity: 0 } : false}
            animate={{ height: 'auto', opacity: 1 }}
            // Collapsing the height is the feedback that the press landed.
            // Under reduced motion it is instant like everything else — the
            // `transition` below drives both directions, and that preference
            // means no animation, not a gentler one.
            exit={{ height: 0, opacity: 0 }}
            transition={{
              duration: shouldReduceMotion ? 0 : SLOT_TRANSITION_S,
              ease: [0, 0, 0.2, 1],
            }}
            className="overflow-hidden"
          >
            {winner.render()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
