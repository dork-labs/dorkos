import { useNavigate } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { useAttentionItems, AttentionItemRow } from '@/layers/features/dashboard-attention';
import { PulseSection } from './PulseSection';

/** Max attention rows shown in the Pulse teaser (overflow lives on the dashboard). */
const PULSE_ATTENTION_CAP = 5;

/**
 * Stagger container that drives the {@link AttentionItemRow} entrance variants.
 * The rows declare `variants` but no `animate` of their own, so — exactly as the
 * dashboard's NeedsAttentionSection does — the parent must propagate the
 * `animate` label or the rows would render stuck at their initial (invisible)
 * variant.
 */
const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/**
 * The "Needs attention" section of the Pulse panel: the top few items that need
 * the operator — stalled sessions, failed runs, dead letters, offline agents —
 * reusing the dashboard's {@link useAttentionItems} model and
 * {@link AttentionItemRow} rendering so there is one implementation. Capped to a
 * teaser; "View all →" opens the dashboard where the full zone and its detail
 * sheets live. Collapses to a calm all-clear line when nothing needs you.
 */
export function PulseAttentionSection() {
  const navigate = useNavigate();
  const { items, isLoading } = useAttentionItems();
  const shown = items.slice(0, PULSE_ATTENTION_CAP);

  return (
    <PulseSection
      label="Needs attention"
      // Only declare all-clear once the backing queries have loaded — never mid
      // cold-load, which would flash "All quiet" before an attention item pops in
      // (mirrors PulseActivitySection's loading gate).
      empty={!isLoading && items.length === 0}
      allClear="All quiet — nothing needs you."
      action={
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => navigate({ to: '/' })}
        >
          View all →
        </Button>
      }
    >
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {shown.map((item) => (
          <AttentionItemRow key={item.id} item={item} />
        ))}
      </motion.div>
    </PulseSection>
  );
}
