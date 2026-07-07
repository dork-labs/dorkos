'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  BENTO_SPAN_CLASS,
  PRODUCT_ACCENT,
  PRODUCT_LABELS,
  deriveFeatureSpan,
  type Feature,
  type FeatureProduct,
} from '../lib/features';
import { FeatureCard } from './FeatureCard';

const VALID_PRODUCTS = Object.keys(PRODUCT_LABELS) as FeatureProduct[];

/**
 * Catalog reflow timing — a quick, non-lingering tween in the site's easeOut
 * idiom (mirrors `REVEAL_TRANSITION`, a touch faster so a filter feels instant).
 */
const REFLOW_TRANSITION = { duration: 0.28, ease: 'easeOut' } as const;

/** Reduced-motion path — swap instantly, with no reflow, scale, or fade. */
const INSTANT_TRANSITION = { duration: 0 } as const;

/** Enter/exit state for a card fading and settling into the bento. */
const CARD_HIDDEN = { opacity: 0, scale: 0.96 };
const CARD_VISIBLE = { opacity: 1, scale: 1 };

/** Fallback sortOrder for features that don't declare one — sorts them last. */
const UNORDERED = 999;

/** Sort a filtered slice the way the catalog reads: by product (tab order), then sortOrder. */
function sortByOrder(list: Feature[]): Feature[] {
  return [...list].sort((a, b) => {
    if (a.product !== b.product) {
      // Explicit product tiebreaker so the "All" grouping never depends on the
      // catalog array's incidental ordering.
      return VALID_PRODUCTS.indexOf(a.product) - VALID_PRODUCTS.indexOf(b.product);
    }
    return (a.sortOrder ?? UNORDERED) - (b.sortOrder ?? UNORDERED);
  });
}

/** Read the active product from a URL query, or null when absent/invalid. */
function productFromSearch(search: string): FeatureProduct | null {
  const value = new URLSearchParams(search).get('product');
  return value && VALID_PRODUCTS.includes(value as FeatureProduct)
    ? (value as FeatureProduct)
    : null;
}

interface FeatureCatalogProps {
  /**
   * The complete catalog. Filtering happens client-side (not by re-fetching the
   * page) so a tab change can animate the cards to their new positions.
   */
  features: Feature[];
  /** Product active on first paint, from `?product=` — for SSR and shareable links. */
  initialProduct: FeatureProduct | null;
}

/**
 * The `/features` catalog: a product tab strip over an animated bento grid.
 *
 * Tabs stay real links (no-JS and SEO keep working via the server `?product=`
 * filter); with JS we intercept, filter in place, and reflow with a FLIP
 * layout animation. The grid gives portrait and flagship captures deliberate
 * spans so ragged media heights read as composition. Honors reduced motion by
 * swapping instantly with no layout animation.
 *
 * @param features - The full feature catalog to filter client-side.
 * @param initialProduct - Active product on first paint, from the URL.
 */
export function FeatureCatalog({ features, initialProduct }: FeatureCatalogProps) {
  const [activeProduct, setActiveProduct] = useState<FeatureProduct | null>(initialProduct);
  const reducedMotion = useReducedMotion();

  // Keep filter state in step with Back/Forward for shareable, navigable URLs.
  useEffect(() => {
    const onPopState = () => setActiveProduct(productFromSearch(window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const selectProduct = useCallback((product: FeatureProduct | null) => {
    setActiveProduct(product);
    const url = product ? `/features?product=${product}` : '/features';
    // Sync the URL without a server round-trip that would interrupt the
    // animation; Next keeps usePathname/useSearchParams in step with this.
    window.history.replaceState(null, '', url);
  }, []);

  const visible = sortByOrder(
    activeProduct ? features.filter((f) => f.product === activeProduct) : features
  );

  return (
    <>
      <nav className="mb-10 flex flex-wrap gap-2" aria-label="Filter by product">
        <ProductTab
          href="/features"
          active={activeProduct === null}
          label="All"
          onSelect={() => selectProduct(null)}
        />
        {VALID_PRODUCTS.map((prod) => (
          <ProductTab
            key={prod}
            href={`/features?product=${prod}`}
            active={activeProduct === prod}
            label={PRODUCT_LABELS[prod]}
            dot={PRODUCT_ACCENT[prod].dot}
            onSelect={() => selectProduct(prod)}
          />
        ))}
      </nav>

      {visible.length === 0 ? (
        <p className="text-warm-gray-light text-sm">No features in this category yet.</p>
      ) : (
        <ul className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:auto-rows-[minmax(9rem,auto)] lg:grid-cols-3">
          <AnimatePresence mode="popLayout" initial={false}>
            {visible.map((feature) => {
              const span = deriveFeatureSpan(feature);
              return (
                <motion.li
                  key={feature.slug}
                  // Position-only layout: reflow translates cards without
                  // scaling, so media and the flagship loop never distort.
                  layout={reducedMotion ? false : 'position'}
                  className={BENTO_SPAN_CLASS[span]}
                  initial={reducedMotion ? false : CARD_HIDDEN}
                  animate={CARD_VISIBLE}
                  exit={reducedMotion ? { opacity: 0 } : CARD_HIDDEN}
                  transition={reducedMotion ? INSTANT_TRANSITION : REFLOW_TRANSITION}
                >
                  <FeatureCard feature={feature} span={span} />
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </>
  );
}

interface ProductTabProps {
  href: string;
  active: boolean;
  label: string;
  dot?: string;
  onSelect: () => void;
}

function ProductTab({ href, active, label, dot, onSelect }: ProductTabProps) {
  return (
    <Link
      href={href}
      scroll={false}
      onClick={(e) => {
        // Let modified clicks (new tab, etc.) and non-primary buttons behave as
        // real navigation; otherwise filter in place and animate.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onSelect();
      }}
      className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 font-mono text-xs tracking-[0.04em] transition-colors ${
        active
          ? 'bg-charcoal text-cream-primary'
          : 'border-warm-gray-light/30 text-warm-gray hover:text-charcoal border'
      }`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />}
      {label}
    </Link>
  );
}
