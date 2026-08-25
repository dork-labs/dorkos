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
  /** Dave's bubble fills with the brand accent; everyone else gets the dark card. */
  own: '#e85d04',
} as const;
