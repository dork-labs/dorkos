/**
 * Prove and remove the one resource an uncertain Community launch create may have left behind.
 *
 * `dorkos community deploy` stops with `CREATION_OUTCOME_UNCERTAIN` when a create may have worked
 * but its identity was never recorded. The verdict comes from `uncertain-verdict.ts`; this module
 * removes the resource only after the operator confirms with a token taken from a fresh read.
 * Nothing here locks the run: every write is revision-checked, and the resource is found and
 * proved again immediately before the delete.
 *
 * @module commands/community-deploy/provenance/uncertain-removal
 */
import { LaunchJournalConflictError, MAX_REMOVALS, type LaunchJournal } from '../journal.js';
import {
  classifyUncertainJournal,
  evaluateUncertainResource,
  precheckUncertainCreate,
  summary,
  type CandidateSummary,
  type PendingIntent,
  type PendingRemoval,
  type ProbeResult,
  type ProvedResource,
  type ProvenanceGate,
  type RemovalProvider,
  type RemovalTarget,
  type UncertainVerdict,
  type UnprovedReason,
} from './uncertain-verdict.js';

export * from './uncertain-verdict.js';

/** How long a removal waits for the service to confirm the resource is gone. */
export const DEFAULT_ABSENCE_DEADLINE_MS = 60_000;

const FIRST_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 10_000;

/** Reads and writes for one service, bound to the run's own accounts by the caller. */
export interface UncertainResourceProbe {
  /** Read everything the proof needs. Throws when a read fails, times out or fails its schema. */
  find(intent: PendingIntent, journal: LaunchJournal): Promise<ProbeResult>;
  /** Send the delete. Its result is advisory: a delete can succeed and still report an error. */
  remove(target: RemovalTarget): Promise<void>;
  /** Whether the exact resource is gone. Throws when that cannot be read. */
  isGone(target: RemovalTarget): Promise<boolean>;
  /** Tigris: non-secret digests of the credentials on the bucket's app, read before deleting. */
  readPriorSecretDigests?(target: RemovalTarget): Promise<Record<string, string>>;
  /** Tigris: unset both credential names and confirm by readback that neither is left. */
  clearBoundSecrets?(target: RemovalTarget): Promise<boolean>;
  /** Fly: whether the name is free for a new app yet. */
  isNameReleased?(target: RemovalTarget): Promise<boolean>;
}

/** The operator's answer to a removal offer. */
export type RemovalAnswer =
  { kind: 'token'; token: string } | { kind: 'declined' } | { kind: 'check-only' };

/** Boundaries for {@link runUncertainRemoval}. */
export interface UncertainRemovalDependencies {
  /** Read the run's journal from disk. */
  readJournal(): Promise<LaunchJournal | null>;
  /** Persist one complete next revision; throws {@link LaunchJournalConflictError} on a race. */
  persist(next: LaunchJournal, expectedRevision: number): Promise<void>;
  /** The probe for one service. Only the service in the intent is ever asked for. */
  probeFor(provider: RemovalProvider): UncertainResourceProbe;
  /** Show the proved resource and return the operator's answer. */
  confirm(target: ProvedResource, notFromRun: readonly CandidateSummary[]): Promise<RemovalAnswer>;
  /** Clock for journal timestamps. */
  now(): string;
  /** Wait between absence polls. */
  sleep(ms: number): Promise<void>;
  /** Contract gate; defaults to the committed value. */
  gate?: ProvenanceGate;
  /** Deadline the create ran under. */
  createDeadlineMs?: number;
  /** How long to wait for the service to confirm absence. */
  absenceDeadlineMs?: number;
  /** Operator cancellation. */
  signal?: AbortSignal;
}

/** What the command did, for the output layer. */
export type RemovalOutcome =
  | { outcome: 'resume-first' }
  | { outcome: 'not-a-create' }
  | { outcome: 'nothing-pending' }
  | { outcome: 'absent'; provider: RemovalProvider }
  | {
      outcome: 'unproved';
      provider: RemovalProvider;
      reason: UnprovedReason;
      candidates: CandidateSummary[];
      /** Set when a removal was already under way: the resource must now be removed by hand. */
      removalPending?: true;
    }
  | { outcome: 'unreachable'; provider: RemovalProvider }
  | { outcome: 'check-only'; target: ProvedResource; notFromRun: CandidateSummary[] }
  | { outcome: 'declined'; target: ProvedResource }
  | { outcome: 'wrong-token'; target: ProvedResource }
  | { outcome: 'changed' }
  | { outcome: 'too-many-removals' }
  | { outcome: 'removed'; target: RemovalTarget; nameReleased: boolean | null }
  | { outcome: 'removal-uncertain'; target: RemovalTarget };

function targetOf(proved: ProvedResource): RemovalTarget {
  return {
    provider: proved.provider,
    token: proved.token,
    resourceName: proved.resourceName,
    organization: proved.organization,
    proof: proved.proof,
    appName: proved.appName,
  };
}

function targetFromPending(journal: LaunchJournal, removal: PendingRemoval): RemovalTarget {
  return {
    provider: removal.provider,
    token: removal.token,
    resourceName: removal.resourceName,
    organization: journal.pendingIntent?.organizationId ?? '',
    proof: removal.proof,
    appName: journal.recoveryContext?.appName ?? '',
  };
}

/**
 * The token check. It must equal the token read back from the service, and a Fly app's name is
 * never accepted, even where it happens to equal the token.
 */
export function tokenConfirms(target: RemovalTarget, typed: string): boolean {
  if (target.provider === 'fly' && typed === target.resourceName) return false;
  return typed.length > 0 && typed === target.token;
}

function sameProof(left: ProvedResource, right: ProvedResource): boolean {
  return (
    left.provider === right.provider &&
    left.token === right.token &&
    left.resourceName === right.resourceName &&
    left.organization === right.organization &&
    left.proofValue === right.proofValue &&
    left.createdAt === right.createdAt
  );
}

function samePendingRemoval(journal: LaunchJournal, removal: PendingRemoval): boolean {
  const current = journal.pendingRemoval;
  return (
    current !== null &&
    current !== undefined &&
    current.provider === removal.provider &&
    current.token === removal.token &&
    current.resourceName === removal.resourceName &&
    current.proof === removal.proof &&
    current.requestedAt === removal.requestedAt
  );
}

function revise(current: LaunchJournal, now: string, update: Partial<LaunchJournal>) {
  return { ...current, ...update, revision: current.revision + 1, updatedAt: now };
}

async function waitForAbsence(
  probe: UncertainResourceProbe,
  target: RemovalTarget,
  dependencies: UncertainRemovalDependencies
): Promise<boolean> {
  const deadline = dependencies.absenceDeadlineMs ?? DEFAULT_ABSENCE_DEADLINE_MS;
  let waited = 0;
  let delay = FIRST_POLL_DELAY_MS;
  for (;;) {
    if (dependencies.signal?.aborted) throw new RemovalCancelledError();
    // A failed read is not absence; it is one more reason to look again.
    if (await probe.isGone(target).catch(() => false)) return true;
    if (waited >= deadline) return false;
    const pause = Math.min(delay, deadline - waited);
    await dependencies.sleep(pause);
    waited += pause;
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
  }
}

/** Raised when the operator cancels a removal. */
export class RemovalCancelledError extends Error {
  /** Create a secret-free cancellation. */
  constructor() {
    super('The removal was cancelled. It is safe to run the same command again to check.');
    this.name = 'RemovalCancelledError';
  }
}

interface ClaimedRemoval {
  journal: LaunchJournal;
  removal: PendingRemoval;
}

async function recordRemovalUncertain(
  dependencies: UncertainRemovalDependencies,
  claimed: LaunchJournal
): Promise<void> {
  await dependencies.persist(
    revise(claimed, dependencies.now(), {
      state: 'uncertain',
      lastSafeError: { category: 'uncertain', code: 'REMOVAL_OUTCOME_UNCERTAIN' },
    }),
    claimed.revision
  );
}

async function recordGone(
  dependencies: UncertainRemovalDependencies,
  current: LaunchJournal,
  removal: PendingRemoval
): Promise<void> {
  const lastConfirmed = current.completedSteps.at(-1) ?? 'planned';
  await dependencies.persist(
    revise(current, dependencies.now(), {
      removals: [...(current.removals ?? []), { ...removal, removedAt: dependencies.now() }],
      pendingRemoval: null,
      pendingIntent: null,
      state: lastConfirmed,
      lastSafeError: null,
    }),
    current.revision
  );
}

/**
 * Delete, confirm absence, and record the outcome against the revision this removal claimed.
 * Every path from here writes the journal, because a delete may have reached the service.
 */
async function deleteAndRecord(
  dependencies: UncertainRemovalDependencies,
  probe: UncertainResourceProbe,
  target: RemovalTarget,
  claim: ClaimedRemoval
): Promise<RemovalOutcome> {
  await probe.remove(target).catch(() => undefined);
  return finishFromAbsence(dependencies, probe, target, claim, false);
}

async function finishFromAbsence(
  dependencies: UncertainRemovalDependencies,
  probe: UncertainResourceProbe,
  target: RemovalTarget,
  claim: ClaimedRemoval,
  alreadyGone: boolean
): Promise<RemovalOutcome> {
  let gone = alreadyGone || (await waitForAbsence(probe, target, dependencies));
  if (gone && target.provider === 'tigris') {
    // The credentials the bucket set must be gone too, or a re-created bucket could inherit them.
    gone = (await probe.clearBoundSecrets?.(target).catch(() => false)) === true;
  }
  try {
    if (!gone) {
      await recordRemovalUncertain(dependencies, claim.journal);
      return { outcome: 'removal-uncertain', target };
    }
    const nameReleased =
      target.provider === 'fly' && probe.isNameReleased
        ? await probe.isNameReleased(target).catch(() => null)
        : null;
    await recordGone(dependencies, claim.journal, claim.removal);
    return { outcome: 'removed', target, nameReleased };
  } catch (error) {
    // Another writer moved the run after this removal claimed it. The delete may already have
    // reached the service, so the result is uncertain, and the journal keeps the removal pending.
    if (error instanceof LaunchJournalConflictError) {
      return { outcome: 'removal-uncertain', target };
    }
    throw error;
  }
}

/**
 * Run `--remove-uncertain` for one journal: classify, prove, confirm, re-check, delete, record.
 *
 * @param dependencies - Journal, probe, confirmation and clock boundaries.
 * @returns What happened, for the output layer to explain.
 */
export async function runUncertainRemoval(
  dependencies: UncertainRemovalDependencies
): Promise<RemovalOutcome> {
  const journal = await dependencies.readJournal();
  if (!journal) throw new Error('The selected Community launch journal was not found');
  const shape = classifyUncertainJournal(journal);
  if (shape.shape === 'resume-first') return { outcome: 'resume-first' };
  if (shape.shape === 'not-a-create') return { outcome: 'not-a-create' };
  if (shape.shape === 'nothing-pending') return { outcome: 'nothing-pending' };

  const intent = journal.pendingIntent;
  if (!intent) return { outcome: 'nothing-pending' };
  const provider = intent.provider;
  const precheck = precheckUncertainCreate(journal, intent);
  if (precheck && shape.shape === 'uncertain-create') {
    return { outcome: 'unproved', provider, reason: precheck, candidates: [] };
  }
  const probe = dependencies.probeFor(provider);
  const evaluate = async (current: LaunchJournal): Promise<UncertainVerdict> => {
    try {
      return evaluateUncertainResource(current, intent, await probe.find(intent, current), {
        gate: dependencies.gate,
        createDeadlineMs: dependencies.createDeadlineMs,
      });
    } catch {
      return { verdict: 'unreachable' };
    }
  };

  // A removal that was confirmed before. Finish it if the resource is gone; offer it again only
  // when the same resource is still there and still proved.
  const restart = shape.shape === 'pending-removal' ? shape.removal : null;
  if (restart) {
    const earlier = targetFromPending(journal, restart);
    let gone: boolean;
    try {
      gone = await probe.isGone(earlier);
    } catch {
      return { outcome: 'unreachable', provider };
    }
    if (gone) {
      return finishFromAbsence(dependencies, probe, earlier, { journal, removal: restart }, true);
    }
  }

  const verdict = await evaluate(journal);
  if (verdict.verdict === 'unreachable') return { outcome: 'unreachable', provider };
  const pendingFlag = restart ? { removalPending: true as const } : {};
  if (verdict.verdict === 'absent') {
    return restart
      ? { outcome: 'unproved', provider, reason: 'not-the-same', candidates: [], ...pendingFlag }
      : { outcome: 'absent', provider };
  }
  if (verdict.verdict === 'unproved') {
    return {
      outcome: 'unproved',
      provider,
      reason: verdict.reason,
      candidates: verdict.candidates,
      ...pendingFlag,
    };
  }
  const proved = verdict.target;
  if (restart && proved.token !== restart.token) {
    return {
      outcome: 'unproved',
      provider,
      reason: 'not-the-same',
      candidates: [summary({ ...proved, name: proved.resourceName }, 'not-the-same')],
      ...pendingFlag,
    };
  }
  if (!restart && (journal.removals?.length ?? 0) >= MAX_REMOVALS) {
    return { outcome: 'too-many-removals' };
  }

  const answer = await dependencies.confirm(proved, verdict.notFromRun);
  if (answer.kind === 'check-only') {
    return { outcome: 'check-only', target: proved, notFromRun: verdict.notFromRun };
  }
  if (answer.kind === 'declined') return { outcome: 'declined', target: proved };
  if (!tokenConfirms(proved, answer.token)) return { outcome: 'wrong-token', target: proved };

  const target = targetOf(proved);
  let priorSecretDigests: Record<string, string> | undefined;
  if (provider === 'tigris') {
    try {
      priorSecretDigests =
        restart?.priorSecretDigests ?? (await probe.readPriorSecretDigests?.(target)) ?? {};
    } catch {
      return { outcome: 'unreachable', provider };
    }
  }
  const removal: PendingRemoval = restart ?? {
    provider,
    token: proved.token,
    resourceName: proved.resourceName,
    proof: proved.proof,
    ...(priorSecretDigests === undefined ? {} : { priorSecretDigests }),
    requestedAt: dependencies.now(),
  };

  // Step 1: claim the run at the revision the verdict was computed from. Any write since then,
  // from a `--resume` or another removal, makes this fail and nothing is deleted.
  const claimed = revise(journal, dependencies.now(), { pendingRemoval: removal });
  try {
    await dependencies.persist(claimed, journal.revision);
  } catch (error) {
    if (error instanceof LaunchJournalConflictError) return { outcome: 'changed' };
    throw error;
  }
  const claim: ClaimedRemoval = { journal: claimed, removal };
  const release = async () => {
    // A fresh claim that never deleted anything goes back to exactly what it replaced. A restart
    // keeps the removal it found, since an earlier delete may still have reached the service.
    if (restart) return;
    await dependencies
      .persist(revise(claimed, dependencies.now(), { pendingRemoval: null }), claimed.revision)
      .catch(() => undefined);
  };

  // Whether this run has sent the delete. Before that, a cancel changes nothing at the service.
  let deleteSent = false;
  try {
    // Step 2: find and prove it again, then check the journal is still at the claimed revision.
    const again = await evaluate(claimed);
    if (again.verdict !== 'proved' || !sameProof(again.target, proved)) {
      await release();
      return { outcome: 'changed' };
    }
    const current = await dependencies.readJournal();
    if (
      !current ||
      current.revision !== claimed.revision ||
      !samePendingRemoval(current, removal)
    ) {
      return { outcome: 'changed' };
    }
    if (dependencies.signal?.aborted) throw new RemovalCancelledError();
    // Steps 3 to 5.
    deleteSent = true;
    return await deleteAndRecord(dependencies, probe, target, claim);
  } catch (error) {
    if (error instanceof LaunchJournalConflictError) return { outcome: 'changed' };
    if (dependencies.signal?.aborted) {
      // After the delete was sent it may have reached the service, so say the outcome is
      // uncertain. Before that, nothing was deleted: give the claim back instead.
      if (deleteSent) await recordRemovalUncertain(dependencies, claimed).catch(() => undefined);
      else await release();
    }
    throw error;
  }
}
