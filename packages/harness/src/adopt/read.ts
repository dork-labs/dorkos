/**
 * The filesystem half of adopt: everything {@link planAdopt} would otherwise
 * have had to open a file for.
 *
 * It walks the inventory rather than the disk directly — the inventory already
 * knows every root a person authors a skill in and which of them belong to one
 * tool — and then reads each candidate's `SKILL.md` exactly ONCE, for the two
 * facts the allowlist asks about.
 *
 * **It re-derives the two exclusions `adoptableSkillSources` applies rather than
 * importing them**, because that function lives in `apps/server` and this
 * package cannot import the server: the edge runs the other way. A duplication
 * nobody can compare is a duplication nobody is checking, so the server holds a
 * property test (`services/harness/__tests__/adoptable-agreement.test.ts`) that
 * the two readers answer with the same set — the only place that can import both
 * sides.
 *
 * @module adopt/read
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import type { HarnessManifest } from '../manifest/schema.js';
import type { SkillInventoryEntry, SkillRoot, SourceInventory } from '../inventory/types.js';
import { canonicalLayerIgnoredBy } from '../apply/gitignore.js';
import { blockedWritePath, type WritePathCause } from '../apply/write-path-occupants.js';
import { CLAUDE_TOKEN_PREFIX } from './allowlist.js';
import {
  ADOPT_TARGET_ROOT,
  HARNESS_OWNED_SKILL_ROOTS,
  type AdoptCandidate,
  type AdoptExclusion,
  type AdoptSkillInput,
} from './types.js';

/** The canonical skills root: a skill here is already shared with every harness. */
const CANONICAL_SKILLS_ROOT: SkillRoot = '.agents/skills';

/** What {@link readAdoptCandidates} establishes, and {@link planAdopt} decides over. */
export type AdoptReadResult = Pick<
  AdoptSkillInput,
  'candidates' | 'exclusions' | 'roots' | 'enabledHarnesses' | 'canonicalLayerIgnoredBy'
>;

/**
 * Read everything one adopt run needs to know about a repository.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param inventory - the source-tree inventory, already walked.
 * @param manifest - the repository's harness manifest.
 * @returns the candidates, the skills that were excluded and why, the roots this
 *   run looked in, and the harnesses the manifest enables.
 */
export function readAdoptCandidates(
  repoRoot: string,
  inventory: SourceInventory,
  manifest: HarnessManifest
): AdoptReadResult {
  const canonicalNames = new Set(
    inventory.skills.filter((s) => s.root === CANONICAL_SKILLS_ROOT).map((s) => s.name)
  );
  const declaredNames = new Set(manifest.claudeOnlySkills.map((entry) => entry.name));
  const owned = inventory.skills.filter((s) =>
    (HARNESS_OWNED_SKILL_ROOTS as readonly string[]).includes(s.root)
  );

  const candidates: AdoptCandidate[] = [];
  const exclusions: AdoptExclusion[] = [];
  // Siblings share every ancestor above their own folder, so a repository with
  // forty skills asks about `.claude` and `.agents/skills` once each.
  const probed = new Map<string, WritePathCause | undefined>();

  for (const skill of owned) {
    // `also-canonical` is tested first when both apply: it is the blocker whose
    // fix is a deletion, and telling somebody their duplicate is "declared" would
    // send them to edit a manifest that is not the problem.
    if (canonicalNames.has(skill.name)) {
      exclusions.push({ ...place(skill), why: 'also-canonical' });
      continue;
    }
    if (declaredNames.has(skill.name)) {
      exclusions.push({ ...place(skill), why: 'declared' });
      continue;
    }
    candidates.push(readCandidate(repoRoot, skill, probed));
  }

  return {
    candidates,
    exclusions,
    roots: rootsLookedIn(owned),
    // Straight off the manifest, in its own order: the planner asks it one
    // question — is Claude Code enabled? — and that decides whether a move
    // leaves a link behind.
    enabledHarnesses: manifest.harnesses,
    ...ignoredBy(repoRoot),
  };
}

/** The three fields an exclusion and a candidate both carry. */
function place(skill: SkillInventoryEntry): Pick<AdoptExclusion, 'name' | 'source' | 'root'> {
  return { name: skill.name, source: skill.source, root: skill.root };
}

/**
 * The roots a person's "there is no skill called that" sentence should name.
 *
 * The roots that actually hold a skill, so the sentence describes this
 * repository rather than reciting a list of six folders most of which are not
 * there. A repository whose harness-owned roots hold nothing at all falls back
 * to the whole list, because a sentence naming no folder at all says nothing.
 *
 * @param owned - every inventoried skill in a harness-owned root.
 * @returns the roots to name, in inventory order.
 */
function rootsLookedIn(owned: readonly SkillInventoryEntry[]): readonly SkillRoot[] {
  const found = HARNESS_OWNED_SKILL_ROOTS.filter((root) =>
    owned.some((skill) => skill.root === root)
  );
  return found.length > 0 ? found : HARNESS_OWNED_SKILL_ROOTS;
}

/**
 * Read one candidate's `SKILL.md` and probe both of its write paths.
 *
 * The frontmatter is read RAW — `readRawFrontmatter`, never `parseSkillFile` —
 * because the schema strips the keys that decide this question. The body is the
 * text already in memory, so the file is opened once.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param skill - the inventory entry.
 * @param probed - the shared write-path memo.
 * @returns the candidate.
 */
function readCandidate(
  repoRoot: string,
  skill: SkillInventoryEntry,
  probed: Map<string, WritePathCause | undefined>
): AdoptCandidate {
  const target = `${ADOPT_TARGET_ROOT}/${skill.name}`;
  // Asked of the `SKILL.md` inside the target folder rather than of the folder,
  // so the folder ITSELF is one of the directories on the write path: a file at
  // `.agents/skills/<name>` is answered by the same check as a file at
  // `.agents/skills`, and R2 gets there before R4 calls it an occupied target.
  //
  // The SOURCE is deliberately not probed, and the reason is that it cannot
  // fail. Every hostile shape above a candidate's own folder stops it becoming
  // a candidate first: an unreadable `.claude/skills` is refused by the
  // inventory's own root probe, and a source folder that is a file, a dangling
  // link, a link to a file, or unreadable holds no `SKILL.md` the scanner can
  // read, so it never reaches this list. Probing it anyway was a branch no tree
  // could reach — see `adoptable-agreement.test.ts`, which pins what a person
  // gets instead, and DOR-1943's follow-up on the inventory dropping such a
  // folder with no record at all.
  const pathBlockedReason = blockedWritePath(repoRoot, `${target}/${SKILL_FILENAME}`, probed);

  let text: string | undefined;
  try {
    text = readFileSync(join(repoRoot, skill.source, SKILL_FILENAME), 'utf8');
  } catch {
    text = undefined;
  }
  const raw = text === undefined ? null : readRawFrontmatter(text);

  return {
    name: skill.name,
    source: skill.source,
    root: skill.root,
    isSymlink: skill.isSymlink,
    frontmatterKeys: raw === null ? [] : Object.keys(raw.data),
    bodyHasClaudeToken: raw !== null && raw.body.includes(CLAUDE_TOKEN_PREFIX),
    unreadable: raw === null,
    targetState: targetStateOf(repoRoot, target),
    ...(pathBlockedReason === undefined ? {} : { pathBlockedReason }),
  };
}

/**
 * Whether anything is at `.agents/skills/<name>`.
 *
 * `lstat` rather than `stat`, because a dangling link there is still something
 * occupying the target — and a link DorkOS cannot follow is already answered by
 * the write-path probe, which runs first.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param target - the repo-relative target directory.
 * @returns whether the target is free.
 */
function targetStateOf(repoRoot: string, target: string): AdoptCandidate['targetState'] {
  try {
    lstatSync(join(repoRoot, target));
    return 'occupied';
  } catch {
    return 'absent';
  }
}

/**
 * The `.gitignore` that keeps `.agents/` out of git, as an optional field so an
 * absent answer is an absent key (AP-15).
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns `{ canonicalLayerIgnoredBy }`, or nothing.
 */
function ignoredBy(repoRoot: string): { canonicalLayerIgnoredBy?: string } {
  const file = canonicalLayerIgnoredBy(repoRoot);
  return file === undefined ? {} : { canonicalLayerIgnoredBy: file };
}
