/**
 * `dorkos community deploy --forget <run-id>`: wires {@link runForgetLaunch} to the run's journal
 * and the exact reads, and says plainly what it found.
 *
 * @module commands/community-deploy/provenance/forget-command
 */
import type { Writable } from 'node:stream';
import { deleteLaunchJournal, readLaunchJournal } from '../journal.js';
import type { CommunityServiceOptions } from '../runtime/default-services.js';
import { createDefaultLaunchResourceChecks } from '../runtime/default-removal.js';
import {
  runForgetLaunch,
  type ForgetOutcome,
  type LaunchResourceChecks,
  type RemainingResource,
} from './forget-launch.js';
import { formatRunResources, shown, whenClearable } from './removal-output.js';

/** Everything `--forget` needs from the dispatcher. */
export interface ForgetCommandInput {
  runId: string;
  journalPath: string;
  serviceOptions: CommunityServiceOptions;
  output: Writable;
  /** Test seam: the exact reads. */
  checks?: LaunchResourceChecks;
  /** Test seam: the clock. */
  now?(): string;
}

const SERVICE = { fly: 'Fly app', neon: 'Neon project', tigris: 'Tigris bucket' } as const;

function remainingLines(remaining: readonly RemainingResource[], runId: string): string[] {
  const unreadable = remaining.filter((resource) => resource.status === 'unreadable');
  return [
    ...formatRunResources(remaining, runId).slice(0, -1),
    ...(unreadable.length > 0
      ? [
          `DorkOS could not check ${unreadable.map((resource) => `${SERVICE[resource.provider]} ${shown(resource.name)}`).join(', ')}. It is safe to run this again.`,
        ]
      : []),
    `Once they are gone, run this again: dorkos community deploy --forget ${runId}`,
  ];
}

/**
 * Plain text and exit code for one `--forget` outcome.
 *
 * @param outcome - What {@link runForgetLaunch} did.
 * @param runId - The run it acted on.
 */
export function formatForgetOutcome(
  outcome: ForgetOutcome,
  runId: string
): { text: string; exitCode: number } {
  const done = (lines: string[], exitCode = 0) => ({ text: `${lines.join('\n')}\n`, exitCode });
  const removeUncertain = `dorkos community deploy --remove-uncertain ${runId}`;
  switch (outcome.outcome) {
    case 'complete':
      return done([
        'This launch finished, so it is not in --list-incomplete. Nothing was changed.',
      ]);
    case 'removal-pending':
      return done(
        [`A removal is in progress for this run. Finish it first: ${removeUncertain}`],
        1
      );
    case 'too-old':
      return done(
        [
          'This run is too old to check: it did not save where its resources live. Nothing was changed.',
        ],
        1
      );
    case 'pending-create':
      return done(
        [
          outcome.status === 'present'
            ? `This run may have made a ${SERVICE[outcome.provider]} it never recorded. Nothing was changed.`
            : `DorkOS could not check whether this run made a ${SERVICE[outcome.provider]}. Nothing was changed.`,
          `Check it first: ${removeUncertain}`,
        ],
        1
      );
    case 'pending-create-unprovable':
      return done(
        [
          `This run stopped while creating a ${SERVICE[outcome.provider]}, before DorkOS recorded when. DorkOS cannot show it never landed, so nothing was changed.`,
          `Check it first: ${removeUncertain}`,
        ],
        1
      );
    case 'wait':
      return done(
        [
          `This run stopped while creating a ${SERVICE[outcome.provider]} only recently, and it could still appear. Nothing was changed.`,
          `Run dorkos community deploy --forget ${runId} again ${whenClearable(outcome.clearableAfter, outcome.clearableInMs)}.`,
        ],
        1
      );
    case 'still-there':
      return done(
        [
          'DorkOS kept this run, because some of what it made is still there.',
          ...remainingLines(outcome.remaining, runId),
        ],
        1
      );
    case 'changed':
      return done(
        [
          'This run changed while DorkOS was checking it, so nothing was changed. Run the command again.',
        ],
        1
      );
    case 'forgotten':
      return done([
        outcome.checked.length > 0
          ? `Checked that everything this run made is gone: ${outcome.checked.map((resource) => `${SERVICE[resource.provider]} ${shown(resource.name)}`).join(', ')}.`
          : 'This run made nothing.',
        'DorkOS removed its saved record, so it no longer shows in --list-incomplete.',
      ]);
  }
}

/**
 * Run `--forget` and return its exit code.
 *
 * @param input - Run id, journal path, service options and output stream.
 */
export async function runForgetCommand(input: ForgetCommandInput): Promise<number> {
  const outcome = await runForgetLaunch({
    readJournal: () => readLaunchJournal(input.journalPath),
    discard: (expectedRevision) => deleteLaunchJournal(input.journalPath, expectedRevision),
    checks: input.checks ?? createDefaultLaunchResourceChecks(input.serviceOptions),
    now: input.now ?? (() => new Date().toISOString()),
  });
  const result = formatForgetOutcome(outcome, input.runId);
  input.output.write(result.text);
  return result.exitCode;
}
