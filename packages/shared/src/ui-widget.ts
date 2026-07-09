/**
 * Tier-1 generative-UI widget wire schema (`version: 1`).
 *
 * A catalog-constrained, declarative description of native UI an agent can emit
 * as a ` ```dorkos-ui ` fenced JSON block in ordinary assistant text (ADR
 * 260708-111500) or place in the canvas via `control_ui`. The client renders it
 * with host-owned shadcn components — there is no agent-authored code.
 *
 * We own this format rather than adopting json-render or A2UI (ADR
 * 260708-111501): widget JSON is persisted inside session transcripts, so the
 * wire shape is a long-term compatibility commitment. The `version` literal
 * gates future migrations; the flat, discriminated-union node catalog keeps a
 * later A2UI translation mechanical.
 *
 * @module shared/ui-widget
 */
import { z } from 'zod';
import { UiCommandSchema } from './schemas.js';

/** Visual tone shared by `badge` nodes and list-item badges. */
export const WidgetToneSchema = z.enum(['default', 'success', 'warning', 'error', 'info']);

/** Visual tone shared by `badge` nodes and list-item badges. */
export type WidgetTone = z.infer<typeof WidgetToneSchema>;

/**
 * The `agent`-kind action variant — the single definition, reused as the
 * discriminated-union member in {@link WidgetActionSchema} and required
 * standalone by `form` submit buttons.
 */
export const AgentWidgetActionSchema = z.object({
  kind: z.literal('agent'),
  /** Stable identifier the agent receives to know which action fired. */
  id: z.string().min(1),
  label: z.string().optional(),
  /** Literal payload; form field values are merged in at submit time. */
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** The `agent`-kind action variant (form submits). */
export type AgentWidgetAction = z.infer<typeof AgentWidgetActionSchema>;

/**
 * An interactive action a widget node can trigger. Discriminated on `kind`:
 * - `agent` — POSTed to `/api/sessions/:id/ui-action` and injected into the
 *   agent's next turn (channel ships in PR E; rendered disabled until then).
 * - `ui` — dispatched locally through `executeUiCommand`, no agent wake.
 * - `url` — opens an external https link via the link-safety modal.
 */
export const WidgetActionSchema = z.discriminatedUnion('kind', [
  AgentWidgetActionSchema,
  z.object({
    kind: z.literal('ui'),
    command: UiCommandSchema,
  }),
  z.object({
    kind: z.literal('url'),
    href: z
      .string()
      .url()
      .refine((href) => href.startsWith('https://'), {
        message: 'Widget URLs must be https',
      }),
  }),
]);

/** An interactive action a widget node can trigger (agent, ui, or url). */
export type WidgetAction = z.infer<typeof WidgetActionSchema>;

/** Scalar cell value permitted in a `table` row. */
export const WidgetCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** A single item in a `list` node. */
export interface WidgetListItem {
  title: string;
  subtitle?: string;
  /** Lucide icon name, resolved against the client's icon registry. */
  icon?: string;
  /** Leading thumbnail source (https or data URI only). */
  image?: string;
  /** Trailing metadata (e.g. a price or timestamp), right-aligned. */
  meta?: string;
  badge?: { text: string; tone?: WidgetTone };
  actions?: WidgetAction[];
}

/**
 * A single widget node — the discriminated union of the v1 catalog, recursive on
 * `children`/`footer`. Declared explicitly (rather than inferred) so it can
 * annotate the recursive {@link WidgetNodeSchema} and give the client renderer
 * exhaustive types.
 *
 * Forward-compat: growing the catalog (including skill-shipped templates later)
 * means adding a member here and to the schema union. An unknown `type` fails
 * document-level validation; the client renders the D5 error card, never crashes.
 */
export type WidgetNode =
  | {
      type: 'stack';
      direction: 'vertical' | 'horizontal';
      gap?: 'sm' | 'md' | 'lg';
      children: WidgetNode[];
    }
  | {
      type: 'card';
      title?: string;
      description?: string;
      children: WidgetNode[];
      footer?: WidgetNode[];
    }
  | { type: 'divider' }
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'text'; text: string }
  | { type: 'badge'; text: string; tone?: WidgetTone }
  | {
      type: 'stat';
      label: string;
      value: string | number;
      delta?: { value: string | number; direction: 'up' | 'down' | 'flat' };
      hint?: string;
      /** Optional series (≤50 points) drawn as an inline sparkline beside the value. */
      trend?: number[];
    }
  | { type: 'keyValue'; items: { key: string; value: string }[] }
  | { type: 'image'; src: string; alt: string; caption?: string }
  | { type: 'progress'; value: number; label?: string }
  | {
      type: 'table';
      columns: { key: string; label: string; align?: 'left' | 'center' | 'right' }[];
      rows: Record<string, string | number | boolean | null>[];
    }
  | { type: 'list'; items: WidgetListItem[] }
  | {
      type: 'chart';
      kind: 'bar' | 'line' | 'area' | 'pie';
      /** Data points. Values are non-negative in v1 (no zero-baseline handling). */
      data: { label: string; value: number }[];
      height?: number;
    }
  | {
      type: 'button';
      label: string;
      variant?: 'default' | 'secondary' | 'destructive' | 'outline';
      action: WidgetAction;
    }
  | {
      type: 'input';
      name: string;
      label?: string;
      placeholder?: string;
      kind?: 'text' | 'number';
    }
  | { type: 'select'; name: string; label?: string; options: { label: string; value: string }[] }
  | { type: 'form'; children: WidgetNode[]; submit: { label: string; action: AgentWidgetAction } }
  | {
      type: 'timeline';
      items: {
        time?: string;
        title: string;
        subtitle?: string;
        icon?: string;
        status?: 'done' | 'active' | 'upcoming';
      }[];
    }
  | {
      type: 'checklist';
      items: { label: string; checked?: boolean; note?: string }[];
      action?: AgentWidgetAction;
      submitLabel?: string;
    }
  | {
      type: 'compare';
      options: { name: string; recommended?: boolean }[];
      rows: { label: string; values: (string | number | boolean | null)[] }[];
    }
  | { type: 'rating'; value: number; count?: number; label?: string };

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
const gapSchema = z.preprocess(coerceGap, z.enum(GAP_TOKENS));

/**
 * Build a preprocessor mapping case-insensitive string synonyms to a canonical
 * token. Non-strings and unrecognized strings pass through unchanged for the
 * wrapped schema to validate — so agents can use natural vocabulary ("row",
 * "primary", "danger") without failing the whole widget over a synonym.
 *
 * @param map - Lowercase synonym → canonical token (include identity entries).
 */
function synonymCoercer(map: Record<string, string>): (value: unknown) => unknown {
  return (value) => {
    if (typeof value !== 'string') return value;
    const key = value.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : value;
  };
}

/** Tone enum, tolerant of synonyms ("warn", "danger", "ok"). */
const toneSchema = z.preprocess(
  synonymCoercer({
    default: 'default',
    neutral: 'default',
    muted: 'default',
    normal: 'default',
    gray: 'default',
    grey: 'default',
    success: 'success',
    ok: 'success',
    okay: 'success',
    good: 'success',
    positive: 'success',
    done: 'success',
    complete: 'success',
    completed: 'success',
    green: 'success',
    warning: 'warning',
    warn: 'warning',
    caution: 'warning',
    pending: 'warning',
    yellow: 'warning',
    orange: 'warning',
    error: 'error',
    danger: 'error',
    critical: 'error',
    fail: 'error',
    failed: 'error',
    failure: 'error',
    negative: 'error',
    blocked: 'error',
    red: 'error',
    info: 'info',
    information: 'info',
    note: 'info',
    blue: 'info',
  }),
  WidgetToneSchema
);

/** Stack direction, tolerant of flexbox vocabulary ("row"/"column"). */
const directionSchema = z.preprocess(
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
const variantSchema = z.preprocess(
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
const chartKindSchema = z.preprocess(
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
const levelSchema = z.preprocess(
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
const deltaSchema = z.preprocess(
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

/** List-item badge — accepts a bare string label (`badge: "open"`) or the object. */
const listBadgeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { text: value } : value),
  z.object({ text: z.string(), tone: toneSchema.optional() })
);

/** Timeline item status, tolerant of natural progress vocabulary. */
const timelineStatusSchema = z.preprocess(
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
const flagSchema = z.preprocess((value) => {
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

/**
 * Recursive schema for a widget node — `z.discriminatedUnion('type', …)` over
 * the v1 catalog, declared via `z.lazy` so container nodes (`stack`, `card`,
 * `form`) can reference the node union in their `children`/`footer`.
 */
export const WidgetNodeSchema: z.ZodType<WidgetNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('stack'),
      direction: directionSchema,
      gap: gapSchema.optional(),
      children: z.array(WidgetNodeSchema),
    }),
    z.object({
      type: z.literal('card'),
      title: z.string().optional(),
      description: z.string().optional(),
      children: z.array(WidgetNodeSchema),
      footer: z.array(WidgetNodeSchema).optional(),
    }),
    z.object({ type: z.literal('divider') }),
    z.object({
      type: z.literal('heading'),
      text: z.string(),
      level: levelSchema.optional(),
    }),
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('badge'),
      text: z.string(),
      tone: toneSchema.optional(),
    }),
    z.object({
      type: z.literal('stat'),
      label: z.string(),
      value: z.union([z.string(), z.number()]),
      delta: deltaSchema.optional(),
      hint: z.string().optional(),
      // Optional sparkline series; cap at 50 points so a runaway array can't
      // bloat the SVG. Stringified numbers coerce; non-finite values reject.
      trend: z.array(z.coerce.number().finite()).max(50).optional(),
    }),
    z.object({
      type: z.literal('keyValue'),
      items: z.array(z.object({ key: z.string(), value: z.string() })),
    }),
    z.object({
      type: z.literal('image'),
      src: z.string().refine((src) => src.startsWith('https://') || src.startsWith('data:'), {
        message: 'Widget image sources must be https or data URIs',
      }),
      alt: z.string(),
      caption: z.string().optional(),
    }),
    z.object({
      type: z.literal('progress'),
      // Coerce stringified numbers ("72") and clamp to the 0-100 range rather
      // than failing the widget when an agent reports e.g. 120%.
      value: z.coerce
        .number()
        .finite()
        .transform((v) => Math.min(100, Math.max(0, v))),
      label: z.string().optional(),
    }),
    z.object({
      type: z.literal('table'),
      columns: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          align: z.enum(['left', 'center', 'right']).optional(),
        })
      ),
      rows: z.array(z.record(z.string(), WidgetCellSchema)),
    }),
    z.object({
      type: z.literal('list'),
      items: z.array(
        z.object({
          title: z.string(),
          subtitle: z.string().optional(),
          /** Lucide icon name (validated against the registry at render time). */
          icon: z.string().optional(),
          /** Leading thumbnail; https/data only, same posture as the image node. */
          image: z
            .string()
            .refine((src) => src.startsWith('https://') || src.startsWith('data:'), {
              message: 'Widget image sources must be https or data URIs',
            })
            .optional(),
          meta: z.string().optional(),
          badge: listBadgeSchema.optional(),
          actions: z.array(WidgetActionSchema).optional(),
        })
      ),
    }),
    z.object({
      type: z.literal('chart'),
      kind: chartKindSchema,
      // v1 constraint: values are non-negative. The minimal renderer has no
      // zero-baseline handling (negative bars/lines would render off-canvas),
      // so the schema rejects them honestly instead of drawing garbage.
      // Stringified numbers ("12") are coerced — a common LLM output. `.finite()`
      // rejects "Infinity"/NaN, which coerce to non-finite numbers that min(0)
      // and positive() would otherwise let through.
      data: z.array(z.object({ label: z.string(), value: z.coerce.number().finite().min(0) })),
      height: z.coerce.number().finite().positive().optional(),
    }),
    z.object({
      type: z.literal('button'),
      label: z.string(),
      variant: variantSchema.optional(),
      action: WidgetActionSchema,
    }),
    z.object({
      type: z.literal('input'),
      name: z.string().min(1),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      kind: z.enum(['text', 'number']).optional(),
    }),
    z.object({
      type: z.literal('select'),
      name: z.string().min(1),
      label: z.string().optional(),
      options: z.array(z.object({ label: z.string(), value: z.string() })),
    }),
    z.object({
      type: z.literal('form'),
      children: z.array(WidgetNodeSchema),
      submit: z.object({ label: z.string(), action: AgentWidgetActionSchema }),
    }),
    z.object({
      type: z.literal('timeline'),
      items: z
        .array(
          z.object({
            time: z.string().optional(),
            title: z.string(),
            subtitle: z.string().optional(),
            /** Lucide icon name; when present it fills the status dot slot. */
            icon: z.string().optional(),
            status: timelineStatusSchema.optional(),
          })
        )
        .min(1),
    }),
    z.object({
      type: z.literal('checklist'),
      items: z.array(
        z.object({
          label: z.string(),
          checked: flagSchema.optional(),
          note: z.string().optional(),
        })
      ),
      // When present, a submit button posts the checked/unchecked label sets
      // back to the agent (merged into the action payload client-side).
      action: AgentWidgetActionSchema.optional(),
      submitLabel: z.string().optional(),
    }),
    z.object({
      type: z.literal('compare'),
      options: z.array(z.object({ name: z.string(), recommended: flagSchema.optional() })).min(1),
      // Rows may be shorter than `options`; the renderer pads with null rather
      // than failing the whole widget over a ragged matrix.
      rows: z.array(z.object({ label: z.string(), values: z.array(WidgetCellSchema) })),
    }),
    z.object({
      type: z.literal('rating'),
      // Coerce stringified numbers and clamp to the 0-5 star range.
      value: z.coerce
        .number()
        .finite()
        .transform((v) => Math.min(5, Math.max(0, v))),
      count: z.coerce.number().int().nonnegative().optional(),
      label: z.string().optional(),
    }),
  ])
) as z.ZodType<WidgetNode>;

/**
 * A complete widget document — the payload of a `dorkos-ui` fence or a
 * `{ type: 'widget' }` canvas content. `version` gates schema migrations;
 * `title` is used as the canvas tab title and the widget's a11y label.
 */
export const WidgetDocumentSchema = z.object({
  version: z.literal(1),
  title: z.string().optional(),
  root: WidgetNodeSchema,
});

/** A complete, versioned widget document. */
export type WidgetDocument = z.infer<typeof WidgetDocumentSchema>;

// The `<ui_action>` message formatter is a distinct concern (prompt-injection-
// safe rendering of an interaction into a user turn), extracted to keep this
// file focused on the widget catalog. Re-exported so the public
// `@dorkos/shared/ui-widget` import surface is unchanged.
export {
  neutralizeContextClosingTag,
  sanitizeContextScalar,
  formatUiActionMessage,
} from './ui-action-message.js';
