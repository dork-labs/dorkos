/** Fictitious references for contract subjects; no browser, credentials or page state. */
import type {
  SemanticActionV1,
  SemanticNodeV1,
  SemanticSnapshotV1,
  SemanticEditCorrelationV1,
} from '../browser-schemas.js';

/** Deterministic distinct wire references, never production authority. */
export const reference = (number: number): string => `fixture_${String(number).padStart(24, '0')}`;
/** Canonical fixture binding. */
export const binding = {
  browserId: reference(1),
  browserGeneration: 0,
  tabId: reference(2),
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
/** Admission identity without lease. */
export const admission = {
  version: 1 as const,
  ...binding,
  treeId: reference(3),
  treeRevision: 1,
  grantRevision: 0,
};
/** Full leased fixture identity. */
export const identity = { ...admission, semanticLeaseId: reference(4) };
/** One native plain-text editor projection. */
export const node = (): SemanticNodeV1 => ({
  nodeRef: reference(5),
  frameId: reference(6),
  frameNavigationGeneration: 0,
  parentRef: null,
  childRefs: [],
  role: 'textbox',
  name: 'Fixture editor',
  states: { focused: true },
  editKind: 'plainText',
  actions: ['focus', 'insertText', 'replaceText', 'key'],
  redacted: false,
  truncated: false,
  value: 'initial',
});
/** One complete snapshot subject. */
export const snapshot = (): SemanticSnapshotV1 => ({
  ...identity,
  capturedAt: '2026-10-02T12:00:00.000Z',
  expiresInMs: 2000,
  rootRefs: [reference(5)],
  nodes: [node()],
  focusedRef: reference(5),
  focusState: 'node',
  focusRevision: 0,
  completeness: 'complete',
});
/** Explicit edit on its initiating event stream. */
export const edit = (): SemanticActionV1 => ({
  requestId: reference(7),
  identity,
  frameId: reference(6),
  frameNavigationGeneration: 0,
  nodeRef: reference(5),
  focusRevision: 0,
  eventStreamId: reference(8),
  action: { kind: 'insertText', text: '🙂界' },
});
/** Completed edit with two ordered notifications covering its fresh revision. */
export const correlation = (): SemanticEditCorrelationV1 => ({
  request: edit(),
  previousEventSequence: 10,
  receipt: {
    version: 1,
    requestId: reference(7),
    identity: admission,
    outcome: 'completed',
    editContinuation: {
      identity: { ...identity, treeRevision: 2, semanticLeaseId: reference(9) },
      frameId: reference(6),
      frameNavigationGeneration: 0,
      nodeRef: reference(14),
      focusRevision: 1,
      expiresInMs: 2000,
      eventStreamId: reference(8),
      coveredEventSequence: 12,
      allowedKinds: ['insertText', 'replaceText', 'key'],
    },
  },
  events: [
    {
      version: 1,
      sequence: 11,
      eventStreamId: reference(8),
      identity: { ...admission, treeRevision: 2 },
      type: 'dirty',
      reason: 'domChanged',
      editRequestId: reference(7),
    },
    {
      version: 1,
      sequence: 12,
      eventStreamId: reference(8),
      identity: { ...admission, treeRevision: 2 },
      type: 'focusChanged',
      reason: 'selectionChanged',
      editRequestId: reference(7),
      focus: {
        frameId: reference(6),
        frameNavigationGeneration: 0,
        focusedRef: reference(14),
        focusRevision: 1,
        focusState: 'node',
      },
    },
  ],
});

/** Maximum scalar-width fixture, not runtime resource or native capacity evidence. */
export function maximumDiagnosticSummary() {
  const max = Number.MAX_SAFE_INTEGER;
  return {
    binding: {
      ...binding,
      browserId: 'B'.repeat(64),
      tabId: 'T'.repeat(64),
      browserGeneration: max,
      navigationGeneration: max,
      viewportVersion: max,
      epoch: max,
      inputGeneration: max,
    },
    interval: { startOffsetMs: max, endOffsetMs: max },
    entries: Array.from({ length: 256 }, (_, i) => ({
      sequence: max - 255 + i,
      atOffsetMs: max,
      category: 'network' as const,
      requestId: 'request_9007199254740991',
      method: 'OPTIONS' as const,
      resource: 'document' as const,
      status: 'informational' as const,
      duration: 'atLeast10s' as const,
    })),
    counts: { dropped: max, truncated: max, correlationDropped: max, unmatchedCallbacks: max },
    terminal: 'counterExhausted' as const,
    lastAccountedSequence: max,
    subsequentEventsUncounted: true,
  };
}
