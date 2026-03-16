import { DollarSign } from 'lucide-react';

interface CostItemProps {
  costUsd: number;
}

/** Status bar item displaying the session cost in USD. */
export function CostItem({ costUsd }: CostItemProps) {
  return (
    <span className="inline-flex items-center gap-1">
      <DollarSign className="size-(--size-icon-xs)" />
      <span>${costUsd.toFixed(2)}</span>
    </span>
  );
}
