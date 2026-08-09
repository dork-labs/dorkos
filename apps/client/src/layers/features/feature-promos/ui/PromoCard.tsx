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
 */
export function PromoCard({ promo }: PromoCardProps) {
  const { activate, dialog } = usePromoActivation(promo);
  const Icon = promo.content.icon;

  return (
    <motion.div variants={staggerItem} layout>
      <button
        data-slot="promo-card-compact"
        onClick={activate}
        className="border-border bg-card hover:bg-accent flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
      >
        <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
          <Icon className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{promo.content.title}</p>
          <p className="text-muted-foreground truncate text-[11px]">
            {promo.content.shortDescription}
          </p>
        </div>
        <ArrowRight className="text-muted-foreground size-3.5 shrink-0" />
      </button>
      {dialog}
    </motion.div>
  );
}
