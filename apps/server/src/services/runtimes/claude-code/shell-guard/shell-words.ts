/**
 * Read a shell command line well enough to say which paths it names (DOR-3300).
 *
 * **This is a string check, so it is a mitigation, not a boundary.** It takes in `~`, `$HOME`,
 * simple assignments, quotes, escapes, braces and heredocs, but it runs nothing, so a path built
 * while the command runs (`$(printf …)`, base64, a script file) gets past it. The real boundary is
 * agents running as a separate OS user (DOR-3053).
 *
 * @module services/runtimes/claude-code/shell-guard/shell-words
 */

/** One command in a chain or pipeline. */
export interface ShellSegment {
  /** Its words with quotes removed. */
  words: string[];
  /** The words right after a `>`. */
  redirects: string[];
  /** Its heredoc bodies, which only mean something to a program that runs them. */
  scripts: string[];
}

/** The most brace alternatives one word opens into before it counts as too much to check. */
const MAX_BRACE_RESULTS = 256;
/** A word this long, with no spaces, opening braces, counts as too much to check. */
const MAX_BRACE_WORD = 1_024;
/** The longest `${NAME:-default}` default read. A bound keeps an unclosed run of them linear. */
const MAX_DEFAULT_VALUE = 256;
/** The longest path any platform here opens, so nothing longer is worth testing. */
const MAX_PATH_PIECE = 1_024;

/**
 * Split a command line into its commands. Never throws: an unclosed quote just ends the word.
 *
 * @param command - The command line.
 */
export function parseShell(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current: ShellSegment = { words: [], redirects: [], scripts: [] };
  let word = '';
  let inWord = false;
  let nextIsRedirect = false;
  const heredocs: string[] = [];

  const endWord = (): void => {
    if (inWord) {
      if (nextIsRedirect) current.redirects.push(word);
      else current.words.push(word);
      nextIsRedirect = false;
    }
    word = '';
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    nextIsRedirect = false;
    if (current.words.length > 0 || current.redirects.length > 0) segments.push(current);
    current = { words: [], redirects: [], scripts: [] };
  };

  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    if (char === '\\' && command[i + 1] === '\n') {
      // A line continuation: the command carries on, as if the break weren't there.
      i += 2;
    } else if (char === '\\') {
      word += command[i + 1] ?? '';
      inWord = true;
      i += 2;
    } else if (char === "'") {
      const close = command.indexOf(char, i + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (char === '"') {
      inWord = true;
      i += 1;
      while (i < command.length && command[i] !== '"') {
        // Inside double quotes a backslash only escapes these, so `\"` never ends the word.
        if (command[i] === '\\' && '"\\$`'.includes(command[i + 1] ?? '')) i += 1;
        word += command[i] ?? '';
        i += 1;
      }
      i += 1;
    } else if (char === '#' && !inWord) {
      const newline = command.indexOf('\n', i);
      i = newline === -1 ? command.length : newline;
    } else if (command.startsWith('<<', i) && command[i + 2] !== '<') {
      endWord();
      // A delimiter starts with a letter: `$((1<<2))` is arithmetic, and would swallow the rest.
      const match = /^<<-?\s*\\?(['"]?)([A-Za-z_][\w.-]*)\1/.exec(command.slice(i));
      if (match) {
        heredocs.push(match[2]!);
        i += match[0].length;
      } else {
        i += 2;
      }
    } else if (char === '\n') {
      if (heredocs.length > 0) {
        let at = i + 1;
        for (const delimiter of heredocs.splice(0)) {
          const lines = command.slice(at).split('\n');
          const last = lines.findIndex((line) => line.trim() === delimiter);
          const body = (last === -1 ? lines : lines.slice(0, last)).join('\n');
          current.scripts.push(body);
          at += body.length + (last === -1 ? 0 : delimiter.length + 2);
        }
        i = at;
      } else {
        endSegment();
        i += 1;
      }
    } else if (';&|()`'.includes(char)) {
      if (char === '(' && word.endsWith('$')) {
        word = word.slice(0, -1);
        inWord = word.length > 0;
      }
      // `&>` and `2>&1` write or copy; `&` only ends a command when no `>` leads to or from it.
      if (char === '&' && (command[i + 1] === '>' || command[i - 1] === '>')) {
        endWord();
        i += 1;
        continue;
      }
      endSegment();
      i += 1;
    } else if (char === '<' || char === '>') {
      endWord();
      nextIsRedirect = char === '>';
      // `>>` appends and `>|` overwrites: the next word is the target either way.
      while (command[i + 1] === '>' || command[i + 1] === '|') i += 1;
      i += 1;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
      i += 1;
    } else {
      word += char;
      inWord = true;
      i += 1;
    }
  }
  endSegment();
  return segments;
}

/**
 * Open `{a,b}` alternatives, keeping `${…}` for the variable step. A word with a space in it was
 * quoted, so a shell opens none of its braces, and a script's `{a, b}` is the script's.
 *
 * @param word - A word.
 * @returns What it opens into, or `null` when that is too much to check.
 */
export function expandBraces(word: string): string[] | null {
  if (/\s/.test(word) || !word.includes('{')) return [word];
  if (word.length > MAX_BRACE_WORD) return null;
  const results: string[] = [];
  const pending = [word];
  while (pending.length > 0) {
    const next = pending.pop()!;
    const group = firstBraceGroup(next);
    if (!group) {
      results.push(next);
      continue;
    }
    const parts = next.slice(group.start + 1, group.end).split(',');
    // Counted before any is built: a single group can name thousands.
    if (results.length + pending.length + parts.length > MAX_BRACE_RESULTS) return null;
    for (const part of parts) {
      pending.push(`${next.slice(0, group.start)}${part}${next.slice(group.end + 1)}`);
    }
  }
  return results;
}

/** The first `{a,b}` with no brace inside, skipping `${…}`. A scan, so a run of commas stays linear. */
function firstBraceGroup(word: string): { start: number; end: number } | undefined {
  let open = -1;
  let comma = false;
  for (let i = 0; i < word.length; i++) {
    const char = word[i];
    if (char === '{') {
      open = word[i - 1] === '$' ? -1 : i;
      comma = false;
    } else if (char === ',') {
      comma = true;
    } else if (char === '}') {
      if (open !== -1 && comma) return { start: open, end: i };
      open = -1;
    }
  }
  return undefined;
}

/** `${NAME}`, `${NAME:-default}` with its default bounded, or `$NAME`. */
const VARIABLE = new RegExp(
  `\\$\\{([A-Za-z_]\\w*)(?::?[-=+?]([^}]{0,${MAX_DEFAULT_VALUE}}))?\\}|\\$([A-Za-z_]\\w*)`,
  'g'
);

/**
 * Put in `~` at a word's start and any `$NAME`, `${NAME}` or `${NAME:-default}` it knows. An
 * unknown name stays as text, which names no real path: the known limit, stated above.
 *
 * @param word - A word.
 * @param home - The home folder.
 * @param vars - The variables known here.
 */
export function expandVariables(
  word: string,
  home: string,
  vars: Readonly<Record<string, string | undefined>>
): string {
  const named = word.replace(
    VARIABLE,
    (whole, braced?: string, fallback?: string, bare?: string) =>
      vars[braced ?? bare ?? ''] ?? fallback ?? whole
  );
  return named === '~' || named.startsWith('~/') ? `${home}${named.slice(1)}` : named;
}

/**
 * The pieces of a word that could each be a path: the whole word, and what is left when it is cut
 * at anything a path rarely holds. So `--file=/x` and a script's `open('/x')` both give `/x`.
 *
 * @param word - A word, already opened.
 */
export function pathPieces(word: string): string[] {
  const pieces = word
    .split(/[\s'"`(),;:<>|&=]+|[{}]/)
    .map((piece) => piece.replace(/^-[A-Za-z]+(?=[/~.])/, ''))
    .filter((piece) => piece.length > 0 && !piece.startsWith('-'));
  const whole = !word.startsWith('-') && !/[\s'"`(),;:<>|&={}]/.test(word);
  return (whole ? [word, ...pieces] : pieces).filter((piece) => piece.length <= MAX_PATH_PIECE);
}
