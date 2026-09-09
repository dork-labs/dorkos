/**
 * Recording a skill as Claude Code's, on purpose: one element appended to
 * `manifest.claudeOnlySkills`.
 *
 * The write behind `dorkos harness adopt <name> --claude-only`, and the sibling
 * of {@link enableHarnessInManifest} in every respect that matters — it is the
 * second of the two paths that edit a manifest a person hand-authored, it
 * inserts exactly one array element as TEXT, and it reads the result back and
 * refuses to write anything at all when the edit did not do exactly what was
 * asked. The surgery itself lives in `manifest-edit.ts`, which both share.
 *
 * The entry carries the candidate's own `source` as its `path` rather than
 * assuming the `.claude/skills/<name>` convention: SK-04's five states are all
 * resolved from the entry's own `path`, and assuming the convention is the
 * defect DOR-1847 fixed.
 *
 * @module scaffold/declare-claude-only
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../apply/atomic-write.js';
import { parseHarnessManifest } from '../manifest/schema.js';
import {
  findRootObject,
  findValueSpan,
  insertInto,
  manifestSchemaReason,
} from './manifest-edit.js';
import { HARNESS_MANIFEST_PATH } from './manifest.js';

/** The one entry a `--claude-only` run writes. */
export interface ClaudeOnlyDeclaration {
  /** The skill's name. */
  name: string;
  /** Where the skill lives, repo-relative — the candidate's own source. */
  path: string;
  /** Why it is kept where it is, in a sentence a person reads a year later. */
  reason: string;
}

/** What {@link declareClaudeOnlySkill} did, or why it could not. */
export type DeclareClaudeOnlyResult =
  | {
      /** The entry was appended. */
      outcome: 'declared';
      /** Repo-relative path of the manifest that changed. */
      path: string;
      /** The exact text inserted — the whole of the diff. */
      inserted: string;
    }
  | {
      /** The manifest already declares this skill; nothing was written. */
      outcome: 'already-declared';
      /** Repo-relative path of the manifest that was read. */
      path: string;
    }
  | {
      /** The manifest could not be edited safely; nothing was written. */
      outcome: 'unwritable';
      /** Repo-relative path of the manifest that was read. */
      path: string;
      /** What is wrong with the file, in a sentence a person can act on. */
      reason: string;
    };

/**
 * Append one entry to a repo's `manifest.claudeOnlySkills`, preserving every
 * other byte of the file.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param entry - the name, path and reason to record.
 * @returns what happened: declared (with the exact inserted text), already
 *   declared, or unwritable (with the reason).
 * @throws When the manifest cannot be read at all (it is missing, or the process
 *   cannot open it) — every caller has already established that it is there.
 */
export function declareClaudeOnlySkill(
  repoRoot: string,
  entry: ClaudeOnlyDeclaration
): DeclareClaudeOnlyResult {
  const path = HARNESS_MANIFEST_PATH;
  const abs = join(repoRoot, path);
  const before = readFileSync(abs, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch (err) {
    return {
      outcome: 'unwritable',
      path,
      reason: `it is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  // The same strict schema the engine loads with, before a byte is written: a
  // manifest carrying a key the schema rejects would otherwise gain an entry and
  // then still fail to load, leaving a file the person did not write and a sync
  // that still exits 1.
  let manifest;
  try {
    manifest = parseHarnessManifest(parsed);
  } catch (err) {
    return { outcome: 'unwritable', path, reason: manifestSchemaReason(err) };
  }

  if (manifest.claudeOnlySkills.some((declared) => declared.name === entry.name)) {
    return { outcome: 'already-declared', path };
  }

  // The RAW array, never the parsed one: an entry a person wrote with its keys
  // in another order re-serializes differently through the schema, and the
  // before-and-after check below would then refuse a perfectly good edit.
  const raw = (parsed as { claudeOnlySkills?: unknown }).claudeOnlySkills;
  const rawEntries = Array.isArray(raw) ? raw : [];
  const array = findValueSpan(before, 'claudeOnlySkills', '[');
  const edit = array
    ? insertInto(before, array, JSON.stringify(entry))
    : editAddingTheKey(before, rawEntries, entry);
  if (!edit) {
    return {
      outcome: 'unwritable',
      path,
      reason: 'its "claudeOnlySkills" list could not be located in the file as written',
    };
  }

  const { text: after, inserted } = edit;
  if (!isExactlyOneSkillDeclared(after, parsed, rawEntries, entry)) {
    return {
      outcome: 'unwritable',
      path,
      reason: 'recording the skill would have changed something else in the file',
    };
  }

  // Atomic for the same reason `enableHarnessInManifest` is: a second process
  // projecting this repo reads the manifest by name, and `loadManifest` on a
  // half-written one throws and fails its whole projection.
  writeFileAtomic(abs, after);
  return { outcome: 'declared', path, inserted };
}

/**
 * The edit for a manifest with no `claudeOnlySkills` key at all — the common
 * case, since the scaffolded manifest has none.
 *
 * It writes the whole key carrying the set the schema was defaulting to plus the
 * new entry, which for an absent key is the entry alone.
 *
 * @param text - the manifest as written.
 * @param existing - the entries already in the file, which is `[]` here.
 * @param entry - the entry being added.
 * @returns the edit, or nothing when the file has no root object to add to.
 */
function editAddingTheKey(
  text: string,
  existing: readonly unknown[],
  entry: ClaudeOnlyDeclaration
): { text: string; inserted: string } | undefined {
  const root = findRootObject(text);
  if (!root) return undefined;
  const list = [...existing, entry].map((item) => JSON.stringify(item)).join(', ');
  return insertInto(text, root, `"claudeOnlySkills": [${list}]`);
}

/**
 * Whether the edited text is the SAME document with exactly one entry appended
 * to `claudeOnlySkills` — every other key, and their order, untouched.
 *
 * The guard on the text surgery: it reads the result back and compares the whole
 * document to what was asked for, so a layout this module got wrong writes
 * nothing at all instead of a subtly different manifest.
 *
 * @param after - the edited text.
 * @param document - the manifest as parsed before the edit.
 * @param existing - the entries the file already carried, as written.
 * @param entry - the entry that was supposed to be added.
 * @returns whether the edit did exactly that and nothing else.
 */
function isExactlyOneSkillDeclared(
  after: string,
  document: unknown,
  existing: readonly unknown[],
  entry: ClaudeOnlyDeclaration
): boolean {
  try {
    const expected = {
      ...(document as Record<string, unknown>),
      claudeOnlySkills: [...existing, entry],
    };
    return JSON.stringify(JSON.parse(after)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
