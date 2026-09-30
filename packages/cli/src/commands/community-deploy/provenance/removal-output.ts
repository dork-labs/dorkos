/**
 * What `--remove-uncertain` prints: the confirmation screen and one plain result per outcome.
 *
 * Every value shown comes from a schema-validated read or the journal, and is checked again here
 * before it reaches the terminal.
 *
 * @module commands/community-deploy/provenance/removal-output
 */
import { ExternalLabelSchema } from '../provider-contract.js';
import type { LaunchJournal } from '../journal.js';
import type {
  CandidateSummary,
  ProvedResource,
  RemovalOutcome,
  RemovalProvider,
  RemovalTarget,
  UnprovedReason,
} from './uncertain-removal.js';

/** Journal-derived text the dispatcher already knows how to build. */
export interface RemovalOutputContext {
  runId: string;
  journal: LaunchJournal;
  /** The exact `--resume` command, or `null` for a journal without saved choices. */
  resumeCommand: string | null;
  /** The existing recovery report for the journal. */
  recovery: string;
}

const SERVICE: Record<RemovalProvider, string> = {
  fly: 'Fly app',
  neon: 'Neon project',
  tigris: 'Tigris bucket',
};

const TOKEN_NAME: Record<RemovalProvider, string> = {
  fly: 'internal id',
  neon: 'project id',
  tigris: 'add-on id',
};

const OWNER: Record<RemovalProvider, string> = {
  fly: 'Fly organization',
  neon: 'Neon organization',
  tigris: 'Fly organization',
};

/** Show a read value only when it is a plain printable label. */
function shown(value: string | undefined | null): string {
  return value !== undefined && value !== null && ExternalLabelSchema.safeParse(value).success
    ? value
    : '(unreadable)';
}

function shortMarker(value: string): string {
  const safe = shown(value);
  // `dorkos-` or `community_` plus 32 hex characters; the ends are enough to compare by eye.
  const match = /^(dorkos-|community_)([a-f0-9]{4})[a-f0-9]{24}([a-f0-9]{4})$/u.exec(safe);
  return match ? `${match[1]}${match[2]}…${match[3]}` : safe;
}

function formatCreated(createdAt: string | undefined, requestedAt: string | undefined): string {
  const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  if (!Number.isFinite(created)) return 'unknown';
  const stamp = `${new Date(created).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  const requested = requestedAt === undefined ? Number.NaN : Date.parse(requestedAt);
  if (!Number.isFinite(requested)) return stamp;
  const seconds = Math.round((created - requested) / 1000);
  const count = Math.abs(seconds);
  const unit = count === 1 ? 'second' : 'seconds';
  return seconds >= 0
    ? `${stamp}, ${count} ${unit} after the run asked for it`
    : `${stamp}, ${count} ${unit} before the run asked for it (the clocks differ slightly)`;
}

function proofLine(target: ProvedResource): string {
  if (target.provider === 'fly') {
    return `its private network is ${shortMarker(target.proofValue)}, the name this run recorded before creating it`;
  }
  if (target.provider === 'neon') {
    return `its database role is ${shortMarker(target.proofValue)}, the name this run recorded before creating it`;
  }
  return `it is attached to Fly app ${shown(target.appName)}, which this run made: that app's private network is ${shortMarker(target.proofValue)}`;
}

function removalEffect(target: ProvedResource): string {
  if (target.provider === 'fly') return 'Removing it deletes this app.';
  if (target.provider === 'neon') return 'Removing it deletes this project and its database.';
  return `Removing it deletes this bucket and every file in it, and removes its two access keys from app ${shown(target.appName)}.`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(14)}${value}`;
}

/**
 * The confirmation screen for a proved resource.
 *
 * @param target - The proved resource.
 * @param notFromRun - Same-name resources that were found and are not this run's.
 * @param context - The run's journal and id.
 */
export function formatRemovalOffer(
  target: ProvedResource,
  notFromRun: readonly CandidateSummary[],
  context: RemovalOutputContext
): string {
  const requestedAt = context.journal.pendingIntent?.requestedAt;
  const lines = [
    `Run ${context.runId.slice(0, 8)} stopped while creating a ${SERVICE[target.provider]}. DorkOS can prove that run made it:`,
    '',
    row(
      SERVICE[target.provider],
      `${shown(target.resourceName)}  (${TOKEN_NAME[target.provider]} ${shown(target.token)})`
    ),
    row('Owner', `${OWNER[target.provider]} ${shown(target.organization)}`),
    row('Created', formatCreated(target.createdAt, requestedAt)),
    row('Proof', proofLine(target)),
    row('Contents', target.contents),
  ];
  if (notFromRun.length > 0) {
    lines.push('', 'Also found with the same name, and not from this run (kept):');
    for (const candidate of notFromRun)
      lines.push(`  ${candidateLine(target.provider, candidate)}`);
  }
  lines.push('', `${removalEffect(target)} Nothing else from this run is touched.`);
  return `${lines.join('\n')}\n`;
}

/** The interactive question after {@link formatRemovalOffer}. */
export function removalPrompt(provider: RemovalProvider): string {
  return `Type the ${TOKEN_NAME[provider]} to remove it, or press Enter to keep it: `;
}

/** Plain sentence for each reason a resource was not removed. */
export function unprovedReasonText(reason: UnprovedReason, provider: RemovalProvider): string {
  switch (reason) {
    case 'too-old':
      return 'this run is too old to check';
    case 'no-marker':
      return 'this run started before DorkOS recorded proof';
    case 'different-marker':
      return 'it does not carry the marker this run recorded before creating it';
    case 'other-organization':
      return 'it belongs to a different organization';
    case 'other-region':
      return 'it is in a different region from this run’s plan';
    case 'outside-window':
      return 'it was not created in the minutes when this run asked for it, or its creation time could not be read';
    case 'several':
      return 'more than one resource matches this run’s proof';
    case 'no-match':
      return 'none of the resources with this name carry this run’s proof';
    case 'incomplete-list':
      return 'Fly returned only part of the app’s storage list';
    case 'bound-app-unproved':
      return 'the Fly app it is attached to can no longer be shown to be this run’s';
    case 'not-confirmed':
      return `DorkOS has not yet confirmed this proof with ${provider === 'neon' ? 'Neon' : 'Fly'}`;
    case 'grown':
      return 'something was added after the run stopped';
    case 'not-the-same':
      return 'it is not the resource you confirmed before';
  }
}

function candidateLine(provider: RemovalProvider, candidate: CandidateSummary): string {
  return `${SERVICE[provider]} ${shown(candidate.name)} (${TOKEN_NAME[provider]} ${shown(candidate.token)}), ${OWNER[provider]} ${shown(candidate.organization)}, created ${formatCreated(candidate.createdAt, undefined)}: ${unprovedReasonText(candidate.reason, provider)}`;
}

function manualSteps(provider: RemovalProvider, journal: LaunchJournal): string[] {
  const intent = journal.pendingIntent;
  const context = journal.recoveryContext;
  const name = shown(intent?.resourceName);
  const organization = shown(intent?.organizationId);
  if (provider === 'fly') {
    return [
      'To check it and remove it yourself:',
      `  Inspect: fly apps list --org ${organization} --json`,
      `  Remove:  fly apps destroy ${name}`,
    ];
  }
  if (provider === 'neon') {
    return [
      'To check it and remove it yourself:',
      `  Inspect: neonctl projects list --org-id ${organization} --output json`,
      '  Remove:  neonctl projects delete <project id>',
    ];
  }
  const app = shown(context?.appName);
  return [
    'To check it and remove it yourself:',
    `  Inspect: fly storage list --org ${organization}`,
    `  Remove:  fly storage destroy ${name}`,
    `  Then remove its access keys: fly secrets unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY --app ${app} --stage`,
  ];
}

function removeCommand(runId: string, token?: string): string {
  return `dorkos community deploy --remove-uncertain ${runId}${token ? ` --confirm ${shown(token)}` : ''}`;
}

function continueWith(context: RemovalOutputContext): string {
  return context.resumeCommand
    ? `Continue with: ${context.resumeCommand}`
    : 'This run has no saved choices to resume with.';
}

function removedLine(target: RemovalTarget, nameReleased: boolean | null): string {
  const what = `${SERVICE[target.provider]} ${shown(target.resourceName)} (${TOKEN_NAME[target.provider]} ${shown(target.token)})`;
  if (target.provider === 'tigris') {
    return `Removed ${what} and its two access keys on app ${shown(target.appName)}.`;
  }
  if (target.provider === 'neon') return `Removed ${what}.`;
  if (nameReleased === true) return `Removed ${what}. Fly has released the name.`;
  if (nameReleased === false) {
    return `Removed ${what}. Fly has not released the name yet, so wait a few minutes before you continue.`;
  }
  return `Removed ${what}. If Fly still holds the name when you continue, wait a few minutes and try again.`;
}

/**
 * The result of one `--remove-uncertain` run and the exit code it maps to.
 *
 * @param outcome - What the removal did.
 * @param context - The run's journal and the commands built from it.
 */
export function formatRemovalOutcome(
  outcome: RemovalOutcome,
  context: RemovalOutputContext
): { text: string; exitCode: number } {
  const done = (lines: string[], exitCode = 0) => ({ text: `${lines.join('\n')}\n`, exitCode });
  switch (outcome.outcome) {
    case 'resume-first':
      return done([
        'This run recorded the resource’s id, so `--resume` can check it itself:',
        `  ${context.resumeCommand ?? `dorkos community deploy --resume ${context.runId}`}`,
      ]);
    case 'not-a-create':
      return done([
        'This run stopped while checking secrets, not while creating something. There is nothing to remove.',
        context.recovery,
      ]);
    case 'nothing-pending':
      return done(['This run has no unresolved resource.']);
    case 'absent':
      return done([
        `Nothing named ${shown(context.journal.pendingIntent?.resourceName)} exists in ${OWNER[outcome.provider]} ${shown(context.journal.pendingIntent?.organizationId)}. The create probably never landed.`,
        'Nothing was changed. This run cannot be resumed; start a new launch instead.',
      ]);
    case 'unproved':
      return done([
        `DorkOS will not remove anything for this run: ${unprovedReasonText(outcome.reason, outcome.provider)}.`,
        ...(outcome.removalPending
          ? [
              'A removal was already started for this run, and DorkOS can no longer prove the resource is this run’s. Remove it yourself with the commands below.',
              `Then run ${removeCommand(context.runId)} again. It will see the resource is gone and finish the removal, and --resume will work again.`,
            ]
          : []),
        ...(outcome.candidates.length > 0
          ? [
              'Found:',
              ...outcome.candidates.map(
                (candidate) => `  ${candidateLine(outcome.provider, candidate)}`
              ),
            ]
          : []),
        ...manualSteps(outcome.provider, context.journal),
      ]);
    case 'unreachable':
      return done(
        [
          `DorkOS could not read ${outcome.provider === 'neon' ? 'Neon' : 'Fly'} to check. Nothing was changed.`,
          `It is safe to run this again: ${removeCommand(context.runId)}`,
        ],
        1
      );
    case 'check-only':
      return done([
        'Nothing was removed. To remove it, run this in a terminal, or with the id to confirm:',
        `  ${removeCommand(context.runId, outcome.target.token)}`,
      ]);
    case 'declined':
      return done([
        `Kept ${SERVICE[outcome.target.provider]} ${shown(outcome.target.resourceName)}. Nothing was changed.`,
      ]);
    case 'wrong-token':
      return done(
        [
          `That is not the ${TOKEN_NAME[outcome.target.provider]}. Kept ${SERVICE[outcome.target.provider]} ${shown(outcome.target.resourceName)}. Nothing was changed.`,
        ],
        1
      );
    case 'changed':
      return done(
        [
          'This run changed while DorkOS was checking it, so nothing was removed. Run the command again.',
        ],
        1
      );
    case 'too-many-removals':
      return done(
        ['This run has already removed as many resources as it can. Start a new launch instead.'],
        1
      );
    case 'removed':
      return done([removedLine(outcome.target, outcome.nameReleased), continueWith(context)]);
    case 'removal-uncertain':
      return done(
        [
          `DorkOS asked to remove ${SERVICE[outcome.target.provider]} ${shown(outcome.target.resourceName)} but could not confirm it is gone. The run stays paused.`,
          `It is safe to run this again: ${removeCommand(context.runId)}`,
        ],
        1
      );
  }
}
