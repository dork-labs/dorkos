/**
 * `ui/*.widget.json` — skill-shipped widget templates (gen-ui program, PR G).
 *
 * A skill directory may ship a `ui/` subdirectory of widget templates: a
 * named, described widget document (`@dorkos/shared/ui-widget`) whose string
 * fields may contain `{{placeholder}}` tokens for an agent to fill in before
 * emitting the document as a ` ```dorkos-ui ` fence. Templates give a skill a
 * battle-tested widget shape to reuse turn after turn instead of hand-rolling
 * document JSON every time.
 *
 * **The zod version boundary.** `@dorkos/shared` is on zod v4; this package
 * is still on zod v3 (a mixed-version migration is in flight across the
 * monorepo — see `packages/marketplace` and `packages/harness` for other v3
 * holdouts). Nesting a v4 `ZodType` inside a v3 `z.object()` is not
 * supported: v3's object parser reaches into `_def` internals whose shape
 * changed in v4, so composition silently misbehaves rather than erroring
 * loudly. Instead of composing schemas, `document` is validated by calling
 * `WidgetDocumentSchema.safeParse()` as an opaque function — a call
 * boundary, not a type-composition boundary — inside a `superRefine`.
 *
 * **Where placeholders are allowed — the three-bucket convention.**
 * Whole-string `{{token}}` placeholders are validated by substituting a dummy
 * `https://` URL before checking the document against `WidgetDocumentSchema`:
 *
 * 1. **Free-form string fields — allowed.** Any plain-string field
 *    (`text.text`, `heading.text`, `card.title`, `stat.label`, …), the
 *    https-refined fields (`image.src`, the `url` action's `href`), and
 *    `string | number` fields (`stat.value`, `stat.delta.value` — author
 *    numeric fill-ins there).
 * 2. **Number-only fields — rejected.** `progress.value`,
 *    `chart.data[].value`, `chart.height`: the dummy URL is not a number.
 * 3. **Enum/literal fields — rejected.** `badge.tone` (and list-item badge
 *    tones), `stack.direction`, `stack.gap`, `chart.kind`,
 *    `stat.delta.direction`, `button.variant`, `input.kind`,
 *    `table.columns[].align`, `heading.level`, `version`, and every node
 *    `type`: the dummy URL is not a member of the enum. Pick the concrete
 *    value when authoring the template.
 *
 * When a rejected placeholder causes the failure, the error names the
 * offending field and states that placeholders are not allowed there, rather
 * than surfacing the raw mismatch against the dummy substitution value.
 *
 * @module skills/ui-template
 */
import { z } from 'zod';
import { WidgetDocumentSchema } from '@dorkos/shared/ui-widget';

/** Matches a string value that is *entirely* a `{{placeholder}}` token. */
const WHOLE_PLACEHOLDER_PATTERN = /^\{\{\s*[^{}]+?\s*\}\}$/;

/**
 * Dummy value substituted for whole-string placeholders during validation.
 * An `https://` URL satisfies every string-typed field in the widget
 * catalog, including the https-refined ones, while never satisfying a
 * number-typed or enum/literal field.
 */
const PLACEHOLDER_DUMMY_VALUE = 'https://placeholder.dorkos.dev/widget-template-slot';

/**
 * Recursively replace whole-string `{{placeholder}}` values with
 * {@link PLACEHOLDER_DUMMY_VALUE} so the result can be checked against
 * `WidgetDocumentSchema`. Substitution is whole-string only: a placeholder
 * embedded in a larger string (e.g. `"Weather in {{city}}"`) is left
 * untouched, which passes in unconstrained string fields but means partial
 * placeholders are NOT supported in the https-refined fields —
 * `"https://{{host}}/img.png"` in `image.src` fails validation; use a
 * whole-string placeholder (`"{{imageUrl}}"`) there instead.
 *
 * @param value - Raw JSON value (object, array, or scalar) to walk
 * @returns A structurally identical value with whole-string placeholders replaced
 */
function substitutePlaceholders(value: unknown): unknown {
  if (typeof value === 'string') {
    return WHOLE_PLACEHOLDER_PATTERN.test(value) ? PLACEHOLDER_DUMMY_VALUE : value;
  }
  if (Array.isArray(value)) {
    return value.map(substitutePlaceholders);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        substitutePlaceholders(entry),
      ])
    );
  }
  return value;
}

/**
 * Walk `value` along a zod issue path and return the value at that position,
 * or `undefined` when the path does not resolve.
 *
 * @param value - The root value the path is relative to
 * @param path - Issue path segments (string keys and array indices)
 * @returns The value at the path, or `undefined`
 */
function getValueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * A widget document that may still contain `{{placeholder}}` slots in its
 * node tree.
 *
 * Deliberately NOT assignable to `WidgetDocument` from
 * `@dorkos/shared/ui-widget`: `root` is typed `unknown` because the tree
 * holds unfilled placeholder tokens, so rendering it raw would fail
 * `WidgetDocumentSchema` re-validation. Consumers must fill every
 * `{{placeholder}}` with a real value and re-validate (or emit the filled
 * JSON as a `dorkos-ui` fence, which the client validates) — the type system
 * prevents passing a template where a renderable document is expected.
 */
export interface WidgetDocumentTemplate {
  /** Wire-schema version — the same migration gate as the widget document's. */
  version: 1;
  /** Optional document title (may itself contain placeholders). */
  title?: string;
  /** The widget node tree, with `{{placeholder}}` slots still unfilled. */
  root: unknown;
}

/**
 * A skill-shipped widget template: a named, described widget document whose
 * string fields may contain `{{placeholder}}` tokens for the agent to fill
 * before emitting the document as a `dorkos-ui` fence.
 */
export const WidgetTemplateSchema = z.object({
  /** Identifier for the template, unique within the skill's `ui/` directory. */
  name: z.string().min(1),
  /** What the template renders and when an agent should reach for it. */
  description: z.string().min(1),
  /**
   * The widget document with `{{placeholder}}` slots intact. Validated for
   * structural conformance via dummy substitution (see module docs), but
   * returned UNSUBSTITUTED — hence {@link WidgetDocumentTemplate}, which is
   * deliberately not renderable until placeholders are filled.
   */
  document: z
    .unknown()
    .superRefine((value, ctx) => {
      const result = WidgetDocumentSchema.safeParse(substitutePlaceholders(value));
      if (result.success) return;
      for (const issue of result.error.issues) {
        // zod v4 issue paths are `PropertyKey[]` (string | number | symbol);
        // JSON has no symbol keys, so this narrowing is always exact in practice.
        const path = issue.path.filter(
          (segment): segment is string | number =>
            segment !== undefined && typeof segment !== 'symbol'
        );
        // When a placeholder in a number-only or enum/literal position caused
        // the failure, name the field instead of surfacing the raw mismatch
        // against the dummy substitution value.
        const original = getValueAtPath(value, path);
        const message =
          typeof original === 'string' && WHOLE_PLACEHOLDER_PATTERN.test(original)
            ? `Placeholder "${original}" is not allowed in field "${path.join('.')}" — placeholders may only fill free-form string fields, not number or enum fields`
            : issue.message;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
      }
    })
    .transform((value) => value as WidgetDocumentTemplate),
});

/** A validated skill-shipped widget template. */
export type WidgetTemplate = z.infer<typeof WidgetTemplateSchema>;
