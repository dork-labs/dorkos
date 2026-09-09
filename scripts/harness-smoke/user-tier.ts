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
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_VENDOR_FACTS } from '../../packages/harness/dist/vendor-facts/index.js';
import type { UserTierSubject } from './fixture.js';
import type { ListingObservation, SmokeHarness } from './harnesses.js';
import type { ListingAbsence, Verdict } from './oracles.js';

/**
 * The directory five agent tools share, spelled the way the vendor-facts table
 * spells it.
 *
 * The verdict for the `agents-user-root` round is decided against that table
 * rather than against a constant in this file, which is what makes it a
 * calibration and not an assertion: if a re-vendor adds or removes the path on a
 * row, the verdict's EXPECTATION moves with the documentation and a binary that
 * disagrees is reported as the disagreement it is.
 */
const AGENTS_USER_READ_PATH = '~/.agents/skills';

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
 * @returns one verdict per subject, in staging order.
 */
export function userTierVerdicts(
  harness: SmokeHarness,
  subjects: readonly UserTierSubject[],
  observed: ListingObservation | undefined,
  absence: ListingAbsence = 'no-surface'
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

  return subjects.map((subject): Verdict => {
    const found = matches.get(subject.id) ?? [];
    const raw = renderMatches(found);
    const base = {
      id: subject.id,
      capabilities: subject.capabilities,
      ...(subject.cites === undefined ? {} : { cites: subject.cites }),
      question: userTierQuestion(harness, subject),
    };

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

    if (subject.id === 'agents-user-root') {
      const documented =
        HARNESS_VENDOR_FACTS[harness.harnessId].skills.readPaths.user.includes(
          AGENTS_USER_READ_PATH
        );
      const listed = found.length > 0;
      if (documented) {
        return {
          ...base,
          status: listed ? 'pass' : 'fail',
          detail: listed
            ? `Listed ${found.length}×: ${raw}. \`${AGENTS_USER_READ_PATH}\` is on this row's ` +
              `\`skills.readPaths.user\` in \`packages/harness/src/vendor-facts/index.ts\`, and the ` +
              `binary agrees — measured from a sandbox HOME, not the operator's, so nothing but ` +
              `the staged link could have produced it.`
            : `NOT listed, though \`${AGENTS_USER_READ_PATH}\` is on this row's ` +
              `\`skills.readPaths.user\`. The listing carried: ${renderListing(observed)}. That is ` +
              `the compiled vendor facts contradicted by the binary they describe, and it would ` +
              `remove this tool from the five slice A3 plans the shared link for.`,
        };
      }
      return {
        ...base,
        status: listed ? 'finding' : 'pass',
        detail: listed
          ? `Listed ${found.length}×: ${raw} — and \`${AGENTS_USER_READ_PATH}\` is NOT on this ` +
            `row's \`skills.readPaths.user\`. Two consequences, both stated by the ticket: slice ` +
            `A3 drops the \`<claudeRoot>/skills\` link as redundant and gets smaller, and the ` +
            `facts table gains a read path it does not carry.`
          : `NOT listed, and \`${AGENTS_USER_READ_PATH}\` is not on this row's ` +
            `\`skills.readPaths.user\` either — the table and the binary agree. The link at ` +
            `\`${subject.link?.target ?? ''}\` was staged and reached nothing, so the second ` +
            `directory decision 3 asks for is earned: slice A3's \`<claudeRoot>/skills\` link is ` +
            `NOT redundant. The listing carried: ${renderListing(observed)}.`,
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
  switch (subject.id) {
    case 'user-tier-listed':
      return `Does ${harness.label} list a globally installed skill it can only reach through \`${link}\`?`;
    case 'agents-user-root':
      return `Does ${harness.label} read \`${AGENTS_USER_READ_PATH}\`, where the link at \`${link}\` sits?`;
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
