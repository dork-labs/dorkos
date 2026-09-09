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
import type { SmokeHarness } from './harnesses.js';
import type { CalibrationFinding, Verdict } from './oracles.js';

/** Everything the run knows when it writes a report. */
export interface ReportInput {
  /** The harness that was asked. */
  harness: SmokeHarness;
  /** When the run started, ISO-8601. */
  startedAt: string;
  /** The ceiling the run was given. */
  maxUsd: number;
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
 * `<YYYYMMDD-HHMMSS>-<harness>.md`, which sorts chronologically in a directory
 * listing and still says which binary it was about — the chat self-test reports
 * next door use the same timestamp format with no suffix, because they only ever
 * had one subject.
 *
 * @param startedAt - the run's start, ISO-8601.
 * @param harnessId - the harness word.
 * @returns the bare file name.
 */
export function reportFileName(startedAt: string, harnessId: string): string {
  const stamp = startedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${harnessId}.md`;
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
  const lines = [
    `# Harness Smoke — ${harness.label} — ${humanTime(input.startedAt)}`,
    '',
    '## Run',
    '',
    `- **Harness:** ${harness.label} (\`${harness.binary}\`, engine id \`${harness.harnessId}\`)`,
    `- **Status:** ${counts.fail > 0 ? 'FAILED' : 'PASSED'}`,
    `- **Started:** ${input.startedAt}`,
    `- **Instrument:** \`${harness.keyVar}\` (read from the environment; no stored sign-in was read)`,
    `- **Ceiling:** ${input.maxUsd} USD${
      harness.enforcesCeiling ? ' — enforced by the binary itself' : ' — see the ceiling verdict'
    }`,
    `- **Cost:** ${
      input.costUsd === undefined
        ? `not reported by ${harness.label}`
        : `${input.costUsd.toFixed(4)} USD`
    }`,
    `- **Listing oracle:** ${listingLine(harness)}`,
    `- **Verdicts:** ${counts.pass} pass, ${counts.fail} fail, ${counts.finding} finding, ${counts.unknown} unknown`,
    '',
  ];

  if (input.turnCommand !== undefined) {
    lines.push('## The turn', '', '```', input.turnCommand, '```', '');
  }

  lines.push('## Verdicts', '');
  for (const verdict of input.verdicts) {
    const rows = verdict.capabilities.length > 0 ? ` — ${verdict.capabilities.join(', ')}` : '';
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

/** How many verdicts landed in each status. */
function tally(verdicts: readonly Verdict[]): Record<Verdict['status'], number> {
  const counts: Record<Verdict['status'], number> = { pass: 0, fail: 0, unknown: 0, finding: 0 };
  for (const verdict of verdicts) counts[verdict.status] += 1;
  return counts;
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
