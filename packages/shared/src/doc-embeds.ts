/**
 * The Docs embed catalog: which generative-UI widget nodes a markdown doc may
 * embed as a block directive, and how a directive's string attributes become
 * that node.
 *
 * `::chart{kind="bar" data='[{"label":"Mon","value":4}]'}` in a doc and a
 * `chart` node in a `dorkos-ui` fence are ONE component validated by ONE schema:
 * a directive is decoded into a widget node and checked by
 * {@link WidgetNodeSchema}, the same schema the fence uses. The client renders
 * it with the same gen-UI node component.
 *
 * Only display nodes are here. Actions, forms, boards and reveals need an agent
 * on the other end of the click, and a document has none.
 *
 * ## Attributes are strings
 *
 * Directive attributes are strings only, so each field has one codec:
 *
 * - `text`: the string as written.
 * - `number`: parsed with `Number`; anything that is not a finite number is left
 *   as written, so the widget schema reports it.
 * - `scalar`: a number when it reads as one, JSON when it starts with `{` or `[`,
 *   else the string (`delta="-3"` is a number, `delta="+2°"` text, and
 *   `delta='{"value":"+8%","direction":"up"}'` the object a fence would carry).
 * - `json`: structured data (chart points, table rows) as ONE JSON attribute.
 *
 * So the rule agents are taught holds for every field: a field that is an array
 * or an object in a `dorkos-ui` node is one single-line JSON attribute here, and
 * every other field is plain text or a number. `stat` also takes the shorthand
 * `delta="+8%" direction="up"`.
 *
 * A doc is read far more than it is written, so lists are capped at
 * {@link DOC_EMBED_MAX_ITEMS} items and a chart at {@link DOC_EMBED_MAX_CHART_HEIGHT}
 * pixels tall; past either, the embed reports an issue instead of drawing.
 *
 * A JSON attribute has to sit on one line: the directive grammar ends a leaf
 * directive at the line break, and the line then reads as a paragraph. Write it
 * single-quoted (`data='[{"label":"Q1","value":3}]'`) so the JSON's own double
 * quotes need no escaping. The editor writes every attribute back double-quoted,
 * with each `"` as `&#x22;`; both forms decode to the same string. A `'` inside a
 * single-quoted value cannot be escaped, so write it as `\u0027` in the JSON.
 *
 * @module shared/doc-embeds
 */
import type { z } from 'zod';
import { WidgetNodeSchema, type WidgetNode } from './ui-widget.js';

/** How one directive attribute's string becomes a widget field. */
export type DocEmbedCodec = 'text' | 'number' | 'scalar' | 'json';

/** The widget node types a doc may embed. */
export const DOC_EMBED_NAMES = [
  'chart',
  'stat',
  'table',
  'progress',
  'keyValue',
  'timeline',
  'compare',
  'rating',
  'badge',
  'list',
] as const;

/** A directive name in the Docs embed catalog; it equals the widget node type. */
export type DocEmbedName = (typeof DOC_EMBED_NAMES)[number];

/** One catalog entry: the directive's attributes and how to insert a starter. */
export interface DocEmbedSpec {
  /** What the slash menu calls it. */
  title: string;
  /** Every attribute the directive takes, and how its string decodes. */
  attributes: Readonly<Record<string, DocEmbedCodec>>;
  /** A small, valid starter: what a slash-menu insert writes. */
  example: Readonly<Record<string, string>>;
}

/** One problem with an embed's attributes, shaped like a Standard Schema issue. */
export interface DocEmbedIssue {
  /** What is wrong, in a sentence a person can act on. */
  message: string;
  /** The attribute it concerns, then the path inside its value. */
  path?: (string | number)[];
}

/** The result of decoding a directive: the widget node, or why there is none. */
export type DocEmbedDecodeResult =
  { ok: true; node: WidgetNode } | { ok: false; issues: DocEmbedIssue[] };

/** The Docs embed catalog, in slash-menu order. */
export const DOC_EMBED_CATALOG: Readonly<Record<DocEmbedName, DocEmbedSpec>> = {
  chart: {
    title: 'Chart',
    attributes: { kind: 'text', data: 'json', height: 'number', highlight: 'text' },
    example: {
      kind: 'bar',
      data: '[{"label":"Mon","value":4},{"label":"Tue","value":7},{"label":"Wed","value":5}]',
      highlight: 'Tue',
    },
  },
  stat: {
    title: 'Stat',
    attributes: {
      label: 'text',
      value: 'text',
      delta: 'scalar',
      direction: 'text',
      hint: 'text',
      trend: 'json',
    },
    example: { label: 'Revenue', value: '$12.4k', delta: '+8%', direction: 'up' },
  },
  table: {
    title: 'Data table',
    attributes: { columns: 'json', rows: 'json' },
    example: {
      columns: '[{"key":"task","label":"Task"},{"key":"owner","label":"Owner"}]',
      rows: '[{"task":"Write the brief","owner":"Ada"},{"task":"Review","owner":"Sam"}]',
    },
  },
  progress: {
    title: 'Progress bar',
    attributes: { value: 'number', label: 'text' },
    example: { value: '40', label: 'Launch checklist' },
  },
  keyValue: {
    title: 'Key-value list',
    attributes: { items: 'json' },
    example: { items: '[{"key":"Status","value":"On track"},{"key":"Owner","value":"Ada"}]' },
  },
  timeline: {
    title: 'Timeline',
    attributes: { items: 'json' },
    example: {
      items:
        '[{"time":"Mon","title":"Draft","status":"done"},{"time":"Wed","title":"Review","status":"active"},{"time":"Fri","title":"Ship","status":"upcoming"}]',
    },
  },
  compare: {
    title: 'Comparison',
    attributes: { options: 'json', rows: 'json' },
    example: {
      options: '[{"name":"Plan A"},{"name":"Plan B","recommended":true}]',
      rows: '[{"label":"Cost","values":["$10","$25"]},{"label":"Support","values":[false,true]}]',
    },
  },
  rating: {
    title: 'Rating',
    attributes: { value: 'number', count: 'number', label: 'text' },
    example: { value: '4.5', count: '120' },
  },
  badge: {
    title: 'Badge',
    attributes: { text: 'text', tone: 'text' },
    example: { text: 'On track', tone: 'success' },
  },
  list: {
    title: 'Item list',
    attributes: { items: 'json' },
    example: {
      items: '[{"title":"Write the brief","subtitle":"Due Monday"},{"title":"Review","meta":"2h"}]',
    },
  },
};

/**
 * Whether a directive name is in the Docs embed catalog. Own-property only, so
 * `::constructor` never resolves to `Object.prototype`.
 *
 * @param name - The directive name as written.
 */
export function isDocEmbedName(name: string): name is DocEmbedName {
  return Object.prototype.hasOwnProperty.call(DOC_EMBED_CATALOG, name);
}

/** The most items any one list attribute (chart points, table rows, …) may hold. */
export const DOC_EMBED_MAX_ITEMS = 500;

/** The tallest a chart may be drawn, in pixels. */
export const DOC_EMBED_MAX_CHART_HEIGHT = 1200;

/** Numbers as a person writes them: no blanks, no hex, no `Infinity`. */
const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Parse one JSON attribute, refusing one that does not parse or is too long. */
function decodeJson(key: string, raw: string): { value: unknown } | { issue: DocEmbedIssue } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      issue: { path: [key], message: `Isn't valid JSON. Write it on one line, e.g. ${key}='[…]'.` },
    };
  }
  if (Array.isArray(value) && value.length > DOC_EMBED_MAX_ITEMS) {
    return {
      issue: { path: [key], message: `Has ${value.length} items; up to ${DOC_EMBED_MAX_ITEMS}.` },
    };
  }
  return { value };
}

/**
 * Decode one attribute's string with its codec.
 *
 * @returns The decoded value, or an issue when a JSON value does not parse.
 */
function decodeAttribute(
  key: string,
  raw: string,
  codec: DocEmbedCodec
): { value: unknown } | { issue: DocEmbedIssue } {
  const trimmed = raw.trim();
  switch (codec) {
    case 'text':
      return { value: raw };
    case 'number':
      return { value: NUMERIC.test(trimmed) ? Number(trimmed) : raw };
    case 'scalar':
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return decodeJson(key, raw);
      return { value: NUMERIC.test(trimmed) ? Number(trimmed) : raw };
    case 'json':
      return decodeJson(key, raw);
  }
}

/**
 * Zod's issue path as the attributes were written. With the `delta` +
 * `direction` shorthand, `delta.value` and `delta.direction` read back to
 * those two attributes; a delta written as an object keeps its own path.
 */
function attributePath(
  path: readonly PropertyKey[],
  deltaShorthand: boolean
): (string | number)[] | undefined {
  const parts = path.map((part) => (typeof part === 'number' ? part : String(part)));
  if (deltaShorthand && parts[0] === 'delta') {
    return parts[1] === 'direction' ? ['direction'] : ['delta'];
  }
  return parts.length > 0 ? parts : undefined;
}

/** Issues from the widget schema, pointed at the attribute that caused each. */
function schemaIssues(error: z.ZodError, deltaShorthand: boolean): DocEmbedIssue[] {
  return error.issues.map((issue) => ({
    message: issue.message,
    path: attributePath(issue.path, deltaShorthand),
  }));
}

/**
 * What a doc refuses that a chat reply allows: list actions (a doc has nobody
 * to send them to) and a chart taller than {@link DOC_EMBED_MAX_CHART_HEIGHT}.
 */
function docOnlyIssues(node: WidgetNode): DocEmbedIssue[] {
  if (node.type === 'chart' && node.height !== undefined) {
    return node.height > DOC_EMBED_MAX_CHART_HEIGHT
      ? [{ path: ['height'], message: `Up to ${DOC_EMBED_MAX_CHART_HEIGHT} pixels tall.` }]
      : [];
  }
  if (node.type !== 'list') return [];
  return node.items.flatMap((item, index) =>
    item.actions?.length
      ? [{ path: ['items', index, 'actions'], message: 'Docs show lists without actions.' }]
      : []
  );
}

/** Decoded embeds, so the editor's validator and the embed itself parse once. */
const decoded = new Map<string, DocEmbedDecodeResult>();

/** Enough for every embed in a long doc; cleared rather than evicted one by one. */
const DECODE_CACHE_LIMIT = 256;

/**
 * Decode a directive's attributes into the widget node it embeds, then
 * validate that node with the `dorkos-ui` widget schema.
 *
 * Unknown attributes are refused rather than ignored, so a typo is reported
 * where it was made instead of silently dropping a field. Results are cached
 * by name and attributes, so the same directive is parsed once however often it
 * is asked about; treat the returned node as read-only.
 *
 * @param name - The directive name (`chart` for `::chart{…}`).
 * @param attributes - The directive's attributes as written; all strings.
 * @returns The validated widget node, or every issue found.
 */
export function decodeDocEmbed(
  name: string,
  attributes: Readonly<Record<string, string>>
): DocEmbedDecodeResult {
  const key = `${name}\u0000${JSON.stringify(attributes)}`;
  const cached = decoded.get(key);
  if (cached) return cached;
  const result = decodeUncached(name, attributes);
  if (decoded.size >= DECODE_CACHE_LIMIT) decoded.clear();
  decoded.set(key, result);
  return result;
}

/** {@link decodeDocEmbed} without the cache. */
function decodeUncached(
  name: string,
  attributes: Readonly<Record<string, string>>
): DocEmbedDecodeResult {
  if (!isDocEmbedName(name)) {
    return { ok: false, issues: [{ message: `“${name}” isn't a doc embed.` }] };
  }
  const spec = DOC_EMBED_CATALOG[name];
  const issues: DocEmbedIssue[] = [];
  const fields: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(attributes)) {
    const codec = Object.prototype.hasOwnProperty.call(spec.attributes, key)
      ? spec.attributes[key]
      : undefined;
    if (!codec) {
      issues.push({
        path: [key],
        message: `Not used by ${name}. It takes: ${Object.keys(spec.attributes).join(', ')}.`,
      });
      continue;
    }
    const decoded = decodeAttribute(key, raw, codec);
    if ('issue' in decoded) issues.push(decoded.issue);
    else fields[key] = decoded.value;
  }
  if (issues.length > 0) return { ok: false, issues };

  // `direction` is the one attribute that is half of another field: with it,
  // `delta` becomes `{ value, direction }`; without it, the widget schema's own
  // shorthand reads the sign of a numeric delta. A delta written as the object
  // already carries its direction.
  let candidate: Record<string, unknown> = { type: name, ...fields };
  const deltaShorthand = name === 'stat' && 'direction' in fields;
  if (deltaShorthand) {
    const { direction, delta, ...rest } = fields;
    if (typeof delta === 'object' && delta !== null) {
      return {
        ok: false,
        issues: [{ path: ['direction'], message: 'The delta object already gives a direction.' }],
      };
    }
    candidate = { type: name, ...rest, delta: { value: delta, direction } };
  }

  const parsed = WidgetNodeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: schemaIssues(parsed.error, deltaShorthand) };
  const docIssues = docOnlyIssues(parsed.data);
  if (docIssues.length > 0) return { ok: false, issues: docIssues };
  return { ok: true, node: parsed.data };
}

/**
 * Validate an embed's attributes, in the plain-function form Blintz's `validate`
 * and `validateEmbedAttributes` accept: no `issues` means valid.
 *
 * @param name - The directive name.
 * @param attributes - The directive's attributes as written.
 */
export function validateDocEmbed(
  name: string,
  attributes: Readonly<Record<string, string>>
): { issues?: DocEmbedIssue[] } {
  const result = decodeDocEmbed(name, attributes);
  return result.ok ? {} : { issues: result.issues };
}
