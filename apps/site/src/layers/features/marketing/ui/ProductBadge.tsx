import { PRODUCT_ACCENT, PRODUCT_LABELS, type FeatureProduct } from '../lib/features';

interface ProductBadgeProps {
  /** Product family to label and color-key. */
  product: FeatureProduct;
}

/**
 * The color-keyed product badge, shared by feature cards and detail pages.
 *
 * Carries the family accent as a filled dot plus a tinted border while keeping
 * the label text neutral for legibility — wayfinding, not decoration.
 *
 * @param product - Product family whose label and accent to render.
 */
export function ProductBadge({ product }: ProductBadgeProps) {
  const accent = PRODUCT_ACCENT[product];
  return (
    <span
      className={`text-warm-gray inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs ${accent.border}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} aria-hidden="true" />
      {PRODUCT_LABELS[product]}
    </span>
  );
}
