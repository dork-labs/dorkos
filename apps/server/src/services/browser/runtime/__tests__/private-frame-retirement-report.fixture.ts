import type { ProcessIdentity, ProcessObservation } from '@dorkos/browser';

type CleanupStage =
  | 'worker-release'
  | 'worker-return'
  | 'worker-log-close'
  | 'frontend-close'
  | 'projection-close'
  | 'cli-return'
  | 'cli-pipes'
  | 'cli-log-sync'
  | 'cli-log-close'
  | 'retained-job';
/** Data-only cause classification; never read producer error properties or serialize their content. */
function causeKind(value: unknown) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value === false) return 'false';
  return typeof value;
}
function identity(original: ProcessIdentity): ProcessIdentity {
  return Object.freeze({ pid: original.pid, birth: original.birth });
}
/** Fixture-only retention of already entered cleanup and observation results. No observer or authority. */
export function createOriginalFrameRetirementReport() {
  const cleanupFailures: { stage: CleanupStage; causeKind: string }[] = [];
  const observations: {
    identity: ProcessIdentity;
    outcome: 'observed' | 'threw' | 'retirement-refused';
    status?: ProcessObservation['status'];
    causeKind?: string;
  }[] = [];
  return Object.freeze({
    failure(stage: CleanupStage, value: unknown) {
      cleanupFailures.push(Object.freeze({ stage, causeKind: causeKind(value) }));
    },
    observed(original: ProcessIdentity, status: ProcessObservation['status']) {
      observations.push(
        Object.freeze({
          identity: identity(original),
          outcome: 'observed',
          status,
        })
      );
    },
    observationFailure(original: ProcessIdentity, value: unknown, observationReturned: boolean) {
      observations.push(
        Object.freeze({
          identity: identity(original),
          outcome: observationReturned ? 'retirement-refused' : 'threw',
          causeKind: causeKind(value),
        })
      );
    },
    snapshot(options: {
      knownBirths: readonly ProcessIdentity[];
      excludedParent: ProcessIdentity | null;
      originalChildPids: Readonly<{ cli: number | null; frontend: number | null }>;
      primary: { value: unknown } | undefined;
    }) {
      return Object.freeze({
        kind: 'original-frame-retirement',
        version: 1,
        knownBirths: Object.freeze(options.knownBirths.map(identity)),
        excludedParent: options.excludedParent ? identity(options.excludedParent) : null,
        exclusionReason: 'original-entry-manager-still-live',
        // PID provenance is descriptive only; knownBirths contains the actual observer-issued identities.
        originalChildPids: Object.freeze({ ...options.originalChildPids }),
        observations: Object.freeze([...observations]),
        cleanupFailures: Object.freeze([...cleanupFailures]),
        primary: options.primary
          ? Object.freeze({ causeKind: causeKind(options.primary.value) })
          : null,
        physicalScope: 'retained-original-identities-only',
      });
    },
  });
}
