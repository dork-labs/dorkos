/**
 * Types for `blockbuddies`, the Block Buddies genome and renderer (DOR-3065).
 *
 * The package ships no declarations of its own. This describes only what DorkOS
 * calls, from the package's README and the header comments of its source, not
 * the whole surface.
 *
 * @module types/blockbuddies
 */
declare module 'blockbuddies/genome' {
  /** An HSL colour as the genome stores it. */
  export interface BuddyColor {
    h: number;
    s: number;
    l: number;
  }

  /** One buddy's frozen features. DorkOS reads only the ground colour. */
  export interface BuddyGenome {
    hash: string;
    derived: { palette: { ground: BuddyColor } };
  }

  /** The buddy a hash always draws. */
  export function genome(hash: string): BuddyGenome;
  /** `"0x" + sha256(id)`. The same id always gives the same hash. */
  export function hashFromId(id: string): string;
  /** A genome colour as a CSS string. */
  export function css(color: BuddyColor): string;
}

declare module 'blockbuddies/render' {
  import type { BuddyGenome } from 'blockbuddies/genome';

  /** The states DorkOS draws. The package has more; they need data DorkOS lacks yet. */
  export type BuddyMode = 'idle' | 'working' | 'needs-you' | 'error' | 'offline';

  /** Options for a held pose. `size` is the tile's side in pixels. */
  export interface BuddyRenderOptions {
    size: number;
    [option: string]: unknown;
  }

  /** Which renderer drew it. A new one can change pixels, so upgrades are on purpose. */
  export const RENDERER_VERSION: string;
  /** The buddy as one SVG string. */
  export function render(buddy: BuddyGenome, options: BuddyRenderOptions): string;
  /** The options for a mode's still pose, as a list shows it: nothing loops. */
  export function stillOptions(mode: BuddyMode): Record<string, unknown>;
}
