/**
 * The only module that imports `blockbuddies` (DOR-3065).
 *
 * It is reached by one dynamic `import()` in `./store`, so with the experiment
 * off the package is never fetched and the entry chunk does not grow.
 *
 * @module shared/lib/block-buddy/renderer
 */
import { css, genome, hashFromId, type BuddyGenome } from 'blockbuddies/genome';
import { render, stillOptions, type BuddyMode } from 'blockbuddies/render';

/** The most drawings kept: one agent in several states and sizes costs several. */
const MAX_DRAWINGS = 512;

const buddies = new Map<string, BuddyGenome | null>();
const drawings = new Map<string, string>();

/**
 * The one place an agent's id becomes a buddy's hash.
 *
 * **Temporary.** The design seeds from the agent's nickname (`nameHash`), and the
 * package does not ship names yet. The swap PR changes this function and nothing
 * else, and every face changes once. So the flag cannot default on before it
 * (DOR-3065), and nothing derived from this hash may be stored.
 *
 * @param seed - The agent's id.
 */
export function buddyHash(seed: string): string {
  return hashFromId(seed);
}

function buddyOf(seed: string): BuddyGenome | null {
  const known = buddies.get(seed);
  if (known !== undefined) return known;
  let buddy: BuddyGenome | null = null;
  try {
    buddy = genome(buddyHash(seed));
  } catch (error) {
    console.warn('[block-buddy] could not build a buddy', error);
  }
  buddies.set(seed, buddy);
  return buddy;
}

/**
 * The buddy's ground colour, or `null` when it cannot be drawn. The caller then
 * falls back to the face it would have drawn without a buddy.
 *
 * @param seed - The agent's id.
 */
export function buddyGround(seed: string): string | null {
  const buddy = buddyOf(seed);
  return buddy && css(buddy.derived.palette.ground);
}

/**
 * The SVG for one still pose, from a small cache. A state change swaps one cached
 * string.
 *
 * The package's accessible label and title are stripped: the face is decoration,
 * the row's own text names the agent, and a native `<title>` would pop a tooltip
 * saying "working" over a row. No user string reaches this output, because the
 * only input is a hash.
 *
 * @param seed - The agent's id.
 * @param size - The tile's side in pixels. Under 24 draws the mini face crop.
 * @param mode - The pose to hold.
 */
export function drawBuddy(seed: string, size: number, mode: BuddyMode): string | null {
  const key = `${seed}·${size}·${mode}`;
  const known = drawings.get(key);
  if (known !== undefined) {
    // Re-insert, so the map's order is least recently used first.
    drawings.delete(key);
    drawings.set(key, known);
    return known;
  }
  const buddy = buddyOf(seed);
  if (!buddy) return null;
  const svg = render(buddy, { ...stillOptions(mode), size })
    .replace(/ role="img"/, '')
    .replace(/ aria-label="[^"]*"/, '')
    .replace(/<title>[^<]*<\/title>/, '');
  if (drawings.size >= MAX_DRAWINGS) {
    const oldest = drawings.keys().next().value;
    if (oldest !== undefined) drawings.delete(oldest);
  }
  drawings.set(key, svg);
  return svg;
}
