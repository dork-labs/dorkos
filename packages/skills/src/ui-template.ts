/**
 * `ui/*.widget.json` — skill-shipped widget templates (gen-ui program, PR G).
 *
 * A skill directory may ship a `ui/` subdirectory of widget templates: a
 * named, described {@link WidgetDocument} (`@dorkos/shared/ui-widget`) whose
 * string fields may contain `{{placeholder}}` tokens for an agent to fill in
 * before emitting the document as a ` ```dorkos-ui ` fence. Templates give a
 * skill a battle-tested widget shape to reuse turn after turn instead of
 * hand-rolling document JSON every time.
 *
 * **The zod version boundary.** `@dorkos/shared` is on zod v4; this package
 * is still on zod v3 (a mixed-version migration is in flight across the
 * monorepo — see `packages/marketplace` and `packages/harness` for other v3
 * holdouts). Nesting a v4 `ZodType` inside a v3 `z.object()` is not
 * supported: v3's object parser reaches into `_def` internals whose shape
 * changed in v4, so composition silently misbehaves rather than erroring
 * loudly. Instead of composing schemas, `document` is validated by calling
 * `WidgetDocumentSchema.safeParse()` as an opaque function — a call
 * boundary, not a type-composition boundary — inside a `superRefine`. The
 * `WidgetDocument` type itself is imported type-only; a plain structural
 * interface carries no version baggage, so annotating `document`'s output
 * with it is safe regardless of which zod built it.
 *
 * **Placeholder validation.** The widget catalog has a handful of
 * strictly-typed leaf fields — `progress.value` and `chart.data[].value` are
 * numbers; `image.src` and the `url` action's `href` must be `https://` or
 * `data:` strings. A raw template with `"{{value}}"` in one of those
 * positions would fail `WidgetDocumentSchema` outright even though it is a
 * well-formed template. We validate structural conformance by substituting
 * every whole-string `{{token}}` placeholder with a dummy `https://` URL
 * before validating: a value that satisfies every string-typed field in the
 * catalog (plain strings and the two https-constrained fields alike) but can
 * never satisfy a number-typed field. That means placeholders are accepted
 * anywhere the catalog expects a string, and correctly rejected in the
 * catalog's number-only positions — matching the documented convention that
 * placeholders live in string positions. A value an agent must fill in
 * numerically belongs in a field typed `string | number` (e.g. `stat.value`),
 * authored in the template as a string placeholder.
 *
 * @module skills/ui-template
 */
import { z } from 'zod';
import { WidgetDocumentSchema, type WidgetDocument } from '@dorkos/shared/ui-widget';

/** Matches a string value that is *entirely* a `{{placeholder}}` token. */
const WHOLE_PLACEHOLDER_PATTERN = /^\{\{\s*[^{}]+?\s*\}\}$/;

/**
 * Dummy value substituted for whole-string placeholders during validation.
 * An `https://` URL satisfies every string-typed field in the widget
 * catalog, including the two fields with a scheme refinement, while never
 * satisfying a number-typed field.
 */
const PLACEHOLDER_DUMMY_VALUE = 'https://placeholder.dorkos.dev/widget-template-slot';

/**
 * Recursively replace whole-string `{{placeholder}}` values with
 * {@link PLACEHOLDER_DUMMY_VALUE} so the result can be checked against
 * {@link WidgetDocumentSchema}. Embedded placeholders inside larger strings
 * (e.g. `"Weather in {{city}}"`) are left untouched — those fields are
 * already unconstrained strings and need no substitution to pass.
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
 * A skill-shipped widget template: a named, described {@link WidgetDocument}
 * whose string fields may contain `{{placeholder}}` tokens for the agent to
 * fill before emitting the document as a `dorkos-ui` fence.
 */
export const WidgetTemplateSchema = z.object({
  /** Identifier for the template, unique within the skill's `ui/` directory. */
  name: z.string().min(1),
  /** What the template renders and when an agent should reach for it. */
  description: z.string().min(1),
  /**
   * The widget document, with optional `{{placeholder}}` string slots. Kept
   * as `unknown` pre-validation (see module docs for why) and narrowed to
   * {@link WidgetDocument} once {@link WidgetDocumentSchema} accepts the
   * placeholder-substituted shape.
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
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: issue.message });
      }
    })
    .transform((value) => value as WidgetDocument),
});

/** A validated skill-shipped widget template. */
export type WidgetTemplate = z.infer<typeof WidgetTemplateSchema>;
