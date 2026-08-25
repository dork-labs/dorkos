/**
 * The page runs on the site's own warm palette, not a theme of its own.
 *
 * An earlier pass gave this page a charcoal "night shift" of its own invention.
 * It is gone: the cream-and-charcoal scheme the rest of dorkos.ai already uses
 * is the one that sits with the film's 1999 office, and a page that ships its
 * own colour system is a second brand to keep in step. Everything here reaches
 * for the site's Tailwind tokens (`cream-primary`, `charcoal`, `warm-gray`,
 * `brand-orange`) instead.
 *
 * The one surface that does not is the chat panel, which stays the film's dark
 * glass. See `film-tokens.ts` for why that is the rule and not the exception.
 */

/** The one command the whole page asks the visitor to run. */
export const INSTALL_COMMAND = 'npx dorkos@latest';

/** Laptop shell colours, shared by the bezel and its base. */
export const SHELL = {
  bezel: '#d8d2c4',
  baseTop: '#e5dcc8',
  baseBottom: '#cdc5b4',
  foot: '#b9b0a0',
} as const;
