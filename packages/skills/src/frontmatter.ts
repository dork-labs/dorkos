/**
 * The one safe way to read and write markdown frontmatter in DorkOS.
 *
 * `gray-matter` is a code runner as well as a parser. A block that opens with
 * `---js` or `---javascript` goes to its JavaScript engine, which calls `eval`
 * on the block, so reading a package's `SKILL.md` or command file with plain
 * `matter(content)` let whoever wrote that file run code in the server
 * (DOR-2308). The markdown DorkOS reads comes from marketplace packages, git
 * checkouts and agents, so none of it can be trusted to be data.
 *
 * This module is therefore the only importer of `gray-matter` in the repo (an
 * ESLint `no-restricted-imports` ban holds that everywhere else) and it closes
 * the hole three ways, each sufficient on its own for the eval:
 *
 * 1. A frontmatter language other than YAML or JSON is refused before
 *    gray-matter sees the content, with the same language sniffing gray-matter
 *    uses, so no engine lookup ever happens for it.
 * 2. The `javascript` engine (which `js` aliases to) is replaced by one that
 *    throws, in case a spelling ever slips past the check above.
 * 3. YAML is parsed by js-yaml v4 with its default schema pinned explicitly.
 *    v4 has no `!!js/function`-style types at all, so YAML's own tags cannot
 *    construct code either. JSON goes through `JSON.parse`.
 *
 * Reading is also bounded (DOR-2311). YAML aliases (`*name`) are shared
 * references, so a few hundred bytes can describe billions of values once
 * anything walks, copies or serialises the result, and a package's frontmatter
 * reaches schema validation, `JSON.stringify` and the install preview. Every
 * engine refuses a raw block over {@link FRONTMATTER_LIMITS}`.maxBytes`, then
 * walks the parsed value the way a consumer would, alias targets expanded,
 * and refuses it as soon as it grows past `maxExpanded` units (one per value
 * plus one per character of every string and key) or nests past `maxDepth`.
 * The walk stops at the limit, so refusing costs at most the budget.
 *
 * Writing never parses: gray-matter's `stringify(string, data)` runs the body
 * through `matter()` first, so a body opening with `---js` was evaluated on
 * the way OUT. {@link stringifyFrontmatter} hands it a file object instead.
 *
 * Every call also skips gray-matter's process-wide cache, which returns a
 * shared object per content string and caches a placeholder before it parses.
 *
 * @module skills/frontmatter
 */
import matter from 'gray-matter';
import yaml from 'js-yaml';

/** Frontmatter languages DorkOS reads. Everything else is refused. */
const DATA_LANGUAGES = new Set(['yaml', 'yml', 'json']);

/** Thrown when a frontmatter block names a language DorkOS will not parse. */
export class UnsupportedFrontmatterError extends Error {
  /** The language named after the opening `---`, trimmed. */
  readonly language: string;

  /**
   * Build the error for one refused language.
   *
   * @param language - The language named after the opening delimiter.
   */
  constructor(language: string) {
    super(
      `Frontmatter written as "${language}" is not supported. Use YAML between plain "---" lines.`
    );
    this.name = 'UnsupportedFrontmatterError';
    this.language = language;
  }
}

/**
 * How much frontmatter DorkOS will read. Real skill, command and agent headers
 * are a few hundred bytes to a few kilobytes and expand to a few thousand
 * units, so these leave two orders of magnitude of headroom.
 */
export const FRONTMATTER_LIMITS = {
  /** Largest raw frontmatter block, in UTF-16 code units (about bytes). */
  maxBytes: 64 * 1024,
  /** Largest expanded size: one per value, plus every string and key length. */
  maxExpanded: 1_000_000,
  /** Deepest nesting of lists and mappings. */
  maxDepth: 64,
} as const;

/** Thrown when a frontmatter block is larger, or expands larger, than DorkOS reads. */
export class OversizedFrontmatterError extends Error {
  /**
   * Build the error for one exceeded limit.
   *
   * @param detail - Which limit was exceeded, in plain words.
   */
  constructor(detail: string) {
    super(`Frontmatter is too large to read: ${detail}.`);
    this.name = 'OversizedFrontmatterError';
  }
}

/**
 * Refuse a parsed value that is larger than {@link FRONTMATTER_LIMITS} once its
 * shared references are expanded, walking it as a consumer would and stopping
 * the moment it goes over, so the check never costs more than the budget.
 *
 * @param value - The parsed frontmatter value.
 * @throws {OversizedFrontmatterError} When it expands or nests past the limits.
 */
function assertWithinBudget(value: unknown): void {
  let expanded = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    expanded += typeof node === 'string' ? 1 + node.length : 1;
    if (expanded > FRONTMATTER_LIMITS.maxExpanded) {
      throw new OversizedFrontmatterError(
        `it expands to more than ${FRONTMATTER_LIMITS.maxExpanded.toLocaleString('en-US')} values and characters, usually because of repeated YAML aliases (*name)`
      );
    }
    if (node === null || typeof node !== 'object') continue;
    if (depth >= FRONTMATTER_LIMITS.maxDepth) {
      throw new OversizedFrontmatterError(
        `it is nested more than ${FRONTMATTER_LIMITS.maxDepth} levels deep`
      );
    }
    if (Array.isArray(node)) {
      for (const child of node) stack.push([child, depth + 1]);
    } else {
      for (const [key, child] of Object.entries(node)) {
        expanded += key.length;
        stack.push([child, depth + 1]);
      }
    }
  }
}

/**
 * Parse one raw frontmatter block with `parse`, inside the size budget.
 *
 * @param str - The raw block gray-matter found between the fences.
 * @param parse - The data parser for its language.
 * @returns The parsed value.
 * @throws {OversizedFrontmatterError} When the block or its expansion is too large.
 */
function parseWithinBudget(str: string, parse: (source: string) => unknown): object {
  if (str.length > FRONTMATTER_LIMITS.maxBytes) {
    throw new OversizedFrontmatterError(
      `it is longer than ${FRONTMATTER_LIMITS.maxBytes / 1024} KB`
    );
  }
  const value = parse(str);
  assertWithinBudget(value);
  return value as object;
}

/** The result of {@link parseFrontmatter}. */
export interface ParsedFrontmatter {
  /** The frontmatter mapping; `{}` when the content has none. */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter, untrimmed. */
  content: string;
}

/** Thrown when a frontmatter block parses to something other than a mapping. */
export class NonMappingFrontmatterError extends Error {
  /**
   * Build the error for a block that is a scalar, list or null.
   *
   * @param kind - What the block parsed to (`string`, `array`, `null`, ...).
   */
  constructor(kind: string) {
    super(`Frontmatter must be a list of "key: value" fields, but this one is ${kind}.`);
    this.name = 'NonMappingFrontmatterError';
  }
}

/** Engine that refuses to run, standing in for gray-matter's `eval` engine. */
const refusingEngine = {
  parse(_source?: string): never {
    throw new UnsupportedFrontmatterError('javascript');
  },
  stringify(): never {
    throw new UnsupportedFrontmatterError('javascript');
  },
};

/**
 * Throw on an `undefined` anywhere in `value`. js-yaml v4 silently drops an
 * `undefined` key where v3 (gray-matter's own) threw, and a silently dropped
 * `schedule` key would un-schedule a skill with no error at all.
 *
 * @param value - The data about to be written.
 * @param at - Dotted path of `value`, for the message.
 */
function assertNoUndefined(value: unknown, at: string): void {
  if (value === undefined) {
    throw new TypeError(`Frontmatter value at "${at}" is undefined, which YAML cannot hold.`);
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assertNoUndefined(child, at === '' ? key : `${at}.${key}`);
  }
}

/**
 * The engines every gray-matter call uses. Exported only so tests can prove
 * each layer on its own; call {@link parseFrontmatter} and
 * {@link stringifyFrontmatter} instead.
 *
 * @internal
 */
export const FRONTMATTER_ENGINES = {
  yaml: {
    parse: (str: string): object =>
      parseWithinBudget(str, (source) => yaml.load(source, { schema: yaml.DEFAULT_SCHEMA })),
    stringify: (data: object): string => {
      assertNoUndefined(data, '');
      return yaml.dump(data, { schema: yaml.DEFAULT_SCHEMA });
    },
  },
  json: {
    parse: (str: string): object => parseWithinBudget(str, (source) => JSON.parse(source)),
    stringify: (data: object): string => JSON.stringify(data, null, 2),
  },
  javascript: refusingEngine,
  js: refusingEngine,
};

/**
 * Options passed to every gray-matter call. Passing any options object also
 * bypasses gray-matter's cache in both directions.
 */
const MATTER_OPTIONS = { language: 'yaml', engines: FRONTMATTER_ENGINES };

/**
 * Refuse a frontmatter block that names a non-data language, using gray-matter's
 * own rules for spotting one: the content (BOM stripped) opens with `---`, the
 * fourth character is not another `-`, and whatever follows on that first line
 * is the language.
 *
 * An allowed language comes back lowercased on the fence line, because
 * gray-matter matches `yaml`/`yml` in any case but looks `json` up exactly as
 * written, so `---JSON` would otherwise fail as an unregistered engine.
 *
 * @param content - Raw file content.
 * @returns The content to hand gray-matter, with the fence language lowercased.
 * @throws {UnsupportedFrontmatterError} For any language but YAML or JSON.
 */
function normalizeDataLanguage(content: string): string {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  if (!text.startsWith('---') || text.charAt(3) === '-') return content;
  const { raw, name } = matter.language(text);
  if (name === '') return content;
  if (!DATA_LANGUAGES.has(name.toLowerCase())) {
    throw new UnsupportedFrontmatterError(name);
  }
  return `---${raw.toLowerCase()}${text.slice(3 + raw.length)}`;
}

/**
 * Split markdown into its frontmatter mapping and body, safely.
 *
 * @param content - Raw file content (UTF-8).
 * @returns The frontmatter data and the untrimmed body.
 * @throws {UnsupportedFrontmatterError} When the block is written in a language
 *   other than YAML or JSON (for example `---js`).
 * @throws {OversizedFrontmatterError} When the block is too long, expands too
 *   large through YAML aliases, or nests too deep (DOR-2311).
 * @throws {NonMappingFrontmatterError} When the block is a scalar, list or null
 *   rather than `key: value` fields.
 * @throws The YAML or JSON parser's error when the block is malformed.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const parsed = matter(normalizeDataLanguage(content), MATTER_OPTIONS);
  const data: unknown = parsed.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new NonMappingFrontmatterError(
      Array.isArray(data) ? 'a list' : `a ${data === null ? 'null' : typeof data}`
    );
  }
  return { data: data as Record<string, unknown>, content: parsed.content };
}

/**
 * Write `data` as YAML frontmatter above `body`. The body is written as-is and
 * is never parsed, whatever it contains.
 *
 * @param body - Markdown body.
 * @param data - Frontmatter fields. An empty object writes the body alone.
 * @returns The full file text.
 * @throws {TypeError} When any value, at any depth, is `undefined` (js-yaml v4
 *   would silently drop the key; the wrapper refuses instead).
 * @throws js-yaml's error for any other value YAML cannot represent (e.g. a
 *   function).
 */
export function stringifyFrontmatter(body: string, data: Record<string, unknown>): string {
  return matter.stringify({ content: body }, data, MATTER_OPTIONS);
}
