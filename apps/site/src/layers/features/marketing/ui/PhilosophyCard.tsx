import type { PhilosophyItem } from '../lib/types';

interface PhilosophyCardProps {
  item: PhilosophyItem;
}

export function PhilosophyCard({ item }: PhilosophyCardProps) {
  return (
    <div className="text-left">
      {/* Number - Green per mockup */}
      <span className="text-2xs text-brand-green mb-4 block font-mono tracking-[0.1em]">
        {item.number}
      </span>

      {/* Title */}
      <h3 className="text-charcoal mb-3 text-lg font-semibold tracking-[-0.01em]">{item.title}</h3>

      {/* Description */}
      <p className="text-warm-gray text-sm leading-[1.7]">{item.description}</p>
    </div>
  );
}
