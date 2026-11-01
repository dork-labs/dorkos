import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight, X } from 'lucide-react';
import { usePromoDismissals } from '@/layers/entities/config';
import { DURATION } from '@/layers/shared/lib';
import { Button, SIDEBAR_ICON_CONTROL, SIDEBAR_ICON_INLINE } from '@/layers/shared/ui';
import type { PromoDefinition } from '../model/promo-types';
import { usePromoActivation } from './use-promo-activation';

/**
 * The card's entrance and exit: a fade, and nothing else (Phase 4 P5).
 *
 * It rose 12px in and shrank to .95 out, two movements for one fact ("an offer
 * is here", "it is gone") that a fade already says. The slot around it owns the
 * height, so the card itself only needs to appear and disappear.
 */
const fadeItem = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION.fast } },
  exit: { opacity: 0, transition: { duration: DURATION.fast } },
} as const;

interface PromoCardProps {
  /** The promo definition to render. */
  promo: PromoDefinition;
}

/**
 * Individual promo card — a compact row: icon, title, one line of description.
 *
 * One format, because both surviving placements are sidebars. The standard
 * `rounded-xl p-6` card belonged to the retired dashboard grid and went with it
 * (team-room-home task 1.5); on home, the quiet-state suggestion carries a
 * dismiss of its own, and dismissals still reach every card from there and from
 * Settings.
 *
 * **Separation is tint, never a line (spec `sidebar-now-today-library` R1).**
 * The sidebar took every hairline out in favour of one `--sidebar-accent` ramp,
 * and this card kept an outline, a `--card` fill and a `--muted` plate under its
 * icon — three shades the panel around it no longer has. It now spells its rest
 * and hover states exactly as `SidebarSection` and `SidebarRow` spell theirs: `/40`
 * at rest, `/70` under the pointer. `--muted` is deliberately absent for the
 * reason those two give — it is lighter than the panel in light mode and darker
 * in dark, so anything tinted with it separates in opposite directions between
 * the themes.
 *
 * The glyph sits in `SidebarRow`'s own 18px square rather than on a plate of its
 * own, so a card under the list lines its icon up with every row above it.
 *
 * **There is always a way to say no.** The card carries its own `×`, and it is
 * the whole difference between an offer and an ad: this card had no dismiss
 * control at all, because the spec put one on the `dashboard-main` format that
 * was retired with `team-room-home` (spec `sidebar-simplification` D4). The
 * answer goes to config, so it holds on every device and in both directions —
 * dismissing here also silences the matching line in the quiet state on home.
 *
 * The `×` is a real button beside the card's button rather than inside it:
 * nesting one is invalid HTML, and the browsers that tolerate it fire both.
 */
export function PromoCard({ promo }: PromoCardProps) {
  const { activate, dialog } = usePromoActivation(promo);
  const { dismissPromo } = usePromoDismissals();
  const shouldReduceMotion = useReducedMotion();
  const Icon = promo.content.icon;

  return (
    // `layout` is gated: a FLIP animation is exactly the kind of unrequested
    // movement `prefers-reduced-motion` is asking us not to do, and it shipped
    // ungated here (review Appendix C #15).
    <motion.div
      // Variants only, played when a parent names them: in the sidebar the
      // bottom slot owns the entrance and keeps boot still, so the card never
      // starts one of its own.
      variants={shouldReduceMotion ? undefined : fadeItem}
      className="relative"
    >
      <button
        data-slot="promo-card-compact"
        onClick={activate}
        className={
          // `pr-8` (`pr-12` on a phone) is the room the × sits in, so the
          // arrow and the words never run under it. 60px on a phone: two lines
          // in a thumb-sized row.
          'bg-sidebar-accent/40 text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-ring flex w-full items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-left transition-colors duration-(--dur-fast) max-md:min-h-15 max-md:pr-12'
        }
      >
        {/* On the panel's 16px edge with the switcher, Find and the footer
            (Phase 4 S3): the card pays 8, the slot 8. */}
        <Icon className={`${SIDEBAR_ICON_CONTROL} shrink-0`} />
        <span className="min-w-0 flex-1">
          {/* `/90` and `/70`: the title is what the eye lands on and the line
              under it is the aside, and both clear 4.5:1 on the sidebar in
              both themes, measured by the sidebar showcase's axe gate. */}
          <span className="text-sidebar-foreground/90 text-control block truncate font-medium">
            {promo.content.title}
          </span>
          <span className="text-2xs block truncate">{promo.content.shortDescription}</span>
        </span>
        {/* The line's own ink, at full strength: at 60% it was 2.58:1 on the
            light panel, under the 3:1 a glyph needs (Phase 4 B5). */}
        <ArrowRight className={`${SIDEBAR_ICON_INLINE} shrink-0`} />
      </button>
      {/* **The way out is a real button, as strong as the words** (Phase 4
          B5). It was an 18px glyph at 40% ink and 70% opacity, 1.81:1 — the
          weakest control on screen, on the one thing an offer must make easy.
          `ghost icon-xs`: 24px with a mouse, 44 with a thumb; always shown,
          because a touch screen has no hover to find it with. A sibling of the
          card's button, never inside it: nesting one is invalid HTML. */}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => dismissPromo(promo.id)}
        aria-label="Dismiss"
        className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/70 focus-ring absolute top-1/2 right-1 -translate-y-1/2 max-md:right-0"
      >
        <X className={SIDEBAR_ICON_INLINE} />
      </Button>
      {dialog}
    </motion.div>
  );
}
