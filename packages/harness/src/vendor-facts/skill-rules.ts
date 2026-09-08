/**
 * One harness's symlink, identity and name rules applied to one skill — the
 * pure half of the coverage walk, with no filesystem anywhere near it.
 *
 * It lives on its own because **two** callers have to reach the same verdict and
 * a second hand-written copy of this ladder would drift on its first edit:
 *
 * - `coverage.ts` reads a real tree and asks this about each directory it
 *   reaches. That is the oracle.
 * - `plan/source-artifacts.ts` asks it about each `.claude/skills` directory the
 *   inventory found, to decide whether the plan may call the skill `native`.
 *   Before it did, the plan consulted `readPaths` and `symlinks` and stopped
 *   there — so `.claude/skills/My_Skill` holding `name: totally-different` was
 *   claimed as loading in OpenCode and Cursor while the walk, reading the same
 *   table, refused to decide about it (DOR-1845 review). `.claude/skills` is
 *   exactly where an agent drops a directory under whatever name it liked.
 *
 * What is deliberately NOT shared is the walk (which directories a harness
 * looks in, and what its dedupe rule does with a skill reached twice) and the
 * routing (native / drop / warning). Those stay in their own modules, so the
 * agreement property still has something real to check: this module removes the
 * duplicated rule ladder, not the independence of the two answers.
 *
 * **The vocabulary is the contract's.** `reasons` is a refusal to decide — the
 * vendor documented a rule and not its consequence — and a caller must not turn
 * one into a yes or a no. A violation with a DOCUMENTED consequence is not a
 * refusal: `onInvalidName: 'skip'` drops the skill and `'warn-and-load'` loads
 * it, and neither has a row in the table today.
 *
 * @module vendor-facts/skill-rules
 */
import { HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';
import type { SkillsFacts } from './types.js';

/** What a caller knows about one skill without consulting a harness. */
export interface SkillRuleInput {
  /** The skill's directory name. */
  dirName: string;
  /** Its frontmatter `name`, trimmed; absent when there is none or it is unreadable. */
  frontmatterName?: string;
  /** Whether the entry in the read path is a symlink rather than a real directory. */
  reachedThroughSymlink: boolean;
}

/** What one harness's documented rules say about that skill. */
export interface SkillRuleOutcome {
  /** The identifier this harness would key the skill by. */
  key: string;
  /** Every reason the outcome is undecidable. Empty means the rules were enough. */
  reasons: string[];
  /** Whether a documented rule says the harness skips it outright. */
  droppedByRule: boolean;
  /** Whether the documented rules are enough to say it loads. Never true alongside a reason. */
  loads: boolean;
}

/**
 * Decide what one harness's documented rules say about one skill.
 *
 * @param harness - the harness whose rules apply. Its LABEL is what appears in
 *   the message text, because these sentences reach a person twice over: through
 *   `harnessCoverage`'s `uncertain` list and through the plan's warnings, where
 *   "Cursor reads .claude/skills, but cursor does not document…" was the sort of
 *   sentence nobody writes on purpose.
 * @param facts - that harness's skills facts.
 * @param input - what is known about the skill.
 * @returns the key it would be loaded under, and whether that is decidable.
 */
export function evaluateSkillRules(
  harnessId: HarnessId,
  facts: SkillsFacts,
  input: SkillRuleInput
): SkillRuleOutcome {
  const harness = HARNESS_LABELS[harnessId];
  const { dirName, frontmatterName: name, reachedThroughSymlink } = input;
  const reasons: string[] = [];

  if (reachedThroughSymlink && facts.symlinks === 'unknown') {
    reasons.push(
      `it is reached through a symlink, and ${harness} does not document whether it follows one`
    );
  }

  let key = dirName;
  if (facts.identity === 'frontmatter') {
    if (name === undefined) {
      reasons.push(
        `frontmatter name absent, and ${harness} keys a skill by its frontmatter name - the directory name "${dirName}" is a fallback, not what the harness would use`
      );
    } else {
      key = name;
    }
  } else if (facts.identity === 'unknown' && name !== undefined && name !== dirName) {
    reasons.push(
      `${harness} does not document whether a skill is keyed by its directory ("${dirName}") or its frontmatter name ("${name}"), and the two differ`
    );
  }

  const violations: string[] = [];
  if (facts.nameRegex && !facts.nameRegex.test(key)) {
    violations.push(
      `the name "${key}" breaks ${harness}'s documented charset rule ${String(facts.nameRegex)}`
    );
  }
  if (facts.nameMustMatchDir === true) {
    if (name === undefined) {
      reasons.push(
        `${harness} documents that a skill's frontmatter name must match its directory, and this SKILL.md has no name`
      );
    } else if (name !== dirName) {
      violations.push(
        `the frontmatter name "${name}" does not match the directory "${dirName}", which ${harness} documents as required`
      );
    }
  } else if (facts.nameMustMatchDir === 'unknown' && name !== undefined && name !== dirName) {
    reasons.push(
      `the frontmatter name "${name}" does not match the directory "${dirName}", and ${harness} does not document whether it must`
    );
  }

  // A broken name rule with a DOCUMENTED consequence is not uncertainty: 'skip'
  // drops the skill outright and 'warn-and-load' loads it. Only 'unknown' is a
  // refusal to decide, and it joins the reasons above.
  let droppedByRule = false;
  if (violations.length > 0) {
    if (facts.onInvalidName === 'skip') {
      droppedByRule = true;
    } else if (facts.onInvalidName === 'unknown') {
      for (const violation of violations) {
        reasons.push(
          `${violation}, and ${harness} does not document what it does with such a skill`
        );
      }
    }
  }

  return { key, reasons, droppedByRule, loads: reasons.length === 0 && !droppedByRule };
}
