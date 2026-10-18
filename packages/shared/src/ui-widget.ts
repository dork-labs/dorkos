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
import {
  CanvasChannelBindSchema,
  CanvasChannelPublicEventTypeSchema,
  CanvasChannelStateSchema,
} from './canvas-channel-schemas.js';
import { UiCommandSchema } from './schemas.js';
import {
  boardGlyphSchema,
  chartKindSchema,
  coerceBoardCell,
  deltaSchema,
  directionSchema,
  flagSchema,
  gapSchema,
  levelSchema,
  MAX_BOARD_DIM,
  moodEmotionSchema,
  revealKindSchema,
  revealResultSchema,
  synonymCoercer,
  timelineStatusSchema,
  variantSchema,
} from './ui-widget-vocabulary.js';

/** Visual tone shared by `badge` nodes and list-item badges. */
export const WidgetToneSchema = z.enum(['default', 'success', 'warning', 'error', 'info']);

/** Visual tone shared by `badge` nodes and list-item badges. */
export type WidgetTone = z.infer<typeof WidgetToneSchema>;

/**
 * The `agent`-kind action variant — the single definition, reused as the
 * discriminated-union member in {@link WidgetActionSchema} and permitted
 * by native form/checklist submits.
 */
export const AgentWidgetActionSchema = z.object({
  kind: z.literal('agent'),
  /** Stable identifier the agent receives to know which action fired. */
  id: z.string().min(1),
  label: z.string().optional(),
  /** Literal payload; form field values are merged in at submit time. */
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** The legacy inline agent action variant. */
export type AgentWidgetAction = z.infer<typeof AgentWidgetActionSchema>;

/** A native document event action; the host creates each click's event identity. */
export const EmitWidgetActionSchema = z
  .object({
    kind: z.literal('emit'),
    type: CanvasChannelPublicEventTypeSchema,
    payload: CanvasChannelStateSchema.optional(),
    coalesceKey: z.string().min(1).max(128).optional(),
  })
  .strict();
/** Native document event action. */
export type EmitWidgetAction = z.infer<typeof EmitWidgetActionSchema>;
/** Form/checklist submission excludes navigation and local UI commands. */
export const WidgetSubmitActionSchema = z.discriminatedUnion('kind', [
  AgentWidgetActionSchema,
  EmitWidgetActionSchema,
]);
/** Native form/checklist action. */
export type WidgetSubmitAction = z.infer<typeof WidgetSubmitActionSchema>;

/**
 * An interactive action a widget node can trigger. Discriminated on `kind`:
 * - `agent` — uses the inline session action path, or an approved document
 *   route when rendered by a channel-enabled canvas host.
 * - `emit` — saves a bounded public document event through the host transport.
 * - `ui` — dispatched locally through `executeUiCommand`, no agent wake.
 * - `url` — opens an external https link via the link-safety modal.
 */
export const WidgetActionSchema = z.discriminatedUnion('kind', [
  AgentWidgetActionSchema,
  EmitWidgetActionSchema,
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

/** An interactive action a widget node can trigger (agent, emit, ui, or url). */
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
  | { type: 'text'; text: string; bind?: { text?: WidgetStateBinding } }
  | { type: 'badge'; text: string; tone?: WidgetTone }
  | {
      type: 'stat';
      bind?: { value?: WidgetStateBinding };
      label: string;
      value: string | number;
      delta?: { value: string | number; direction: 'up' | 'down' | 'flat' };
      hint?: string;
      /** Optional series (≤50 points) drawn as an inline sparkline beside the value. */
      trend?: number[];
    }
  | { type: 'keyValue'; items: { key: string; value: string }[] }
  | { type: 'image'; src: string; alt: string; caption?: string }
  | {
      type: 'progress';
      value: number;
      label?: string;
      bind?: { value?: WidgetStateBinding; label?: WidgetStateBinding };
    }
  | {
      type: 'table';
      bind?: { rows?: WidgetStateBinding };
      columns: { key: string; label: string; align?: 'left' | 'center' | 'right' }[];
      rows: Record<string, string | number | boolean | null>[];
    }
  | { type: 'list'; items: WidgetListItem[] }
  | {
      type: 'chart';
      bind?: { data?: WidgetStateBinding };
      kind: 'bar' | 'line' | 'area' | 'pie';
      /** Data points. Values are non-negative in v1 (no zero-baseline handling). */
      data: { label: string; value: number }[];
      height?: number;
      /** One data label to draw in the accent; every other bar stays muted. */
      highlight?: string;
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
      required?: boolean;
    }
  | {
      type: 'select';
      name: string;
      label?: string;
      required?: boolean;
      options: { label: string; value: string }[];
    }
  | { type: 'form'; children: WidgetNode[]; submit: { label: string; action: WidgetSubmitAction } }
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
      action?: WidgetSubmitAction;
      submitLabel?: string;
    }
  | {
      type: 'compare';
      options: { name: string; recommended?: boolean }[];
      rows: { label: string; values: (string | number | boolean | null)[] }[];
    }
  | { type: 'rating'; value: number; count?: number; label?: string }
  | {
      type: 'mood';
      emotion:
        | 'happy'
        | 'thinking'
        | 'celebrating'
        | 'sheepish'
        | 'determined'
        | 'surprised'
        | 'sad'
        | 'love';
      message?: string;
    }
  | {
      type: 'board';
      rows: { glyph?: string; icon?: string; tone?: WidgetTone; action?: WidgetAction }[][];
      label?: string;
    }
  | { type: 'reveal'; kind: 'coin' | 'd6' | 'd20' | '8ball'; result: string; label?: string };

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

/** List-item badge — accepts a bare string label (`badge: "open"`) or the object. */
const listBadgeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { text: value } : value),
  z.object({ text: z.string(), tone: toneSchema.optional() })
);

const boardCellSchema = z.preprocess(
  coerceBoardCell,
  z.object({
    glyph: boardGlyphSchema,
    icon: z.string().optional(),
    tone: toneSchema.optional(),
    action: WidgetActionSchema.optional(),
  })
);

/**
 * `board.rows` — slices both dimensions to {@link MAX_BOARD_DIM} instead of
 * rejecting an oversized grid, so a chatty agent's 20x20 board still renders
 * (clipped) rather than failing the whole widget.
 */
const boardRowsSchema = z.preprocess(
  (value) => {
    if (!Array.isArray(value)) return value;
    return value
      .slice(0, MAX_BOARD_DIM)
      .map((row) => (Array.isArray(row) ? row.slice(0, MAX_BOARD_DIM) : row));
  },
  z.array(z.array(boardCellSchema))
);

/** A display-only read from the current channel state, never an action or authority. */
export type WidgetStateBinding = z.infer<typeof CanvasChannelBindSchema>;

const widgetBindingSchemas = {
  text: z.object({ text: CanvasChannelBindSchema.optional() }).strict(),
  stat: z.object({ value: CanvasChannelBindSchema.optional() }).strict(),
  progress: z
    .object({
      value: CanvasChannelBindSchema.optional(),
      label: CanvasChannelBindSchema.optional(),
    })
    .strict(),
  table: z.object({ rows: CanvasChannelBindSchema.optional() }).strict(),
  chart: z.object({ data: CanvasChannelBindSchema.optional() }).strict(),
};

/**
 * Recursive schema for a widget node — `z.discriminatedUnion('type', …)` over
 * the v1 catalog, declared via `z.lazy` so container nodes (`stack`, `card`,
 * `form`) can reference the node union in their `children`/`footer`.
 */
export const WidgetNodeSchema: z.ZodType<WidgetNode> = z.lazy(() =>
  z.preprocess(
    (raw, context) => {
      if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'bind')) {
        const node = raw as { type?: string; bind?: unknown };
        const schema =
          typeof node.type === 'string' && Object.hasOwn(widgetBindingSchemas, node.type)
            ? widgetBindingSchemas[node.type as keyof typeof widgetBindingSchemas]
            : undefined;
        if (!schema || !schema.safeParse(node.bind).success) {
          context.addIssue({
            code: 'custom',
            path: ['bind'],
            message: 'This element needs a supported display field and a safe state path.',
          });
          return z.NEVER;
        }
      }
      return raw;
    },
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
      z.object({
        type: z.literal('text'),
        text: z.string(),
        bind: widgetBindingSchemas.text.optional(),
      }),
      z.object({
        type: z.literal('badge'),
        text: z.string(),
        tone: toneSchema.optional(),
      }),
      z.object({
        type: z.literal('stat'),
        bind: widgetBindingSchemas.stat.optional(),
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
        bind: widgetBindingSchemas.progress.optional(),
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
        bind: widgetBindingSchemas.table.optional(),
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
      z
        .object({
          type: z.literal('chart'),
          bind: widgetBindingSchemas.chart.optional(),
          kind: chartKindSchema,
          // v1 constraint: values are non-negative. The minimal renderer has no
          // zero-baseline handling (negative bars/lines would render off-canvas),
          // so the schema rejects them honestly instead of drawing garbage.
          // Stringified numbers ("12") are coerced — a common LLM output. `.finite()`
          // rejects "Infinity"/NaN, which coerce to non-finite numbers that min(0)
          // and positive() would otherwise let through.
          data: z.array(z.object({ label: z.string(), value: z.coerce.number().finite().min(0) })),
          height: z.coerce.number().finite().positive().optional(),
          highlight: z.string().optional(),
        })
        .superRefine((chart, context) => {
          // A highlight that names no point would silently highlight nothing. Data
          // bound to document state arrives later, so only authored data is checked.
          if (
            chart.highlight !== undefined &&
            chart.bind?.data === undefined &&
            !chart.data.some((d) => d.label === chart.highlight)
          ) {
            context.addIssue({
              code: 'custom',
              path: ['highlight'],
              message: `Names no data label. Use one of: ${chart.data.map((d) => d.label).join(', ')}.`,
            });
          }
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
        required: z.boolean().optional(),
      }),
      z.object({
        type: z.literal('select'),
        required: z.boolean().optional(),
        name: z.string().min(1),
        label: z.string().optional(),
        options: z.array(z.object({ label: z.string(), value: z.string() })),
      }),
      z.object({
        type: z.literal('form'),
        children: z.array(WidgetNodeSchema),
        submit: z.object({ label: z.string(), action: WidgetSubmitActionSchema }),
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
        action: WidgetSubmitActionSchema.optional(),
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
      z.object({
        type: z.literal('mood'),
        emotion: moodEmotionSchema,
        message: z.string().optional(),
      }),
      z.object({
        type: z.literal('board'),
        rows: boardRowsSchema,
        label: z.string().optional(),
      }),
      z.object({
        type: z.literal('reveal'),
        kind: revealKindSchema,
        result: revealResultSchema,
        label: z.string().optional(),
      }),
    ])
  )
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
