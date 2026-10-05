import { z } from 'zod';
import type { ProcessIdentity } from '../configuration.js';
import {
  BootScopeSchema,
  GAP_CODES,
  JournalBindingSchema,
  JOURNAL_LIMITS,
  ObservationWindowSchema,
  ProcessIdentitySchema,
  copyJournalData,
  processKey,
  sameJournalBinding,
  sameProcess,
  validateJournalSnapshot,
  type JournalBinding,
  type JournalCause,
  type JournalGap,
  type JournalSnapshot,
} from './process-journal.js';

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const absenceSchema = z
  .object({
    kind: z.literal('explicit-original-absent'),
    queriedPid: counter,
    queriedBirth: z.string().min(1).max(128),
  })
  .strict();
const identityStatusSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('original-alive'),
      identity: ProcessIdentitySchema,
      currentParent: ProcessIdentitySchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('original-gone'),
      identity: ProcessIdentitySchema,
      absence: absenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('replacement-observed'),
      identity: ProcessIdentitySchema,
      replacement: ProcessIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unknown'),
      identity: ProcessIdentitySchema,
      cause: z.enum(GAP_CODES),
    })
    .strict(),
]);
export const RecordedObservationBatchSchema = z
  .object({
    journalId: JournalBindingSchema.shape.journalId,
    browserGeneration: counter,
    reservationNonce: JournalBindingSchema.shape.reservationNonce,
    bootScope: BootScopeSchema,
    writerEpoch: counter,
    window: ObservationWindowSchema,
    statuses: z.array(identityStatusSchema).max(JOURNAL_LIMITS.identities),
  })
  .strict();
export type RecordedObservationBatch = z.infer<typeof RecordedObservationBatchSchema>;
export interface RecordedReconciliation {
  readonly decision: 'retain';
  readonly recordedDisposition: 'live-recorded' | 'matching-recorded-gone' | 'unknown';
  readonly coverage: 'recorded-window' | 'unknown';
  readonly retainedOriginalIdentities: readonly ProcessIdentity[];
  readonly replacementIdentities: readonly ProcessIdentity[];
  readonly matchingRecordedCount: number;
  readonly gaps: readonly JournalGap[];
  readonly firstCause: JournalSnapshot['firstCause'];
  readonly pendingAttribution: readonly ProcessIdentity[];
}

/** Pure data projection only: no I/O, process query, signal, permit, reuse or recovery factory. */
export function reconcileRecordedGeneration(
  snapshotValue: unknown,
  expectedBindingValue: unknown,
  observationBatchValue: unknown
): RecordedReconciliation {
  let snapshot: JournalSnapshot | undefined;
  let binding: JournalBinding | undefined;
  let batch: RecordedObservationBatch | undefined;
  let failure: JournalCause | undefined;
  try {
    snapshot = validateJournalSnapshot(snapshotValue);
  } catch {
    failure = 'frame-invalid';
  }
  try {
    binding = JournalBindingSchema.parse(copyJournalData(expectedBindingValue));
  } catch {
    failure ??= 'frame-invalid';
  }
  try {
    batch = RecordedObservationBatchSchema.parse(copyJournalData(observationBatchValue));
  } catch {
    failure ??= 'frame-invalid';
  }

  const sequence = snapshot?.sequence ?? 0;
  const originals = snapshot?.retainedIdentities.map((r) => r.identity) ?? [];
  const pendingAttribution: ProcessIdentity[] = [];
  const replacements: ProcessIdentity[] = [];
  const gaps: JournalGap[] = (snapshot?.gaps ?? []).map((g) => ({ ...g }));
  let firstCause = snapshot?.firstCause ?? null;
  const gap = (cause: JournalCause, identity: ProcessIdentity | null = null) => {
    firstCause ??= Object.freeze({ cause, sequence });
    const prior = gaps.find((g) => g.cause === cause);
    if (prior) {
      // Saturated data counts stay saturated; they never wrap or erase the original cause.
      if (prior.count === Number.MAX_SAFE_INTEGER) failure ??= 'capacity-exceeded';
      else gaps[gaps.indexOf(prior)] = { ...prior, count: prior.count + 1 };
    } else if (gaps.length < JOURNAL_LIMITS.gaps)
      gaps.push({ cause, firstSequence: sequence, identity, count: 1 });
    else failure ??= 'capacity-exceeded';
    failure ??= cause;
  };
  if (failure) gap(failure);
  let live = false,
    matched = 0;
  if (snapshot && binding && batch) {
    if (
      !sameJournalBinding(snapshot.binding, binding) ||
      batch.journalId !== binding.journalId ||
      batch.browserGeneration !== binding.browserGeneration ||
      batch.reservationNonce !== binding.reservationNonce ||
      batch.writerEpoch !== snapshot.writer.epoch
    )
      gap('sequence-gap');
    if (
      binding.bootScope.kind !== 'observed' ||
      snapshot.binding.bootScope.kind !== 'observed' ||
      batch.bootScope.kind !== 'observed'
    )
      gap('boot-unknown');
    else if (
      batch.bootScope.value !== binding.bootScope.value ||
      batch.bootScope.sourceIdentityDigest !== binding.bootScope.sourceIdentityDigest
    )
      gap('boot-changed');
    if (
      snapshot.sequence === Number.MAX_SAFE_INTEGER ||
      batch.window.startSequence !== snapshot.sequence + 1 ||
      batch.window.endSequence !== batch.window.startSequence ||
      batch.window.checkpointSequence !== batch.window.endSequence ||
      batch.window.startMonotonic < snapshot.observationWindow.endMonotonic
    )
      gap('sequence-gap');
    if (snapshot.root.kind !== 'attributed') gap('root-pending');
    if (snapshot.phase === 'allocated' || snapshot.phase === 'launch-intent') gap('root-pending');
    const observed = new Map<string, RecordedObservationBatch['statuses'][number]>();
    for (const status of batch.statuses) {
      const key = processKey(status.identity);
      if (observed.has(key)) gap('identity-unknown', status.identity);
      else observed.set(key, status);
      if (!originals.some((identity) => sameProcess(identity, status.identity))) {
        pendingAttribution.push(status.identity);
        gap('association-missing', status.identity);
      }
    }
    for (const retained of snapshot.retainedIdentities) {
      const status = observed.get(processKey(retained.identity));
      if (!status) {
        gap('identity-unknown', retained.identity);
        continue;
      }
      if (status.kind === 'unknown') {
        gap(status.cause, retained.identity);
        continue;
      }
      if (status.kind === 'original-alive') {
        live = true;
        matched++;
        // A reparented original remains attributed by its immutable original association.
        // currentParent is a new observation, never a rewritten enrollment relationship.
      } else if (status.kind === 'original-gone') {
        if (
          status.absence.queriedPid !== retained.identity.pid ||
          status.absence.queriedBirth !== retained.identity.birth
        )
          gap('identity-unknown', retained.identity);
        else matched++;
      } else {
        if (
          status.replacement.pid !== retained.identity.pid ||
          status.replacement.birth === retained.identity.birth
        )
          gap('identity-unknown', retained.identity);
        else {
          matched++;
          replacements.push(status.replacement);
        }
      }
    }
    if (snapshot.gaps.length) failure ??= snapshot.gaps[0]!.cause;
  }
  const uncertain =
    !!failure ||
    !snapshot ||
    !binding ||
    !batch ||
    matched !== originals.length ||
    originals.length === 0;
  return Object.freeze({
    decision: 'retain',
    recordedDisposition: uncertain ? 'unknown' : live ? 'live-recorded' : 'matching-recorded-gone',
    coverage: uncertain ? 'unknown' : 'recorded-window',
    retainedOriginalIdentities: Object.freeze(originals.map((id) => Object.freeze({ ...id }))),
    replacementIdentities: Object.freeze(replacements.map((id) => Object.freeze({ ...id }))),
    matchingRecordedCount: matched,
    gaps: Object.freeze(gaps.map((g) => Object.freeze(g))),
    firstCause,
    pendingAttribution: Object.freeze(pendingAttribution.map((id) => Object.freeze({ ...id }))),
  });
}
