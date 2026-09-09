/**
 * Every sentence adopt refuses with, written down once.
 *
 * The terminal, the boot summary, the Skills page and the API all print these
 * verbatim, and two surfaces describing one fact in two voices is how a person
 * stops trusting either — the argument `apply/sweep-reasons.ts` makes about its
 * own table. Each sentence names the obstacle and the way out, in the same
 * second person the rest of the engine's report uses.
 *
 * **No file CONTENT ever reaches one of these.** A refusal names keys and paths;
 * it never quotes a value. A `SKILL.md` frontmatter routinely carries a
 * person's own prose, and a refusal is printed to a terminal, written to a log
 * and served over an API.
 *
 * @module adopt/refusals
 */
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import type { SkillRoot } from '../inventory/types.js';

/**
 * The skill names DorkOS seeds into every room worktree, derived from the pack
 * rather than listed here.
 *
 * `SEEDED_PACK_EXCLUDES` in `room-worktree-manager.ts` derives its own list the
 * same way and says why: the pack has grown before, and a list extended by hand
 * is a list that will be one behind. A name in here is reserved inside a room
 * folder — `.agents/skills/<name>` is hidden from git there and is deleted when
 * the folder is cleaned up — so adopting onto one would quietly lose the
 * person's skill.
 */
export const ROOM_SEEDED_SKILL_NAMES: ReadonlySet<string> = new Set(
  OPERATING_SKILLS_PACK.map((skill) => skill.name)
);

/**
 * Join names the way a person would read them out: `a`, `a and b`, `a, b and c`.
 *
 * @param items - the names, in the order they appear in the file.
 * @returns the joined phrase.
 */
export function joinNames(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The `${CLAUDE_…}` token the body sentences name, spelled once. */
const CLAUDE_PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

/**
 * Every frozen sentence, keyed by the rule that produces it.
 *
 * The keys are the `S…` ids the specification freezes, so a reviewer reading
 * either document can find the other. Each is asserted verbatim by a test that
 * compares against the literal rather than against the constant here — a test
 * reading this table would agree with any edit to it.
 */
export const ADOPT_SENTENCES = {
  /** R1, and there is no such skill anywhere adopt looked. */
  S2: (name: string, roots: readonly SkillRoot[]): string =>
    `There is no skill called "${name}" in ${joinNames([...roots])}. ` +
    `Run dorkos harness sync --check to see what is here.`,

  /** R1, and the name is already in the canonical layer as well. */
  S2b: (name: string, source: string): string =>
    `"${name}" is already in .agents/skills, where every agent reads it. ` +
    `The copy in ${source} is a second one that gets in the way — delete one of them.`,

  /** R1, and the name is declared in `manifest.claudeOnlySkills`. */
  S2c: (name: string): string =>
    `"${name}" is listed in manifest.claudeOnlySkills, which says the Claude-Code-only spot is ` +
    `on purpose. Take it out of that list first if you want to share it.`,

  /** B2 — a `.gitignore` keeps the canonical layer out of git (AP-15). */
  S3: (file: string): string =>
    `DorkOS can't move a skill into .agents/skills here: ${file} tells git to ignore .agents/, ` +
    `so moving it would take the skill out of git for everybody who clones this project. ` +
    `Stop ignoring .agents/ in ${file}, or leave the skill where it is.`,

  /** R3 — the name is one DorkOS seeds into every room folder (SRC-11). */
  S4: (name: string): string =>
    `"${name}" is one of the skills DorkOS puts in every room folder, so .agents/skills/${name} ` +
    `is hidden from git here and would be deleted when the room folder is cleaned up. ` +
    `Rename your skill and adopt it under the new name.`,

  /** R4 — something is already at the target. */
  S5: (name: string): string =>
    `.agents/skills/${name} already has something in it. ` +
    `Look at both copies, keep the one you want, and adopt again.`,

  /** R5 — the source directory is itself a link. */
  S6: (source: string): string =>
    `${source} is a link to a folder somewhere else, so DorkOS can't move it without changing ` +
    `where your real skill lives. Move the real folder into .agents/skills yourself, or leave ` +
    `the link alone.`,

  /** R7, and every offending key is one the schema declares. */
  S7: (name: string, fields: string): string =>
    `"${name}" uses ${fields} in its settings, which only Claude Code understands, so moving it ` +
    `would hand it to agents that can't run it properly. Run dorkos harness adopt ${name} ` +
    `--claude-only to say it belongs to Claude Code, or take ${fields} out and adopt it.`,

  /** R7, and the body carries a `${CLAUDE_…}` token. */
  S7b: (name: string): string =>
    `"${name}" mentions ${CLAUDE_PLUGIN_ROOT} in its text, which only Claude Code fills in, so ` +
    `moving it would hand it to agents that read a broken path. Run dorkos harness adopt ` +
    `${name} --claude-only to say it belongs to Claude Code, or take the token out and adopt it.`,

  /** R7, and every offending key is one of DorkOS's own. */
  S7d: (name: string, fields: string): string =>
    `"${name}" uses ${fields} in its settings, which are DorkOS's own and mean nothing to your ` +
    `other agents.` +
    // Only a `schedule` changes what DorkOS itself does after the move; `kind` is
    // a marketplace marker with no runtime consequence, so it earns no warning.
    (/\bschedule\b/.test(fields)
      ? ` Moving it also changes what DorkOS does with it: a skill with a schedule starts ` +
        `running on a timer once it is in .agents/skills.`
      : '') +
    ` Take ${fields} out and adopt it, or run dorkos harness adopt ${name} --claude-only to ` +
    `keep it where it is.`,

  /** R7, and the offending keys are a mix, or one belongs to nobody DorkOS knows. */
  S7c: (name: string, fields: string): string =>
    `"${name}" uses ${fields} in its settings, which DorkOS doesn't recognise, so it can't tell ` +
    `whether your other agents can run it. Run dorkos harness adopt ${name} --claude-only to ` +
    `keep it where it is, or take ${fields} out and adopt it.`,

  /** B1 — `harness.autoAdopt` is on somewhere DorkOS does not own. */
  S8: (): string =>
    `harness.autoAdopt is on, and it does nothing here: DorkOS only moves skills on its own ` +
    `inside the agent folders and room folders it owns. Run dorkos harness adopt <name> to ` +
    `move one yourself.`,

  /** R8 — `--claude-only` on a candidate that does not live in Claude Code's folder. */
  S9: (name: string, root: SkillRoot): string =>
    `--claude-only records a skill as belonging to Claude Code, and "${name}" lives in ${root}. ` +
    `Leave it where it is, or move the folder yourself.`,

  /**
   * The apply's own refusal: `rename(2)` came back `EXDEV`, so the source and
   * the canonical layer are on different filesystems.
   *
   * Never degraded to a copy-then-delete. That is the one alternative, it is not
   * atomic, and its failure mode is exactly the half-moved skill this design
   * promises never to leave.
   */
  S10: (source: string): string =>
    `DorkOS can't move ${source} into .agents/skills because the two folders are on different ` +
    `drives. Move the folder yourself, then run dorkos harness sync --fix.`,

  /** R6 — the frontmatter would not parse at all. */
  S12: (source: string): string =>
    `DorkOS can't read the settings at the top of ${source}/SKILL.md, so it can't tell whether ` +
    `the skill is safe to share. Fix that file and adopt again.`,
} as const;

/**
 * The `reason` `--claude-only` writes into `manifest.claudeOnlySkills` (S18).
 *
 * The one frozen string here a person reads in a FILE rather than on a screen,
 * and it has to still make sense a year later beside a dozen others — which is
 * why each names what made the skill Claude-shaped rather than saying "declared
 * by `dorkos harness adopt --claude-only`".
 */
export const ADOPT_DECLARATION_REASONS = {
  /** The frontmatter carried Claude Code's own dialect. */
  claudeFields: (fields: string): string =>
    `Kept in Claude Code: its settings use ${fields}, which only Claude Code understands.`,
  /** The frontmatter carried DorkOS's own fields. */
  dorkosFields: (fields: string): string =>
    `Kept in Claude Code: its settings use ${fields}, which are DorkOS's own.`,
  /**
   * The frontmatter carried keys DorkOS cannot place.
   *
   * It says "on purpose" and never "only Claude Code understands": DorkOS does
   * not know that, and this line is read a year later by somebody deciding
   * whether the entry is still true.
   */
  unknownFields: (fields: string): string =>
    `Kept in Claude Code on purpose: its settings use ${fields}, which DorkOS doesn't recognise.`,
  /** The body carried a `${CLAUDE_…}` token. */
  bodyToken: (): string =>
    `Kept in Claude Code: its text uses ${CLAUDE_PLUGIN_ROOT}, which only Claude Code fills in.`,
  /** Nothing about the file would have stopped the move; the person decided anyway. */
  onPurpose: (): string => `Kept in Claude Code on purpose.`,
} as const;
