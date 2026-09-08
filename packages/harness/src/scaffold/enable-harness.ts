/**
 * The one path that writes a manifest the person already owns: adding a harness
 * id to `.agents/harness.manifest.json`.
 *
 * Everything else about the manifest is write-if-absent (ADR-302, and see
 * {@link scaffoldManifest}): the file is hand-authored, so the engine reads it
 * and never rewrites it. That rule is what made a harness added later
 * unreachable — detection ran once, at scaffold time, and nothing would enable
 * Cursor for a repo that grew a `.cursor/` a month afterwards (contract TR-11).
 *
 * So this is one deliberate, explicit exception, reached only by
 * `dorkos harness sync --fix --enable <harness>`. It writes the smallest thing
 * that can be written: **a text insertion of one array element**. The file is
 * never parsed-and-reprinted, because a person's key order, indentation and
 * spacing are theirs and a round-trip through `JSON.stringify` silently
 * reformats every line of a file they may have spent time on. A byte-for-byte
 * diff of a run is exactly `"cursor"` and the separator in front of it.
 *
 * The insertion is checked before it is written: the result has to parse, and it
 * has to parse to the same manifest plus this one harness. Text surgery that
 * cannot prove it did the right thing writes nothing.
 *
 * @module scaffold/enable-harness
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessId } from '../manifest/schema.js';
import { HARNESS_MANIFEST_PATH } from './manifest.js';

/** What {@link enableHarnessInManifest} did, or why it could not. */
export type EnableHarnessResult =
  | {
      /** The harness was added to the manifest. */
      outcome: 'enabled';
      /** The harness that was added. */
      harness: HarnessId;
      /** Repo-relative path of the manifest that changed. */
      path: string;
      /** The exact text inserted — the whole of the diff. */
      inserted: string;
    }
  | {
      /** The manifest already enabled this harness; nothing was written. */
      outcome: 'already-enabled';
      /** The harness that was already there. */
      harness: HarnessId;
      /** Repo-relative path of the manifest that was read. */
      path: string;
    }
  | {
      /** The manifest could not be edited safely; nothing was written. */
      outcome: 'unwritable';
      /** The harness that was asked for. */
      harness: HarnessId;
      /** Repo-relative path of the manifest that was read. */
      path: string;
      /** What is wrong with the file, in a sentence a person can act on. */
      reason: string;
    };

/**
 * Add one harness id to a repo's `.agents/harness.manifest.json`, preserving
 * every other byte of the file.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param harness - the harness id to enable.
 * @returns what happened: enabled (with the exact inserted text), already
 *   enabled, or unwritable (with the reason).
 * @throws When the manifest cannot be read at all (it is missing, or the process
 *   cannot open it) — the caller scaffolds one before asking.
 */
export function enableHarnessInManifest(repoRoot: string, harness: HarnessId): EnableHarnessResult {
  const path = HARNESS_MANIFEST_PATH;
  const abs = join(repoRoot, path);
  const before = readFileSync(abs, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch (err) {
    return {
      outcome: 'unwritable',
      harness,
      path,
      reason: `it is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const existing = (parsed as { harnesses?: unknown }).harnesses;
  if (!Array.isArray(existing)) {
    return { outcome: 'unwritable', harness, path, reason: 'it has no "harnesses" list' };
  }
  if (existing.includes(harness)) return { outcome: 'already-enabled', harness, path };

  const span = findHarnessesArray(before);
  if (!span) {
    return {
      outcome: 'unwritable',
      harness,
      path,
      reason: 'the "harnesses" list could not be located in the file as written',
    };
  }

  const { text: after, inserted } = insertElement(before, span, harness);
  if (!isExactlyOneHarnessAdded(after, parsed, existing, harness)) {
    return {
      outcome: 'unwritable',
      harness,
      path,
      reason: 'adding the harness would have changed something else in the file',
    };
  }

  writeFileSync(abs, after);
  return { outcome: 'enabled', harness, path, inserted };
}

/** Where the top-level `harnesses` array starts and ends, as indexes of `[` and `]`. */
interface ArraySpan {
  /** Index of the opening `[`. */
  open: number;
  /** Index of the closing `]`. */
  close: number;
}

/**
 * Locate the ROOT object's `harnesses` array in the raw text.
 *
 * Depth-aware rather than a regex: a `"harnesses"` key nested inside some future
 * per-entry object is not the one being edited, and a plain search would find
 * whichever came first in the file.
 */
function findHarnessesArray(text: string): ArraySpan | undefined {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = endOfString(text, i);
      // A key of the ROOT object: depth 1, and followed by `:` then `[`.
      if (depth === 1 && text.slice(i + 1, end) === 'harnesses') {
        const colon = skipWhitespace(text, end + 1);
        if (text[colon] === ':') {
          const open = skipWhitespace(text, colon + 1);
          if (text[open] === '[') {
            const close = endOfArray(text, open);
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

/** Index of the `]` closing the array whose `[` is at `open`, or undefined. */
function endOfArray(text: string, open: number): number | undefined {
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
 * Insert one element into an array, in the file's own layout, as a pure
 * insertion — nothing already in the file moves or changes.
 *
 * A multi-line array gets the element on its own line, indented like the line
 * the last element ends on (or one step in from the `[` when the array is
 * empty). A single-line array gets `, "x"`. Either way the element goes AFTER
 * the last one, so no trailing comma is ever introduced and none is needed.
 */
function insertElement(
  text: string,
  span: ArraySpan,
  value: string
): { text: string; inserted: string } {
  const inner = text.slice(span.open + 1, span.close);
  const multiline = inner.includes('\n');
  const element = JSON.stringify(value);

  // Empty array: the element goes straight after the `[`, so the closing `]`
  // and whatever whitespace sits in front of it are untouched.
  if (inner.trim() === '') {
    const inserted = multiline
      ? `\n${indentOfLineAt(text, span.open)}${indentUnit(text)}${element}`
      : element;
    return { text: splice(text, span.open + 1, inserted), inserted };
  }

  const lastElementEnd = span.open + 1 + trimmedEnd(inner);
  const inserted = multiline
    ? `,\n${indentOfLineAt(text, lastElementEnd)}${element}`
    : `, ${element}`;
  return { text: splice(text, lastElementEnd, inserted), inserted };
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
 * Whether the edited text is the SAME document with exactly one harness added at
 * the end of `harnesses` — every other key, and their order, untouched.
 *
 * The guard on the text surgery: it reads the result back and compares the whole
 * document to what was asked for, so a layout this function got wrong writes
 * nothing at all instead of a subtly different manifest. Key order survives both
 * sides of the comparison because the spread keeps an existing key where it
 * already was.
 */
function isExactlyOneHarnessAdded(
  after: string,
  document: unknown,
  harnesses: unknown[],
  harness: string
): boolean {
  try {
    const expected = {
      ...(document as Record<string, unknown>),
      harnesses: [...harnesses, harness],
    };
    return JSON.stringify(JSON.parse(after)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
