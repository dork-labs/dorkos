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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../apply/atomic-write.js';
import { ZodError } from 'zod';
import { parseHarnessManifest, type HarnessId } from '../manifest/schema.js';
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

  // Validated with the SAME strict schema the engine loads with, before a byte is
  // written. `Array.isArray` alone was not enough: a manifest carrying a stale
  // key the schema rejects (`sharedSkills`) passed that check, got the harness
  // inserted, and then failed to load — leaving a file the person did not write
  // and a sync that still exits 1. Refusing costs them one hand-edit; the other
  // way costs them a file they now have to un-edit first.
  let manifest;
  try {
    manifest = parseHarnessManifest(parsed);
  } catch (err) {
    return { outcome: 'unwritable', harness, path, reason: schemaReason(err) };
  }

  // The VALIDATED set, so an absent `harnesses` key reads as the schema's own
  // default rather than as nothing — the difference between adding Cursor and
  // silently turning Claude Code off.
  const existing = manifest.harnesses;
  if (existing.includes(harness)) return { outcome: 'already-enabled', harness, path };

  const edit = plannedEdit(before, existing, harness);
  if (!edit) {
    return {
      outcome: 'unwritable',
      harness,
      path,
      reason: 'its "harnesses" list could not be located in the file as written',
    };
  }

  const { text: after, inserted } = edit;
  if (!isExactlyOneHarnessAdded(after, parsed, existing, harness)) {
    return {
      outcome: 'unwritable',
      harness,
      path,
      reason: 'adding the harness would have changed something else in the file',
    };
  }

  // Atomic, for the same reason `scaffoldManifest` is: a second process
  // projecting this repo reads the manifest by name, and `loadManifest` on a
  // half-written one throws and fails its whole projection.
  writeFileAtomic(abs, after);
  return { outcome: 'enabled', harness, path, inserted };
}

/**
 * The first thing wrong with a manifest, as one sentence naming the key.
 *
 * A `ZodError`'s own `message` is a pretty-printed JSON array, so the first line
 * of it is `[` — which is what a person would have been shown. This says
 * `sharedSkills: Unrecognized key` instead.
 */
function schemaReason(err: unknown): string {
  const issue = err instanceof ZodError ? err.issues[0] : undefined;
  if (!issue) return `it is not a valid harness manifest (${String(err)})`;
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `it is not a valid harness manifest (${at}${issue.message})`;
}

/**
 * The text edit that adds one harness: an element inserted into the `harnesses`
 * array, or — when the file has no such key — the whole key, carrying the set
 * the schema was defaulting to plus the new one.
 *
 * That second case is why this is not simply "insert an element". A manifest of
 * `{"version": 1}` is VALID, and the notice that sent the person here prints for
 * it, so `--enable` refusing with "add it yourself" would be the tool pointing at
 * a command it had just declined to run. And writing `["cursor"]` there would be
 * worse than refusing: the schema had been defaulting the set to `["claude-code"]`,
 * so the edit that turned Cursor on would have turned Claude Code off.
 */
function plannedEdit(
  text: string,
  existing: readonly string[],
  harness: HarnessId
): { text: string; inserted: string } | undefined {
  const array = findValueSpan(text, 'harnesses', '[');
  if (array) return insertInto(text, array, JSON.stringify(harness));

  const root = findRootObject(text);
  if (!root) return undefined;
  const list = [...existing, harness].map((id) => JSON.stringify(id)).join(', ');
  return insertInto(text, root, `"harnesses": [${list}]`);
}

/** Where a JSON container starts and ends, as indexes of its brackets. */
interface Span {
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
function findValueSpan(text: string, key: string, opener: '[' | '{'): Span | undefined {
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
function findRootObject(text: string): Span | undefined {
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
 */
function insertInto(text: string, span: Span, entry: string): { text: string; inserted: string } {
  const inner = text.slice(span.open + 1, span.close);
  const multiline = inner.includes('\n');

  // Empty container: the entry goes straight after the bracket, so the closing
  // one and whatever whitespace sits in front of it are untouched.
  if (inner.trim() === '') {
    const inserted = multiline
      ? `\n${indentOfLineAt(text, span.open)}${indentUnit(text)}${entry}`
      : entry;
    return { text: splice(text, span.open + 1, inserted), inserted };
  }

  const lastEntryEnd = span.open + 1 + trimmedEnd(inner);
  const inserted = multiline ? `,\n${indentOfLineAt(text, lastEntryEnd)}${entry}` : `, ${entry}`;
  return { text: splice(text, lastEntryEnd, inserted), inserted };
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
