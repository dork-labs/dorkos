/**
 * The adopt planner — data in, a plan out, and no filesystem anywhere near it.
 *
 * **This module is PURE, and that is a deliberate departure rather than a
 * precedent.** `buildPlan` walks the disk itself (`scanSkills(repoRoot)` at
 * `plan/projector.ts:450`), which is workable for a projector whose output is
 * checked against a real tree anyway and is the wrong shape for a refusal table
 * of eight rules, each of which has to be provable in isolation. So adopt splits
 * in two: `adopt/read.ts` establishes the facts, and this decides. Every case
 * below is a fixture rather than a staged tree, and `adoptable-agreement.test.ts`
 * in the server is what keeps the reader honest about the facts it feeds in.
 *
 * The ladder is **first match wins, most fundamental first**: what makes the
 * whole run impossible, then what makes the filesystem operation impossible,
 * then what makes the RESULT wrong. Order is stated rather than emergent because
 * it decides which sentence a person reads when two rules apply.
 *
 * @module adopt/plan
 */
import { planAdoptedSkillLink } from '../plan/projector.js';
import { allowlistVerdict, type AllowlistVerdict } from './allowlist.js';
import {
  ADOPT_DECLARATION_REASONS,
  ADOPT_SENTENCES,
  joinNames,
  ROOM_SEEDED_SKILL_NAMES,
} from './refusals.js';
import {
  ADOPT_TARGET_ROOT,
  HARNESS_OWNED_SKILL_ROOTS,
  type AdoptCandidate,
  type AdoptDeclaration,
  type AdoptSkillInput,
  type AdoptPlan,
  type AdoptRefusal,
} from './types.js';

/** The one root `manifest.claudeOnlySkills` can say anything about. */
const CLAUDE_SKILLS_ROOT = '.claude/skills';

/**
 * Plan one adopt run.
 *
 * @param input - the candidates, the exclusions and the two facts about the
 *   directory, all established by {@link readAdoptCandidates}.
 * @returns the moves, the declarations and one sentence per refusal — or a
 *   single `blocked` and nothing else.
 */
export function planAdopt(input: AdoptSkillInput): AdoptPlan {
  const { request } = input;

  // `--claude-only` writes one line into the manifest and moves nothing, so
  // nothing about the filesystem or the file's content can stand in its way: it
  // runs R1 then R8 and stops. Neither run-level rule applies either — nothing
  // goes into `.agents/`, so a `.gitignore` there is not a fact about this
  // operation, and the flag exists only in explicit mode. That short-circuit is
  // what makes the flag a real way out of R7 rather than a second thing that can
  // be refused for the same reason.
  if (request.mode === 'explicit' && request.claudeOnly === true) {
    return planDeclaration(input, request.name);
  }

  // B1 before B2: somebody who set the flag in a repository DorkOS does not own
  // should be told THAT, not sent to edit a `.gitignore` for a run that was
  // never going to happen.
  if (request.mode === 'auto' && input.ownership === 'plain') {
    return { moves: [], declarations: [], refusals: [], blocked: blockedByAutoAdopt() };
  }
  if (input.canonicalLayerIgnoredBy !== undefined) {
    return {
      moves: [],
      declarations: [],
      refusals: [],
      blocked: {
        rule: 'canonical-layer-ignored',
        reason: ADOPT_SENTENCES.S3(input.canonicalLayerIgnoredBy),
      },
    };
  }

  if (request.mode === 'explicit') {
    const candidate = input.candidates.find((entry) => entry.name === request.name);
    if (candidate === undefined) {
      return { moves: [], declarations: [], refusals: [notAdoptable(input, request.name)] };
    }
    return decide(input, [candidate]);
  }
  return decide(input, input.candidates);
}

/** B1's answer, alone in a helper so the ladder above reads as a ladder. */
function blockedByAutoAdopt(): AdoptPlan['blocked'] {
  return { rule: 'auto-adopt-not-permitted', reason: ADOPT_SENTENCES.S8() };
}

/**
 * Run R2 → R7 over each candidate and collect what came out.
 *
 * @param input - the run's input, for the ownership R3 asks about.
 * @param candidates - the candidates this run is deciding.
 * @returns the plan's moves and refusals.
 */
function decide(input: AdoptSkillInput, candidates: readonly AdoptCandidate[]): AdoptPlan {
  const moves: AdoptPlan['moves'] = [];
  const refusals: AdoptRefusal[] = [];
  for (const candidate of candidates) {
    const refusal = refuse(input, candidate);
    if (refusal !== undefined) refusals.push(refusal);
    else
      moves.push({
        name: candidate.name,
        from: candidate.source,
        to: `${ADOPT_TARGET_ROOT}/${candidate.name}`,
        // The link is planned iff Claude Code is ENABLED — never off the source
        // root — and it is the projector's own action rather than one built here
        // (see {@link AdoptMove.link}).
        ...(input.enabledHarnesses.includes('claude-code')
          ? { link: planAdoptedSkillLink(candidate.name) }
          : {}),
      });
  }
  return { moves, declarations: [], refusals };
}

/**
 * The per-candidate ladder, first match wins.
 *
 * R2 sits before R3–R6 because a hostile path is the only case where the CHECK
 * ITSELF is what prevented a throw: DOR-1882 computes the blocked set before
 * anything writes, and adopt sits inside that discipline rather than beside it.
 * R7 is last of the move rules because it is the only one whose answer is about
 * the file's content rather than about the filesystem.
 *
 * @param input - the run's input, for the ownership R3 asks about.
 * @param candidate - the skill being decided.
 * @returns the refusal, or `undefined` when the skill may be moved.
 */
function refuse(input: AdoptSkillInput, candidate: AdoptCandidate): AdoptRefusal | undefined {
  const { name, source } = candidate;

  // R2 — a directory on the way to the source or the target is not one DorkOS
  // may write through, in DOR-1882's own words (S17).
  if (candidate.pathBlockedReason !== undefined) {
    return { name, source, rule: 'hostile-path', reason: candidate.pathBlockedReason };
  }
  // R3 — the name is one DorkOS seeds into every room folder (SRC-11).
  if (input.ownership === 'room-worktree' && ROOM_SEEDED_SKILL_NAMES.has(name)) {
    return { name, source, rule: 'room-seeded-name', reason: ADOPT_SENTENCES.S4(name) };
  }
  // R4 — something is already at the target.
  if (candidate.targetState === 'occupied') {
    return { name, source, rule: 'target-exists', reason: ADOPT_SENTENCES.S5(name) };
  }
  // R5 — the source is a link, and DorkOS has no way to know whether the person
  // meant the link or the folder it points at.
  if (candidate.isSymlink) {
    return { name, source, rule: 'source-is-symlink', reason: ADOPT_SENTENCES.S6(source) };
  }
  // R6 — the frontmatter would not parse, so the allowlist has nothing to read.
  if (candidate.unreadable) {
    return { name, source, rule: 'unreadable-frontmatter', reason: ADOPT_SENTENCES.S12(source) };
  }
  // R7 — hard in both modes. There is no `--force`: the exposure is one-way, and
  // `manifest.claudeOnlySkills` cannot un-expose a skill that has already moved.
  const verdict = allowlistVerdict(candidate);
  if (!verdict.safe) {
    return { name, source, rule: 'not-on-allowlist', reason: notOnAllowlistReason(name, verdict) };
  }
  return undefined;
}

/**
 * R1 — the name the person typed is not one this run can move, and which of the
 * three things is wrong decides the sentence.
 *
 * @param input - the run's input, for the exclusions and the roots looked in.
 * @param name - the name the person asked for.
 * @returns the refusal.
 */
function notAdoptable(input: AdoptSkillInput, name: string): AdoptRefusal {
  const excluded = input.exclusions.find((entry) => entry.name === name);
  if (excluded?.why === 'also-canonical') {
    return {
      name,
      source: excluded.source,
      rule: 'not-adoptable',
      reason: ADOPT_SENTENCES.S2b(name, excluded.source),
    };
  }
  if (excluded?.why === 'declared') {
    return {
      name,
      source: excluded.source,
      rule: 'not-adoptable',
      reason: ADOPT_SENTENCES.S2c(name),
    };
  }
  // A caller that looked in no roots at all would otherwise print "in .", so the
  // fallback the reader applies is applied here as well: a pure function cannot
  // rely on its caller having done it.
  const roots = input.roots.length > 0 ? input.roots : HARNESS_OWNED_SKILL_ROOTS;
  return { name, source: '', rule: 'not-adoptable', reason: ADOPT_SENTENCES.S2(name, roots) };
}

/**
 * `--claude-only`: R1, then R8, then one manifest line.
 *
 * @param input - the run's input.
 * @param name - the name the person asked for.
 * @returns a plan carrying one declaration, or one refusal.
 */
function planDeclaration(input: AdoptSkillInput, name: string): AdoptPlan {
  const candidate = input.candidates.find((entry) => entry.name === name);
  if (candidate === undefined) {
    return { moves: [], declarations: [], refusals: [notAdoptable(input, name)] };
  }
  // R8 — `manifest.claudeOnlySkills` is named for Claude Code and every one of
  // SK-04's five states is about `.claude/skills`, so a candidate under another
  // tool's folder has no such declaration to make.
  if (candidate.root !== CLAUDE_SKILLS_ROOT) {
    return {
      moves: [],
      declarations: [],
      refusals: [
        {
          name,
          source: candidate.source,
          rule: 'claude-only-wrong-root',
          reason: ADOPT_SENTENCES.S9(name, candidate.root),
        },
      ],
    };
  }
  return { moves: [], declarations: [declare(candidate)], refusals: [] };
}

/**
 * The manifest line one declaration writes, with the reason that names what made
 * the skill Claude-shaped (S18).
 *
 * A skill whose frontmatter carried keys DorkOS does not recognise gets the same
 * sentence as one carrying Claude Code's own dialect: the person has just said
 * the placement is deliberate, and the entry records their claim rather than
 * DorkOS's guess about who understands the key.
 *
 * @param candidate - the skill being declared.
 * @returns the entry to append to `manifest.claudeOnlySkills`.
 */
function declare(candidate: AdoptCandidate): AdoptDeclaration {
  return {
    name: candidate.name,
    path: candidate.source,
    reason: declarationReason(allowlistVerdict(candidate)),
  };
}

/**
 * The sentence R7 refuses with, chosen by whose fields the offending keys are.
 *
 * A sentence that names a tool is only printed when EVERY key it names belongs
 * to that tool — the mixed case gets S7c, which claims nothing about who
 * understands what and still names every key the person has to take out.
 *
 * @param name - the skill's name.
 * @param verdict - what the allowlist found wrong.
 * @returns the frozen sentence.
 */
function notOnAllowlistReason(
  name: string,
  verdict: Extract<AllowlistVerdict, { safe: false }>
): string {
  switch (verdict.why) {
    case 'body-token':
      return ADOPT_SENTENCES.S7b(name);
    case 'claude-field':
      return ADOPT_SENTENCES.S7(name, joinNames(verdict.fields));
    case 'dorkos-field':
      return ADOPT_SENTENCES.S7d(name, joinNames(verdict.fields));
    default:
      return ADOPT_SENTENCES.S7c(name, joinNames(verdict.fields));
  }
}

/**
 * The `reason` a `--claude-only` entry carries (S18), chosen the same way.
 *
 * The unknown case deliberately says "on purpose" rather than "only Claude Code
 * understands": a person opening that manifest a year later should read what
 * DorkOS actually knew, and DorkOS does not know who understands a key it has
 * never heard of.
 *
 * @param verdict - what the allowlist found wrong, if anything.
 * @returns the sentence to store in `manifest.claudeOnlySkills`.
 */
function declarationReason(verdict: AllowlistVerdict): string {
  if (verdict.safe) return ADOPT_DECLARATION_REASONS.onPurpose();
  switch (verdict.why) {
    case 'body-token':
      return ADOPT_DECLARATION_REASONS.bodyToken();
    case 'claude-field':
      return ADOPT_DECLARATION_REASONS.claudeFields(joinNames(verdict.fields));
    case 'dorkos-field':
      return ADOPT_DECLARATION_REASONS.dorkosFields(joinNames(verdict.fields));
    default:
      return ADOPT_DECLARATION_REASONS.unknownFields(joinNames(verdict.fields));
  }
}
