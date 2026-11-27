/**
 * A script's text with its comments left out (DOR-5240, DOR-5261), so a web address in a comment is
 * not read as a fetch. Strings are read as strings: a ` #` inside a Python string, or a `/*` inside
 * a JavaScript string or regex, starts no comment. One pass, so a long script costs its length.
 *
 * @module services/runtimes/shared/tools/script-comments
 */

/** A language's comment style: `#` (Python, Ruby, Perl) or `//` and `/* … *\/` (JavaScript, PHP). */
export type CommentStyle = 'hash' | 'slash';

/** Where a string that opens at `open` ends, just past its close; a one-line string ends by its line. */
function stringEnd(text: string, open: number, style: CommentStyle): number {
  const quote = text[open]!;
  const triple = style === 'hash' && text.startsWith(quote.repeat(3), open);
  const close = triple ? quote.repeat(3) : quote;
  // A JavaScript template and a Python triple-quoted string run across lines.
  const multiline = triple || quote === '`';
  for (let at = open + close.length; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '\\') at += 1;
    else if (char === '\n' && !multiline) return at;
    else if (text.startsWith(close, at)) return at + close.length;
  }
  return text.length;
}

/** The characters after which a `/` opens a regex rather than divides. */
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%~^<>'.split(''), '']);

/** Where a JavaScript regex that opens at `open` ends, just past its close; `-1` when none does. */
function regexEnd(text: string, open: number): number {
  let inClass = false;
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '\n') return -1;
    if (char === '\\') at += 1;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return at + 1;
  }
  return -1;
}

/**
 * The script's text with its comments left out.
 *
 * @param text - The script.
 * @param style - Its language's comment style.
 */
export function withoutComments(text: string, style: CommentStyle): string {
  let out = '';
  let copied = 0;
  let at = 0;
  let previous = '';
  // Past a `/` that opened no regex on a line, no regex is tried again before that line ends.
  let noRegexUntil = -1;
  const skipTo = (end: number): void => {
    copied = end;
    at = end;
  };
  while (at < text.length) {
    const char = text[at]!;
    const quotes = style === 'slash' ? '"\'`' : '"\'';
    if (quotes.includes(char)) {
      at = stringEnd(text, at, style);
      previous = 'a';
      continue;
    }
    if (style === 'hash' && char === '#' && (at === 0 || /\s/.test(text[at - 1]!))) {
      out += text.slice(copied, at);
      const end = text.indexOf('\n', at);
      if (end === -1) return out;
      skipTo(end);
      continue;
    }
    if (style === 'slash' && char === '/') {
      const next = text[at + 1];
      // `https://` is not a comment.
      if (next === '/' && text[at - 1] !== ':') {
        out += text.slice(copied, at);
        const end = text.indexOf('\n', at);
        if (end === -1) return out;
        skipTo(end);
        continue;
      }
      if (next === '*') {
        out += text.slice(copied, at);
        const end = text.indexOf('*/', at + 2);
        if (end === -1) return out;
        skipTo(end + 2);
        continue;
      }
      if (BEFORE_REGEX.has(previous) && at > noRegexUntil) {
        const end = regexEnd(text, at);
        if (end !== -1) {
          at = end;
          previous = 'a';
          continue;
        }
        const line = text.indexOf('\n', at);
        noRegexUntil = line === -1 ? text.length : line;
      }
    }
    if (!/\s/.test(char)) previous = char;
    at += 1;
  }
  return out + text.slice(copied);
}
