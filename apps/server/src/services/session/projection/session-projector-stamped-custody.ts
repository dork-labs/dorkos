/** Isolated stamped-event custody; the original projector alone retains its actual instance. */
import type { SessionStateProjector } from '../session-state-projector.js';
import type { RawSessionEvent } from './session-projector-status-data.js';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** Allocate unrelated constructor/stamped-event maps and the original guarded readers. */
export function createIsolatedSessionProjectionCustody() {
  const originalProjectorIngest = new WeakMap<
    SessionStateProjector,
    (raw: RawSessionEvent) => SessionEvent
  >();
  const originalProjectionEvents = new WeakMap<
    object,
    { projector: SessionStateProjector; seq: number }
  >();
  /** Ingest through the projector's constructor-captured original implementation. */
  function ingestOriginalSessionProjection(
    projector: SessionStateProjector,
    raw: RawSessionEvent
  ): SessionEvent {
    const run = originalProjectorIngest.get(projector);
    if (!run) throw new Error('Session projection constructor is not original.');
    const event = run(raw);
    originalProjectionEvents.set(event, { projector, seq: event.seq });
    return event;
  }
  /** Require the projector's exact original stamped event. */
  function requireOriginalSessionProjection(
    projector: SessionStateProjector,
    event: SessionEvent
  ): void {
    const own = originalProjectionEvents.get(event);
    if (
      !own ||
      own.projector !== projector ||
      own.seq !== event.seq ||
      !originalProjectorIngest.has(projector)
    )
      throw new Error('Session projection is not original.');
  }
  /** Return constructor-private stamped sequence, after one own DATA-descriptor check. */
  function readOriginalSessionProjectionSequence(
    projector: SessionStateProjector,
    event: SessionEvent
  ): number {
    const own = originalProjectionEvents.get(event),
      slot = Object.getOwnPropertyDescriptor(event, 'seq');
    if (
      !own ||
      own.projector !== projector ||
      !originalProjectorIngest.has(projector) ||
      !Number.isSafeInteger(own.seq) ||
      own.seq < 1 ||
      !slot ||
      !('value' in slot) ||
      slot.value !== own.seq
    )
      throw new Error('Original stamped projection sequence changed');
    return own.seq;
  }
  return Object.freeze({
    originalProjectorIngest,
    ingestOriginalSessionProjection,
    requireOriginalSessionProjection,
    readOriginalSessionProjectionSequence,
  });
}
