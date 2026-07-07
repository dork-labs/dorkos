import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { Feature, FeatureStatus, FeatureSpanKind } from '../lib/features';
import { CATEGORY_LABELS, PRODUCT_ACCENT, deriveFeatureSpan } from '../lib/features';
import { ProductFrame } from './ProductFrame';
import { ProductBadge } from './ProductBadge';

interface FeatureCardProps {
  feature: Feature;
  /**
   * Bento tile footprint, so the card can tune its media to the tile it fills.
   * Defaults to the feature's own derived span when rendered outside a bento.
   */
  span?: FeatureSpanKind;
}

const STATUS_STYLES: Record<FeatureStatus, string> = {
  ga: 'bg-emerald-100/60 text-emerald-900',
  beta: 'bg-amber-100/60 text-amber-900',
  'coming-soon': 'bg-warm-gray/10 text-warm-gray-light',
};

const STATUS_LABELS: Record<FeatureStatus, string> = {
  ga: 'Available',
  beta: 'Beta',
  'coming-soon': 'Coming Soon',
};

/**
 * Compact feature card for use in catalog grids.
 * Links to /features/[slug].
 */
export function FeatureCard({ feature, span }: FeatureCardProps) {
  const kind = span ?? deriveFeatureSpan(feature);
  const accent = PRODUCT_ACCENT[feature.product];
  // The flagship's wide tile earns its living loop; every other card stays a
  // still so the catalog reads calm and stays light.
  const isFlagship = kind === 'wide';
  const media = feature.media;
  const isPhone = media?.frame === 'phone';
  const isDesktopMedia = !!media && !isPhone;

  return (
    <Link
      href={`/features/${feature.slug}`}
      className={`border-warm-gray-light/20 ${accent.hover} transition-smooth group flex flex-col rounded-xl border bg-white/40 p-5 hover:shadow-sm`}
    >
      {isDesktopMedia && media && (
        // A landscape capture holds a fixed 16/10 frame so the screenshot reads
        // as a coherent slice, never zoom-cropped by a stretched-tall tile.
        <div className="mb-4">
          <ProductFrame
            surface={media.surface}
            alt={media.alt}
            crop={media.crop}
            size="card"
            animate={isFlagship}
          />
        </div>
      )}

      {isPhone && media && (
        // A portrait phone keeps its shape, centered above the text block.
        <div className="mb-4 flex justify-center">
          <ProductFrame surface={media.surface} alt={media.alt} frame="phone" size="card" />
        </div>
      )}

      <div className={media ? 'shrink-0' : 'flex flex-1 flex-col'}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ProductBadge product={feature.product} />
          <span className="text-warm-gray-light/70 rounded-full px-2 py-0.5 font-mono text-xs">
            {CATEGORY_LABELS[feature.category]}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-xs ${STATUS_STYLES[feature.status]}`}
          >
            {STATUS_LABELS[feature.status]}
          </span>
        </div>

        <h3 className="text-charcoal group-hover:text-brand-orange transition-smooth mb-1 font-mono text-base font-semibold">
          {feature.name}
        </h3>
        <p className={`text-warm-gray mb-4 text-sm leading-relaxed ${media ? '' : 'flex-1'}`}>
          {feature.tagline}
        </p>

        <div className="text-warm-gray-light group-hover:text-brand-orange transition-smooth flex items-center gap-1 font-mono text-xs">
          Learn more <ArrowRight size={10} />
        </div>
      </div>
    </Link>
  );
}
