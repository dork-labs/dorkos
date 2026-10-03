/** Retained scalar payload targets; these do not bound total browser/JS memory. */
export const DIAGNOSTICS_LIMITS = Object.freeze({
  owners: 16,
  entriesPerOwner: 256,
  entries: 4096,
  charge: 1024,
  wrapper: 4096,
  projection: 4 * 1024 * 1024,
  correlationsPerOwner: 256,
  correlations: 4096,
  correlationBytes: 4 * 1024 * 1024,
  summaryBytes: 266240,
});
/** One exact retained owner slot; no caller-supplied token can authorize release. */
export interface DiagnosticOwnerUsage {
  entries: number;
  bytes: number;
  correlations: number;
  correlationBytes: number;
}
/** A single engine closure shared by all BrowserRecords; release follows payload severing. */
export interface DiagnosticsBudget {
  reserve(): object | null;
  commit(
    owner: object,
    delta: { entryBytes?: number; correlationBytes?: number; priorCorrelationBytes?: number }
  ): boolean;
  correlationFits(owner: object, bytes: number, priorBytes?: number): boolean;
  releaseCorrelation(owner: object, bytes: number): void;
  clear(owner: object): void;
  discard(owner: object): void;
  snapshot(): Readonly<{
    owners: number;
    entries: number;
    bytes: number;
    correlations: number;
    correlationBytes: number;
  }>;
}
/** Allocate an engine-local cardinality/byte ledger with atomic joint entry/correlation admission. */
export function createDiagnosticsBudget(): DiagnosticsBudget {
  const owners = new Map<object, DiagnosticOwnerUsage>();
  let entries = 0,
    bytes = 0,
    correlations = 0,
    correlationBytes = 0;
  const clear = (owner: object) => {
    const usage = owners.get(owner);
    if (!usage) return;
    entries -= usage.entries;
    bytes -= usage.bytes;
    correlations -= usage.correlations;
    correlationBytes -= usage.correlationBytes;
    usage.entries = usage.bytes = usage.correlations = usage.correlationBytes = 0;
  };
  return Object.freeze({
    reserve() {
      if (owners.size >= DIAGNOSTICS_LIMITS.owners) return null;
      const owner = Object.freeze({});
      owners.set(owner, { entries: 0, bytes: 0, correlations: 0, correlationBytes: 0 });
      return owner;
    },
    commit(
      owner: object,
      delta: { entryBytes?: number; correlationBytes?: number; priorCorrelationBytes?: number }
    ) {
      const usage = owners.get(owner);
      if (!usage) return false;
      const e = delta.entryBytes === undefined ? 0 : 1;
      const c =
        delta.correlationBytes === undefined || delta.priorCorrelationBytes !== undefined ? 0 : 1;
      const eb = delta.entryBytes ?? 0,
        cb = (delta.correlationBytes ?? 0) - (delta.priorCorrelationBytes ?? 0);
      if (
        (e && (!Number.isSafeInteger(eb) || eb < 1 || eb > DIAGNOSTICS_LIMITS.charge)) ||
        (delta.correlationBytes !== undefined &&
          (!Number.isSafeInteger(delta.correlationBytes) ||
            delta.correlationBytes < 1 ||
            delta.correlationBytes > DIAGNOSTICS_LIMITS.charge)) ||
        usage.entries + e > DIAGNOSTICS_LIMITS.entriesPerOwner ||
        entries + e > DIAGNOSTICS_LIMITS.entries ||
        bytes + eb + DIAGNOSTICS_LIMITS.owners * DIAGNOSTICS_LIMITS.wrapper >
          DIAGNOSTICS_LIMITS.projection ||
        usage.correlations + c > DIAGNOSTICS_LIMITS.correlationsPerOwner ||
        correlations + c > DIAGNOSTICS_LIMITS.correlations ||
        correlationBytes + cb > DIAGNOSTICS_LIMITS.correlationBytes
      )
        return false;
      usage.entries += e;
      entries += e;
      usage.bytes += eb;
      bytes += eb;
      usage.correlations += c;
      correlations += c;
      usage.correlationBytes += cb;
      correlationBytes += cb;
      return true;
    },
    correlationFits(owner: object, charge: number, prior?: number) {
      const u = owners.get(owner);
      const add = prior === undefined ? 1 : 0;
      return (
        !!u &&
        Number.isSafeInteger(charge) &&
        charge > 0 &&
        charge <= DIAGNOSTICS_LIMITS.charge &&
        u.correlations + add <= DIAGNOSTICS_LIMITS.correlationsPerOwner &&
        correlations + add <= DIAGNOSTICS_LIMITS.correlations &&
        correlationBytes + charge - (prior ?? 0) <= DIAGNOSTICS_LIMITS.correlationBytes
      );
    },
    releaseCorrelation(owner: object, charge: number) {
      const usage = owners.get(owner);
      if (!usage || usage.correlations < 1 || charge < 1 || charge > usage.correlationBytes)
        throw new Error('DIAGNOSTIC_RELEASE_REFUSED');
      usage.correlations--;
      correlations--;
      usage.correlationBytes -= charge;
      correlationBytes -= charge;
    },
    clear,
    discard(owner: object) {
      clear(owner);
      owners.delete(owner);
    },
    snapshot: () =>
      Object.freeze({ owners: owners.size, entries, bytes, correlations, correlationBytes }),
  });
}
