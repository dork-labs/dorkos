/**
 * The vocabulary tolerance behind the generative-UI widget schema: the
 * synonyms, shorthands and number-like strings LLMs emit for widget fields
 * (`"row"` for a horizontal stack, `gap: 16`, `"danger"` for destructive),
 * coerced to the one token the renderer knows instead of failing the whole
 * widget. Split out of `ui-widget.ts` so the node catalog reads on its own;
 * every schema here is used only by `WidgetNodeSchema`.
 *
 * @module shared/ui-widget-vocabulary
 */
import { z } from 'zod';

/** Spacing tokens the renderer understands. */
const GAP_TOKENS = ['sm', 'md', 'lg'] as const;

/** Pixel cutoffs mapping a numeric gap to the sm/md/lg tokens (`<= sm` → sm, `<= md` → md, else lg). */
const GAP_PX_THRESHOLDS = { sm: 4, md: 12 } as const;

/**
 * Map an arbitrary spacing value to the nearest gap token.
 *
 * LLMs authoring widgets routinely emit a pixel number (`gap: 16`), a numeric
 * string (`"16"`), or a word synonym (`"medium"`) instead of the `sm|md|lg`
 * token. Rejecting those would fail the whole document over one spacing value,
 * so we coerce to the closest token instead — the renderer still only knows
 * three sizes, but a reasonable input renders reasonably.
 *
 * @param value - The raw `gap` value from the widget JSON.
 * @returns A gap token, or the original value (for zod to reject) if it can't be mapped.
 */
function coerceGap(value: unknown): unknown {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))
        ? Number(value)
        : null;
  if (numeric !== null) {
    if (numeric <= GAP_PX_THRESHOLDS.sm) return 'sm';
    if (numeric <= GAP_PX_THRESHOLDS.md) return 'md';
    return 'lg';
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'none' || s === 'xs' || s === 'small' || s === 'sm') return 'sm';
    if (s === 'medium' || s === 'normal' || s === 'md') return 'md';
    if (s === 'large' || s === 'xl' || s === 'xxl' || s === 'lg') return 'lg';
  }
  return value;
}

/** `sm|md|lg`, tolerant of the pixel numbers and synonyms LLMs emit (see {@link coerceGap}). */
export const gapSchema = z.preprocess(coerceGap, z.enum(GAP_TOKENS));

/**
 * Build a preprocessor mapping case-insensitive string synonyms to a canonical
 * token. Non-strings and unrecognized strings pass through unchanged for the
 * wrapped schema to validate — so agents can use natural vocabulary ("row",
 * "primary", "danger") without failing the whole widget over a synonym.
 *
 * @param map - Lowercase synonym → canonical token (include identity entries).
 */
export function synonymCoercer(map: Record<string, string>): (value: unknown) => unknown {
  return (value) => {
    if (typeof value !== 'string') return value;
    const key = value.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : value;
  };
}

/** Stack direction, tolerant of flexbox vocabulary ("row"/"column"). */
export const directionSchema = z.preprocess(
  synonymCoercer({
    vertical: 'vertical',
    vert: 'vertical',
    column: 'vertical',
    col: 'vertical',
    stack: 'vertical',
    horizontal: 'horizontal',
    horiz: 'horizontal',
    row: 'horizontal',
    inline: 'horizontal',
  }),
  z.enum(['vertical', 'horizontal'])
);

/** Button variant, tolerant of synonyms ("primary", "danger", "ghost"). */
export const variantSchema = z.preprocess(
  synonymCoercer({
    default: 'default',
    primary: 'default',
    secondary: 'secondary',
    destructive: 'destructive',
    danger: 'destructive',
    delete: 'destructive',
    outline: 'outline',
    ghost: 'outline',
    link: 'outline',
  }),
  z.enum(['default', 'secondary', 'destructive', 'outline'])
);

/** Chart kind, tolerant of synonyms ("column"→bar, "donut"→pie). */
export const chartKindSchema = z.preprocess(
  synonymCoercer({
    bar: 'bar',
    bars: 'bar',
    column: 'bar',
    columns: 'bar',
    histogram: 'bar',
    line: 'line',
    lines: 'line',
    area: 'area',
    pie: 'pie',
    donut: 'pie',
    doughnut: 'pie',
  }),
  z.enum(['bar', 'line', 'area', 'pie'])
);

/** stat delta direction, tolerant of synonyms ("increase"→up, "negative"→down). */
const deltaDirectionSchema = z.preprocess(
  synonymCoercer({
    up: 'up',
    increase: 'up',
    increased: 'up',
    positive: 'up',
    rise: 'up',
    rising: 'up',
    gain: 'up',
    down: 'down',
    decrease: 'down',
    decreased: 'down',
    negative: 'down',
    fall: 'down',
    falling: 'down',
    drop: 'down',
    loss: 'down',
    flat: 'flat',
    none: 'flat',
    neutral: 'flat',
    same: 'flat',
    unchanged: 'flat',
    steady: 'flat',
  }),
  z.enum(['up', 'down', 'flat'])
);

/** Heading level, tolerant of numeric strings; clamps to the 1-3 range. */
export const levelSchema = z.preprocess(
  (value) => {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))
          ? Number(value)
          : null;
    return n === null ? value : Math.min(3, Math.max(1, Math.round(n)));
  },
  z.union([z.literal(1), z.literal(2), z.literal(3)])
);

/**
 * stat `delta` — accepts the object shape and a bare string/number shorthand
 * (`delta: "+2°"` or `delta: -3`), and coerces direction synonyms. A missing
 * direction defaults to `flat`.
 */
export const deltaSchema = z.preprocess(
  (value) => {
    if (typeof value === 'string') return { value, direction: 'flat' };
    if (typeof value === 'number') {
      return { value, direction: value > 0 ? 'up' : value < 0 ? 'down' : 'flat' };
    }
    return value;
  },
  z.object({
    value: z.union([z.string(), z.number()]),
    direction: deltaDirectionSchema.default('flat'),
  })
);

/** Timeline item status, tolerant of natural progress vocabulary. */
export const timelineStatusSchema = z.preprocess(
  synonymCoercer({
    done: 'done',
    complete: 'done',
    completed: 'done',
    finished: 'done',
    past: 'done',
    active: 'active',
    current: 'active',
    now: 'active',
    'in-progress': 'active',
    in_progress: 'active',
    inprogress: 'active',
    ongoing: 'active',
    upcoming: 'upcoming',
    pending: 'upcoming',
    next: 'upcoming',
    todo: 'upcoming',
    future: 'upcoming',
    planned: 'upcoming',
  }),
  z.enum(['done', 'active', 'upcoming'])
);

/**
 * A boolean, tolerant of the truthy/falsy strings and 0/1 that LLMs emit for
 * flags like `checked` and `recommended` ("yes"/"checked"/1 → true,
 * "no"/0 → false). Unrecognized values pass through for zod to reject.
 */
export const flagSchema = z.preprocess((value) => {
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'checked') return true;
    if (s === 'false' || s === 'no' || s === 'unchecked') return false;
  }
  return value;
}, z.boolean());

/** `mood` emotion, tolerant of natural synonyms ("excited"→celebrating, "proud"→happy). */
export const moodEmotionSchema = z.preprocess(
  synonymCoercer({
    happy: 'happy',
    proud: 'happy',
    joy: 'happy',
    joyful: 'happy',
    glad: 'happy',
    thinking: 'thinking',
    confused: 'thinking',
    pondering: 'thinking',
    curious: 'thinking',
    hmm: 'thinking',
    celebrating: 'celebrating',
    excited: 'celebrating',
    party: 'celebrating',
    hyped: 'celebrating',
    sheepish: 'sheepish',
    embarrassed: 'sheepish',
    oops: 'sheepish',
    awkward: 'sheepish',
    shy: 'sheepish',
    determined: 'determined',
    focused: 'determined',
    serious: 'determined',
    resolute: 'determined',
    surprised: 'surprised',
    shocked: 'surprised',
    wow: 'surprised',
    amazed: 'surprised',
    'mind-blown': 'surprised',
    sad: 'sad',
    unhappy: 'sad',
    disappointed: 'sad',
    down: 'sad',
    love: 'love',
    heart: 'love',
    hearts: 'love',
    adore: 'love',
  }),
  z.enum(['happy', 'thinking', 'celebrating', 'sheepish', 'determined', 'surprised', 'sad', 'love'])
);

/** `reveal` kind, tolerant of synonyms ("flip"/"coinflip"→coin, "dice"/"die"→d6, magic-8-ball spellings→8ball). */
export const revealKindSchema = z.preprocess(
  synonymCoercer({
    coin: 'coin',
    flip: 'coin',
    coinflip: 'coin',
    d6: 'd6',
    dice: 'd6',
    die: 'd6',
    d20: 'd20',
    '8ball': '8ball',
    magic8ball: '8ball',
    '8-ball': '8ball',
    eightball: '8ball',
    'magic-8-ball': '8ball',
  }),
  z.enum(['coin', 'd6', 'd20', '8ball'])
);

/** `reveal.result`, tolerant of a bare number (dice/coin results often arrive numeric). */
export const revealResultSchema = z.preprocess(
  (value) => (typeof value === 'number' ? String(value) : value),
  z.string()
);

/** Grid dimension cap for `board` — LLMs occasionally emit an oversized grid; slice rather than reject. */
export const MAX_BOARD_DIM = 12;

/**
 * A `board` cell, tolerant of a bare string shorthand (`"X"`, `"O"`) — an empty
 * string coerces to a blank cell (`{}`) rather than a glyph of `""`.
 */
export function coerceBoardCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.trim() === '' ? {} : { glyph: value };
}

/**
 * A board cell's `glyph`, trimmed. Models routinely emit `glyph: " "` for an
 * empty square; a whitespace-only glyph is truthy downstream, so it rendered a
 * phantom mark, broke the cell's accessible name, and let the win-line detector
 * see a "line" of identical spaces across an empty board. Whitespace-only →
 * `undefined` (no glyph at all); the transform narrows the value without
 * changing the declared `string | undefined` type.
 */
export const boardGlyphSchema = z
  .string()
  .max(8)
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });
