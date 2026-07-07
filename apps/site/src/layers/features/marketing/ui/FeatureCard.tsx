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
 * Benefits previewed on a text-only card. A media tile carries its weight with
 * a screenshot; a text-only card fills the same stretched tile height with a
 * few concrete benefits instead of dead space.
 */
const TEXT_CARD_BENEFITS = 3;

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
  // A text-only card previews benefits so it reads as intentional — not empty —
  // when the row stretches it to match a taller media sibling.
  const benefits = media ? [] : feature.benefits.slice(0, TEXT_CARD_BENEFITS);

  return (
    <Link
      href={`/features/${feature.slug}`}
      // `h-full` fills the stretched grid cell; the text block below is the only
      // part that grows, so a fixed-aspect capture is never zoom-cropped.
      className={`border-warm-gray-light/20 ${accent.hover} transition-smooth group flex h-full flex-col rounded-xl border bg-white/40 p-5 hover:shadow-sm`}
    >
      {isDesktopMedia && media && (
        // A landscape capture holds a fixed 16/10 frame so the screenshot reads
        // as a coherent slice; `shrink-0` keeps it that height as the card grows.
        <div className="mb-4 shrink-0">
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
        <div className="mb-4 flex shrink-0 justify-center">
          <ProductFrame surface={media.surface} alt={media.alt} frame="phone" size="card" />
        </div>
      )}

      <div className="flex flex-1 flex-col">
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
        <p className="text-warm-gray mb-4 text-sm leading-relaxed">{feature.tagline}</p>

        {benefits.length > 0 && (
          <ul className="text-warm-gray-light mb-4 space-y-1.5">
            {benefits.map((benefit) => (
              <li key={benefit} className="flex items-start gap-2 text-xs leading-relaxed">
                <span
                  className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${accent.dot}`}
                  aria-hidden="true"
                />
                {benefit}
              </li>
            ))}
          </ul>
        )}

        <div className="text-warm-gray-light group-hover:text-brand-orange transition-smooth mt-auto flex items-center gap-1 font-mono text-xs">
          Learn more <ArrowRight size={10} />
        </div>
      </div>
    </Link>
  );
}
