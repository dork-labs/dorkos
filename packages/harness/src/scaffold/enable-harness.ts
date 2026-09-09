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
import { parseHarnessManifest, type HarnessId } from '../manifest/schema.js';
import {
  findRootObject,
  findValueSpan,
  insertInto,
  manifestSchemaReason,
} from './manifest-edit.js';
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
    return { outcome: 'unwritable', harness, path, reason: manifestSchemaReason(err) };
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
