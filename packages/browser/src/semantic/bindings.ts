/** Private identity ledger. Supplied objects are not acquired/revalidated DOM objects. */
export interface PrivateSemanticGeneration {
  browserId: string;
  browserGeneration: number;
  tabId: string;
  navigationGeneration: number;
  viewportVersion: number;
  epoch: number;
  inputGeneration: number;
  treeRevision: number;
}
/** Only private owner-held objects and sanitized fingerprint material belong here. */
export interface SuppliedPrivateSemanticBinding {
  object: object;
  frameDocument: object;
  frameId: string;
  frameNavigationGeneration: number;
  fingerprint: string;
}
/** Opaque owner-local reference whose identity is checked against retained membership. */
export interface PrivateSemanticReference {
  readonly privateReference: true;
}
/** Fail-closed refusal from supplied-input validation or private custody checks. */
export type PrivateBindingRefusal =
  'terminal' | 'stale' | 'expired' | 'capacity' | 'invalidObservation';
/** Private result carrying either retained output or an explicit refusal. */
export type PrivateBindingResult<T> =
  { ok: true; value: T } | { ok: false; reason: PrivateBindingRefusal };
interface BindingRecord {
  input: SuppliedPrivateSemanticBinding;
  generation: PrivateSemanticGeneration;
  cellRevision: object;
  end: number;
}
const generationKeys = [
  'browserId',
  'browserGeneration',
  'tabId',
  'navigationGeneration',
  'viewportVersion',
  'epoch',
  'inputGeneration',
  'treeRevision',
] as const;
const encoder = new TextEncoder();
/** Opaque fixture-local supplied state, not native provenance or authenticated generation authority. */
export interface SuppliedSemanticGenerationCell {
  readonly suppliedGenerationCell: true;
}
interface CellRecord {
  generation: PrivateSemanticGeneration;
  revision: object;
}
const cells = new WeakMap<SuppliedSemanticGenerationCell, CellRecord>();
function sameGeneration(a: PrivateSemanticGeneration, b: PrivateSemanticGeneration): boolean {
  return generationKeys.every((key) => a[key] === b[key]);
}
function validGeneration(value: PrivateSemanticGeneration): boolean {
  return (
    typeof value.browserId === 'string' &&
    typeof value.tabId === 'string' &&
    generationKeys
      .filter((key) => !['browserId', 'tabId'].includes(key))
      .every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
  );
}
function validInput(value: SuppliedPrivateSemanticBinding): boolean {
  return (
    !!value.object &&
    typeof value.object === 'object' &&
    !!value.frameDocument &&
    typeof value.frameDocument === 'object' &&
    typeof value.frameId === 'string' &&
    Number.isSafeInteger(value.frameNavigationGeneration) &&
    value.frameNavigationGeneration >= 0 &&
    typeof value.fingerprint === 'string' &&
    encoder.encode(value.fingerprint).length <= 256 * 1024
  );
}
/** The real native producer/synchronous publication discipline is a separate mandatory prerequisite. */
export function createSuppliedSemanticGenerationCell(
  initial: PrivateSemanticGeneration
): SuppliedSemanticGenerationCell {
  if (!validGeneration(initial)) throw new Error('Invalid supplied semantic generation');
  const cell = Object.freeze({ suppliedGenerationCell: true as const });
  cells.set(cell, { generation: { ...initial }, revision: {} });
  return cell;
}
/** Private owner publishes before restrictive changes become observable; this certifies no native fact. */
export function publishSuppliedSemanticGeneration(
  cell: SuppliedSemanticGenerationCell,
  next: PrivateSemanticGeneration
): boolean {
  const record = cells.get(cell);
  if (!record || !validGeneration(next)) return false;
  if (!sameGeneration(record.generation, next)) {
    record.generation = { ...next };
    record.revision = {};
  }
  return true;
}
/**
 * Trusted supplied plain inputs only; no Page, actor, native observation or public lease constructor.
 * Clock/context callbacks are reentrancy boundaries. Terminal/current-revision checks follow both.
 */
export function createPrivateSemanticBindings(
  cell: SuppliedSemanticGenerationCell,
  readGeneration: () => PrivateSemanticGeneration | null,
  now: () => number
) {
  const records = new Map<PrivateSemanticReference, BindingRecord>();
  let revision: object = {};
  let terminal = false;
  let lastTime = -Infinity;
  let retainedGeneration: PrivateSemanticGeneration | null = null;
  const refuse = (reason: PrivateBindingRefusal): PrivateBindingResult<never> => ({
    ok: false,
    reason,
  });
  const sample = (
    expected: object
  ): PrivateBindingResult<{
    generation: PrivateSemanticGeneration;
    cellRevision: object;
    initialTime: number;
    time: number;
  }> => {
    if (terminal) return refuse('terminal');
    const cellRecord = cells.get(cell);
    if (!cellRecord) return refuse('invalidObservation');
    const cellRevision = cellRecord.revision;
    const cellGeneration = cellRecord.generation;
    const fence = () =>
      !terminal &&
      revision === expected &&
      cells.get(cell) === cellRecord &&
      cellRecord.revision === cellRevision &&
      cellRecord.generation === cellGeneration;
    const staleCell = () => {
      // Retire only old-generation obligations; never clear a newer nested cohort.
      for (const [ref, record] of records)
        if (record.cellRevision !== cellRecord.revision) records.delete(ref);
      if (retainedGeneration && !sameGeneration(retainedGeneration, cellRecord.generation))
        retainedGeneration = null;
      return refuse('stale');
    };
    let generation: PrivateSemanticGeneration | null;
    let time: number;
    try {
      generation = readGeneration();
    } catch {
      return refuse('invalidObservation');
    }
    if (terminal) return refuse('terminal');
    if (revision !== expected) return refuse('stale');
    if (!generation || !validGeneration(generation)) return refuse('invalidObservation');
    // Copy trusted primitive fields before the second external observation.
    const captured = { ...generation };
    try {
      time = now();
    } catch {
      return refuse('invalidObservation');
    }
    if (terminal) return refuse('terminal');
    if (revision !== expected) return refuse('stale');
    if (!Number.isFinite(time) || time < 0 || time < lastTime) return refuse('invalidObservation');
    let checked: PrivateSemanticGeneration | null;
    try {
      checked = readGeneration();
    } catch {
      return refuse('invalidObservation');
    }
    if (terminal) return refuse('terminal');
    if (revision !== expected) return refuse('stale');
    if (
      !checked ||
      !validGeneration(checked) ||
      !sameGeneration(captured, checked) ||
      !sameGeneration(captured, cellGeneration) ||
      !fence()
    )
      return staleCell();
    const initialTime = time;
    // Final generation observation may itself cross expiry. Sample time AFTER it.
    try {
      time = now();
    } catch {
      return refuse('invalidObservation');
    }
    // No external callback follows this genuine-local cell fence inside this sample.
    if (terminal) return refuse('terminal');
    if (!fence()) return staleCell();
    if (!Number.isFinite(time) || time < initialTime || time < lastTime)
      return refuse('invalidObservation');
    if (retainedGeneration && !sameGeneration(retainedGeneration, captured)) {
      for (const [ref, record] of records)
        if (!sameGeneration(record.generation, captured)) records.delete(ref);
    }
    for (const [ref, record] of records)
      if (record.cellRevision !== cellRevision) records.delete(ref);
    retainedGeneration = captured;
    lastTime = time;
    return { ok: true, value: { generation: captured, cellRevision, initialTime, time } };
  };
  const dropExpired = (time: number) => {
    for (const [ref, record] of records) if (time >= record.end) records.delete(ref);
  };
  return {
    retain(input: SuppliedPrivateSemanticBinding): PrivateBindingResult<PrivateSemanticReference> {
      const expected = revision;
      const current = sample(expected);
      if (!current.ok) return current;
      if (!validInput(input)) return refuse('invalidObservation');
      const end = current.value.initialTime + 2000;
      if (current.value.time >= end) return refuse('expired');
      dropExpired(current.value.time);
      if (records.size >= 2000) return refuse('capacity');
      const ref = Object.freeze({ privateReference: true as const });
      records.set(ref, {
        input: { ...input },
        generation: current.value.generation,
        cellRevision: current.value.cellRevision,
        end,
      });
      return { ok: true, value: ref };
    },
    resolve(
      ref: PrivateSemanticReference,
      candidate: SuppliedPrivateSemanticBinding
    ): PrivateBindingResult<object> {
      const expected = revision;
      const current = sample(expected);
      if (!current.ok) return current;
      const record = records.get(ref);
      if (!record || !validInput(candidate)) return refuse('stale');
      if (current.value.time >= record.end) {
        records.delete(ref);
        return refuse('expired');
      }
      if (
        record.cellRevision !== current.value.cellRevision ||
        !sameGeneration(record.generation, current.value.generation) ||
        record.input.object !== candidate.object ||
        record.input.frameDocument !== candidate.frameDocument ||
        record.input.frameId !== candidate.frameId ||
        record.input.frameNavigationGeneration !== candidate.frameNavigationGeneration ||
        record.input.fingerprint !== candidate.fingerprint
      ) {
        records.delete(ref);
        return refuse('stale');
      }
      return { ok: true, value: record.input.object };
    },
    /** Dirty/replacement/reset is terminal for the entire old reference set, not the owner. */
    invalidateCurrent(): void {
      revision = {};
      records.clear();
      retainedGeneration = null;
    },
    /** Publish terminal state before clearing custody; this owner never resumes. */
    retire(): void {
      terminal = true;
      revision = {};
      records.clear();
      retainedGeneration = null;
    },
    /** Internal logical-custody seam; never a native allocation/capacity receipt. */
    retainedCount(): number {
      return records.size;
    },
  };
}
