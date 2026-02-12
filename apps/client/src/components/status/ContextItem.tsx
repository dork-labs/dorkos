import { Layers } from 'lucide-react';

interface ContextItemProps {
  percent: number;
}

export function ContextItem({ percent }: ContextItemProps) {
  const colorClass =
    percent >= 95 ? 'text-red-500' : percent >= 80 ? 'text-amber-500' : '';

  return (
    <span className={`inline-flex items-center gap-1 ${colorClass}`}>
      <Layers className="h-3 w-3" />
      <span>{percent}%</span>
    </span>
  );
}
