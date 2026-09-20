/**
 * The tiny HTML layer the daily report is built with: escaping, the template's
 * placeholder scheme, and a sparkline drawn as inline SVG.
 *
 * Everything the report shows about the outside world is untrusted. A pull
 * request title, a branch name and an API error message all reach the page,
 * and any of them can hold `<script>`. So there is exactly one way to put a
 * value on the page, `esc`, and one way to assemble markup, the `h` tag, which
 * escapes every interpolation for you. Raw markup gets in only through
 * `raw()`, which you write around something you built here, never around
 * something you read.
 *
 * No template engine, no chart library: the dependency budget is node
 * built-ins, `zod` and `yaml`, and a test pins it.
 */

/** Markup that is already safe to put on the page. */
export class Html {
  /** The markup. */
  readonly value: string;
  /**
   * Wrap markup that is already safe.
   *
   * @param value - Markup that has already been escaped.
   */
  constructor(value: string) {
    this.value = value;
  }
  /** The markup, for string interpolation. */
  toString(): string {
    return this.value;
  }
}

/**
 * Wrap a string that is already safe markup. Never call it on anything that
 * came from GitHub, from a file on the data branch, or from a person.
 *
 * @param markup - The markup.
 */
export function raw(markup: string): Html {
  return new Html(markup);
}

/**
 * Escape a value for HTML text and for a double-quoted attribute.
 *
 * @param value - Anything; `null` and `undefined` render as an empty string.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A template tag that escapes every interpolation. An `Html` value passes
 * through, an array is joined, everything else is escaped.
 *
 * @param strings - The literal parts.
 * @param values - The interpolated parts.
 */
export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  const out: string[] = [];
  strings.forEach((s, i) => {
    out.push(s);
    if (i < values.length) out.push(render(values[i]));
  });
  return new Html(out.join(''));
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

/**
 * Fill a template's `{{slot}}` (escaped) and `{{{slot}}}` (markup) holes. An
 * unknown slot is left in place: a typo in the template should be visible on
 * the page, not silently blank.
 *
 * @param template - The template's text.
 * @param slots - Values by slot name.
 */
export function fill(template: string, slots: Readonly<Record<string, unknown>>): string {
  return template
    .replace(/\{\{\{(\w+)\}\}\}/g, (all, name: string) => {
      const v = slots[name];
      if (v === undefined) return all;
      return v instanceof Html ? v.value : esc(v);
    })
    .replace(/\{\{(\w+)\}\}/g, (all, name: string) => {
      const v = slots[name];
      return v === undefined ? all : esc(v);
    });
}

/**
 * A sparkline: one `<svg>` polyline over a series, scaled to its own range.
 * A gap (a day with no reading) breaks the line rather than inventing a value.
 *
 * @param series - The values, oldest first; `null` for a day with no reading.
 * @param label - The accessible description of what the line shows.
 * @param size - Width and height in pixels.
 */
export function sparkline(
  series: readonly (number | null)[],
  label: string,
  size: { width?: number; height?: number } = {}
): Html {
  const width = size.width ?? 96;
  const height = size.height ?? 22;
  const points = series.filter((v): v is number => v !== null);
  if (points.length < 2) return h`<span class="note">not enough days yet</span>`;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = series.length > 1 ? (width - 2) / (series.length - 1) : 0;
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);
  const parts: string[] = [];
  let pen = false;
  series.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const x = 1 + i * stepX;
    parts.push(`${pen ? 'L' : 'M'}${x.toFixed(1)} ${y(v).toFixed(1)}`);
    pen = true;
  });
  return h`<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}"><path d="${parts.join(' ')}" /></svg>`;
}
