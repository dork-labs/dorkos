/**
 * What a status item says, and how short it says it.
 *
 * The line's width budget counts slots, and a count only holds if every item is
 * about the same size. `"Default (recommended)"` at ~160px beside `"▤ 78%"` at
 * ~33px is what broke it: two items outgrew the whole bar before the `⋯` was
 * placed, and the count budget never noticed. So the values themselves are
 * bounded here, once, in pure functions the budget's tests can assert against.
 *
 * @module features/status/lib/status-labels
 */
import type { ModelOption } from '@dorkos/shared/types';
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import { formatModelLabel } from '@/layers/entities/runtime';

// The bound itself lives in `@dorkos/shared/constants`, not here: the names
// DorkOS's own catalogs and runtime descriptors carry are held to it by test
// (`Claude Code`, `GPT-5.3 Codex`), and that promise is only worth anything if the
// server's own model catalogs can be held to the same number. Labels written
// elsewhere are not all inside it — `Bypass permissions` (18) and `Live updates lost`
// (17) both ship — so pixels stay the browser's job: see
// `features/status/ui/StatusLine`, where a value that still does not fit truncates
// with an ellipsis.

/**
 * Bound a status value to {@link STATUS_VALUE_MAX_CHARS}, marking the cut.
 *
 * The ellipsis is the honesty: a clipped value looks like the whole value, and
 * the full text is always one tap away in the Session panel.
 *
 * @param text - The value an item would like to render.
 */
export function compactStatusValue(text: string): string {
  const trimmed = text.trim();
  // Cut by code point, not by UTF-16 unit: slicing an emoji in half leaves a lone
  // surrogate, which draws as a replacement glyph.
  const points = Array.from(trimmed);
  if (points.length <= STATUS_VALUE_MAX_CHARS) return trimmed;
  return `${points
    .slice(0, STATUS_VALUE_MAX_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * Strip picker-only decoration from a model's display name.
 *
 * `"Default (recommended)"` is guidance for someone *choosing* a model; once it
 * is chosen, the parenthetical is 14 characters of nothing. Same for a trailing
 * `· detail` clause. What is left is the name — which is what a status line is
 * for.
 *
 * @internal
 */
function stripPickerDecoration(displayName: string): string {
  return displayName
    .replace(/\s*\([^()]*\)\s*$/, '')
    .split('·')[0]
    .trim();
}

/**
 * The model name the status line shows.
 *
 * Resolves through the catalog when it can, so the line reads the same words the
 * picker does — minus the picker's decoration. A model the catalog no longer
 * offers still gets a name rather than a blank: a Claude id degrades to its
 * family (`claude-opus-4-6` → `Opus`), anything else to its short label with any
 * `provider/` prefix dropped. Never blank, never invented.
 *
 * @param model - The session's selected model value.
 * @param options - The catalog for this session's runtime, empty while it loads.
 */
export function statusModelLabel(model: string, options: readonly ModelOption[]): string {
  return compactStatusValue(resolveModelName(model, options));
}

/**
 * The model's name before it is bounded — catalog display name, Claude family, or
 * short id.
 *
 * @internal
 */
function resolveModelName(model: string, options: readonly ModelOption[]): string {
  const option = options.find((o) => o.value === model);
  if (option) return stripPickerDecoration(option.displayName);

  const family = /claude-(\w+)-/.exec(model);
  if (family) return `${family[1].charAt(0).toUpperCase()}${family[1].slice(1)}`;

  // The cold-catalog window: `options` is empty while the catalog is still
  // loading, so the lookup above never runs for the literal `default`
  // sentinel — the case the catalog itself would otherwise label "Default"
  // (see the tests below). `formatModelLabel` treats that sentinel as "no
  // model resolved" and returns `null` (DOR-1279), which would otherwise fall
  // through to the RAW SENTINEL via `?? model`, resurfacing the exact
  // meaningless "default" text DOR-1279 was written to stop showing — just
  // here instead of in the runtime identity line. "Default" is honest rather
  // than invented: the model genuinely IS the runtime's default, which is
  // what the catalog itself calls this same entry once it has loaded.
  if (model === 'default') return 'Default';

  return formatModelLabel(model) ?? model;
}
