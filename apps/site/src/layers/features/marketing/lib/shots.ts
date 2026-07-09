import manifest from '../../../../../public/product/manifest.json';

/**
 * The product-media shot registry, as published by the capture pipeline. The
 * pipeline (`apps/e2e/capture/shots.ts`) is the source of truth; it writes the
 * registry snapshot into `public/product/manifest.json` (`shots`), which this
 * module reads so the marketing site and docs stay consistent with the pipeline
 * without importing across the app boundary. A guard test asserts the marketing
 * `ProductSurface` union and `LOOP_SURFACES` still match this registry.
 *
 * @module marketing/lib/shots
 */

/** Who consumes a shot. Only `marketing` shots appear in the feature catalog. */
export type ShotConsumer = 'marketing' | 'docs' | 'changelog';

/** Still-only, or a still plus an animated dark loop. */
export type ShotKind = 'still' | 'loop';

/** Device framing — `desktop` renders in browser chrome, `mobile` in a phone shell. */
export type ShotFrame = 'desktop' | 'mobile';

/** One registered shot, as read from the published manifest. */
export interface ProductShotMeta {
  readonly id: string;
  readonly kind: ShotKind;
  readonly frame: ShotFrame;
  readonly consumers: readonly ShotConsumer[];
}

/** Every registered shot (marketing, docs, and changelog). */
export const PRODUCT_SHOTS: readonly ProductShotMeta[] = (manifest as { shots?: ProductShotMeta[] })
  .shots as readonly ProductShotMeta[];

/** Index of shots by id. */
const BY_ID = new Map<string, ProductShotMeta>(PRODUCT_SHOTS.map((s) => [s.id, s]));

/** Look up a shot by id, or `undefined` when it is not registered. */
export function getProductShot(id: string): ProductShotMeta | undefined {
  return BY_ID.get(id);
}

/** True when the shot exists and ships an animated loop. */
export function shotHasLoop(id: string): boolean {
  return getProductShot(id)?.kind === 'loop';
}

/** Every valid shot id (any consumer). */
export const PRODUCT_SHOT_IDS: readonly string[] = PRODUCT_SHOTS.map((s) => s.id);
