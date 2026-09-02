/**
 * The text-level reading that touch chips need: pulling paths, URLs, diffstats
 * and deleted files out of tool inputs and results.
 *
 * Split out of `touch-chips.ts` so the accumulator there reads as one thing —
 * the fold — rather than as a fold buried in string handling. Everything here
 * is pure, best-effort, and refuses to guess: a shape it cannot read confidently
 * returns `undefined` or an empty list, never an invented value.
 *
 * @module features/chat/lib/touch-chip-parsers
 */

/** Lines added and removed by one edit. */
export interface Diffstat {
  /** Lines the edit introduced. */
  additions: number;
  /** Lines the edit removed. */
  deletions: number;
}

/** Sub-command separators a shell would honour, used to find `rm` inside a compound command. */
const INLINE_SEPARATORS = /\|\||&&|;|\|/;

/**
 * A heredoc marker or a redirect into a file. Once one of these appears, the
 * lines that follow are the thing being written, not the thing being run — the
 * `rm -rf /var/www/html` inside a deploy script is text, and claiming it as a
 * deletion is a lie about what the agent did.
 *
 * Deliberately blunt: any `>` counts, including `2>&1`, so a genuine `rm` on a
 * later line of the same command is sometimes missed. That is the safe
 * direction. A deletion this never finds is a chip the reader does not get; a
 * deletion this invents is a chip that says a file is gone when it is not.
 */
const WRITES_A_FILE = /<<|>/;

/** How much of a command a chip shows and says. Enough to recognise, not enough to bury the row. */
const COMMAND_LABEL_MAX = 60;

/** Parse a tool call's JSON-encoded input. Returns null for anything that is not a JSON object. */
export function parseToolInput(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read a non-empty string field off a parsed tool input. */
export function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A coarse, deterministic line diffstat: everything between the shared opening
 * and closing lines counts as changed.
 *
 * Deliberately not a real diff. Nothing on the wire carries a structured patch
 * for these tools, and the chip only needs a number that grows honestly as edits
 * land — precision here would buy nothing a reader could see.
 */
function lineDiffstat(oldText: string, newText: string): Diffstat {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const overlap = prefix + suffix;
  return {
    additions: Math.max(0, newLines.length - overlap),
    deletions: Math.max(0, oldLines.length - overlap),
  };
}

/**
 * Diffstat for an `Edit`-shaped input — the `old_string`/`new_string` pair
 * `OutputRenderer`'s `parseEditInput` already reads. Absent when neither is
 * there, which is how a `NotebookEdit` ends up with no numbers instead of
 * fabricated ones.
 */
export function editDiffstat(input: Record<string, unknown>): Diffstat | undefined {
  const oldText = input.old_string;
  const newText = input.new_string;
  if (typeof oldText !== 'string' && typeof newText !== 'string') return undefined;
  return lineDiffstat(
    typeof oldText === 'string' ? oldText : '',
    typeof newText === 'string' ? newText : ''
  );
}

/** Diffstat for a `MultiEdit` input — the sum across its `edits[]` entries. */
export function multiEditDiffstat(input: Record<string, unknown>): Diffstat | undefined {
  const edits = input.edits;
  if (!Array.isArray(edits)) return editDiffstat(input);

  let additions = 0;
  let deletions = 0;
  let counted = false;
  for (const entry of edits) {
    if (typeof entry !== 'object' || entry === null) continue;
    const stat = editDiffstat(entry as Record<string, unknown>);
    if (!stat) continue;
    additions += stat.additions;
    deletions += stat.deletions;
    counted = true;
  }
  return counted ? { additions, deletions } : undefined;
}

/** Render a diffstat the way the chip and its history show it: `+12 −4`, with a real minus sign. */
export function formatDiffstat(stat: Diffstat | undefined): string {
  if (!stat) return '';
  return ` +${stat.additions} −${stat.deletions}`;
}

/**
 * How many lines a `Write` put on disk.
 *
 * A created file is entirely new, so its line count is an honest `+A` — and it
 * is the only write that can report one. Nothing on the wire says what an
 * overwrite replaced, so counting an overwrite's lines as additions would claim
 * a file grew by 90 lines when it may have shrunk.
 *
 * A single trailing newline is the end of the last line, not an extra one.
 */
export function writtenLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replace(/\n$/, '').split('\n').length;
}

/**
 * Reduce a path to the form two tools would have to agree on to mean one file:
 * no trailing slash, no leading `./`, and no `..` left to walk.
 *
 * This is what stops `Read /repo/src/old.ts` followed by `rm ./src/old.ts` from
 * becoming two chips — one of them a live link to a file that is gone. It is
 * textual, not resolved against a working directory: nothing on the wire says
 * what `src/a.ts` was relative to, so the absolute-vs-relative half of the same
 * question is answered by {@link pathsAlias} at fold time instead.
 */
export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed.length === 0) return path;

  const absolute = trimmed.startsWith('/');
  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      // A `..` only cancels a real segment. Above the root there is nowhere to
      // go, so it is dropped; in a relative path it is kept, because
      // `../src/a.ts` names a file this cannot resolve any further.
      if (last !== undefined && last !== '..') segments.pop();
      else if (!absolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (joined.length === 0) return absolute ? '/' : path;
  return absolute ? `/${joined}` : joined;
}

/**
 * Whether two normalized paths name the same file, one of them absolute and the
 * other relative to somewhere inside it.
 *
 * `/repo/src/a.ts` and `src/a.ts` are the same file the moment one of them ends
 * with the other; two relative paths that merely look alike are not, because
 * `a/x.ts` and `b/x.ts` both end with `x.ts` and are different files. Only the
 * absolute-vs-relative pair is ever folded, which is exactly the case the wire
 * produces: tools name a file by its full path, shells name it by where they are.
 */
export function pathsAlias(a: string, b: string): boolean {
  if (a === b) return true;
  const absolute = a.startsWith('/') ? a : b;
  const relative = a.startsWith('/') ? b : a;
  if (!absolute.startsWith('/') || relative.startsWith('/')) return false;
  return absolute.endsWith(`/${relative}`);
}

/** Last path segment, falling back to the whole path when there is no segment to take. */
export function basename(path: string): string {
  const segments = normalizePath(path).split('/');
  return segments[segments.length - 1] || path;
}

/**
 * Drop a URL's fragment so `#section1` and `#section2` on one page are one chip.
 * The query string stays — it usually selects a different page.
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

/** The domain a URL chip is labelled with: host without a leading `www.`. */
export function urlLabel(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

/**
 * Best-effort hit count from a `Grep` result. The tool returns plain text whose
 * shape depends on its output mode, so this reads the count it states and
 * otherwise falls back to counting the lines it printed. A result it cannot read
 * carries no count at all rather than a wrong one.
 *
 * Two shapes are refused outright. A result that counts **files** is answering a
 * different question — `files_with_matches` mode says how many files contain a
 * match, never how many matches there are — so it yields no count rather than a
 * file tally wearing an `N hits` badge. And an error result is not a result: a
 * grep that failed found nothing it can report, and its text is a message, not
 * matches.
 */
export function grepHits(result: string | undefined): number | undefined {
  if (!result) return undefined;
  const text = result.trim();
  if (text.length === 0) return undefined;
  if (/^no (matches|files)/i.test(text)) return 0;

  const bare = /^(\d+)$/.exec(text);
  if (bare) return Number(bare[1]);

  const stated = /(\d+)\s+(?:matches?|lines?)/i.exec(text);
  if (stated) return Number(stated[1]);

  if (/\d+\s+files?/i.test(text)) return undefined;

  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * What a command chip is called: its first meaningful line, short enough to sit
 * in a row of pills.
 *
 * A `Bash` command can be a whole script — a heredoc writing a deploy file runs
 * to hundreds of characters — and the full text is still the chip's identity and
 * its tooltip. This is only what the chip shows and says out loud.
 */
export function commandLabel(command: string): string {
  const firstLine = command
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();
  const line = firstLine ?? command.trim();
  if (line.length <= COMMAND_LABEL_MAX) return line;
  return `${line.slice(0, COMMAND_LABEL_MAX - 1).trimEnd()}…`;
}

/**
 * Split a shell command into words, honouring single and double quotes so a
 * quoted path with spaces survives as one word.
 *
 * Not a shell parser — it makes no attempt at escapes, expansion, or
 * substitution, because the only question ever asked of it is "which paths did
 * this `rm` name".
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/**
 * The paths a command deletes — `rm` and `git rm`, in any sub-command of a
 * compound line. A deletion the agent performed through a shell is still a
 * deletion, and the design is explicit that deletions are never invisible.
 *
 * Conservative on purpose: anything it cannot read confidently yields no path,
 * because a guessed deletion is worse than a missing one. The sharpest edge is a
 * command that WRITES a script rather than running one — `cat > deploy.sh <<'EOF'`
 * followed by lines that happen to contain `rm -rf`. Those lines are file
 * contents, so reading past a heredoc or a redirect stops (see
 * {@link WRITES_A_FILE}); the line carrying the marker is still read, so
 * `rm old.ts > log.txt` keeps its deletion.
 */
export function parseDeletedPaths(command: string): string[] {
  const paths: string[] = [];
  for (const line of command.split('\n')) {
    for (const segment of line.split(INLINE_SEPARATORS)) {
      const words = shellWords(segment.trim());
      if (words.length === 0) continue;

      let cursor: number;
      if (words[0] === 'git' && words[1] === 'rm') cursor = 2;
      else if (words[0] === 'rm') cursor = 1;
      else continue;

      for (const word of words.slice(cursor)) {
        // A redirect ends the argument list. What follows it is where the output
        // goes — `/dev/null` is not a file this command deleted.
        if (word.includes('>') || word.includes('<')) break;
        if (word === '--' || word.startsWith('-') || word.length === 0) continue;
        paths.push(word);
      }
    }
    if (WRITES_A_FILE.test(line)) break;
  }
  return paths;
}
