import { DollarSign } from 'lucide-react';

interface CostItemProps {
  costUsd: number;
}

export function CostItem({ costUsd }: CostItemProps) {
  return (
    <span className="inline-flex items-center gap-1">
      <DollarSign className="h-3 w-3" />
      <span>${costUsd.toFixed(2)}</span>
    </span>
  );
}
