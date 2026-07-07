import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { features, BENTO_SPAN_CLASS, deriveFeatureSpan } from '../lib/features';
import { FeatureCard } from './FeatureCard';

/**
 * Homepage teaser section — shows featured features in a 3-column grid with
 * a link to the full /features catalog.
 *
 * Only renders features with `featured: true`. Maximum 6 per spec.
 */
export function FeatureCatalogSection() {
  const featuredFeatures = features.filter((f) => f.featured);

  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="mb-10 flex items-end justify-between">
        <div>
          <h2 className="text-charcoal font-mono text-3xl font-bold tracking-tight">
            Built for how you actually work
          </h2>
          <p className="text-warm-gray mt-2 text-lg">
            Every subsystem designed to get out of the way.
          </p>
        </div>
        <Link
          href="/features"
          className="text-warm-gray-light hover:text-brand-orange transition-smooth hidden items-center gap-1.5 font-mono text-sm sm:flex"
        >
          All features <ArrowRight size={14} />
        </Link>
      </div>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:auto-rows-[minmax(9rem,auto)] lg:grid-cols-3">
        {featuredFeatures.map((feature) => {
          const span = deriveFeatureSpan(feature);
          return (
            <li key={feature.slug} className={BENTO_SPAN_CLASS[span]}>
              <FeatureCard feature={feature} span={span} />
            </li>
          );
        })}
      </ul>

      <div className="mt-8 sm:hidden">
        <Link
          href="/features"
          className="text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center gap-1.5 font-mono text-sm"
        >
          View all features <ArrowRight size={14} />
        </Link>
      </div>
    </section>
  );
}
