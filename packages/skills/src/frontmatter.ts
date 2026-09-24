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

/** The result of {@link parseFrontmatter}. */
export interface ParsedFrontmatter {
  /** The frontmatter mapping; `{}` when the content has none. */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter, untrimmed. */
  content: string;
}

/** Engine that refuses to run, standing in for gray-matter's `eval` engine. */
const refusingEngine = {
  parse(): never {
    throw new UnsupportedFrontmatterError('javascript');
  },
  stringify(): never {
    throw new UnsupportedFrontmatterError('javascript');
  },
};

/**
 * Options passed to every gray-matter call. Passing any options object also
 * bypasses gray-matter's cache in both directions.
 */
const MATTER_OPTIONS = {
  language: 'yaml',
  engines: {
    yaml: {
      parse: (str: string): object => yaml.load(str, { schema: yaml.DEFAULT_SCHEMA }) as object,
      stringify: (data: object): string => yaml.dump(data, { schema: yaml.DEFAULT_SCHEMA }),
    },
    json: {
      parse: (str: string): object => JSON.parse(str) as object,
      stringify: (data: object): string => JSON.stringify(data, null, 2),
    },
    javascript: refusingEngine,
    js: refusingEngine,
  },
};

/**
 * Refuse a frontmatter block that names a non-data language, using gray-matter's
 * own rules for spotting one: the content (BOM stripped) opens with `---`, the
 * fourth character is not another `-`, and whatever follows on that first line
 * is the language.
 *
 * @param content - Raw file content.
 * @throws {UnsupportedFrontmatterError} For any language but YAML or JSON.
 */
function assertDataLanguage(content: string): void {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  if (!text.startsWith('---') || text.charAt(3) === '-') return;
  const language = matter.language(text).name;
  if (language !== '' && !DATA_LANGUAGES.has(language.toLowerCase())) {
    throw new UnsupportedFrontmatterError(language);
  }
}

/**
 * Split markdown into its frontmatter mapping and body, safely.
 *
 * @param content - Raw file content (UTF-8).
 * @returns The frontmatter data and the untrimmed body.
 * @throws {UnsupportedFrontmatterError} When the block is written in a language
 *   other than YAML or JSON (for example `---js`).
 * @throws The YAML or JSON parser's error when the block is malformed.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  assertDataLanguage(content);
  const parsed = matter(content, MATTER_OPTIONS);
  return { data: parsed.data, content: parsed.content };
}

/**
 * Write `data` as YAML frontmatter above `body`. The body is written as-is and
 * is never parsed, whatever it contains.
 *
 * @param body - Markdown body.
 * @param data - Frontmatter fields. An empty object writes the body alone.
 * @returns The full file text.
 * @throws js-yaml's error for a value YAML cannot represent (e.g. `undefined`).
 */
export function stringifyFrontmatter(body: string, data: Record<string, unknown>): string {
  return matter.stringify({ content: body }, data, MATTER_OPTIONS);
}
