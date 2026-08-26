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

/**
 * The drawn MacBook's colours: dark anodised aluminium, not cream.
 *
 * The cream shell above is the page's own palette wearing a laptop shape. This
 * one is the machine as it actually looks, because the beat it appears in only
 * works if the visitor recognises their own computer, and nobody's computer is
 * the colour of this page's background. Dark also does the contrast work for
 * free: the chat panel is near-black glass, and a near-black enclosure around
 * it means the only bright thing in the frame is the conversation.
 *
 * Every value is sampled off a space-black enclosure under soft light: the lid
 * is the darkest face, the deck catches more of it, and the front edge catches
 * most of all, which is the gradient that stops the deck reading as a flat
 * rectangle.
 */
export const MACBOOK = {
  /** The lid's back and its bezel. */
  lid: '#1c1c1f',
  /** Highlight along the lid's top edge, where the light catches the chamfer. */
  lidEdge: 'rgba(255,255,255,0.16)',
  /** The display when nothing is on it yet. */
  glass: '#0a0a0c',
  /** The dark band between lid and deck. */
  hinge: '#131316',
  /** The deck, from the hinge end to the front lip. */
  deckBack: '#212124',
  deckFront: '#3a3a3f',
  /** The recess the keys sit in. */
  well: '#0d0d0f',
  /** A key top, and the light that catches its front edge. */
  key: '#1a1a1d',
  keyEdge: 'rgba(255,255,255,0.07)',
  /** The speaker grilles' perforations. */
  speaker: 'rgba(0,0,0,0.55)',
  /** The trackpad: glass a shade cooler than the deck, with a machined seam. */
  trackpad: 'rgba(255,255,255,0.022)',
  trackpadEdge: 'rgba(0,0,0,0.35)',
  /** What the machine sits on. */
  shadow: 'rgba(64,54,38,0.28)',
} as const;
