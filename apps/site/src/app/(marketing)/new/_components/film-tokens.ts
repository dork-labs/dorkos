/**
 * The film's own values, transcribed for the web.
 *
 * Source of truth is `scenes/chat-ui.tsx` in the video project, lines 62-65 for
 * the cast rings and the `TaskCard` block for {@link DONE_GREEN}. Two of these
 * are deliberately NOT in `brand.tokens.json`: the token file's agent trio is
 * violet/teal/green, but a recolour pass moved Otto off pure accent so his ring
 * reads distinctly from Dave's, and moved Hal to butter yellow because
 * blue-green collided with Pip and anything dark or red-adjacent dulled his one
 * red eye. What is on screen in the film is what matters here, so these are
 * hard-coded with this comment rather than imported from the token file.
 *
 * Open question for the brand owner: promote `agent-otto` and `agent-hal` into
 * `brand.tokens.json` so the site and the film stop being two sources of truth.
 */

/**
 * Every pixel value in the film is authored against a 1080px short edge, where
 * the panel has to be readable in a muted feed at thumbnail size: 132px avatars
 * against 46px body type. On a page read at arm's length those numbers are
 * roughly three times too big.
 *
 * This is the one factor that converts them, kept in one place so the port
 * cannot drift component by component. 46px body type becomes ~15px.
 *
 * It is a guide, not a law: type below about 10px stops being readable no
 * matter what the ratio says, so small labels are floored at the site's own
 * `text-2xs` instead of scaled all the way down. Those floors are marked where
 * they happen.
 */
const FILM_SCALE = 0.34;

/** Convert an authored 1080p pixel value to its web size. */
export function filmPx(authored: number): number {
  return Math.round(authored * FILM_SCALE);
}

/**
 * The chat panel's dark surface, straight from `ChatPanel`.
 *
 * The panel stays dark and modern on a cream page, and that is the point:
 * the film's hardest rule is that Dave's office is 1999 and the DorkOS chat is
 * not. The retro lives in the story and the photography. The moment the product
 * UI looks period, the argument inverts from "even this guy can do this" into
 * "this software is old".
 */
export const PANEL = {
  surface: 'rgba(16, 16, 16, 0.94)',
  border: 'rgba(255, 255, 255, 0.10)',
  hairline: 'linear-gradient(90deg, #e85d04, #cf722b 55%, transparent)',
  bubble: 'rgba(38, 38, 38, 0.96)',
  bubbleBorder: 'rgba(255, 255, 255, 0.10)',
  divider: 'rgba(255, 255, 255, 0.08)',
  text: '#ffffff',
  textMuted: '#7a756a',
  /**
   * Small labels on the dark surfaces: the typing dots, the localhost caption.
   *
   * Was written as `--cream-dim`, a custom property this site has never
   * defined — Tailwind emitted `color: var(--cream-dim)` with no fallback, the
   * declaration was invalid at computed-value time, and the caption silently
   * inherited charcoal while the typing dots lost their background entirely.
   * The value is the one the storyboard's palette calls "Cream dim"; it lives
   * here, with the rest of the film's transcribed values, rather than being
   * added to the site's global tokens, because nothing outside this page uses
   * it.
   */
  dim: '#a49c8e',
  /** Dave's bubble fills with the brand accent; everyone else gets the dark card. */
  own: '#e85d04',
} as const;

/**
 * Dave's room, transcribed from `DorkSpace` in `chat-ui.tsx`.
 *
 * Three layers over near-black: the cubicle plate at 55%, a warm centre glow,
 * and a vignette that closes the edges down. The film added this because its
 * four middle beats used to sit on flat black, and "four hard cuts between four
 * black frames read as a slide deck with a voiceover over it."
 *
 * The blur is baked into the JPEG (ffmpeg, sigma 30, two stops down) rather
 * than applied in CSS, which is why the plate is 40KB and why nothing here
 * asks the browser for a `filter: blur()`.
 */
export const ROOM = {
  base: '#0b0b0b',
  plateOpacity: 0.55,
  glow: 'radial-gradient(60% 55% at 50% 45%, #e85d041f 0%, transparent 70%)',
  vignette: 'radial-gradient(75% 75% at 50% 50%, transparent 35%, rgba(0,0,0,0.72) 100%)',
  /** The brand off-white, warmer than pure white. */
  text: '#fffefb',
  muted: '#7a756a',
} as const;
