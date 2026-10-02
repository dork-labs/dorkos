import { it, expect } from 'vitest';
import {
  SemanticEditCorrelationV1Schema,
  SemanticActionV1Schema,
  validateSemanticActionContext,
} from '../browser-schemas.js';
import { correlation, reference } from './browser-schema-fixtures.js';

// Receipt arrival order is outside a schema; this validates supplied ordered notification evidence.
it('accepts one exact edit stream watermark and rejects a peer stream, wrong request or wrong field', () => {
  expect(SemanticEditCorrelationV1Schema.safeParse(correlation()).success).toBe(true);
  const peer = correlation();
  peer.events[0].eventStreamId = reference(100);
  expect(SemanticEditCorrelationV1Schema.safeParse(peer).success).toBe(false);
  const wrongRequest = correlation();
  wrongRequest.receipt.requestId = reference(100);
  expect(SemanticEditCorrelationV1Schema.safeParse(wrongRequest).success).toBe(false);
  const wrongField = correlation();
  if (wrongField.receipt.outcome !== 'completed' || !wrongField.receipt.editContinuation)
    throw Error('Missing fixture continuation');
  wrongField.receipt.editContinuation.nodeRef = reference(100);
  expect(SemanticEditCorrelationV1Schema.safeParse(wrongField).success).toBe(false);
});
it('rejects sequence gaps, uncorrelated dirty events, unexpected focus and watermark overshoot', () => {
  const gap = correlation();
  gap.events[1].sequence++;
  expect(SemanticEditCorrelationV1Schema.safeParse(gap).success).toBe(false);
  const unrelated = correlation();
  if (unrelated.events[0].type !== 'dirty') throw Error('Missing dirty fixture');
  delete unrelated.events[0].editRequestId;
  expect(SemanticEditCorrelationV1Schema.safeParse(unrelated).success).toBe(false);
  const focus = correlation();
  if (focus.events[1].type !== 'focusChanged' || focus.events[1].reason !== 'selectionChanged')
    throw Error('Missing selection fixture');
  const { editRequestId: _editRequest, ...withoutCorrelation } = focus.events[1];
  focus.events[1] = { ...withoutCorrelation, reason: 'focusChanged' };
  expect(SemanticEditCorrelationV1Schema.safeParse(focus).success).toBe(false);
  const beyond = correlation();
  beyond.events.push({ ...beyond.events[0], sequence: 13 });
  expect(SemanticEditCorrelationV1Schema.safeParse(beyond).success).toBe(false);
});
it('rejects changed grants, epochs, frame documents and continuations without a fresh correlated dirty revision', () => {
  for (const field of [
    'grantRevision',
    'epoch',
    'inputGeneration',
    'browserGeneration',
    'navigationGeneration',
    'viewportVersion',
  ] as const) {
    const changed = correlation();
    changed.events[0].identity[field]++;
    expect(SemanticEditCorrelationV1Schema.safeParse(changed).success, field).toBe(false);
  }
  const frame = correlation();
  frame.request.frameNavigationGeneration++;
  expect(SemanticEditCorrelationV1Schema.safeParse(frame).success).toBe(false);
  const missingFresh = correlation();
  missingFresh.events[0].identity.treeRevision = 1;
  expect(SemanticEditCorrelationV1Schema.safeParse(missingFresh).success).toBe(false);
});
it('accepts secret write continuation without echo and rejects plain-text continuation on a secret request', () => {
  const secret = correlation();
  secret.request.action = { kind: 'writeSecret', mode: 'insert', text: 'PASSWORD-SENTINEL' };
  if (secret.receipt.outcome !== 'completed' || !secret.receipt.editContinuation)
    throw Error('Missing fixture continuation');
  expect(SemanticEditCorrelationV1Schema.safeParse(secret).success).toBe(false);
  secret.receipt.editContinuation.allowedKinds = ['writeSecret'];
  expect(SemanticEditCorrelationV1Schema.safeParse(secret).success).toBe(true);
  expect(JSON.stringify(secret.receipt)).not.toContain('PASSWORD-SENTINEL');
  expect(JSON.stringify(secret.events)).not.toContain('PASSWORD-SENTINEL');
});

it('rejects old node/lease reuse and notification revisions beyond the receipt watermark revision', () => {
  for (const old of ['node', 'lease']) {
    const value = correlation();
    if (value.receipt.outcome !== 'completed' || !value.receipt.editContinuation)
      throw Error('Missing fixture continuation');
    if (old === 'node') value.receipt.editContinuation.nodeRef = value.request.nodeRef;
    else
      value.receipt.editContinuation.identity.semanticLeaseId =
        value.request.identity.semanticLeaseId;
    expect(SemanticEditCorrelationV1Schema.safeParse(value).success, old).toBe(false);
  }
  const newer = correlation();
  newer.events[1].identity.treeRevision = 3;
  expect(SemanticEditCorrelationV1Schema.safeParse(newer).success).toBe(false);
});

it('classifies keyboard editing through trusted native context rather than caller body fields', () => {
  const value = correlation().request;
  value.action = { kind: 'key', key: 'Backspace' };
  expect(SemanticActionV1Schema.safeParse(value).success).toBe(true);
  const trusted = {
    editKind: 'plainText' as const,
    intent: 'edit' as const,
    liveEventStreamId: value.eventStreamId!,
  };
  expect(validateSemanticActionContext(value, trusted)).toBe(true);
  expect(validateSemanticActionContext(value, { ...trusted, intent: 'nonediting' })).toBe(false);
  expect(validateSemanticActionContext(value, { ...trusted, editKind: 'secret' })).toBe(false);
  expect(
    validateSemanticActionContext(value, { ...trusted, liveEventStreamId: reference(100) })
  ).toBe(false);
  const { eventStreamId: _stream, ...withoutStream } = value;
  expect(validateSemanticActionContext(withoutStream, trusted)).toBe(false);
  expect(
    validateSemanticActionContext(
      { ...withoutStream, action: { kind: 'key', key: 'Enter' } },
      { ...trusted, intent: 'nonediting' }
    )
  ).toBe(false);
  expect(
    SemanticActionV1Schema.safeParse({ ...value, editKind: 'plainText', intent: 'edit' }).success
  ).toBe(false);
  const correlated = correlation();
  correlated.request.action = value.action;
  expect(SemanticEditCorrelationV1Schema.safeParse(correlated).success).toBe(true);
});

// Original 7ff accepted editor-mutating keys without an edit stream solely from an inconsistent intent label.
it.each(['plainText', 'secret', 'unsupported'] as const)(
  'refuses ambiguous or value/selection-affecting keys mislabeled nonediting in %s editors',
  (editKind) => {
    const { eventStreamId: _stream, ...request } = correlation().request;
    for (const key of [
      'Backspace',
      'Delete',
      'Enter',
      'Space',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ] as const) {
      expect(
        validateSemanticActionContext(
          { ...request, action: { kind: 'key', key } },
          {
            editKind,
            intent: 'nonediting',
            liveEventStreamId: null,
          }
        ),
        key
      ).toBe(false);
    }
  }
);
it('preserves clear focus navigation and explicit noneditor activation without an edit stream', () => {
  const { eventStreamId: _stream, ...request } = correlation().request;
  for (const editKind of ['plainText', 'secret', 'unsupported'] as const)
    for (const key of ['Tab', 'ShiftTab', 'Escape'] as const)
      expect(
        validateSemanticActionContext(
          { ...request, action: { kind: 'key', key } },
          {
            editKind,
            intent: 'nonediting',
            liveEventStreamId: null,
          }
        ),
        `${editKind}/${key}`
      ).toBe(true);
  // Native button/link classification is supplied by the trusted engine, not inferred from the key.
  for (const key of ['Enter', 'Space'] as const)
    expect(
      validateSemanticActionContext(
        { ...request, action: { kind: 'key', key } },
        {
          editKind: 'none',
          intent: 'nonediting',
          liveEventStreamId: null,
        }
      ),
      key
    ).toBe(true);
});
it('refuses unknown classification and unsupported editor edits while preserving exact live-stream checks', () => {
  const request = correlation().request;
  for (const context of [
    { editKind: 'unknown', intent: 'nonediting', liveEventStreamId: null },
    { editKind: 'plainText', intent: 'unknown', liveEventStreamId: null },
    { editKind: 'unsupported', intent: 'edit', liveEventStreamId: request.eventStreamId! },
    { editKind: 'plainText', intent: 'edit', liveEventStreamId: reference(100) },
  ]) {
    expect(
      validateSemanticActionContext(
        request,
        context as Parameters<typeof validateSemanticActionContext>[1]
      )
    ).toBe(false);
  }
});

it.each([
  ['plainText', 'Delete'],
  ['plainText', 'Enter'],
  ['secret', 'Space'],
  ['unsupported', 'Space'],
] as const)('refuses %s/%s without a coherent edit path', (editKind, key) => {
  const { eventStreamId: _stream, ...request } = correlation().request;
  expect(
    validateSemanticActionContext(
      { ...request, action: { kind: 'key', key } },
      {
        editKind,
        intent: 'nonediting',
        liveEventStreamId: null,
      }
    )
  ).toBe(false);
});

it('refuses clear focus-navigation keys mislabeled as edits even with a live stream', () => {
  const request = correlation().request;
  for (const key of ['Tab', 'ShiftTab', 'Escape'] as const)
    expect(
      validateSemanticActionContext(
        { ...request, action: { kind: 'key', key } },
        {
          editKind: 'plainText',
          intent: 'edit',
          liveEventStreamId: request.eventStreamId!,
        }
      ),
      key
    ).toBe(false);
});
