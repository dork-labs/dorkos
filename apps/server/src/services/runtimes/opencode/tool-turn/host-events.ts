/** Server-only tag: vendor JSON cannot acquire this symbol. */
import type { StreamEvent } from '@dorkos/shared/types';
import type { OpenCodeWireEvent } from '../events/event-mapper.js';

const HOST_EVENT = Symbol('opencode-host-event');
/** A host event carried through the existing single-consumer turn queue. */
export type OpenCodeHostEvent = StreamEvent & { readonly [HOST_EVENT]: true };
/** Internal input: native wire events or server-constructed host events. */
export type OpenCodeTurnEvent = OpenCodeWireEvent | OpenCodeHostEvent;

/** Tag an already-authorized host event without imitating a vendor permission. */
export function hostTurnEvent(event: StreamEvent): OpenCodeHostEvent {
  return { ...event, [HOST_EVENT]: true };
}

/** Recognize only the private server tag, never a vendor-provided string field. */
export function isHostTurnEvent(
  event: OpenCodeTurnEvent | StreamEvent
): event is OpenCodeHostEvent {
  return HOST_EVENT in event && event[HOST_EVENT] === true;
}
