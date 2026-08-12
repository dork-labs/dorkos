import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
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
  const Icon = promo.content.icon;

  return (
    <motion.div variants={staggerItem} layout>
      <button
        data-slot="promo-card-compact"
        onClick={activate}
        className="bg-sidebar-accent/40 text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-hidden transition-colors duration-150 focus-visible:ring-2"
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
      {dialog}
    </motion.div>
  );
}
