/**
 * The shapes the adopt engine reads and produces.
 *
 * Adopt answers one question — "may this skill be moved out of an agent tool's
 * own folder into `.agents/skills`, where every agent reads it?" — and the
 * answer is either a move or one sentence saying why not. Everything here
 * exists so that question is a total function of FACTS about a tree rather than
 * of the tree itself: {@link readAdoptCandidates} does the reading and
 * {@link planAdopt} does the deciding, and nothing in the deciding half opens a
 * file.
 *
 * @module adopt/types
 */
import { HARNESS_NATIVE_SKILL_ROOTS, type SkillRoot } from '../inventory/types.js';

/** The canonical skills layer every adopted skill lands in. */
export const ADOPT_TARGET_ROOT = '.agents/skills';

/**
 * Every skills root that belongs to ONE agent tool rather than to all of them.
 *
 * The same set `apps/server/src/services/harness/status.ts` calls
 * `HARNESS_OWNED_SKILL_ROOTS`, spelled here because this package cannot import
 * the server. A skill in any of these is one a person could move;
 * {@link ADOPT_TARGET_ROOT} is where they would move it to.
 *
 * It lives in this module rather than beside the reader because the PLANNER
 * needs it too: it is the sentence R1 falls back to when a caller hands it no
 * roots at all.
 */
export const HARNESS_OWNED_SKILL_ROOTS: readonly SkillRoot[] = [
  '.claude/skills',
  ...HARNESS_NATIVE_SKILL_ROOTS,
];

/**
 * One skill that could be moved into the canonical layer, and everything the
 * plan needs to know about it.
 *
 * Every field is a fact the reader established once, so the planner can decide
 * eight rules over it without a second look at the disk.
 */
export interface AdoptCandidate {
  /** The skill's name — its directory name, which is also the target's basename. */
  name: string;
  /** Repo-relative source directory, e.g. `.claude/skills/deploy-checklist`. */
  source: string;
  /** Which inventory root it was found in. */
  root: SkillRoot;
  /** Whether the source directory is itself reached through a symlink. */
  isSymlink: boolean;
  /**
   * The frontmatter keys the author wrote, in file order, unstripped and
   * unvalidated.
   *
   * Read through `readRawFrontmatter`, never through the schema: the schema
   * strips a key it does not know, and the keys it does not know are exactly the
   * ones that make a skill unsafe to hand to five other tools.
   */
  frontmatterKeys: readonly string[];
  /** Whether the body carries a `${CLAUDE_…}` token (SK-07's rule, applied to the body). */
  bodyHasClaudeToken: boolean;
  /** True when the frontmatter would not parse at all — a different answer from "no keys". */
  unreadable: boolean;
  /** What is at `.agents/skills/<name>` right now. */
  targetState: 'absent' | 'occupied';
  /**
   * Why a directory on the way to the source or the target may not be written
   * through, in DOR-1882's own words — absent when every one of them is fine.
   *
   * Carried on the candidate rather than probed by the planner because the
   * planner never touches a disk, and stated in the occupant check's sentences
   * rather than in new ones so a sync and an adopt say the same words about the
   * same file (S17).
   */
  pathBlockedReason?: string;
}

/**
 * One skill in a harness-owned root the reader saw and did NOT offer, and which
 * of the two exclusions kept it out.
 *
 * Carried because the refusal a person reads depends on it: "there is no skill
 * called that" is a different sentence from "that one is already canonical" and
 * from "you said that one is deliberate", and a candidate list alone cannot tell
 * the three apart.
 */
export interface AdoptExclusion {
  /** The skill's name. */
  name: string;
  /** Repo-relative source directory of the copy in the harness-owned root. */
  source: string;
  /** Which root that copy was found in. */
  root: SkillRoot;
  /**
   * Which exclusion applied. `also-canonical` wins when both do: it is the
   * blocker whose fix is a deletion, and saying "it is declared" about a
   * duplicated skill would send a person to edit a manifest that is not the
   * problem.
   */
  why: 'also-canonical' | 'declared';
}

/** What DorkOS owns the directory a run is happening in as. */
export type DirectoryOwnership = 'plain' | 'agent-home' | 'room-worktree';

/**
 * One move the plan will make.
 *
 * There is no `link` field yet. The symlink Claude Code needs at the old path
 * arrives in slice 2, when `planAdoptedSkillLink` is extracted out of
 * `plan/projector.ts`: the link adopt leaves has to be the link the projector
 * plans, and that is only a fact the compiler holds once both callers share one
 * export. A field nothing could set would be a field nothing checks.
 */
export interface AdoptMove {
  /** The skill's name. */
  name: string;
  /** Repo-relative source directory. */
  from: string;
  /** Always `.agents/skills/<name>`. */
  to: string;
}

/** One name recorded in `manifest.claudeOnlySkills` instead of being moved (`--claude-only`). */
export interface AdoptDeclaration {
  /** The skill's name. */
  name: string;
  /** The `path` the manifest entry carries — the candidate's own `source`. */
  path: string;
  /**
   * The `reason` the manifest entry carries. **Required**, because
   * `ClaudeOnlySkillSchema` is `.strict()` with three required fields and an
   * entry without one fails the parse — so a declaration that omitted it would
   * break the very manifest it wrote into. Composed from what made the skill
   * Claude-shaped (S18).
   */
  reason: string;
}

/** Which rule refused, so a test and the census can name it. */
export type AdoptRefusalRule =
  | 'not-adoptable'
  | 'hostile-path'
  | 'room-seeded-name'
  | 'target-exists'
  | 'source-is-symlink'
  | 'unreadable-frontmatter'
  | 'not-on-allowlist'
  | 'claude-only-wrong-root';

/** One candidate that will not be moved, and the one sentence saying why. */
export interface AdoptRefusal {
  /** The skill's name, as the person asked for it. */
  name: string;
  /** Repo-relative source directory, or `''` when no such skill was found. */
  source: string;
  /** One plain sentence with the way out. Frozen. */
  reason: string;
  /** Which rule of the ladder answered. */
  rule: AdoptRefusalRule;
}

/**
 * Something true of the whole RUN rather than of one candidate.
 *
 * Separate from the refusals because both of these are facts about the
 * DIRECTORY: repeating one of them once per candidate would print the same
 * paragraph six times and bury the six things a person could act on.
 */
export interface AdoptBlocked {
  /** One plain sentence with the way out. Frozen. */
  reason: string;
  /** Which of the two run-level rules answered. */
  rule: 'canonical-layer-ignored' | 'auto-adopt-not-permitted';
}

/** What one adopt run would do. */
export interface AdoptPlan {
  /** Empty when {@link AdoptPlan.blocked} is set. */
  moves: AdoptMove[];
  /** Empty when {@link AdoptPlan.blocked} is set. */
  declarations: AdoptDeclaration[];
  /** One per candidate that will not be moved. */
  refusals: AdoptRefusal[];
  /** Present when one fact about the directory stops every candidate at once. */
  blocked?: AdoptBlocked;
}

/**
 * What one run was asked to do.
 *
 * A union rather than a mode plus optional fields, because `--claude-only` names
 * a skill and exists only in explicit mode: an auto run has no name to declare
 * and nobody to have decided it.
 */
export type AdoptRequest =
  | { mode: 'auto' }
  | {
      mode: 'explicit';
      /** The name the person asked for. */
      name: string;
      /** Record the skill as Claude Code's instead of moving it. */
      claudeOnly?: boolean;
    };

/**
 * Everything {@link planAdopt} needs, and nothing it would have to read a disk
 * for.
 *
 * Named for the skill it is about rather than `AdoptInput`, because
 * `services/relay/chat-bridge` already exports a type by that name about
 * adopting a bridged SESSION — a different verb on a different noun, and two of
 * them in one editor's autocomplete is how somebody imports the wrong one.
 */
export interface AdoptSkillInput {
  /** What the run was asked to do. */
  request: AdoptRequest;
  /** Every skill that could be moved. */
  candidates: readonly AdoptCandidate[];
  /** Every skill in a harness-owned root that was not offered, and why. */
  exclusions: readonly AdoptExclusion[];
  /**
   * The harness-owned roots this run looked in, for the sentence a person reads
   * when the name they typed is in none of them.
   */
  roots: readonly SkillRoot[];
  /** What DorkOS owns this directory as — decided by the caller, never here. */
  ownership: DirectoryOwnership;
  /**
   * The repo-relative `.gitignore` that keeps `.agents/` out of git, when one
   * does (AP-15). Absent means git would track the canonical layer.
   */
  canonicalLayerIgnoredBy?: string;
}
