/**
 * Brand constants — canonical color values for DorkOS brand identity.
 *
 * @module icons/brand
 */

/** Core brand palette. */
export const BRAND_COLORS = {
  orange: '#E85D04',
  green: '#228B22',
  blue: '#4A90A4',
  purple: '#8B7BA4',
  charcoal: '#1A1A1A',
  red: '#CE2021',
} as const;

/** Logo color variants keyed by usage context. */
export const LOGO_COLORS = {
  default: '#1A1A1A',
  white: '#FFFFFF',
  orange: '#CE2021',
  current: 'currentColor',
} as const;

export type LogoVariant = keyof typeof LOGO_COLORS;
