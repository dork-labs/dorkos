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
 * **Sharing it moves one class of bug and creates another.** P9c compares the
 * plan against the walk, so it catches a DIVERGENCE — and it cannot, by
 * construction, catch an OMISSION: a rule missing from this ladder is missing
 * from both answers at once, and they agree perfectly on the wrong thing. That
 * is not hypothetical. Until `nameRequired` was added below, a `SKILL.md` with
 * no frontmatter `name` was "loads" for Copilot, whose own page says the key is
 * required, and the walk said so too. The guard against that is the per-rule
 * unit test beside this file, which drives the ladder with SYNTHETIC facts and
 * so answers to the vendor pages rather than to the other half of the engine.
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
  /**
   * Every reason the outcome is undecidable, each a whole sentence.
   *
   * Self-contained on purpose: the coverage walk lists one `uncertain` entry per
   * reason, and each has to read on its own. Use {@link summariseSkillRules} for
   * the one-line form, which says a shared vendor silence once instead of once
   * per violation.
   */
  reasons: string[];
  /** Whether a documented rule says the harness skips it outright. */
  droppedByRule: boolean;
  /** Set with {@link SkillRuleOutcome.droppedByRule}: which rule, and that the vendor documents skipping. */
  droppedReason?: string;
  /** Whether the documented rules are enough to say it loads. Never true alongside a reason. */
  loads: boolean;
  /** The same undecidable outcomes, split into detail and vendor silence. */
  undecided: Undecided[];
}

/** One undecidable outcome, split so a silence shared by several can be said once. */
interface Undecided {
  /** What is wrong with this skill, as a clause. */
  detail: string;
  /** The vendor silence that makes it undecidable, as a clause. */
  silence: string;
}

/**
 * The undecidable outcomes as ONE sentence, with a shared vendor silence stated
 * once.
 *
 * A directory like `My_Skill` holding `name: totally-different` breaks two of
 * Cursor's rules and hits the same silence about both, and joining the raw
 * `reasons` printed "and Cursor does not document what it does with such a
 * skill" twice in one line.
 *
 * @param outcome - the outcome to describe; must not be `loads`.
 * @returns one sentence, or `''` when there is nothing undecided.
 */
export function summariseSkillRules(outcome: SkillRuleOutcome): string {
  const undecided = outcome.undecided;
  if (undecided.length === 0) return '';
  const silences = [...new Set(undecided.map((u) => u.silence))];
  if (silences.length === 1) {
    return `${undecided.map((u) => u.detail).join('; ')}, and ${silences[0]}`;
  }
  return outcome.reasons.join('; ');
}

/**
 * Decide what one harness's documented rules say about one skill.
 *
 * @param harnessId - the harness whose rules apply. Its LABEL is what appears in
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
  const undecided: Undecided[] = [];

  if (reachedThroughSymlink && facts.symlinks === 'unknown') {
    undecided.push({
      detail: 'it is reached through a symlink',
      silence: `${harness} does not document whether it follows one`,
    });
  }

  let key = dirName;
  if (facts.identity === 'frontmatter') {
    if (name === undefined) {
      undecided.push({
        detail: 'frontmatter name absent',
        silence: `${harness} keys a skill by its frontmatter name - the directory name "${dirName}" is a fallback, not what the harness would use`,
      });
    } else {
      key = name;
    }
  } else if (facts.identity === 'unknown' && name !== undefined && name !== dirName) {
    undecided.push({
      detail: `${harness} does not document whether a skill is keyed by its directory ("${dirName}") or its frontmatter name ("${name}")`,
      silence: 'the two differ',
    });
  }

  const violations: string[] = [];
  if (facts.nameRegex && !facts.nameRegex.test(key)) {
    violations.push(
      `the name "${key}" breaks ${harness}'s documented charset rule ${String(facts.nameRegex)}`
    );
  }
  // A required name that is absent is a broken rule like any other, so it goes
  // through `onInvalidName` with the rest. Skipped when the harness ALSO requires
  // the two names to match, because that rule already reports an absent name and
  // saying it twice helps nobody.
  if (facts.nameRequired === true && name === undefined && facts.nameMustMatchDir !== true) {
    violations.push(
      `${harness} documents that a SKILL.md must declare a name, and this one has none`
    );
  }
  if (facts.nameMustMatchDir === true) {
    if (name === undefined) {
      undecided.push({
        detail: `${harness} documents that a skill's frontmatter name must match its directory`,
        silence: 'this SKILL.md has no name',
      });
    } else if (name !== dirName) {
      violations.push(
        `the frontmatter name "${name}" does not match the directory "${dirName}", which ${harness} documents as required`
      );
    }
  } else if (facts.nameMustMatchDir === 'unknown' && name !== undefined && name !== dirName) {
    undecided.push({
      detail: `the frontmatter name "${name}" does not match the directory "${dirName}"`,
      silence: `${harness} does not document whether it must`,
    });
  }

  // A broken name rule with a DOCUMENTED consequence is not uncertainty: 'skip'
  // drops the skill outright and 'warn-and-load' loads it. Only 'unknown' is a
  // refusal to decide, and it joins the outcomes above.
  let droppedByRule = false;
  let droppedReason: string | undefined;
  if (violations.length > 0) {
    if (facts.onInvalidName === 'skip') {
      droppedByRule = true;
      droppedReason = `${violations.join('; ')}, and ${harness} documents that it skips such a skill`;
    } else if (facts.onInvalidName === 'unknown') {
      for (const violation of violations) {
        undecided.push({
          detail: violation,
          silence: `${harness} does not document what it does with such a skill`,
        });
      }
    }
  }

  return {
    key,
    reasons: undecided.map((u) => `${u.detail}, and ${u.silence}`),
    undecided,
    droppedByRule,
    ...(droppedReason === undefined ? {} : { droppedReason }),
    loads: undecided.length === 0 && !droppedByRule,
  };
}
