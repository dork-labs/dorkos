import type { CSSProperties } from 'react';

/**
 * The night palette, scoped to this page via CSS custom properties on the
 * page root. This is the brand's cream-on-charcoal identity inverted —
 * the "night shift" of the homepage — so nothing here leaks into globals.
 */
export const NIGHT_VARS = {
  '--pitch': '#131110',
  '--panel': '#1c1917',
  '--panel-raised': '#26211c',
  '--cream': '#f5f0e6',
  '--cream-dim': '#a49c8e',
  '--line': 'rgba(245, 240, 230, 0.09)',
  '--ember': '#e85d04',
} as CSSProperties;

/** The one command the whole page asks the visitor to run. */
export const INSTALL_COMMAND = 'npx dorkos@latest';

/** Laptop shell colors, shared by the bezel and its base. */
export const SHELL = {
  bezel: '#2b2620',
  baseTop: '#332d26',
  baseBottom: '#211d18',
  foot: '#171310',
} as const;
