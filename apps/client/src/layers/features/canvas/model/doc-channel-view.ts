/** Pure rendering and receipt projection; none of these values can issue action authority. */
import type { Transport } from '@dorkos/shared/transport';
import type {
  CanvasChannelReplayResponse,
  CanvasChannelFrame,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';
import type { WidgetChannelPort } from '@/layers/features/gen-ui';
import type {
  FrameLifetimeController,
  FrameObservation,
  BoundDocPort,
} from '@/layers/shared/lib/canvas-doc-frame';
export interface NativeFrameAdmission {
  prepareFrameLoad(
    controller: FrameLifetimeController,
    observation: FrameObservation
  ): { completeLoad(): FrameObservation | null } | null;
  attachFrame(
    controller: FrameLifetimeController,
    observation: FrameObservation
  ): BoundDocPort | null;
  /** Nonissuing custody check for a previously completed original load during quarantine. */
  retainsLoadedFrame(controller: FrameLifetimeController, observation: FrameObservation): boolean;
  subscribeInvalidation(callback: () => void): () => void;
}

export type DocChannelSnapshot = Omit<CanvasChannelReplayResponse, 'events'>;
export interface DocChannelBinding {
  owner: object;
  verified: boolean;
  current: NonNullable<WidgetChannelPort['current']>;
  submit: WidgetChannelPort['submit'];
  inspect: WidgetChannelPort['inspect'];
  captureOriginal: NonNullable<WidgetChannelPort['captureOriginal']>;
}
/** Closed original MCP recording port; a displayed origin cannot manufacture this owner. */
export interface DocMcpBinding {
  readonly owner: object;
  readonly documentId: string;
  readonly generation: string;
  readonly origin: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelMcpOrigin;
  current(purpose: 'read' | 'submit'): boolean;
  captureOriginal: NonNullable<WidgetChannelPort['captureOriginal']>;
}
export interface DocChannelView {
  mcpBinding?: DocMcpBinding;
  documentId: string;
  transport: Transport;
  snapshot?: DocChannelSnapshot;
  events: CanvasChannelFrame[];
  available: boolean;
  binding?: DocChannelBinding;
  frameAdmission?: NativeFrameAdmission;
  /** Display-only initial owned HTTP disposition; it never authorizes submission. */
  replayObserved?: boolean;
}

/** Start or replace a displayed lifetime without an action fallback. */
export function emptyDocChannelView(documentId: string, transport: Transport): DocChannelView {
  return { documentId, transport, events: [], available: false };
}

/** Merge bounded receipts and state from an already-qualified snapshot. */
export function mergeDocChannelSnapshot(
  previous: DocChannelView,
  snapshot: DocChannelSnapshot,
  documentId: string,
  transport: Transport,
  routingCurrent: boolean,
  available: boolean
): DocChannelView {
  const current =
    previous.documentId === documentId && previous.transport === transport
      ? previous
      : emptyDocChannelView(documentId, transport);
  if (
    current.snapshot &&
    (snapshot.highWatermark < current.snapshot.highWatermark ||
      snapshot.stateRev < current.snapshot.stateRev)
  )
    return current;
  const receipts = new Map(
    (current.snapshot?.receipts ?? [])
      .filter((row) => row.receipt.docSeq >= snapshot.receiptRetentionFloor)
      .map((row) => [row.receipt.id, row])
  );
  for (const row of snapshot.receipts) receipts.set(row.receipt.id, row);
  return {
    ...current,
    available,
    snapshot: {
      ...snapshot,
      ...(routingCurrent ? {} : { routing: current.snapshot?.routing }),
      receipts: [...receipts.values()]
        .sort((a, b) => b.receipt.docSeq - a.receipt.docSeq)
        .slice(0, 400),
    },
    events: snapshot.resetRequired
      ? current.events.filter((frame) => frame.docSeq >= snapshot.retentionFloor)
      : current.events,
  };
}

/** Render state flags; currentness and effects remain controller-owned event callbacks. */
export function projectDocChannelPort(view: DocChannelView): WidgetChannelPort {
  const unavailable = async () => {
    throw Object.assign(new Error('Document actions are unavailable.'), { status: 409 });
  };
  return {
    documentId: view.documentId,
    enabled:
      view.available && view.binding?.verified === true && view.snapshot?.routing?.enabled === true,
    submissionOwner: view.binding?.owner,
    current: view.binding?.current ?? (() => false),
    approvedEventTypes: view.available ? (view.snapshot?.routing?.approvedEventTypes ?? []) : [],
    destinationLabel: view.available
      ? (view.snapshot?.routing?.destinationLabel ?? 'Actions unavailable')
      : 'Actions unavailable',
    ...(view.snapshot ? { snapshot: view.snapshot } : {}),
    submit: view.binding?.submit ?? unavailable,
    inspect: view.binding?.inspect ?? unavailable,
    captureOriginal: view.binding?.captureOriginal,
  };
}

/** Compare only inert snapshot revisions within the same full physical birth. */
export function isOlderDocChannelSnapshot(
  previous: DocChannelSnapshot | undefined,
  birth: CanvasDocIncarnation | undefined,
  incoming: DocChannelSnapshot
): boolean {
  return !!(
    previous &&
    birth &&
    incoming.incarnation &&
    sameCanvasDocIncarnation(birth, incoming.incarnation) &&
    (incoming.highWatermark < previous.highWatermark || incoming.stateRev < previous.stateRev)
  );
}

/** Append a qualified event to the bounded displayed history. */
export function appendDocChannelFrame(
  previous: DocChannelView,
  frame: CanvasChannelFrame,
  documentId: string,
  transport: Transport
): DocChannelView {
  const current =
    previous.documentId === documentId && previous.transport === transport
      ? previous
      : emptyDocChannelView(documentId, transport);
  return { ...current, events: [...current.events, frame].slice(-200) };
}

/** Validate inert replay/frame birth equality without creating or admitting an owner. */
export function assertDocChannelReplayIdentity(
  response: CanvasChannelReplayResponse,
  documentId: string
): void {
  if (
    response.incarnation &&
    (response.incarnation.documentId !== documentId ||
      response.events.some(
        (frame) =>
          frame.documentId !== documentId ||
          !frame.incarnation ||
          !sameCanvasDocIncarnation(response.incarnation!, frame.incarnation)
      ))
  ) {
    throw new Error('Document replay identity changed.');
  }
}
