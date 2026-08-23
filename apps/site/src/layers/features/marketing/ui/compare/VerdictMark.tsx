import { Check, Minus, X } from 'lucide-react';
import type { CapabilityVerdict } from '../../lib/comparisons';

const VERDICT_LABEL: Record<CapabilityVerdict, string> = {
  yes: 'Yes',
  partial: 'Partly',
  no: 'No',
};

const VERDICT_STYLE: Record<CapabilityVerdict, string> = {
  yes: 'bg-brand-green/10 text-brand-green',
  partial: 'bg-brand-orange/10 text-brand-orange',
  no: 'bg-warm-gray/10 text-warm-gray',
};

const VERDICT_ICON: Record<CapabilityVerdict, typeof Check> = {
  yes: Check,
  partial: Minus,
  no: X,
};

/**
 * A small yes / partly / no chip. The word is always visible, so the answer
 * never depends on reading a colour or an icon.
 *
 * @param verdict - The scored answer for one product on one dimension.
 */
export function VerdictMark({ verdict }: { verdict: CapabilityVerdict }) {
  const Icon = VERDICT_ICON[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-xs ${VERDICT_STYLE[verdict]}`}
    >
      <Icon size={12} strokeWidth={2.5} aria-hidden="true" />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}
