/**
 * Editing a manifest somebody else wrote, as a TEXT INSERTION of one element.
 *
 * Two commands write into `.agents/harness.manifest.json` — `sync --fix --enable
 * <harness>` and `harness adopt --claude-only` — and both keep the same
 * contract: the file is never parsed-and-reprinted, because a person's key
 * order, indentation and spacing are theirs and a round-trip through
 * `JSON.stringify` silently reformats every line of a file they may have spent
 * time on. A byte-for-byte diff of either run is exactly the element inserted
 * and the separator in front of it.
 *
 * This module is the surgery both of them do; each caller keeps its own
 * before-and-after check, because what "exactly one thing added" means is the
 * caller's question rather than this one's.
 *
 * @module scaffold/manifest-edit
 */
import { ZodError } from 'zod';

/** Where a JSON container starts and ends, as indexes of its brackets. */
export interface Span {
  /** Index of the opening `[` or `{`. */
  open: number;
  /** Index of the matching closing bracket. */
  close: number;
}

/**
 * Locate the value of a ROOT-object key in the raw text, when it opens with
 * `opener`.
 *
 * Depth-aware rather than a regex: a `"harnesses"` key nested inside some other
 * entry is not the one being edited, and a plain search would find whichever
 * came first in the file.
 */
export function findValueSpan(text: string, key: string, opener: '[' | '{'): Span | undefined {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = endOfString(text, i);
      // A key of the ROOT object: depth 1, and followed by `:` then the opener.
      if (depth === 1 && text.slice(i + 1, end) === key) {
        const colon = skipWhitespace(text, end + 1);
        if (text[colon] === ':') {
          const open = skipWhitespace(text, colon + 1);
          if (text[open] === opener) {
            const close = endOfContainer(text, open);
            if (close !== undefined) return { open, close };
          }
        }
      }
      i = end + 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    i += 1;
  }
  return undefined;
}

/** The document's own outermost `{ … }`, the container a missing key is added to. */
export function findRootObject(text: string): Span | undefined {
  const open = text.indexOf('{');
  if (open === -1) return undefined;
  const close = endOfContainer(text, open);
  return close === undefined ? undefined : { open, close };
}

/** Index of the closing quote of the JSON string starting at `start`. */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return text.length;
}

/** Index of the bracket closing the container opened at `open`, or undefined. */
function endOfContainer(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i = endOfString(text, i);
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/** The first index at or after `from` that is not JSON whitespace. */
function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] as string)) i += 1;
  return i;
}

/**
 * Insert one entry into a JSON container, in the file's own layout, as a pure
 * insertion — nothing already in the file moves or changes.
 *
 * One routine for both containers, because the placement question is the same
 * one: an array gains `"cursor"`, the root object gains
 * `"harnesses": ["claude-code", "cursor"]`, and each goes after the last thing
 * already inside. A multi-line container puts it on its own line, indented like
 * the line the last entry ends on (or one step in from the bracket when the
 * container is empty); a single-line one gets `, x`. Either way the entry goes
 * AFTER the last, so no trailing comma is ever introduced and none is needed.
 *
 * An entry that is itself several lines — a whole object, which is what a
 * `claudeOnlySkills` line is — has every line after its first indented to the
 * same place, so it reads as part of the file rather than as one very long line
 * somebody's tool must have written.
 *
 * @param text - the file as written.
 * @param span - the container to insert into.
 * @param entry - the entry, already serialized.
 * @returns the edited text and the exact text inserted.
 */
export function insertInto(
  text: string,
  span: Span,
  entry: string
): { text: string; inserted: string } {
  const inner = text.slice(span.open + 1, span.close);
  const multiline = inner.includes('\n');

  // Empty container: the entry goes straight after the bracket, so the closing
  // one and whatever whitespace sits in front of it are untouched.
  if (inner.trim() === '') {
    const indent = `${indentOfLineAt(text, span.open)}${indentUnit(text)}`;
    const inserted = multiline ? `\n${indent}${reindent(entry, indent)}` : entry;
    return { text: splice(text, span.open + 1, inserted), inserted };
  }

  const lastEntryEnd = span.open + 1 + trimmedEnd(inner);
  const indent = indentOfLineAt(text, lastEntryEnd);
  const inserted = multiline ? `,\n${indent}${reindent(entry, indent)}` : `, ${entry}`;
  return { text: splice(text, lastEntryEnd, inserted), inserted };
}

/**
 * A serialized entry with every line after the first pushed out to `indent`.
 *
 * A single-line entry comes back untouched, which is every entry the harness
 * list has ever had.
 *
 * @param entry - the serialized entry.
 * @param indent - the whitespace its first line sits behind.
 * @returns the entry, indented to match.
 */
function reindent(entry: string, indent: string): string {
  return entry.split('\n').join(`\n${indent}`);
}

/** `text` with `insertion` placed at `at`, and nothing else changed. */
function splice(text: string, at: number, insertion: string): string {
  return text.slice(0, at) + insertion + text.slice(at);
}

/** The length of `s` with trailing whitespace removed. */
function trimmedEnd(s: string): number {
  return s.replace(/\s+$/, '').length;
}

/**
 * The leading whitespace of the line the index `at` falls on.
 *
 * The search starts at `at - 1` deliberately: `at` is one PAST the last element,
 * which is the newline itself when that element ends its line, and
 * `lastIndexOf` counts a hit at its own start index — so searching from `at`
 * finds that newline and reads the indent of the NEXT line (which is empty).
 */
function indentOfLineAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, at))?.[0] ?? '';
}

/**
 * The file's own indentation step, read off its first indented line — so a
 * four-space manifest gets a four-space element and a tab-indented one gets a
 * tab. Two spaces when the file has no indented line to learn from.
 */
function indentUnit(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
}

/**
 * The first thing wrong with a manifest, as one sentence naming the key.
 *
 * A `ZodError`'s own `message` is a pretty-printed JSON array, so the first line
 * of it is `[` — which is what a person would have been shown. This says
 * `sharedSkills: Unrecognized key` instead.
 */
export function manifestSchemaReason(err: unknown): string {
  const issue = err instanceof ZodError ? err.issues[0] : undefined;
  if (!issue) return `it is not a valid harness manifest (${String(err)})`;
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `it is not a valid harness manifest (${at}${issue.message})`;
}
