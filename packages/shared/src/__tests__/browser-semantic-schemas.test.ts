import { describe, it, expect } from 'vitest';
import {
  SemanticSnapshotV1Schema,
  SemanticNodeV1Schema,
  SemanticActionV1Schema,
  SemanticEventV1Schema,
  SemanticReceiptV1Schema,
  SemanticEditContinuationV1Schema,
  SemanticErrorV1Schema,
  SemanticRoleV1Schema,
  SemanticKeyV1Schema,
} from '../browser-schemas.js';
import {
  snapshot,
  node,
  edit,
  correlation,
  reference,
  admission,
} from './browser-schema-fixtures.js';

// These subjects verify structural wire safety; no authentication or real Page effect is asserted.
describe('frozen semantic v1 wire', () => {
  it('accepts a complete editor forest and exact Unicode edit', () => {
    expect(SemanticSnapshotV1Schema.parse(snapshot()).nodes[0].value).toBe('initial');
    expect(SemanticActionV1Schema.parse(edit()).action).toEqual({
      kind: 'insertText',
      text: '🙂界',
    });
  });
  it('rejects unknown major versions, roles, free-form keys and forged actor/owner fields', () => {
    expect(SemanticSnapshotV1Schema.safeParse({ ...snapshot(), version: 2 }).success).toBe(false);
    expect(SemanticRoleV1Schema.safeParse('application').success).toBe(false);
    expect(SemanticKeyV1Schema.safeParse('Meta+R').success).toBe(false);
    for (const field of [
      'actorId',
      'ownerId',
      'isHuman',
      'backendNodeId',
      'selector',
      'cdp',
      'profilePath',
    ]) {
      expect(
        SemanticActionV1Schema.safeParse({ ...edit(), [field]: reference(20) }).success,
        field
      ).toBe(false);
    }
    expect(
      SemanticActionV1Schema.safeParse({
        ...edit(),
        identity: { ...edit().identity, grantId: reference(20) },
      }).success
    ).toBe(false);
  });
  it('bounds safe integers, random references, UTF-8 bytes and entire action envelopes', () => {
    for (const revision of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(
        SemanticSnapshotV1Schema.safeParse({
          ...snapshot(),
          treeRevision: revision,
        }).success
      ).toBe(false);
    for (const id of ['short', 'x'.repeat(65), '/private/profile/path', 'é'.repeat(22)])
      expect(SemanticActionV1Schema.safeParse({ ...edit(), nodeRef: id }).success).toBe(false);
    expect(
      SemanticActionV1Schema.safeParse({
        ...edit(),
        action: { kind: 'insertText', text: '🙂'.repeat(512) },
      }).success
    ).toBe(true);
    expect(
      SemanticActionV1Schema.safeParse({
        ...edit(),
        action: { kind: 'insertText', text: '🙂'.repeat(513) },
      }).success
    ).toBe(false);
    expect(
      SemanticActionV1Schema.safeParse({
        ...edit(),
        action: { kind: 'insertText', text: '\ud800' },
      }).success
    ).toBe(false);
  });
  it('requires stream identity for edits and prohibits it for nonedit commands', () => {
    const request = edit();
    const { eventStreamId: _stream, ...withoutStream } = request;
    expect(SemanticActionV1Schema.safeParse(withoutStream).success).toBe(false);
    expect(
      SemanticActionV1Schema.safeParse({
        ...request,
        action: { kind: 'focus' },
      }).success
    ).toBe(false);
    expect(
      SemanticActionV1Schema.safeParse({
        ...withoutStream,
        action: { kind: 'focus' },
      }).success
    ).toBe(true);
  });
  it('rejects duplicate/dangling references, nonreciprocal hierarchy, cycles and wrong focus', () => {
    const initial = snapshot();
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...initial,
        nodes: [node(), node()],
      }).success
    ).toBe(false);
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...initial,
        rootRefs: [reference(30)],
      }).success
    ).toBe(false);
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...initial,
        nodes: [{ ...node(), childRefs: [reference(30)] }],
      }).success
    ).toBe(false);
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...initial,
        rootRefs: [],
        nodes: [{ ...node(), parentRef: node().nodeRef, childRefs: [node().nodeRef] }],
      }).success
    ).toBe(false);
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...initial,
        focusedRef: reference(30),
      }).success
    ).toBe(false);
  });
  it('accepts depth32 but refuses depth33 and more than32 frame documents', () => {
    function chain(count: number, frames = false) {
      const nodes = Array.from({ length: count }, (_, index) => ({
        ...node(),
        nodeRef: reference(100 + index),
        parentRef: index ? reference(99 + index) : null,
        childRefs: index + 1 < count ? [reference(101 + index)] : [],
        frameId: frames ? reference(300 + index) : node().frameId,
        states: {},
        actions: [],
      }));
      return {
        ...snapshot(),
        rootRefs: [reference(100)],
        nodes,
        focusedRef: null,
        focusState: 'none',
      };
    }
    expect(SemanticSnapshotV1Schema.safeParse(chain(32)).success).toBe(true);
    expect(SemanticSnapshotV1Schema.safeParse(chain(33)).success).toBe(false);
    const wide = {
      ...chain(33, true),
      rootRefs: Array.from({ length: 33 }, (_, index) => reference(100 + index)),
      nodes: chain(33, true).nodes.map((item) => ({
        ...item,
        parentRef: null,
        childRefs: [],
      })),
    };
    expect(SemanticSnapshotV1Schema.safeParse(wide).success).toBe(false);
    const wrongDocument = {
      ...snapshot(),
      nodes: [
        node(),
        {
          ...node(),
          nodeRef: reference(50),
          parentRef: null,
          frameNavigationGeneration: 1,
          states: {},
        },
      ],
      rootRefs: [node().nodeRef, reference(50)],
    };
    expect(SemanticSnapshotV1Schema.safeParse(wrongDocument).success).toBe(false);
  });
  it('rejects more than2000 nodes and a snapshot exceeding256KiB', () => {
    const many = Array.from({ length: 2001 }, (_, index) => ({
      ...node(),
      nodeRef: reference(100 + index),
      actions: [],
      states: {},
    }));
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...snapshot(),
        nodes: many,
        rootRefs: many.map((item) => item.nodeRef),
        focusedRef: null,
        focusState: 'none',
      }).success
    ).toBe(false);
    const large = many.slice(0, 150).map((item) => ({ ...item, text: 'x'.repeat(2048) }));
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...snapshot(),
        nodes: large,
        rootRefs: large.map((item) => item.nodeRef),
        focusedRef: null,
        focusState: 'none',
      }).success
    ).toBe(false);
  });
  it('makes truncated/unavailable snapshots read-only and requires truthful reasons', () => {
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...snapshot(),
        completeness: 'truncated',
        reason: 'limit',
      }).success
    ).toBe(false);
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...snapshot(),
        completeness: 'truncated',
        reason: 'limit',
        nodes: [{ ...node(), actions: [] }],
      }).success
    ).toBe(true);
    expect(SemanticSnapshotV1Schema.safeParse({ ...snapshot(), reason: 'limit' }).success).toBe(
      false
    );
    expect(
      SemanticSnapshotV1Schema.safeParse({
        ...snapshot(),
        completeness: 'unavailable',
        reason: 'unstable',
        nodes: [],
        rootRefs: [],
        focusedRef: null,
        focusState: 'none',
      }).success
    ).toBe(true);
  });
  it('enforces password noecho and native plain-text value eligibility', () => {
    const secret = {
      ...node(),
      name: 'Password field',
      editKind: 'secret',
      redacted: true,
      actions: ['focus', 'writeSecret'],
      value: undefined,
    };
    delete secret.value;
    expect(SemanticNodeV1Schema.safeParse(secret).success).toBe(true);
    for (const field of ['value', 'text', 'description', 'selection', 'length', 'axSource'])
      expect(
        SemanticNodeV1Schema.safeParse({
          ...secret,
          [field]: 'PASSWORD-SENTINEL',
        }).success,
        field
      ).toBe(false);
    expect(
      SemanticNodeV1Schema.safeParse({
        ...secret,
        name: 'Autofill credential hint',
      }).success
    ).toBe(false);
    expect(SemanticNodeV1Schema.safeParse({ ...node(), editKind: 'unsupported' }).success).toBe(
      false
    );
    expect(SemanticNodeV1Schema.safeParse({ ...node(), states: { readonly: true } }).success).toBe(
      false
    );
  });
  it('refuses unsafe output controls, split Unicode and description markup without sanitizing silently', () => {
    for (const name of ['x\u202ey', 'x\u0000y', 'x\udc00y', '界'.repeat(171)])
      expect(SemanticNodeV1Schema.safeParse({ ...node(), name }).success).toBe(false);
    expect(
      SemanticNodeV1Schema.safeParse({
        ...node(),
        description: '<img src=x onerror=alert(1)>',
      }).success
    ).toBe(false);
  });
  it('accepts each exact event payload and rejects mixed reasons, content and focus correlation', () => {
    const base = {
      version: 1,
      sequence: 0,
      eventStreamId: reference(8),
      identity: admission,
    };
    const subjects = [
      { ...base, type: 'ready', reason: 'initial' },
      { ...base, type: 'dirty', reason: 'domChanged' },
      { ...base, type: 'reset', reason: 'streamGap' },
      {
        ...base,
        type: 'controlChanged',
        reason: 'acquired',
        control: { controllerId: reference(40), status: 'ready' },
      },
      { ...base, type: 'revoked', reason: 'grantExpired' },
      { ...base, type: 'unavailable', reason: 'unstable' },
      {
        ...base,
        type: 'focusChanged',
        reason: 'focusChanged',
        focus: {
          frameId: null,
          frameNavigationGeneration: null,
          focusedRef: null,
          focusRevision: 0,
          focusState: 'none',
        },
      },
    ];
    expect(subjects.length).toBe(7);
    for (const subject of subjects) {
      expect(SemanticEventV1Schema.safeParse(subject).success).toBe(true);
      expect(SemanticEventV1Schema.safeParse({ ...subject, text: 'SECRET' }).success).toBe(false);
    }
    expect(
      SemanticEventV1Schema.safeParse({
        ...subjects[0],
        reason: 'grantExpired',
      }).success
    ).toBe(false);
    expect(
      SemanticEventV1Schema.safeParse({
        ...subjects[6],
        editRequestId: reference(7),
      }).success
    ).toBe(false);
    expect(
      SemanticEventV1Schema.safeParse({
        ...subjects[6],
        focus: {
          frameId: reference(6),
          frameNavigationGeneration: null,
          focusedRef: null,
          focusRevision: 0,
          focusState: 'unmapped',
        },
      }).success
    ).toBe(false);
  });
  it('enforces receipt outcome/reason conditions and exact continuation capability tuples', () => {
    const complete = correlation().receipt;
    expect(SemanticReceiptV1Schema.safeParse(complete).success).toBe(true);
    expect(SemanticReceiptV1Schema.safeParse({ ...complete, reason: 'deadline' }).success).toBe(
      false
    );
    expect(SemanticReceiptV1Schema.safeParse({ ...complete, outcome: 'uncertain' }).success).toBe(
      false
    );
    expect(
      SemanticReceiptV1Schema.safeParse({
        ...complete,
        outcome: 'uncertain',
        reason: 'deadline',
      }).success
    ).toBe(false);
    if (complete.outcome !== 'completed' || !complete.editContinuation)
      throw Error('Fixture must contain continuation');
    for (const allowedKinds of [
      ['key'],
      ['writeSecret', 'key'],
      ['key', 'replaceText', 'insertText'],
    ])
      expect(
        SemanticEditContinuationV1Schema.safeParse({
          ...complete.editContinuation,
          allowedKinds,
        }).success
      ).toBe(false);
    expect(
      SemanticReceiptV1Schema.safeParse({
        ...complete,
        editContinuation: { ...complete.editContinuation, text: 'SECRET' },
      }).success
    ).toBe(false);
    expect(
      SemanticErrorV1Schema.safeParse({
        version: 1,
        reason: 'inaccessible',
        identity: admission,
      }).success
    ).toBe(false);
  });
});
