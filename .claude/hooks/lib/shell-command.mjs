/**
 * Shell command-line parsing shared by the PreToolUse(Bash) guard hooks.
 *
 * `git-guard.mjs` and `process-guard.mjs` both need the same three things
 * before they can decide anything: split a command line into the commands it
 * runs (respecting quotes), pull out `$(...)` / backtick bodies so a command
 * hiding inside a substitution is still inspected, and turn one segment into
 * unquoted argument tokens with the `sudo`/`env`/loop-keyword prefixes
 * stripped. Keeping one copy here means a hole found in one guard's parsing is
 * fixed for both — the fixture suites in `scripts/test-git-guard.sh` and
 * `scripts/test-process-guard.sh` both run against this module.
 *
 * Substitutions inside single quotes and quoted heredocs are skipped, because
 * a PR body or commit message naming a blocked command there is text. That
 * skip is deliberately NOT a model of bash: it only applies when the line is
 * plain enough to read with confidence. Comments, `$'...'`, quotes inside
 * backticks, a heredoc inside a substitution whose body has quotes or
 * parentheses, `case` inside `$(...)`, unterminated quotes, a heredoc that
 * never closes, and any line that hands text to `sh -c` / `eval` all fall back
 * to inspecting every substitution-shaped span, quoted or not.
 *
 * Coverage limits are the guards' own contract (see the header comment in
 * git-guard.mjs): this reads the command string the model submits and one
 * level of substitution, and does not see scripts on disk, aliases, `eval` of
 * a variable, `xargs`, or substitutions nested more than one level deep.
 */

import path from 'path';

const { basename } = path;

/** Shell operators that separate one command from the next. */
const TWO_CHAR_OPERATORS = ['&&', '||', '|&'];
const ONE_CHAR_OPERATORS = [';', '|', '&', '\n'];

/** Wrappers whose `-c` argument is itself a command line. */
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Words that can precede the real command without changing it. */
const COMMAND_PREFIXES = new Set([
  'sudo',
  'command',
  'env',
  'nohup',
  'nice',
  'time',
  'builtin',
  // Shell grouping and control keywords. Without these, the command inside a
  // loop body or a subshell reads as a command named `do` or `(git`, and the
  // whole segment is skipped. `for f in ...; do git checkout -- $f; done` is a
  // spelling agents reach for unprompted.
  'then',
  'do',
  'else',
  'elif',
  '!',
  '(',
  '{',
]);

/** Characters that end a shell word, so what follows starts a new one. */
const WORD_BOUNDARY = /[\s;&|()<>]/;

/**
 * Split a command line into the individual commands it runs, ignoring
 * operators that appear inside quotes.
 *
 * @param {string} command - Raw command line.
 * @returns {string[]} Non-empty, trimmed command segments.
 */
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += char + command[++i];
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && i + 1 < command.length) {
      current += char + command[++i];
      continue;
    }
    if (TWO_CHAR_OPERATORS.includes(command.slice(i, i + 2))) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ONE_CHAR_OPERATORS.includes(char)) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Read the delimiter word after a `<<` / `<<-` heredoc operator.
 *
 * Any quoting in the word (`'EOF'`, `"EOF"`, `\EOF`) turns expansion off for
 * the whole body, which is the only thing the caller needs to know about it.
 *
 * @param {string} command - Raw command line.
 * @param {number} start - Index just past the `<<`.
 * @returns {{ delimiter: string, quoted: boolean, stripTabs: boolean, end: number } | null}
 *   The parsed operator, or null when there is no usable delimiter word.
 */
function readHeredocOperator(command, start) {
  let i = start;
  const stripTabs = command[i] === '-';
  if (stripTabs) i++;
  while (command[i] === ' ' || command[i] === '\t') i++;

  let delimiter = '';
  let quoted = false;
  while (i < command.length) {
    const char = command[i];
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, i + 1);
      if (close === -1) return null;
      delimiter += command.slice(i + 1, close);
      quoted = true;
      i = close + 1;
      continue;
    }
    if (char === '\\' && i + 1 < command.length) {
      delimiter += command[i + 1];
      quoted = true;
      i += 2;
      continue;
    }
    if (/[\s;&|<>()]/.test(char)) break;
    delimiter += char;
    i++;
  }
  return delimiter ? { delimiter, quoted, stripTabs, end: i } : null;
}

/**
 * Find where a heredoc body ends: the first line that is exactly its delimiter.
 *
 * @param {string} command - Raw command line.
 * @param {number} start - Index of the first body line.
 * @param {{ delimiter: string, stripTabs: boolean }} heredoc - The operator read for it.
 * @returns {{ bodyEnd: number, next: number } | null} Where the body stops and
 *   where the delimiter line ends, or null when the delimiter never appears.
 */
function findHeredocEnd(command, start, heredoc) {
  let lineStart = start;
  while (lineStart <= command.length) {
    let lineEnd = command.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = command.length;
    let line = command.slice(lineStart, lineEnd);
    if (heredoc.stripTabs) line = line.replace(/^\t+/, '');
    if (line === heredoc.delimiter) return { bodyEnd: lineStart, next: lineEnd };
    if (lineEnd === command.length) return null;
    lineStart = lineEnd + 1;
  }
  return null;
}

/**
 * Decide whether a heredoc body inside a substitution is safe to read as ending
 * at its delimiter line.
 *
 * bash 3.2 (still `/bin/bash` on macOS) matches the parentheses of `$(...)`
 * without knowing about heredocs, so a `)` in the body can end the
 * substitution early and a quote or `#` can knock the rest of the line out of
 * step. Measured: backticks in such a body are left alone, apostrophes and
 * parentheses are not. Anything that could move 3.2's reading is refused.
 *
 * @param {string} body - The heredoc body text.
 * @returns {boolean} True when no shell reads this body differently.
 */
function isInertSubstitutionHeredocBody(body) {
  if (/['"()\\#]/.test(body)) return false;
  return (body.match(/`/g) ?? []).length % 2 === 0;
}

/**
 * Blank out the text bash never expands — single-quoted strings and the bodies
 * of quoted heredocs — keeping every index in place.
 *
 * Without this, a PR body in `--body '...'` or a commit message written
 * through `<<'EOF'` reads as running the command its markdown merely names,
 * and the guard refuses a PR body that describes the guard. Double quotes and
 * unquoted heredocs are left alone because bash DOES substitute inside them.
 * Contexts are tracked as a stack because the quoting rules change inside a
 * substitution: an apostrophe is literal in `"it's"` but opens a real quote
 * in `"$(echo 'x')"`.
 *
 * This is a reader for plain lines, not a bash parser, and every construct it
 * does not model returns null rather than a guess: a misread that stays in
 * step with itself is exactly how a live substitution gets blanked. So `$'...'`
 * (where `\'` does not close the quote), a `#` comment (an apostrophe in it is
 * not a quote), a quote inside backticks (the next backtick ends the
 * substitution regardless), a heredoc opened inside backticks, and `case`
 * inside `$(...)` (its `)` patterns) all mean "cannot tell".
 *
 * @param {string} command - Raw command line.
 * @returns {string | null} The masked line (same length), or null when the
 *   line holds something it does not model. Callers treat null as "cannot
 *   tell" and fall back to the strict, unmasked reading.
 */
function maskUnexpandedText(command) {
  const masked = command.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (masked[k] !== '\n') masked[k] = ' ';
  };
  const atWordStart = (index) => index === 0 || WORD_BOUNDARY.test(command[index - 1]);
  const stack = [{ kind: 'top', depth: 0 }];
  let pending = [];
  let i = 0;

  while (i < command.length) {
    const context = stack[stack.length - 1];
    const char = command[i];

    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '$' && command[i + 1] === '(') {
      stack.push({ kind: 'sub', depth: 0 });
      i += 2;
      continue;
    }

    if (context.kind === 'dq') {
      if (char === '"') stack.pop();
      else if (char === '`') stack.push({ kind: 'bt', depth: 0 });
      i++;
      continue;
    }

    // Unquoted text: the top level, or the inside of a substitution. Each
    // early null below is a construct this reader refuses to guess about.
    if (char === '$' && command[i + 1] === "'") return null;
    if (char === '#' && atWordStart(i)) return null;
    if (context.kind === 'bt' && (char === "'" || char === '"')) return null;
    if (context.kind === 'sub' && atWordStart(i) && /^case(?![\w-])/.test(command.slice(i))) {
      return null;
    }

    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return null;
      blank(i + 1, close);
      i = close + 1;
      continue;
    }
    if (char === '"') {
      stack.push({ kind: 'dq', depth: 0 });
      i++;
      continue;
    }
    if (char === '`') {
      if (context.kind === 'bt') stack.pop();
      else stack.push({ kind: 'bt', depth: 0 });
      i++;
      continue;
    }
    if (context.kind === 'sub' && char === '(') {
      context.depth++;
      i++;
      continue;
    }
    if (context.kind === 'sub' && char === ')') {
      if (context.depth === 0) stack.pop();
      else context.depth--;
      i++;
      continue;
    }
    // `<<<` is a here-string: one word, no body.
    if (command.startsWith('<<<', i)) {
      i += 3;
      continue;
    }
    if (command.startsWith('<<', i)) {
      if (context.kind === 'bt') return null;
      const heredoc = readHeredocOperator(command, i + 2);
      if (!heredoc) return null;
      pending.push({ ...heredoc, inSubstitution: context.kind === 'sub' });
      i = heredoc.end;
      continue;
    }
    // Heredoc bodies start on the line after their operators, in order. An
    // unquoted body is skipped without being masked: quotes inside it are
    // literal, so its substitutions stay visible to the caller.
    if (char === '\n' && pending.length > 0) {
      let cursor = i + 1;
      for (const heredoc of pending) {
        const end = findHeredocEnd(command, cursor, heredoc);
        if (!end) return null;
        const body = command.slice(cursor, end.bodyEnd);
        if (heredoc.inSubstitution && !isInertSubstitutionHeredocBody(body)) return null;
        if (heredoc.quoted) blank(cursor, end.bodyEnd);
        cursor = end.next;
      }
      pending = [];
      i = cursor;
      continue;
    }
    i++;
  }

  if (stack.length !== 1 || pending.length > 0) return null;
  return masked.join('');
}

/**
 * Pull out the bodies of one level of `$(...)` and backtick substitution so
 * `echo $(git stash pop)` is inspected rather than skipped as an `echo`.
 *
 * Substitutions inside single quotes or a quoted heredoc are skipped as text
 * (see `maskUnexpandedText`), with two ways back to the strict reading where
 * every substitution-shaped span counts: a line the masker will not vouch
 * for, and a line that hands quoted text to another parser (`bash -c '...'`,
 * `eval '...'`), where the quotes protect nothing. A guard that misses a real
 * command is worse than one that refuses a harmless line.
 *
 * @param {string} command - Raw command line.
 * @returns {string[]} Substitution bodies, which may be empty.
 */
function extractSubstitutions(command) {
  const runsQuotedText = splitSegments(command).some(
    (segment) => readWrappedCommand(segment) !== null
  );
  const masked = runsQuotedText ? null : maskUnexpandedText(command);

  // Strict: the two shapes are searched separately over the raw text. One
  // alternation would let a `$(...)` match swallow a backtick span inside it,
  // and the body's own pass would then re-mask that span as if it were a
  // plain top-level heredoc — losing the strict reading this line earned.
  if (masked === null) {
    return [
      ...[...command.matchAll(/\$\(([^()]*)\)/g)].map((match) => match[1]),
      ...[...command.matchAll(/`([^`]*)`/g)].map((match) => match[1]),
    ];
  }

  // Match against the masked copy, slice bodies from the original: the mask
  // keeps every index, and a body may itself contain quoted text that the
  // recursive inspection needs to see as written.
  const bodies = [];
  const pattern = /\$\(([^()]*)\)|`([^`]*)`/g;
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    const isDollar = match[1] !== undefined;
    const start = match.index + (isDollar ? 2 : 1);
    bodies.push(command.slice(start, start + (isDollar ? match[1] : match[2]).length));
  }
  return bodies;
}

/**
 * Split a single command segment into arguments, dropping quotes and
 * collapsing runs of whitespace (so `git  stash` reads as `git stash`).
 *
 * @param {string} segment - One command segment.
 * @returns {string[]} Unquoted argument tokens.
 */
function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let quote = null;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[++i];
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === '\\' && i + 1 < segment.length) {
      current += segment[++i];
      continue;
    }
    if (/\s/.test(char)) {
      if (current || quoted) tokens.push(current);
      current = '';
      quoted = false;
      continue;
    }
    current += char;
  }
  if (current || quoted) tokens.push(current);

  return tokens;
}

/**
 * Find where the real command starts, past `VAR=value` assignments and
 * wrapper words like `sudo`.
 *
 * @param {string[]} tokens - Argument tokens for one segment.
 * @returns {number} Index of the first token that is not a prefix.
 */
function skipCommandPrefixes(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || COMMAND_PREFIXES.has(basename(token))) {
      index++;
      continue;
    }
    break;
  }
  return index;
}

/**
 * Drop leading `VAR=value` assignments and wrapper words like `sudo`.
 *
 * @param {string[]} tokens - Argument tokens for one segment.
 * @returns {string[]} Tokens starting at the real command name.
 */
function stripCommandPrefixes(tokens) {
  // Strip the grouping punctuation that can sit flush against the command:
  // `(git stash pop)` tokenizes as `(git` ... `pop)`, and without this the
  // first token is not `git` and the segment is skipped entirely. The trailing
  // half matters just as much in the other direction — leaving `)` attached to
  // `list` in `(git stash list)` would turn a read-only command into a block.
  // Never use this for a `-c` payload: see `readWrappedCommand`.
  const rest = tokens.slice(skipCommandPrefixes(tokens));
  if (rest.length > 0) {
    rest[0] = rest[0].replace(/^[({]+/, '');
    const last = rest.length - 1;
    rest[last] = rest[last].replace(/[)};]+$/, '');
    if (rest[0] === '') rest.shift();
  }
  return rest;
}

/**
 * Return the command line a segment hands to another shell parser: the `-c`
 * argument of `sh` / `bash` / `zsh` / `dash` / `ksh`, or the arguments of
 * `eval` joined back together.
 *
 * Read from the raw tokens on purpose. `stripCommandPrefixes` trims a trailing
 * `)` off the last token, which cuts `bash -c 'echo $(pkill x)'` down to
 * `echo $(pkill x` so the substitution no longer matches at all. Leaving extra
 * punctuation on (`(bash -c '...')` keeps its closing `)`) only ever gives the
 * inspection more text, never less.
 *
 * @param {string} segment - One command segment.
 * @returns {string | null} The wrapped command line, or null when the segment
 *   does not run another command line.
 */
function readWrappedCommand(segment) {
  const tokens = tokenize(segment);
  const index = skipCommandPrefixes(tokens);
  if (index >= tokens.length) return null;

  const name = basename(tokens[index].replace(/^[({]+/, ''));
  const args = tokens.slice(index + 1);
  if (name === 'eval') return args.length > 0 ? args.join(' ') : null;
  if (!SHELL_WRAPPERS.has(name)) return null;
  const flagIndex = args.indexOf('-c');
  return flagIndex !== -1 && flagIndex + 1 < args.length ? args[flagIndex + 1] : null;
}

export {
  SHELL_WRAPPERS,
  COMMAND_PREFIXES,
  splitSegments,
  extractSubstitutions,
  tokenize,
  stripCommandPrefixes,
  readWrappedCommand,
};
