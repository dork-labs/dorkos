/**
 * `--forget`: stop listing a stopped launch once everything it made is provably gone.
 *
 * A person may remove a stopped launch's resources by hand instead of resuming it. Its journal
 * then points at nothing, but `--list-incomplete` would show it forever. This deletes the journal
 * only after an exact read shows each resource the run recorded is gone, and, for a create whose
 * outcome was never known, that nothing with its name exists long after the create window
 * (the same bar `--remove-uncertain` uses). Nothing at any service is changed.
 *
 * @module commands/community-deploy/provenance/forget-launch
 */
import { LaunchJournalConflictError, type LaunchJournal } from '../journal.js';
import {
  absentCreateSettledAt,
  classifyUncertainJournal,
  evaluateUncertainResource,
  type PendingIntent,
  type ProbeResult,
  type RemovalProvider,
  type UnprovedReason,
} from './uncertain-removal.js';

/** Exact reads of whether a run's resources are gone. Each throws when it cannot tell. */
export interface LaunchResourceChecks {
  /** Fly's exact "no such app" for the name, and the organization's listing lacks it. */
  flyAppGone(appName: string, organization: string): Promise<boolean>;
  /** The organization's full project listing lacks this id. */
  neonProjectGone(projectId: string, organization: string): Promise<boolean>;
  /** Fly answers that this add-on id does not exist, or was deleted. */
  tigrisBucketGone(addOnId: string): Promise<boolean>;
  /**
   * Read what has the intended name, for a create whose outcome was never known: the same read
   * `--remove-uncertain` makes for its verdict.
   */
  findIntended(intent: PendingIntent, journal: LaunchJournal): Promise<ProbeResult>;
  /**
   * Whether Fly's add-on lookup by name finds a bucket with this name; only its exact `NOT_FOUND`
   * means free. The lookup answers for what the signed-in Fly account can see, which includes the
   * run's own organization; that is all it is relied on to show.
   */
  tigrisNameHeld(bucketName: string): Promise<boolean>;
}

/** One resource a run recorded, with what a person needs to find and remove it. */
export interface RunResource {
  provider: RemovalProvider;
  /** The id the run recorded: the app name, the Neon project id, or the Tigris add-on id. */
  id: string;
  /** The name the plan gave it. */
  name: string;
  /** The organization it lives in, or `null` for a journal without saved choices. */
  organization: string | null;
}

/**
 * Every resource a run recorded, in the order it made them.
 *
 * @param journal - The run's journal.
 */
export function runResources(journal: LaunchJournal): RunResource[] {
  const context = journal.recoveryContext;
  const { flyAppId, neonProjectId, tigrisBucketId } = journal.resources;
  const resources: RunResource[] = [];
  if (flyAppId) {
    resources.push({
      provider: 'fly',
      id: flyAppId,
      name: context?.appName ?? flyAppId,
      organization: context?.flyOrganization ?? null,
    });
  }
  if (neonProjectId) {
    resources.push({
      provider: 'neon',
      id: neonProjectId,
      name: context?.neonProjectName ?? neonProjectId,
      organization: context?.neonOrganization ?? null,
    });
  }
  if (tigrisBucketId) {
    resources.push({
      provider: 'tigris',
      id: tigrisBucketId,
      name: context?.bucketName ?? tigrisBucketId,
      organization: context?.flyOrganization ?? null,
    });
  }
  return resources;
}

/**
 * Reasons that show a same-name Fly app or Neon project is not this run's: it does not carry the
 * marker this run recorded before its create and sent with it, or it lives where this run never
 * asked for one. Never applied to a bucket: a bucket has no marker of its own and is read through
 * this run's own app, so a same-name bucket there is never proved someone else's.
 * `outside-window` is deliberately not here: the marker is checked first, so a resource judged
 * only on its time carries this run's marker, and is this run's create landing late.
 */
const NOT_THIS_RUNS: ReadonlySet<UnprovedReason> = new Set([
  'different-marker',
  'other-organization',
  'other-region',
]);

/**
 * Whether a create whose outcome was never known can have landed, from one read.
 *
 * `not-landed` when nothing has the name, or when every same-name resource is proved not to be
 * this run's (someone else's project, say). Anything that could be this run's is `may-have-landed`.
 *
 * @param journal - The run's journal.
 * @param intent - Its unresolved creation intent.
 * @param found - What the read for `intent.provider` found.
 */
export function judgeIntendedCreate(
  journal: LaunchJournal,
  intent: PendingIntent,
  found: ProbeResult
): 'not-landed' | 'may-have-landed' | 'unreadable' {
  const verdict = evaluateUncertainResource(journal, intent, found);
  if (verdict.verdict === 'unreachable') return 'unreadable';
  if (verdict.verdict === 'absent') return 'not-landed';
  if (
    verdict.verdict === 'unproved' &&
    intent.provider !== 'tigris' &&
    verdict.candidates.length > 0 &&
    verdict.candidates.every((candidate) => NOT_THIS_RUNS.has(candidate.reason))
  ) {
    return 'not-landed';
  }
  return 'may-have-landed';
}

async function intendedCreateState(
  checks: LaunchResourceChecks,
  journal: LaunchJournal,
  intent: PendingIntent
): Promise<'not-landed' | 'may-have-landed' | 'unreadable'> {
  let judged: 'not-landed' | 'may-have-landed' | 'unreadable';
  try {
    judged = judgeIntendedCreate(journal, intent, await checks.findIntended(intent, journal));
  } catch {
    judged = 'unreadable';
  }
  if (judged === 'not-landed' || intent.provider !== 'tigris') return judged;
  // A bucket is read through its app, and anything short of "absent" there (the app removed, or a
  // same-name bucket on it) is settled by name instead. The bucket would live in the run's own
  // organization, which the signed-in account can see, so a name Fly reports free to it cannot be
  // this run's bucket. A failed read settles nothing.
  try {
    return (await checks.tigrisNameHeld(intent.resourceName)) ? judged : 'not-landed';
  } catch {
    return judged;
  }
}

/** A recorded resource that is still there, or that could not be checked. */
export interface RemainingResource extends RunResource {
  status: 'present' | 'unreadable';
}

/** Boundaries for {@link runForgetLaunch}. */
export interface ForgetLaunchDependencies {
  /** Read the run's journal from disk. */
  readJournal(): Promise<LaunchJournal | null>;
  /**
   * Delete the run's journal if it is still at this revision; throws
   * {@link LaunchJournalConflictError} on a race.
   */
  discard(expectedRevision: number): Promise<void>;
  /** Exact reads against the run's own organizations. */
  checks: LaunchResourceChecks;
  /** Clock for the create window. */
  now(): string;
  /** Deadline the create ran under; defaults to the provider's. */
  createDeadlineMs?: number;
}

/** What `--forget` did, for the output layer. */
export type ForgetOutcome =
  | { outcome: 'complete' }
  | { outcome: 'removal-pending' }
  | { outcome: 'too-old' }
  | { outcome: 'pending-create'; provider: RemovalProvider; status: 'present' | 'unreadable' }
  | { outcome: 'pending-create-unprovable'; provider: RemovalProvider }
  | { outcome: 'wait'; provider: RemovalProvider; clearableAfter: string; clearableInMs: number }
  | { outcome: 'still-there'; remaining: RemainingResource[] }
  | { outcome: 'changed' }
  | { outcome: 'forgotten'; checked: RunResource[] };

async function isGone(checks: LaunchResourceChecks, resource: RunResource): Promise<boolean> {
  const organization = resource.organization!;
  if (resource.provider === 'fly') return checks.flyAppGone(resource.id, organization);
  if (resource.provider === 'neon') return checks.neonProjectGone(resource.id, organization);
  return checks.tigrisBucketGone(resource.id);
}

/**
 * Run `--forget` for one journal: check that everything the run made is gone, then delete its
 * journal at the revision that was checked.
 *
 * @param dependencies - Journal, exact reads and clock.
 * @returns What happened, for the output layer to explain.
 */
export async function runForgetLaunch(
  dependencies: ForgetLaunchDependencies
): Promise<ForgetOutcome> {
  const journal = await dependencies.readJournal();
  if (!journal) throw new Error('The selected space server launch journal was not found');
  if (journal.state === 'complete') return { outcome: 'complete' };
  if (journal.pendingRemoval) return { outcome: 'removal-pending' };
  // Without the saved choices there is no organization to read, so nothing can be shown gone.
  if (!journal.recoveryContext) return { outcome: 'too-old' };

  // A create whose outcome was never known must be shown absent on the same bar that lets
  // `--remove-uncertain` release it. With its id recorded, it is checked below like the rest.
  const shape = classifyUncertainJournal(journal);
  if (shape.shape === 'uncertain-create') {
    const intent = shape.intent;
    const settledAt = absentCreateSettledAt(intent, dependencies.createDeadlineMs);
    if (settledAt === null) {
      return { outcome: 'pending-create-unprovable', provider: intent.provider };
    }
    const state = await intendedCreateState(dependencies.checks, journal, intent);
    if (state !== 'not-landed') {
      return {
        outcome: 'pending-create',
        provider: intent.provider,
        status: state === 'unreadable' ? 'unreadable' : 'present',
      };
    }
    const checkedAt = Date.parse(dependencies.now());
    if (checkedAt < settledAt) {
      return {
        outcome: 'wait',
        provider: intent.provider,
        clearableAfter: new Date(settledAt).toISOString(),
        clearableInMs: settledAt - checkedAt,
      };
    }
  }

  const resources = runResources(journal);
  const remaining: RemainingResource[] = [];
  for (const resource of resources) {
    let gone: boolean;
    try {
      gone = await isGone(dependencies.checks, resource);
    } catch {
      remaining.push({ ...resource, status: 'unreadable' });
      continue;
    }
    if (!gone) remaining.push({ ...resource, status: 'present' });
  }
  if (remaining.length > 0) return { outcome: 'still-there', remaining };

  try {
    await dependencies.discard(journal.revision);
  } catch (error) {
    if (error instanceof LaunchJournalConflictError) return { outcome: 'changed' };
    throw error;
  }
  return { outcome: 'forgotten', checked: resources };
}
