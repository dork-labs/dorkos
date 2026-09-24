/**
 * The one way to read and write markdown frontmatter in DorkOS.
 *
 * Everything DorkOS reads here can come from someone else: marketplace
 * packages, git checkouts, agents. So this module treats every header as
 * untrusted data, and does the whole job itself rather than through a
 * general-purpose library.
 *
 * It used to wrap `gray-matter`, which is a code runner as well as a parser: a
 * block opening with `---js` goes to an engine that calls `eval` (DOR-2308).
 * Before any engine runs, gray-matter also strips comments with a regular
 * expression that is quadratic in the block's length, and it keeps a
 * process-wide cache. A wrapper could refuse the eval but not the rest
 * (DOR-2311), so this module now splits the fences itself, with the same
 * rules gray-matter used, and hands the block straight to a data parser.
 * Nothing in the repo imports gray-matter any more; an ESLint ban and
 * `scripts/__tests__/gray-matter-import-boundary.test.ts` keep it that way.
 *
 * Reading:
 *
 * 1. Only YAML and JSON are read. Any other language named after the opening
 *    `---` (`---js`, `---coffee`, `---constructor`) is refused.
 * 2. The block is capped at {@link FRONTMATTER_LIMITS}`.maxBlockBytes` UTF-8
 *    bytes before anything else looks at it, whitespace and comments included.
 * 3. YAML is parsed by js-yaml v4 with its default schema, which has no
 *    JavaScript types, and with a nesting limit. Explicit `? ` keys are
 *    refused. YAML aliases (`*name`) are shared references, so a few hundred
 *    bytes can describe billions of values. While parsing, aliases are
 *    counted and every list and mapping is sized with its aliases expanded,
 *    and parsing stops at the first one past its limit. Recursive aliases are
 *    refused. js-yaml itself caps keys copied by `<<` merges and refuses
 *    lists nested inside keys.
 * 4. The parsed value is walked the way a consumer would, aliases expanded,
 *    and refused past `maxExpanded` units (one per value, plus one per
 *    character of every string and key) or `maxDepth` levels. The walk stops
 *    at the limit, so refusing costs at most the budget.
 * 5. The result must be `key: value` fields; a lone value or a list is refused.
 *
 * Writing never parses the body, and refuses an `undefined` value anywhere
 * (js-yaml v4 would silently drop the key).
 *
 * @module skills/frontmatter
 */
import yaml from 'js-yaml';

/** Frontmatter languages DorkOS reads, by the name written after `---`. */
const DATA_LANGUAGES: ReadonlyMap<string, 'yaml' | 'json'> = new Map([
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['json', 'json'],
]);

/**
 * How much frontmatter DorkOS will read. The largest real header in the
 * DorkOS, marketplace and plugin corpora is about 16 KB, expands to a few
 * thousand units, nests four levels deep and uses no aliases.
 */
export const FRONTMATTER_LIMITS = {
  /** Largest frontmatter block, in UTF-8 bytes, measured before any parsing. */
  maxBlockBytes: 32 * 1024,
  /** Most YAML aliases (`*name`) one block may use. */
  maxAliases: 100,
  /** Largest expanded size: one per value, plus every string and key length. */
  maxExpanded: 1_000_000,
  /** Deepest nesting of lists and mappings. */
  maxDepth: 64,
} as const;

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

/** Thrown when a frontmatter block is larger, or expands larger, than DorkOS reads. */
export class OversizedFrontmatterError extends Error {
  /**
   * Build the error for one exceeded limit.
   *
   * @param detail - Which limit was exceeded, in plain words.
   * @param options - The parser error that reported it, when there was one.
   */
  constructor(detail: string, options?: ErrorOptions) {
    super(`Frontmatter is too large to read: ${detail}.`, options);
    this.name = 'OversizedFrontmatterError';
  }
}

/** Thrown when a frontmatter block parses to something other than a mapping. */
export class NonMappingFrontmatterError extends Error {
  /**
   * Build the error for a block that is a scalar or a list.
   *
   * @param kind - What the block parsed to (`a string`, `a list`, ...).
   */
  constructor(kind: string) {
    super(`Frontmatter must be a list of "key: value" fields, but this one is ${kind}.`);
    this.name = 'NonMappingFrontmatterError';
  }
}

/** The result of {@link parseFrontmatter}. */
export interface ParsedFrontmatter {
  /** The frontmatter mapping; `{}` when the content has none. */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter, untrimmed. */
  content: string;
}

/** The expanded size of a primitive: one, plus a string's length. */
function primitiveSize(value: unknown): number {
  return typeof value === 'string' ? 1 + value.length : 1;
}

/** Refusal for a value nested past the depth limit. */
function tooDeep(options?: ErrorOptions): OversizedFrontmatterError {
  return new OversizedFrontmatterError(
    `it is nested more than ${FRONTMATTER_LIMITS.maxDepth} levels deep`,
    options
  );
}

/** Refusal for a value that expands past the budget. */
function tooExpanded(): OversizedFrontmatterError {
  return new OversizedFrontmatterError(
    `it expands to more than ${FRONTMATTER_LIMITS.maxExpanded.toLocaleString('en-US')} values and characters, usually because of repeated YAML aliases (*name)`
  );
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
    expanded += primitiveSize(node);
    if (expanded > FRONTMATTER_LIMITS.maxExpanded) throw tooExpanded();
    if (node === null || typeof node !== 'object') continue;
    if (depth >= FRONTMATTER_LIMITS.maxDepth) throw tooDeep();
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

/** The slice of js-yaml's loader state a listener can read. */
interface YamlListenerState {
  /** The text being parsed (js-yaml may append a newline). */
  input: string;
  /** Where the parser is in `input`. */
  position: number;
  /** The node just composed, on a `close` event. */
  result: unknown;
}

/**
 * An alias node: separation space or whole comment lines, then `*`, at a
 * node's start. A comment must run to its line break, so a `*` inside one is
 * never taken for an alias.
 */
const ALIAS_AT = /(?:[ \t\r\n]|#[^\n]*\n)*\*/y;

/**
 * A js-yaml listener that bounds aliases while the document is parsed, before
 * anything (a mapping key's string conversion, a caller) can repeat an aliased
 * value. Every alias counts towards {@link FRONTMATTER_LIMITS}`.maxAliases`.
 * Every list and mapping is sized as it finishes, aliases expanded, and
 * refused past `maxExpanded`, so a chain of aliases to aliases is refused at
 * the first level that grows too large, while its cost is still small.
 *
 * Sizes are kept per composed collection, one level at a time, so the
 * bookkeeping is linear in the text. An alias to a collection that has not
 * finished composing is a recursive alias and is refused.
 *
 * @returns The listener to pass to `yaml.load`.
 */
function aliasBudgetListener(): (event: 'open' | 'close', state: YamlListenerState) => void {
  const sizes = new WeakMap<object, number>();
  const starts: number[] = [];
  let aliases = 0;

  const sizeOf = (value: unknown): number => {
    if (value === null || typeof value !== 'object') return primitiveSize(value);
    const known = sizes.get(value);
    if (known === undefined) {
      throw new OversizedFrontmatterError('an alias (*name) refers to a value that contains it');
    }
    return known;
  };

  return (event, state) => {
    if (event === 'open') {
      starts.push(state.position);
      return;
    }
    const start = starts.pop() ?? state.position;
    ALIAS_AT.lastIndex = start;
    if (ALIAS_AT.test(state.input)) {
      aliases += 1;
      if (aliases > FRONTMATTER_LIMITS.maxAliases) {
        throw new OversizedFrontmatterError(
          `it uses more than ${FRONTMATTER_LIMITS.maxAliases} YAML aliases (*name)`
        );
      }
      // Resolves the target now, so a recursive alias is refused here.
      sizeOf(state.result);
      return;
    }
    const value = state.result;
    if (value === null || typeof value !== 'object' || sizes.has(value)) return;
    let size = 1;
    if (Array.isArray(value)) {
      for (const child of value) size += sizeOf(child);
    } else {
      for (const [key, child] of Object.entries(value)) size += key.length + sizeOf(child);
    }
    if (size > FRONTMATTER_LIMITS.maxExpanded) throw tooExpanded();
    sizes.set(value, size);
  };
}

/**
 * An explicit YAML key (`? `), at the start of a line (after indentation and
 * any `- `) or right after a flow `[`, `{` or `,`. Such keys can be whole lists
 * or mappings, which js-yaml turns into strings by joining them while it parses.
 */
const EXPLICIT_KEY = /^[ \t]*(?:-[ \t]+)*\?(?:[ \t]|$)|[[{,][ \t]*\?(?:[ \t]|$)/m;

/**
 * The data parsers, each bounded by {@link FRONTMATTER_LIMITS}. Exported only
 * so tests can prove each bound on its own; call {@link parseFrontmatter}.
 *
 * @internal
 */
export const FRONTMATTER_PARSERS = {
  /**
   * Parse a YAML block, refusing explicit keys, deep nesting, too many aliases
   * and oversized expansions while it parses, then walking the result.
   */
  yaml: (block: string): unknown => {
    if (EXPLICIT_KEY.test(block)) {
      throw new OversizedFrontmatterError(
        'it uses an explicit "? " key, which DorkOS does not read'
      );
    }
    let value: unknown;
    try {
      // js-yaml 4.3 has `maxDepth`; @types/js-yaml 4.0.9 does not know it yet.
      const options: yaml.LoadOptions & { maxDepth: number } = {
        schema: yaml.DEFAULT_SCHEMA,
        maxDepth: FRONTMATTER_LIMITS.maxDepth,
        listener: aliasBudgetListener() as (this: unknown, ...args: unknown[]) => void,
      };
      value = yaml.load(block, options);
    } catch (err) {
      // js-yaml's own limits (nesting depth, and its cap on keys copied by
      // `<<` merges), reported like the others.
      if (err instanceof yaml.YAMLException) {
        if (err.reason.startsWith('nesting exceeded maxDepth')) throw tooDeep({ cause: err });
        if (err.reason.startsWith('merge keys exceeded')) {
          throw new OversizedFrontmatterError('it merges too many keys with "<<"', { cause: err });
        }
      }
      throw err;
    }
    assertWithinBudget(value);
    return value;
  },
  /** Parse a JSON block, then walk the result. */
  json: (block: string): unknown => {
    const value: unknown = JSON.parse(block);
    assertWithinBudget(value);
    return value;
  },
};

/** Fence-split markdown: the block and its language when there is one. */
interface SplitFrontmatter {
  /** The data language, when the content opens with a frontmatter fence. */
  language: 'yaml' | 'json' | null;
  /** Everything between the fences (no block when `language` is null). */
  block: string;
  /** Everything after the closing fence. */
  body: string;
}

/**
 * Split content into its frontmatter block and body with gray-matter's rules,
 * which every file DorkOS already reads was written against:
 *
 * - A leading byte-order mark is dropped.
 * - Frontmatter opens with `---` at the very start, not followed by another
 *   `-`. Whatever else is on that line, trimmed, is the language.
 * - The block ends at the first line that starts with `---`; the rest of that
 *   line, and then one line break, are dropped. Without a closing line the
 *   whole rest of the file is the block and the body is empty.
 *
 * Linear in the content's length.
 *
 * @param content - Raw file content.
 * @returns The split.
 * @throws {UnsupportedFrontmatterError} For a language other than YAML or JSON.
 */
function splitFrontmatter(content: string): SplitFrontmatter {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!text.startsWith('---') || text.charAt(3) === '-') {
    return { language: null, block: '', body: text };
  }
  let rest = text.slice(3);
  // As gray-matter: the language runs to the first line break. With no line
  // break at all it drops the last character, which only matters for a file
  // that is nothing but an opening fence.
  const lineBreak = rest.search(/\r?\n/);
  const rawLanguage = rest.slice(0, lineBreak);
  const name = rawLanguage.trim();
  let language: 'yaml' | 'json' = 'yaml';
  if (name !== '') {
    const known = DATA_LANGUAGES.get(name.toLowerCase());
    if (known === undefined) throw new UnsupportedFrontmatterError(name);
    language = known;
    rest = rest.slice(rawLanguage.length);
  }
  const close = rest.indexOf('\n---');
  if (close === -1) return { language, block: rest, body: '' };
  let body = rest.slice(close + 4);
  if (body.startsWith('\r')) body = body.slice(1);
  if (body.startsWith('\n')) body = body.slice(1);
  return { language, block: rest.slice(0, close), body };
}

/**
 * Whether a block holds nothing but whitespace and `#` comment lines, which
 * gray-matter read as no fields without parsing. Linear, unlike the regular
 * expression gray-matter used for this.
 *
 * @param block - The frontmatter block.
 */
function isBlankBlock(block: string): boolean {
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue;
    const text = line.trimStart();
    if (text.startsWith('#') && text.length > 1) continue;
    return false;
  }
  return true;
}

/**
 * Split markdown into its frontmatter mapping and body, safely.
 *
 * @param content - Raw file content (UTF-8).
 * @returns The frontmatter data and the untrimmed body.
 * @throws {UnsupportedFrontmatterError} When the block is written in a language
 *   other than YAML or JSON (for example `---js`).
 * @throws {OversizedFrontmatterError} When the block is too long, uses too many
 *   aliases, expands too large, nests too deep, or uses an explicit `? ` key
 *   (DOR-2311).
 * @throws {NonMappingFrontmatterError} When the block is a lone value or a
 *   list rather than `key: value` fields.
 * @throws The YAML or JSON parser's error when the block is malformed.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const { language, block, body } = splitFrontmatter(content);
  if (language === null) return { data: {}, content: body };
  if (Buffer.byteLength(block, 'utf8') > FRONTMATTER_LIMITS.maxBlockBytes) {
    throw new OversizedFrontmatterError(
      `it is longer than ${FRONTMATTER_LIMITS.maxBlockBytes / 1024} KB`
    );
  }
  if (isBlankBlock(block)) return { data: {}, content: body };
  const data = FRONTMATTER_PARSERS[language](block);
  if (data === null || data === undefined) return { data: {}, content: body };
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new NonMappingFrontmatterError(Array.isArray(data) ? 'a list' : `a ${typeof data}`);
  }
  return { data: data as Record<string, unknown>, content: body };
}

/**
 * Throw on an `undefined` anywhere in `value`. js-yaml v4 silently drops an
 * `undefined` key, and a silently dropped `schedule` key would un-schedule a
 * skill with no error at all.
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
 * Write `data` as YAML frontmatter above `body`. The body is written as-is and
 * is never parsed, whatever it contains.
 *
 * @param body - Markdown body.
 * @param data - Frontmatter fields. An empty object writes the body alone.
 * @returns The full file text, ending in a line break.
 * @throws {TypeError} When any value, at any depth, is `undefined` (js-yaml v4
 *   would silently drop the key; this refuses instead).
 * @throws js-yaml's error for any other value YAML cannot represent (e.g. a
 *   function).
 */
export function stringifyFrontmatter(body: string, data: Record<string, unknown>): string {
  assertNoUndefined(data, '');
  const fields = yaml.dump({ ...data }, { schema: yaml.DEFAULT_SCHEMA }).trim();
  const head = fields === '{}' ? '' : `---\n${fields}\n---\n`;
  return head + (body.endsWith('\n') ? body : `${body}\n`);
}
