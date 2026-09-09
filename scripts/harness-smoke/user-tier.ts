/**
 * The user-tier oracle — does a harness read a directory in a person's HOME, and
 * does one package reachable two ways appear once or twice?
 *
 * Kept apart from `./oracles.ts` for the same reason `./calibration.ts` is: it
 * asks a different KIND of question. Every verdict there is about a projected
 * repository — a tree this runner just wrote and can walk. Every verdict here is
 * about a home directory, which is where slice A3 (DOR-1924) proposes to write
 * and where nothing DorkOS ships has ever written before, so the bar is higher
 * and the machinery is separate:
 *
 * - Its expectations come from the compiled vendor facts rather than from a
 *   constant, so a re-vendor moves the EXPECTATION and a binary that disagrees
 *   is reported as the disagreement it is.
 * - Its duplicate verdict carries a control per ROUTE, and refuses to answer
 *   without both. "One entry" from a run where one of the two routes was dead
 *   would be this runner's most expensive possible lie: it is the sentence
 *   `specs/harness-sync-global/02-specification.md` §2.9 gates a design decision
 *   on.
 * - It matches by PATH wherever the harness reports one, because the names are
 *   not what anybody predicted: Codex renames a linked package's skill and
 *   Claude Code's plugin loader gives it a third form again.
 *
 * @module harness-smoke/user-tier
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_VENDOR_FACTS } from '../../packages/harness/dist/vendor-facts/index.js';
import type { UserTierSubject } from './fixture.js';
import type { ListingObservation, SmokeHarness } from './harnesses.js';
import type { ListingAbsence, Verdict } from './oracles.js';

/**
 * What each read-path subject means for the design, once its answer is known.
 *
 * Kept beside the verdict rather than inside the detail strings because the two
 * rounds that ask a read-path question mean different things by the same answer:
 * one decides whether slice A3 writes two directories or one, and the other
 * found a directory nobody had asked about.
 *
 * @param subject - the subject the verdict is about.
 * @returns one sentence a person can act on.
 */
function consequenceOf(subject: UserTierSubject): string {
  if (subject.id === 'agents-user-root') {
    return (
      'The consequence is decision 3 in `specs/harness-sync-global/02-specification.md`: a harness ' +
      'that reads this directory needs no second link of its own, and one that does not is why ' +
      'slice A3 writes two directories rather than one.'
    );
  }
  return (
    'The consequence is a `skills.readPaths.user` entry the row is missing — which may NOT be ' +
    'added without a vendor page to cite, per that module’s own rule. See the `codex` row’s notes ' +
    'for what a refresh has to find.'
  );
}

/** One listing entry the runner attributed to a user-tier subject. */
export interface UserTierMatch {
  /** The identifier the harness printed, verbatim. */
  entry: string;
  /** The absolute `SKILL.md` path beside it, where the harness reports one. */
  path?: string;
  /** Which of the listing's two arrays it came from. */
  list: 'skills' | 'commands';
}

/**
 * Every listing entry that resolves to one subject's skill directory.
 *
 * Two modes, because the two harnesses answer in two different currencies and
 * neither may be guessed at:
 *
 * - **By PATH**, where the harness reports one (Codex). This is name-agnostic by
 *   construction, which matters more than it looks: Codex renames a linked skill
 *   to `<pkg>:<name>` when the package carries a Claude Code plugin manifest, so
 *   a name-keyed match would have reported "not listed" about an entry sitting in
 *   front of it.
 * - **By NAME**, where it does not (Claude Code reports names only). The
 *   candidates are enumerated rather than assumed: the link's directory name
 *   `<pkg>__<name>`, the plugin loader's `<pkg>:<name>`, and the bare `<name>`.
 *   The fixture gives every subject a distinct skill name for exactly this
 *   reason — two subjects sharing one would make the bare form ambiguous and the
 *   count meaningless.
 *
 * Counted WITHIN one array, never across both, for the reason
 * {@link countEntry} gives: Claude Code prints a skill's name in `skills` AND
 * again in `slash_commands`, so a sum would report every skill as two.
 *
 * @param subject - the staged package the count is about.
 * @param observed - what the harness listed.
 * @returns every matching entry, verbatim, in the order the harness printed them.
 */
export function userTierMatches(
  subject: UserTierSubject,
  observed: ListingObservation
): UserTierMatch[] {
  if (observed.skillPaths.some((path) => path !== undefined && path !== '')) {
    const wanted = join(subject.sourceDir, 'SKILL.md');
    const matches: UserTierMatch[] = [];
    for (const [index, name] of observed.skills.entries()) {
      const path = observed.skillPaths[index];
      if (path === undefined) continue;
      if (samePath(path, wanted)) matches.push({ entry: name, path, list: 'skills' });
    }
    return matches;
  }

  const candidates = new Set([
    `${subject.pkg}__${subject.skill}`,
    `${subject.pkg}:${subject.skill}`,
    subject.skill,
  ]);
  const inSkills = observed.skills
    .filter((name) => candidates.has(name))
    .map((entry): UserTierMatch => ({ entry, list: 'skills' }));
  if (inSkills.length > 0) return inSkills;
  return observed.commands
    .filter((name) => candidates.has(name))
    .map((entry): UserTierMatch => ({ entry, list: 'commands' }));
}

/** Whether two absolute paths name the same file once symlinks are resolved. */
function samePath(left: string, right: string): boolean {
  const resolve = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return resolve(left) === resolve(right);
}

/** How a match list reads in a report — the raw entries, never a count on its own. */
export function renderMatches(matches: readonly UserTierMatch[]): string {
  if (matches.length === 0) return '(nothing)';
  return matches
    .map((match) => `\`${match.entry}\`${match.path === undefined ? '' : ` (${match.path})`}`)
    .join(', ');
}

/**
 * Whether a subject's staged link is actually live, and what is wrong when it is
 * not.
 *
 * The liveness control on every NOT-LISTED verdict, and the reason it exists is
 * that its absence was a silent pass. "Not listed" is only evidence about a
 * harness's read paths if the thing it was meant to find was really there: a
 * link pointing one directory too high resolves to nothing, the harness
 * correctly lists nothing, and the verdict would have read `PASS — the table and
 * the binary agree` off a fixture that never staged anything. A verdict that
 * cannot fail is not a verdict.
 *
 * Three conditions, because a link can be wrong in three ways: it can dangle
 * (resolving throws), it can resolve somewhere real that is not the package, and
 * it can resolve to a directory holding no `SKILL.md` — which is a link a
 * harness is RIGHT to ignore, so a not-listed verdict off one of those would be
 * blaming a vendor for the fixture's mistake.
 *
 * @param subject - the subject whose link was staged.
 * @returns the fault, in a sentence, or `undefined` when the link is live.
 */
export function userTierLinkFault(subject: UserTierSubject): string | undefined {
  if (!subject.link) return undefined;
  const target = subject.link.target;
  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch {
    return `\`${target}\` does not resolve — the link dangles, or nothing was written there at all`;
  }
  let wanted: string;
  try {
    wanted = realpathSync(subject.sourceDir);
  } catch {
    return `\`${subject.sourceDir}\` is not there, so the package the link points at was never staged`;
  }
  if (resolved !== wanted) {
    return `\`${target}\` resolves to \`${resolved}\`, not to \`${wanted}\``;
  }
  if (!existsSync(join(target, 'SKILL.md'))) {
    return `\`${target}\` resolves, but holds no \`SKILL.md\` for a harness to find`;
  }
  return undefined;
}

/** Injectable seams, so every verdict branch is reachable without staging a tree. */
export interface UserTierVerdictDeps {
  /**
   * Whether a subject's link is live. Defaults to {@link userTierLinkFault},
   * which is the real filesystem check; the unit cases that drive verdict
   * BRANCHES against hand-built paths inject a no-fault stub, and the case that
   * drives the CHECK stages a real fixture and breaks its link.
   */
  linkFault?: (subject: UserTierSubject) => string | undefined;
}

/**
 * The user-tier verdicts — does this harness read a directory in a person's
 * home, and does a package reachable two ways appear once or twice?
 *
 * This is the DOR-1924 gate, and every verdict is decided from what the binary
 * printed rather than from what a document expects. Three of the four are about
 * a READ PATH and one is a positive control on the runner itself; the control is
 * evaluated first because the duplicate verdict is meaningless without it, which
 * is the difference between "the two routes collapsed into one" and "only one
 * route ever worked".
 *
 * @param harness - the harness being asked.
 * @param subjects - what the round staged, from {@link ./fixture.js#userTierSubjects}.
 * @param observed - what its listing said, or `undefined` when it produced none.
 * @param absence - why a listing is missing, when one is.
 * @param deps - injectable liveness seam; defaults to the real filesystem check.
 * @returns one verdict per subject, in staging order.
 */
export function userTierVerdicts(
  harness: SmokeHarness,
  subjects: readonly UserTierSubject[],
  observed: ListingObservation | undefined,
  absence: ListingAbsence = 'no-surface',
  deps: UserTierVerdictDeps = {}
): Verdict[] {
  if (!observed) {
    return subjects.map((subject): Verdict => ({
      id: subject.id,
      capabilities: subject.capabilities,
      ...(subject.cites === undefined ? {} : { cites: subject.cites }),
      question: userTierQuestion(harness, subject),
      status: 'unknown',
      detail:
        absence === 'no-surface'
          ? `NOT ANSWERABLE. ${harness.label} enumerated nothing this run. ${harness.listing.note}`
          : 'The probe produced no startup record at all, so the listing oracle DID NOT RUN. ' +
            `That is a broken probe, not a documented gap. ${harness.listing.note}`,
    }));
  }

  const matches = new Map<string, UserTierMatch[]>(
    subjects.map((subject) => [subject.id, userTierMatches(subject, observed)])
  );
  // The duplicate question needs BOTH routes proved to work on their own, and
  // one control each is what proves them: `injection-control` is a package
  // reachable only by injection, and `user-tier-listed` is one reachable only by
  // a link. Without both, "one entry" cannot be told apart from "one of the two
  // routes never worked", and a verdict that said "the two collapse" about a
  // dead link would be this runner's most expensive possible lie — it is the
  // sentence slice A3's design is gated on.
  const controlCount = matches.get('injection-control')?.length ?? 0;
  const linkRouteCount = matches.get('user-tier-listed')?.length ?? 0;

  const linkFault = deps.linkFault ?? userTierLinkFault;

  return subjects.map((subject): Verdict => {
    const found = matches.get(subject.id) ?? [];
    const raw = renderMatches(found);
    const base = {
      id: subject.id,
      capabilities: subject.capabilities,
      ...(subject.cites === undefined ? {} : { cites: subject.cites }),
      question: userTierQuestion(harness, subject),
    };

    // THE LIVENESS CONTROL. Only a NOT-LISTED answer needs it, and it needs it
    // absolutely: an entry that WAS listed proves the link worked by existing,
    // while "nothing was listed" is evidence about the harness only if the
    // fixture really put something there for it to miss. Checked before the
    // branches so no verdict can reach a not-listed conclusion without it.
    if (found.length === 0) {
      const fault = linkFault(subject);
      if (fault !== undefined) {
        return {
          ...base,
          status: 'unknown',
          detail:
            `NOT ANSWERABLE. ${harness.label} listed nothing for this subject, but the link this ` +
            `round staged is not live, so the absence is the FIXTURE's and says nothing about ` +
            `what the harness reads: ${fault}. Fix the staging and run it again.`,
        };
      }
    }

    if (subject.id === 'user-tier-listed') {
      return {
        ...base,
        status: found.length > 0 ? 'pass' : 'fail',
        detail:
          found.length > 0
            ? `Listed ${found.length}×: ${raw}. The only route to that entry is the link at ` +
              `\`${subject.link?.target ?? ''}\` → \`${subject.link?.text ?? ''}\`, in a project ` +
              `holding no skills of its own — so ${harness.label} reads its own user-scope skills ` +
              `directory, and SRC-04's listing half is measured rather than assumed.`
            : `NOT listed. The listing carried: ${renderListing(observed)}. A link at ` +
              `\`${subject.link?.target ?? ''}\` reached nothing, so slice A3's ` +
              `\`<claudeRoot>/skills\` link would buy a person nothing and the design needs ` +
              `revisiting before it ships.`,
      };
    }

    if (subject.documentedAs !== undefined) {
      const path = subject.documentedAs;
      const documented =
        HARNESS_VENDOR_FACTS[harness.harnessId].skills.readPaths.user.includes(path);
      const listed = found.length > 0;
      if (documented) {
        return {
          ...base,
          status: listed ? 'pass' : 'fail',
          detail: listed
            ? `Listed ${found.length}×: ${raw}. \`${path}\` is on this row's ` +
              `\`skills.readPaths.user\` in \`packages/harness/src/vendor-facts/index.ts\`, and the ` +
              `binary agrees — measured from a sandbox HOME, not the operator's, so nothing but ` +
              `the staged link could have produced it.`
            : `NOT listed, though \`${path}\` is on this row's ` +
              `\`skills.readPaths.user\`. The listing carried: ${renderListing(observed)}. That is ` +
              `the compiled vendor facts contradicted by the binary they describe, and it would ` +
              `remove this tool from the five slice A3 plans the shared link for.`,
        };
      }
      return {
        ...base,
        status: listed ? 'finding' : 'pass',
        detail: listed
          ? `Listed ${found.length}×: ${raw} — and \`${path}\` is NOT on this row's ` +
            `\`skills.readPaths.user\` in \`packages/harness/src/vendor-facts/index.ts\`. A ` +
            `writable directory a harness reads and the compiled facts do not carry is exactly ` +
            `the disagreement this tier exists to produce: it is a finding, not a failure, and ` +
            `the fix is the facts table rather than this report. ${consequenceOf(subject)}`
          : `NOT listed, and \`${path}\` is not on this row's \`skills.readPaths.user\` either — ` +
            `the table and the binary agree. The link at \`${subject.link?.target ?? ''}\` was ` +
            `staged, resolves to the package, and still reached nothing. ${consequenceOf(subject)} ` +
            `The listing carried: ${renderListing(observed)}.`,
      };
    }

    if (subject.id === 'injection-control') {
      return {
        ...base,
        status: found.length > 0 ? 'pass' : 'fail',
        detail:
          found.length > 0
            ? `Listed ${found.length}×: ${raw}. This package is reachable ONLY through ` +
              `\`--plugin-dir\`, so the injection route loaded, and the duplicate verdict beside ` +
              `it is decidable.`
            : `NOT listed, from a package staged with no link at all. The injection route loaded ` +
              `nothing, so the duplicate question cannot be answered this run — read the ` +
              `duplicate verdict as UNKNOWN whatever number it carries. The listing carried: ` +
              `${renderListing(observed)}.`,
      };
    }

    // `injection-duplicate` — the one §2.9 gates the design on.
    if (controlCount === 0 || linkRouteCount === 0) {
      const dead =
        controlCount === 0
          ? '`--plugin-dir` loaded no package at all'
          : 'the user-tier link route reached nothing (see `user-tier-listed`)';
      return {
        ...base,
        status: 'unknown',
        detail:
          `NOT ANSWERABLE this run. ${dead}, so only one of the two routes this question is ` +
          `about was working, and a count of ${found.length} here says nothing about whether two ` +
          `routes collapse into one. Matched: ${raw}.`,
      };
    }
    if (found.length === 0) {
      return {
        ...base,
        status: 'fail',
        detail:
          `NEITHER route produced an entry, though the control proves injection works and the ` +
          `link is the same shape the round's other link took. The listing carried: ` +
          `${renderListing(observed)}.`,
      };
    }
    return {
      ...base,
      status: found.length === 1 ? 'pass' : 'finding',
      detail:
        found.length === 1
          ? `ONE entry: ${raw}. The package is reachable BOTH through the user-tier link at ` +
            `\`${subject.link?.target ?? ''}\` and through \`--plugin-dir\`, and the control ` +
            `beside it proves the injection route loaded — so the two collapse to one. The design ` +
            `§2.9 records stands, and slice A3 does NOT need the \`sdkInjected\` fallback.`
          : `${found.length} entries: ${raw}. The same skill directory is listed more than once ` +
            `because it is reachable both ways, which is the outcome §2.9 names: slice A3 takes ` +
            `the \`sdkInjected\` fallback and skips the Claude Code user-tier link for every ` +
            `package \`refreshActivatedPlugins\` activates.`,
    };
  });
}

/** The question one user-tier subject puts to a binary, in a person's words. */
function userTierQuestion(harness: SmokeHarness, subject: UserTierSubject): string {
  const link = subject.link?.target ?? '';
  if (subject.documentedAs !== undefined) {
    return `Does ${harness.label} read \`${subject.documentedAs}\`, where the link at \`${link}\` sits?`;
  }
  switch (subject.id) {
    case 'user-tier-listed':
      return `Does ${harness.label} list a globally installed skill it can only reach through \`${link}\`?`;
    case 'injection-control':
      return `Does \`--plugin-dir\` load \`${subject.pkg}\` at all, with no link anywhere?`;
    default:
      return (
        `With \`${subject.pkg}\` reachable BOTH through \`${link}\` and through ` +
        `\`--plugin-dir\`, how many entries does ${harness.label} list?`
      );
  }
}

/** Everything a listing carried, for a verdict that has to show its working. */
function renderListing(observed: ListingObservation): string {
  const skills = observed.skills.length > 0 ? observed.skills.join(', ') : '(no skills)';
  const commands =
    observed.commands.length > 0 ? `; commands: ${observed.commands.join(', ')}` : '';
  return `${skills}${commands}`;
}

/**
 * Every oracle the user-tier scenario deliberately does not reach, in the
 * report's own words.
 *
 * Written out rather than left off, because a shorter list of verdicts reads as
 * a clean run — the failure `meta/harness-smoke/README.md` calls "a directory of
 * files that all look like results".
 *
 * @param harness - the harness being asked.
 * @returns one sentence per oracle this scenario cannot answer.
 */
export function userTierNotRun(harness: SmokeHarness): string[] {
  const lines = [
    'the two hook-activation oracles, the skill-activation oracle and the instructions sentinel ' +
      '— this scenario stages no hooks, no probe skill and no `AGENTS.md`, because what it asks ' +
      'is which directory in a home folder the harness OPENS, and a hook that fired would say ' +
      'nothing about that',
    'whether the harness INJECTED a user-tier skill into a model’s context rather than merely ' +
      'enumerating it. That is the paid half, and it is the same half the project scenario ' +
      'leaves open: a listing is a harness saying what it found, never what it sent',
    'the calibration diff against `harnessCoverage()` — that walk reads a PROJECT tree, this ' +
      'scenario’s project is deliberately empty, and every subject sits outside every root the ' +
      'walk opens. A pass there would be an artifact of an empty tree, which reads as coverage',
  ];
  if (!harness.userTierRounds.includes('claude-user-root')) {
    lines.push(
      `the duplicate question (\`specs/harness-sync-global/02-specification.md\` §2.9) — it asks ` +
        `what happens when one package is reachable through a user-tier link AND through SDK ` +
        `injection, and ${harness.label} has no injection route for DorkOS to use: ` +
        `\`--plugin-dir\` is Claude Code's flag, and \`plugin-activation.ts\` builds the SDK's ` +
        `\`plugins\` array for Claude Code sessions only. Not an unknown; not applicable`
    );
  }
  return lines;
}
