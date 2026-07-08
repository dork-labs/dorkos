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
  | { type: 'form'; children: WidgetNode[]; submit: { label: string; action: AgentWidgetAction } };

const gapSchema = z.enum(['sm', 'md', 'lg']);

/**
 * Recursive schema for a widget node — `z.discriminatedUnion('type', …)` over
 * the v1 catalog, declared via `z.lazy` so container nodes (`stack`, `card`,
 * `form`) can reference the node union in their `children`/`footer`.
 */
export const WidgetNodeSchema: z.ZodType<WidgetNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('stack'),
      direction: z.enum(['vertical', 'horizontal']),
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
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    }),
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('badge'),
      text: z.string(),
      tone: WidgetToneSchema.optional(),
    }),
    z.object({
      type: z.literal('stat'),
      label: z.string(),
      value: z.union([z.string(), z.number()]),
      delta: z
        .object({
          value: z.union([z.string(), z.number()]),
          direction: z.enum(['up', 'down', 'flat']),
        })
        .optional(),
      hint: z.string().optional(),
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
      value: z.number().min(0).max(100),
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
          badge: z.object({ text: z.string(), tone: WidgetToneSchema.optional() }).optional(),
          actions: z.array(WidgetActionSchema).optional(),
        })
      ),
    }),
    z.object({
      type: z.literal('chart'),
      kind: z.enum(['bar', 'line', 'area', 'pie']),
      // v1 constraint: values are non-negative. The minimal renderer has no
      // zero-baseline handling (negative bars/lines would render off-canvas),
      // so the schema rejects them honestly instead of drawing garbage.
      data: z.array(z.object({ label: z.string(), value: z.number().min(0) })),
      height: z.number().positive().optional(),
    }),
    z.object({
      type: z.literal('button'),
      label: z.string(),
      variant: z.enum(['default', 'secondary', 'destructive', 'outline']).optional(),
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
