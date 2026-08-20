import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight, X } from 'lucide-react';
import { usePromoDismissals } from '@/layers/entities/config';
import type { PromoDefinition } from '../model/promo-types';
import { usePromoActivation } from './use-promo-activation';

const staggerItem = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
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
 * and hover states exactly as `SidebarZone` and `SidebarRow` spell theirs: `/40`
 * at rest, `/70` under the pointer. `--muted` is deliberately absent for the
 * reason those two give — it is lighter than the panel in light mode and darker
 * in dark, so anything tinted with it separates in opposite directions between
 * the themes.
 *
 * The glyph sits in `SidebarRow`'s own 18px square rather than on a plate of its
 * own, so a card under Library lines its icon up with every row above it.
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
 *
 * **One ramp for both placements, deliberately.** The other surviving placement
 * is the Obsidian `EmbedSidebar`, whose panel is bordered and painted from
 * `--background` rather than `--sidebar`, so `--sidebar-accent` composites
 * against a slightly different backdrop there. The tint idiom is still the right
 * one — both placements are sidebars, and one ramp is the whole point of R1 —
 * and per-placement scoping is not worth its cost while the embed is a staged,
 * under-tested surface (AGENTS.md). Its adoption of the shared sidebar
 * primitives belongs to DOR-1080, which is where a real calibration pass over
 * that backdrop should happen rather than as a special case here.
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
      variants={shouldReduceMotion ? undefined : staggerItem}
      layout={!shouldReduceMotion}
      className="group/promo relative"
    >
      <button
        data-slot="promo-card-compact"
        onClick={activate}
        className="bg-sidebar-accent/40 text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring flex w-full items-center gap-2 rounded-md py-1.5 pr-7 pl-2 text-left outline-hidden transition-colors duration-150 focus-visible:ring-2"
      >
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          {/* `/90` and `/70`: the title is what the eye lands on and the line
              under it is the aside, and both clear 4.5:1 on the zone tint in
              both themes — the measurement `SidebarZone`'s heading records. */}
          <span className="text-sidebar-foreground/90 block truncate text-[13px] font-medium">
            {promo.content.title}
          </span>
          <span className="block truncate text-[11px]">{promo.content.shortDescription}</span>
        </span>
        <ArrowRight className="size-3.5 shrink-0 opacity-60" />
      </button>
      {/* Always present, never hover-only: a control you cannot see is one a
          touch screen cannot find, and this is the card's only way out. It
          fades UP on hover rather than in from nothing. */}
      <button
        type="button"
        onClick={() => dismissPromo(promo.id)}
        aria-label="Dismiss"
        className="text-sidebar-foreground/40 hover:text-sidebar-foreground focus-ring absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-0.5 opacity-70 transition-[color,opacity] duration-150 group-hover/promo:opacity-100"
      >
        <X className="size-3.5" />
      </button>
      {dialog}
    </motion.div>
  );
}
