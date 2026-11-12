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
/** The most variables may add to one word or one assigned value before it counts as too much. */
const MAX_VARIABLE_GROWTH = 64 * 1_024;
/** The longest path any platform here opens (Linux); a longer piece names nothing that exists. */
export const MAX_PATH_PIECE = 4_096;

/** Decode one ANSI-C escape without running a shell or evaluating script text. */
function ansiEscape(text: string, at: number): { value: string; length: number } {
  const rest = text.slice(at + 1, at + 10);
  const numeric = /^(?:[0-7]{1,3}|x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8})/.exec(
    rest
  )?.[0];
  if (numeric) {
    const octal = /^[0-7]/.test(numeric);
    const code = Number.parseInt(octal ? numeric : numeric.slice(1), octal ? 8 : 16);
    if (code <= 0x10ffff) return { value: String.fromCodePoint(code), length: numeric.length + 1 };
  }
  const char = text[at + 1] ?? '';
  const simple: Readonly<Record<string, string>> = {
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  };
  return { value: simple[char] ?? `\\${char}`, length: char ? 2 : 1 };
}

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
    } else if (char === '$' && command[i + 1] === "'") {
      // ANSI-C quoting can spell a protected name entirely with numeric escapes. Decode only
      // inside this quote form; an ordinary script or single-quoted string keeps its escapes.
      i += 2;
      while (i < command.length && command[i] !== "'") {
        if (command[i] === '\\') {
          const escape = ansiEscape(command, i);
          word += escape.value;
          i += escape.length;
        } else {
          word += command[i] ?? '';
          i += 1;
        }
      }
      inWord = true;
      i += 1;
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
          // Line by line from here, never the whole rest per delimiter: 42,000 heredocs that all
          // close took 7 s when each one split what was left.
          let line = at;
          let bodyEnd = command.length;
          let next = command.length;
          while (line <= command.length) {
            const newline = command.indexOf('\n', line);
            const end = newline === -1 ? command.length : newline;
            if (command.slice(line, end).trim() === delimiter) {
              bodyEnd = Math.max(at, line - 1);
              next = newline === -1 ? command.length : newline + 1;
              break;
            }
            if (newline === -1) break;
            line = newline + 1;
          }
          current.scripts.push(command.slice(at, bodyEnd));
          at = next;
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
      // `>>` appends, and `>|` and zsh's `>!` overwrite: the next word is the target either way.
      while (
        command[i + 1] === '>' ||
        command[i + 1] === '|' ||
        (nextIsRedirect && command[i + 1] === '!')
      ) {
        i += 1;
      }
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

/** A variable's name, read at a set place. */
const VARIABLE_NAME = /[A-Za-z_]\w*/y;

/**
 * Put in `~` at a word's start and any `$NAME`, `${NAME}` or `${NAME:-default}` it knows. An
 * unknown name stays as text, which names no real path: the known limit, stated above.
 *
 * A scan rather than a regex, so an unclosed run of `${A:- ` stays linear with no limit on a
 * default's length, and what variables add is counted before it is built: `a1=$a0$a0…` lines
 * multiply, and 344 bytes of them ran the server out of memory.
 *
 * @param word - A word.
 * @param home - The home folder.
 * @param vars - The variables known here.
 * @returns The word, or `null` when variables would add too much to it.
 */
export function expandVariables(
  word: string,
  home: string,
  vars: Readonly<Record<string, string | undefined>>
): string | null {
  let named = '';
  let at = 0;
  let added = 0;
  while (at < word.length) {
    const dollar = word.indexOf('$', at);
    if (dollar === -1) break;
    named += word.slice(at, dollar);
    at = dollar + 1;
    const braced = word[at] === '{';
    VARIABLE_NAME.lastIndex = braced ? at + 1 : at;
    const name = VARIABLE_NAME.exec(word)?.[0];
    let value: string | undefined;
    let end = at;
    if (name !== undefined) {
      const after = dollar + (braced ? 2 : 1) + name.length;
      if (!braced) {
        value = vars[name] ?? word.slice(dollar, after);
        end = after;
      } else if (word[after] === '}') {
        value = vars[name] ?? word.slice(dollar, after + 1);
        end = after + 1;
      } else if ('-=+?'.includes(word[word[after] === ':' ? after + 1 : after] ?? ' ')) {
        const close = word.indexOf('}', after);
        // No close here means none later either: the rest is text, in one step.
        if (close === -1) {
          named += '$';
          break;
        }
        const start = word[after] === ':' ? after + 2 : after + 1;
        value = vars[name] ?? word.slice(start, close);
        end = close + 1;
      }
    }
    if (value === undefined) {
      named += '$';
      continue;
    }
    added += value.length;
    if (added > MAX_VARIABLE_GROWTH) return null;
    named += value;
    at = end;
  }
  named += word.slice(at);
  return named === '~' || named.startsWith('~/') ? `${home}${named.slice(1)}` : named;
}

/** The longest name a path can have on the systems DorkOS runs on (macOS's `PATH_MAX`). */
const MAX_PATH_NAME = 1_024;

/** Whether a stretch of text could be one path, spaces and all: one line, and not too long. */
function couldBePath(text: string): boolean {
  return (
    text.length > 0 && text.length <= MAX_PATH_NAME && !text.startsWith('-') && !/\n/.test(text)
  );
}

/**
 * The pieces of a word that could each be a path: the whole word, each quoted string in it, and
 * what is left when it is cut at anything a path rarely holds. So `--file=/x` and a script's
 * `open('/x')` both give `/x`, and a path with a space in it (`~/Library/Application Support/…`,
 * as an interpreter's argument or inside `open('…')`) is also tried whole (DOR-3613).
 *
 * @param word - A word, already opened.
 */
export function pathPieces(word: string): string[] {
  const pieces = word
    .split(/[\s'"`(),;:<>|&=]+|[{}]/)
    .map((piece) => piece.replace(/^-[A-Za-z]+(?=[/~.])/, ''))
    .filter((piece) => piece.length > 0 && !piece.startsWith('-'));
  const quoted = [...word.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter(couldBePath);
  const whole = couldBePath(word) ? [word] : [];
  return [...new Set([...whole, ...quoted, ...pieces])];
}
