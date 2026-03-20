import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { Feature } from '../lib/features';
import { CATEGORY_LABELS } from '../lib/features';

interface FeatureCardProps {
  feature: Feature;
}

const STATUS_STYLES: Record<string, string> = {
  ga: 'bg-emerald-100/60 text-emerald-900',
  beta: 'bg-amber-100/60 text-amber-900',
  'coming-soon': 'bg-warm-gray/10 text-warm-gray-light',
};

const STATUS_LABELS: Record<string, string> = {
  ga: 'Available',
  beta: 'Beta',
  'coming-soon': 'Coming Soon',
};

/**
 * Compact feature card for use in catalog grids.
 * Links to /features/[slug].
 */
export function FeatureCard({ feature }: FeatureCardProps) {
  return (
    <Link
      href={`/features/${feature.slug}`}
      className="border-warm-gray-light/20 hover:border-warm-gray-light/50 hover:shadow-sm transition-smooth group flex flex-col rounded-xl border bg-white/40 p-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="text-warm-gray-light border-warm-gray-light/30 rounded-full border px-2 py-0.5 font-mono text-xs">
          {CATEGORY_LABELS[feature.category]}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-xs ${STATUS_STYLES[feature.status] ?? ''}`}
        >
          {STATUS_LABELS[feature.status] ?? feature.status}
        </span>
      </div>

      <h3 className="text-charcoal group-hover:text-brand-orange transition-smooth mb-1 font-mono text-base font-semibold">
        {feature.name}
      </h3>
      <p className="text-warm-gray mb-4 flex-1 text-sm leading-relaxed">{feature.tagline}</p>

      <div className="text-warm-gray-light group-hover:text-brand-orange transition-smooth flex items-center gap-1 font-mono text-xs">
        Learn more <ArrowRight size={10} />
      </div>
    </Link>
  );
}
