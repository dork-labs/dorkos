import { PhilosophyCard } from './PhilosophyCard';
import type { PhilosophyItem } from '../lib/types';

interface PhilosophyGridProps {
  items: PhilosophyItem[];
  title?: string;
}

export function PhilosophyGrid({ items, title = 'Principles' }: PhilosophyGridProps) {
  return (
    <section id="philosophy" className="bg-cream-primary px-6 py-24">
      <div className="mx-auto max-w-4xl">
        {/* Section Header */}
        <h2 className="text-charcoal mb-16 text-center text-3xl font-semibold md:text-4xl">
          {title}
        </h2>

        {/* Grid */}
        <div className="grid grid-cols-1 gap-12 md:grid-cols-3 md:gap-8">
          {items.map((item) => (
            <PhilosophyCard key={item.number} item={item} />
          ))}
        </div>
      </div>
    </section>
  );
}
