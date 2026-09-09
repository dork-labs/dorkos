/**
 * The report a smoke run leaves behind.
 *
 * Written in the shape `/chat:self-test` reports use (`test-results/chat-self-test/*.md`):
 * a dated title, a run block, then one section per phase, then a verdict. The
 * shape is copied on purpose — `meta/chat-capabilities.md`'s `S` cells cite those
 * reports the way `meta/harness-sync-capabilities.md`'s `H` cells will cite these,
 * and a reader who knows one should not have to learn the other.
 *
 * Two rules the renderers keep:
 *
 * 1. **Every verdict cites its capability ids.** A report that says "listing
 *    failed" sends the next person back to a plan document to work out which row
 *    just became false.
 * 2. **No markdown tables.** `test-results/` is not in `.prettierignore`, so a
 *    generated report goes through the same `prettier --check` gate as source,
 *    and Prettier realigns table columns — which would red the formatting gate
 *    for anyone who ran the smoke locally. Lists survive that gate unchanged.
 *
 * @module harness-smoke/report
 */
import type { UserTierRound } from './fixture.js';
import type { ListingObservation, SmokeHarness } from './harnesses.js';
import type { CalibrationFinding } from './calibration.js';
import type { Verdict } from './oracles.js';

/** Everything the run knows when it writes a report. */
export interface ReportInput {
  /** The harness that was asked. */
  harness: SmokeHarness;
  /** When the run started, ISO-8601. */
  startedAt: string;
  /** The ceiling the run was given. */
  maxUsd: number;
  /** Whether this was a `--free` run — no model, no spend, fewer oracles. */
  free: boolean;
  /** The model id the run pinned. */
  pinnedModel: string;
  /** The model the harness said it used, where it says. */
  reportedModel?: string;
  /** Oracles this run deliberately did not reach, in words. */
  notRun: string[];
  /** The verdicts, in oracle order. */
  verdicts: Verdict[];
  /** Every calibration disagreement, for the section that names them. */
  calibration: CalibrationFinding[];
  /** The engine's applied actions, so the report says what tree was asked about. */
  applied: string[];
  /** What the turn cost, when the harness said. */
  costUsd?: number;
  /** The command line the turn actually ran, for reproduction. */
  turnCommand?: string;
}

/** The symbol a status renders as, chosen so a skim reads the failures first. */
const MARK: Record<Verdict['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  unknown: 'UNKNOWN',
  finding: 'FINDING',
};

/**
 * The file name a report is written under.
 *
 * `<YYYYMMDD-HHMMSS.mmm>-<harness>.md`, which sorts chronologically in a
 * directory listing and still says which binary it was about. The chat
 * self-test reports next door stop at seconds; these do not, because two runs of
 * the SAME harness a second apart — a free one and then a paid one, which is the
 * documented workflow — would otherwise write to one path and the first would
 * vanish.
 *
 * @param startedAt - the run's start, ISO-8601.
 * @param harnessId - the harness word.
 * @returns the bare file name.
 */
export function reportFileName(startedAt: string, harnessId: string, scenario = 'project'): string {
  const stamp = startedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 19);
  // The default scenario adds nothing, so every name a run wrote before there
  // was more than one scenario is still the name it writes today. A second
  // scenario of the same harness is a second question with a second answer, and
  // two answers may not overwrite each other.
  const suffix = scenario === 'project' ? '' : `-${scenario}`;
  return `${stamp}-${harnessId}${suffix}.md`;
}

/**
 * The report a run that never started writes.
 *
 * A skip is not a failure and the report says so in its first line, because the
 * alternative — a directory of files that all look like results — is how a gap in
 * coverage gets mistaken for coverage.
 *
 * @param harness - the harness that was asked for.
 * @param startedAt - the run's start, ISO-8601.
 * @param reason - the gate's machine-readable reason.
 * @param message - the gate's message, which already names every variable.
 * @returns the whole markdown file.
 */
export function renderSkipReport(
  harness: SmokeHarness,
  startedAt: string,
  reason: string,
  message: string
): string {
  return [
    `# Harness Smoke — ${harness.label} — ${humanTime(startedAt)}`,
    '',
    '## Run',
    '',
    `- **Harness:** ${harness.label} (\`${harness.binary}\`, engine id \`${harness.harnessId}\`)`,
    `- **Status:** SKIPPED (\`${reason}\`)`,
    `- **Started:** ${startedAt}`,
    '- **Spent:** nothing. No model was reached and no stored sign-in was read.',
    '',
    '## Why it skipped',
    '',
    ...message.split('\n').map((line) => `> ${line}`),
    '',
    '## What this proves, and what it does not',
    '',
    '- It proves the gate refuses on its own, which is the property the money rule is about.',
    '- It proves NOTHING about SK-08, SK-09, SK-12, CM-05 or HK-01. Those rows stay unverified',
    '  until a run with an instrument writes a report beside this one.',
    '',
    '## How to run it for real',
    '',
    '```bash',
    `${armLine(harness)} \\`,
    `  bash scripts/harness-smoke/run.sh ${harness.id} --max-usd 0.50`,
    '```',
    '',
    ...(harness.free.kind === 'none'
      ? []
      : [
          '## Or run the free half now',
          '',
          `\`bash scripts/harness-smoke/run.sh ${harness.id} --free\` needs no flag and no key: ` +
            `${harness.free.note}`,
          '',
        ]),
  ].join('\n');
}

/**
 * The report a run that actually asked a binary writes.
 *
 * @param input - everything the run learned.
 * @returns the whole markdown file.
 */
export function renderRunReport(input: ReportInput): string {
  const { harness } = input;
  const counts = tally(input.verdicts);
  const status = input.free ? 'FREE' : counts.fail > 0 ? 'FAILED' : 'PASSED';
  const lines = [
    `# Harness Smoke — ${harness.label} — ${humanTime(input.startedAt)}`,
    '',
    '## Run',
    '',
    `- **Harness:** ${harness.label} (\`${harness.binary}\`, engine id \`${harness.harnessId}\`)`,
    `- **Status:** ${status}${
      input.free
        ? counts.fail > 0
          ? ' — and one or more of the oracles it DID run failed'
          : ' — no model was reached, so this is a partial answer by design'
        : ''
    }`,
    `- **Started:** ${input.startedAt}`,
    `- **Instrument:** ${
      input.free
        ? 'none — `--free` reaches no model, so nothing was armed and nothing was billed'
        : `\`${harness.keyVar}\` (read from the environment; no stored sign-in was read)`
    }`,
    `- **Isolation:** \`HOME\` and the harness's own config home both point at an empty sandbox, ` +
      'so no stored sign-in and no user-scope skill can reach this answer',
    `- **Model pinned:** \`${input.pinnedModel}\` — ${harness.model.why}`,
    ...(input.reportedModel === undefined
      ? []
      : [`- **Model the harness reported:** \`${input.reportedModel}\``]),
    `- **Ceiling:** ${
      input.free
        ? `${input.maxUsd} USD, inert — the flag is on the command line below because the argv is ` +
          'the same one a paid run uses, and no API request is made for it to bound'
        : `${input.maxUsd} USD${
            harness.enforcesCeiling
              ? ' — enforced by the binary itself'
              : ' — see the ceiling verdict'
          }`
    }`,
    `- **Cost:** ${
      input.free
        ? 'nothing. No API request was made.'
        : input.costUsd === undefined
          ? `not reported by ${harness.label}`
          : `${input.costUsd.toFixed(4)} USD`
    }`,
    `- **Listing oracle:** ${listingLine(harness)}`,
    `- **Skill-injection proof:** ${denialLine(harness)}`,
    `- **Verdicts:** ${counts.pass} pass, ${counts.fail} fail, ${counts.finding} finding, ${counts.unknown} unknown`,
    '',
  ];

  if (input.notRun.length > 0) {
    lines.push('## What this run did NOT answer', '');
    for (const item of input.notRun) lines.push(`- ${item}`);
    lines.push(
      '',
      'Reported rather than omitted: a shorter list of verdicts reads as a clean run.',
      ''
    );
  }

  if (input.turnCommand !== undefined) {
    lines.push('## The turn', '', '```', input.turnCommand, '```', '');
  }

  lines.push('## Verdicts', '');
  for (const verdict of input.verdicts) {
    const rows =
      verdict.capabilities.length > 0
        ? ` — ${verdict.capabilities.join(', ')}`
        : verdict.cites === undefined
          ? ''
          : ` — ${verdict.cites}`;
    lines.push(`- **${MARK[verdict.status]}** \`${verdict.id}\`${rows}`);
    lines.push(`  - ${verdict.question}`);
    lines.push(`  - ${verdict.detail}`);
  }
  lines.push('');

  lines.push('## Calibration against `harnessCoverage()`', '');
  if (input.calibration.length === 0) {
    lines.push(
      'No disagreement between the compiled vendor facts and the binary on this tree.',
      ''
    );
  } else {
    for (const finding of input.calibration) {
      lines.push(
        finding.side === 'coverage-only'
          ? `- The coverage walk discovered \`${finding.key}\` (\`${finding.where}\`) and ${harness.label} did not list it.`
          : `- ${harness.label} listed \`${finding.key}\` (\`${finding.where}\`) and the coverage walk did not discover it.`
      );
    }
    lines.push(
      '',
      'Each line is a cell of `packages/harness/src/vendor-facts/` that the binary disagrees with.',
      'Fix the facts table, not the report.',
      ''
    );
  }

  lines.push('## The tree that was asked about', '');
  for (const action of input.applied) lines.push(`- \`${action}\``);
  lines.push('');

  return lines.join('\n');
}

/** One round of the user-tier scenario, as the report needs it. */
export interface UserTierRoundReport {
  /** Which question this round staged. */
  round: UserTierRound;
  /** The user-tier directories it wrote into. */
  roots: string[];
  /** The packages it injected on the command line. */
  injectDirs: string[];
  /** Every link and injection it staged, in words. */
  staged: string[];
  /** What the harness listed, when it listed anything. */
  listing?: ListingObservation;
  /** The command line the probe ran, for reproduction. */
  command?: string;
  /** What the round's turn cost, when the harness said. */
  costUsd?: number;
  /** The verdicts this round produced. */
  verdicts: Verdict[];
  /** Lines the runner printed after the report path. */
  notes: string[];
}

/** Everything the user-tier run knows when it writes its report. */
export interface UserTierReportInput {
  /** The harness that was asked. */
  harness: SmokeHarness;
  /** When the run started, ISO-8601. */
  startedAt: string;
  /** Whether this was a `--free` run. */
  free: boolean;
  /** The model id the run pinned. */
  pinnedModel: string;
  /** Every round, in the order they ran. */
  rounds: UserTierRoundReport[];
  /** The money-rule verdict, which is a property of the run rather than of a round. */
  credential: Verdict;
  /** Oracles this scenario deliberately does not reach, in words. */
  notRun: string[];
}

/** What each round is asking, on the report's own front page. */
const ROUND_QUESTION: Record<UserTierRound, string> = {
  'claude-user-root':
    'a globally installed package linked into the harness’s OWN user skills folder, and a second ' +
    'one reachable both that way and through SDK injection, with a third injected and never ' +
    'linked as the control',
  'agents-user-root':
    'a globally installed package linked into `~/.agents/skills`, the one directory Codex, ' +
    'OpenCode, Cursor, Gemini CLI and Copilot all read, and nothing anywhere else',
  'codex-home-root':
    'a globally installed package linked into `$CODEX_HOME/skills` — a writable directory the ' +
    'compiled vendor facts do not list, noticed because the first free run printed five of ' +
    'Codex’s own bundled skills out of it',
};

/**
 * The report a user-tier run writes.
 *
 * A different question from the project scenario's, so a different report rather
 * than a widened one: this one has to say, per round, which directories it wrote
 * into, what it linked and injected, and — the whole deliverable — the RAW
 * entries the binary printed. A verdict that said "listed 1×" without them would
 * be this runner asking to be believed, which is the thing the H tier exists not
 * to do.
 *
 * @param input - everything the run learned.
 * @returns the whole markdown file.
 */
export function renderUserTierReport(input: UserTierReportInput): string {
  const { harness } = input;
  const all = [...input.rounds.flatMap((round) => round.verdicts), input.credential];
  const counts = tally(all);
  const lines = [
    `# Harness Smoke — user tier — ${harness.label} — ${humanTime(input.startedAt)}`,
    '',
    '## Run',
    '',
    `- **Harness:** ${harness.label} (\`${harness.binary}\`, engine id \`${harness.harnessId}\`)`,
    `- **Scenario:** \`user-tier\` — an EMPTY project, and a globally installed package reachable ` +
      'only through a link in the run’s own home directory. The project scenario’s report is the ' +
      'other file beside this one.',
    `- **Status:** ${input.free ? 'FREE' : counts.fail > 0 ? 'FAILED' : 'PASSED'}${
      input.free
        ? counts.fail > 0
          ? ' — and one or more of the oracles it DID run failed'
          : ' — no model was reached, so this is a partial answer by design'
        : ''
    }`,
    `- **Started:** ${input.startedAt}`,
    `- **Instrument:** ${
      input.free
        ? 'none — `--free` reaches no model, so nothing was armed and nothing was billed'
        : `\`${harness.keyVar}\` (read from the environment; no stored sign-in was read)`
    }`,
    `- **Isolation:** \`HOME\` and the harness’s own config home both point at ONE empty sandbox per ` +
      `round, which is why ${rootsLine(input)} below ${
        countRoots(input) === 1 ? 'is' : 'are'
      } inside it. Nothing on the operator’s machine can reach this answer, and nothing this run ` +
      `wrote can reach their home folder.`,
    `- **Model pinned:** \`${input.pinnedModel}\``,
    `- **Cost:** ${costLine(input)}`,
    `- **Listing oracle:** ${listingLine(harness)}`,
    `- **Rounds:** ${input.rounds.map((round) => `\`${round.round}\``).join(', ') || '(none)'}`,
    `- **Verdicts:** ${counts.pass} pass, ${counts.fail} fail, ${counts.finding} finding, ${counts.unknown} unknown`,
    '',
    '## What this run did NOT answer',
    '',
    ...input.notRun.map((item) => `- ${item}`),
    '',
    'Reported rather than omitted: a shorter list of verdicts reads as a clean run.',
    '',
  ];

  for (const round of input.rounds) {
    lines.push(`## Round \`${round.round}\``, '', `Staged: ${ROUND_QUESTION[round.round]}.`, '');
    lines.push('### The roots it wrote', '');
    if (round.roots.length === 0) lines.push('- (none — this round staged no link)');
    for (const root of round.roots) lines.push(`- \`${root}\``);
    lines.push('');
    lines.push('### What it staged', '');
    for (const action of round.staged) lines.push(`- \`${action}\``);
    lines.push('');
    if (round.command !== undefined) {
      lines.push('### The probe', '', '```', round.command, '```', '');
    }
    lines.push('### The raw listing', '');
    if (!round.listing) {
      lines.push(`${harness.label} enumerated nothing. ${harness.listing.note}`, '');
    } else {
      lines.push(
        `- **skills** (${round.listing.skills.length})${round.listing.skills.length === 0 ? ': none' : ':'}`
      );
      for (const [index, name] of round.listing.skills.entries()) {
        const path = round.listing.skillPaths[index];
        lines.push(`  - \`${name}\`${path === undefined ? '' : ` — \`${path}\``}`);
      }
      if (round.listing.commands.length > 0) {
        lines.push(`- **commands** (${round.listing.commands.length}):`);
        for (const name of round.listing.commands) lines.push(`  - \`${name}\``);
      }
      lines.push('');
    }
    lines.push('### Verdicts', '');
    for (const verdict of round.verdicts) lines.push(...verdictLines(verdict));
    lines.push('');
  }

  lines.push('## Run-level verdict', '', ...verdictLines(input.credential), '');
  return lines.join('\n');
}

/** How many distinct user directories this run wrote into, across every round. */
function countRoots(input: UserTierReportInput): number {
  return new Set(input.rounds.flatMap((round) => round.roots)).size;
}

/**
 * How the header names the directories this run wrote into.
 *
 * Derived rather than written, because the count is per HARNESS: Claude Code
 * gets two rounds and two directories, Codex gets two rounds and — since
 * `$CODEX_HOME/skills` and `~/.agents/skills` are two — also two, and a harness
 * with one round writes one. The bullet used to say "the two user directories"
 * unconditionally, which was already false for the Codex report it was printed
 * in.
 */
function rootsLine(input: UserTierReportInput): string {
  const count = countRoots(input);
  if (count === 0) return 'nothing outside it was written, and every root named';
  return count === 1 ? 'the one user directory' : `the ${count} user directories`;
}

/**
 * What the run cost, said plainly rather than deferred to a section that may
 * carry no number.
 *
 * A `--free` user-tier run spends nothing on any harness. A paid one runs one
 * turn per ROUND, so the honest figure is the sum and the count of turns it
 * covers, never a single number that looks like one turn's price.
 */
function costLine(input: UserTierReportInput): string {
  if (input.free) return 'nothing. No API request was made.';
  const reported = input.rounds.filter((round) => round.costUsd !== undefined);
  if (reported.length === 0) return `not reported by ${input.harness.label}`;
  const spent = reported.reduce((total, round) => total + (round.costUsd ?? 0), 0);
  return `${spent.toFixed(4)} USD across ${input.rounds.length} round(s), one turn each`;
}

/** One verdict, in the three-line shape both reports use. */
function verdictLines(verdict: Verdict): string[] {
  const rows =
    verdict.capabilities.length > 0
      ? ` — ${verdict.capabilities.join(', ')}`
      : verdict.cites === undefined
        ? ''
        : ` — ${verdict.cites}`;
  return [
    `- **${MARK[verdict.status]}** \`${verdict.id}\`${rows}`,
    `  - ${verdict.question}`,
    `  - ${verdict.detail}`,
  ];
}

/** How many verdicts landed in each status. */
function tally(verdicts: readonly Verdict[]): Record<Verdict['status'], number> {
  const counts: Record<Verdict['status'], number> = { pass: 0, fail: 0, unknown: 0, finding: 0 };
  for (const verdict of verdicts) counts[verdict.status] += 1;
  return counts;
}

/**
 * One sentence on how far the skill-activation oracle's claim goes here.
 *
 * On the front page, because it is the difference between "this harness loaded
 * the skill" and "the model got to the instruction somehow" — and the second is
 * not evidence for SK-08 or SK-09.
 */
function denialLine(harness: SmokeHarness): string {
  return harness.deniesFileReads.kind === 'partial'
    ? `file reads PARTIALLY denied (${harness.deniesFileReads.flags}) — best effort, not proof`
    : 'file reads NOT denied — the skill verdict corroborates, it does not prove';
}

/** One sentence naming this harness's listing surface and what it costs. */
function listingLine(harness: SmokeHarness): string {
  if (harness.listing.kind === 'non-model') {
    return `\`${harness.listing.command}\` — non-model, so it costs nothing`;
  }
  if (harness.listing.kind === 'in-turn') return 'the model turn’s own startup message';
  return 'none known yet — the activation oracle is primary';
}

/** The exact environment prefix that arms a run for this harness. */
export function armLine(harness: SmokeHarness): string {
  return `DORKOS_HARNESS_SMOKE=1 ${harness.keyVar}=<key>`;
}

/** `2026-09-09 01:23` from an ISO timestamp, matching the chat self-test titles. */
function humanTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
