import { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import type { PromoDefinition, PromoPlacement } from '../model/promo-types';
import { PromoDialog } from './PromoDialog';

const staggerItem = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
} as const;

interface PromoCardProps {
  /** The promo definition to render. */
  promo: PromoDefinition;
  /** The placement slot — determines standard vs compact format. */
  placement: PromoPlacement;
}

/**
 * Individual promo card — renders in standard or compact format
 * based on the placement slot.
 *
 * - Standard (`dashboard-main`): `rounded-xl p-6`, icon, title, description, CTA, dismiss button
 * - Compact (`dashboard-sidebar`, `agent-sidebar`): `rounded-lg px-3 py-2.5`, no dismiss button
 */
export function PromoCard({ promo, placement }: PromoCardProps) {
  const dismissPromo = useAppStore((s) => s.dismissPromo);
  const [dialogOpen, setDialogOpen] = useState(false);
  const isCompact = placement === 'dashboard-sidebar' || placement === 'agent-sidebar';
  const Icon = promo.content.icon;

  const handleClick = () => {
    if (promo.action.type === 'dialog' || promo.action.type === 'open-dialog') {
      setDialogOpen(true);
    } else if (promo.action.type === 'navigate') {
      window.location.href = promo.action.to;
    } else if (promo.action.type === 'action') {
      promo.action.handler();
    }
  };

  if (isCompact) {
    return (
      <motion.div variants={staggerItem} layout>
        <button
          data-slot="promo-card-compact"
          onClick={handleClick}
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
        {promo.action.type === 'dialog' && (
          <PromoDialog promo={promo} open={dialogOpen} onOpenChange={setDialogOpen} />
        )}
        {promo.action.type === 'open-dialog' && (
          <promo.action.component open={dialogOpen} onOpenChange={setDialogOpen} />
        )}
      </motion.div>
    );
  }

  // Standard format (dashboard-main)
  return (
    <motion.div variants={staggerItem} layout>
      <div
        role="button"
        tabIndex={0}
        data-slot="promo-card"
        className={cn(
          'group border-border bg-card shadow-soft card-interactive hover:bg-accent relative w-full cursor-pointer rounded-xl border p-4 text-left transition-colors'
        )}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        {/* Dismiss button — visible on hover via group/focus-visible */}
        <button
          type="button"
          aria-label="Dismiss suggestion"
          onClick={(e) => {
            e.stopPropagation();
            dismissPromo(promo.id);
          }}
          className="text-muted-foreground hover:text-foreground absolute top-3 right-3 rounded-sm p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>

        <div className="bg-muted flex size-8 items-center justify-center rounded-md">
          <Icon className="text-muted-foreground size-4" />
        </div>
        <p className="mt-2 text-sm font-medium">{promo.content.title}</p>
        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
          {promo.content.shortDescription}
        </p>
        <span className="text-muted-foreground mt-2 inline-flex items-center gap-1 text-xs font-medium">
          {promo.content.ctaLabel}
          <ArrowRight className="size-3" />
        </span>
      </div>
      {promo.action.type === 'dialog' && (
        <PromoDialog promo={promo} open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
      {promo.action.type === 'open-dialog' && (
        <promo.action.component open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
    </motion.div>
  );
}
