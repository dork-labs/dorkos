/** Proposed portable tests only. Supplied fixture classifications are not native observations. */
import { describe, expect, it, vi } from 'vitest';
import {
  projectSuppliedSemanticForest,
  type SuppliedSemanticObservation,
  type SuppliedSemanticForest,
} from '../browser-semantic-sanitizer.js';
import { SemanticSnapshotV1Schema } from '../browser-semantic-schemas.js';
import { browserUtf8Bytes } from '../browser-schema-json.js';
import { identity, reference } from './browser-schema-fixtures.js';

function item(
  index = 0,
  overrides: Partial<SuppliedSemanticObservation> = {}
): SuppliedSemanticObservation {
  return {
    nodeRef: reference(100 + index),
    frameId: reference(20),
    frameNavigationGeneration: 0,
    parentRef: null,
    role: 'textbox',
    name: 'Ordinary label',
    sensitivity: 'ordinary',
    editKind: 'plainText',
    value: 'Ordinary value',
    states: {},
    candidateActions: ['focus', 'insertText', 'replaceText', 'key'],
    ...overrides,
  };
}
function forest(observations: SuppliedSemanticObservation[]): SuppliedSemanticForest {
  return {
    identity,
    capturedAt: '2026-10-03T12:00:00.000Z',
    expiresInMs: 2000,
    focusRevision: 0,
    focusedRef: null,
    observations,
  };
}
function output(observations: SuppliedSemanticObservation[]) {
  return projectSuppliedSemanticForest(forest(observations));
}
function chain(count: number): SuppliedSemanticObservation[] {
  return Array.from({ length: count }, (_, index) =>
    item(index, {
      parentRef: index ? reference(99 + index) : null,
      editKind: 'none',
      value: undefined,
      role: 'group',
      candidateActions: [],
    })
  );
}

describe('supplied semantic projection: no native or authority claims', () => {
  it.each([true, false, 'mixed'] as const)(
    'preserves the frozen supported pressed:%s state',
    (pressed) => {
      const projected = output([
        item(0, {
          role: 'button',
          editKind: 'none',
          value: undefined,
          states: { pressed },
          candidateActions: ['focus', 'activate'],
        }),
      ]).snapshot;
      expect(projected.completeness).toBe('complete');
      expect(projected.nodes).toHaveLength(1);
      expect(projected.nodes[0]).toMatchObject({
        states: { pressed },
        actions: ['focus', 'activate'],
      });
      expect(SemanticSnapshotV1Schema.safeParse(projected).success).toBe(true);
    }
  );

  it.each(['invalid', 1, null])(
    'refuses malformed pressed:%s without losing the healthy peer',
    (pressed) => {
      const subject = item(0, {
        role: 'button',
        editKind: 'none',
        value: undefined,
        candidateActions: ['focus', 'activate'],
      });
      Object.assign(subject, { states: { pressed } });
      expect(output([subject]).snapshot).toMatchObject({
        completeness: 'unavailable',
        reason: 'unstable',
        nodes: [],
      });
      expect(output([item(0, { states: { pressed: 'mixed' } })]).snapshot.completeness).toBe(
        'complete'
      );
    }
  );

  it('refuses an unknown state and a pressed accessor without evaluating its getter', () => {
    const unknown = item();
    Object.assign(unknown, { states: { remotePriority: true } });
    expect(output([unknown]).snapshot.completeness).toBe('unavailable');
    let reads = 0;
    const subject = item();
    Object.defineProperty(subject.states, 'pressed', {
      enumerable: true,
      get: () => {
        reads++;
        return 'mixed';
      },
    });
    expect(output([subject]).snapshot.completeness).toBe('unavailable');
    expect(reads).toBe(0);
  });

  it('keeps ordinary content but removes named sensitive values before fingerprint input', () => {
    const subjects = [
      item(),
      item(1, {
        sensitivity: 'secret',
        name: 'AUTOFILL_HINT_71',
        value: 'PASSWORD_VALUE_71',
        text: 'PASSWORD_SUBTREE_71',
        description: 'AX_SOURCE_71',
        candidateActions: ['focus', 'writeSecret'],
      }),
      item(2, { sensitivity: 'file', value: 'FILE_PATH_71' }),
      item(3, { sensitivity: 'unknownSensitive', value: 'UNKNOWN_SECRET_71' }),
    ];
    // Unknown plain payload properties are deliberately present but never copied.
    Object.assign(subjects[0], {
      backendNodeId: 'BACKEND_ID_71',
      url: 'TARGET_URL_71',
      axSource: 'AX_SOURCE_71',
    });
    const retainedSecretObservations: unknown[] = [];
    const retainedOrdinaryObservations: unknown[] = [];
    const set = Map.prototype.set;
    // Observe exact graph insertion while preserving the real Map operation. No source map is mocked.
    const insertion = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown
    ) {
      if (
        key === subjects[1].nodeRef &&
        value &&
        typeof value === 'object' &&
        'sensitivity' in value &&
        value.sensitivity === 'secret'
      )
        retainedSecretObservations.push({ ...value });
      if (
        key === subjects[0].nodeRef &&
        value &&
        typeof value === 'object' &&
        'sensitivity' in value &&
        value.sensitivity === 'ordinary'
      )
        retainedOrdinaryObservations.push({ ...value });
      return Reflect.apply(set, this, [key, value]);
    });
    let projected: ReturnType<typeof output>;
    try {
      projected = output(subjects);
    } finally {
      insertion.mockRestore();
    }
    expect(retainedSecretObservations).toHaveLength(1);
    expect(retainedOrdinaryObservations).toHaveLength(1);
    const retainedInput = JSON.stringify(retainedSecretObservations);
    expect(retainedInput).not.toContain('PASSWORD_VALUE_71');
    expect(retainedInput).not.toContain('AUTOFILL_HINT_71');
    for (const field of ['backendNodeId', 'url', 'axSource'])
      expect(retainedOrdinaryObservations[0]).not.toHaveProperty(field);
    expect(projected.snapshot.nodes).toHaveLength(4);
    expect(projected.snapshot.nodes[0].value).toBe('Ordinary value');
    expect(projected.snapshot.nodes[0].actions).toEqual([
      'focus',
      'insertText',
      'replaceText',
      'key',
    ]);
    expect(projected.snapshot.nodes[1]).toMatchObject({
      name: 'Password field',
      redacted: true,
      editKind: 'secret',
      actions: ['focus', 'writeSecret'],
    });
    for (const node of projected.snapshot.nodes.slice(1)) {
      expect(node).not.toHaveProperty('value');
      expect(node).not.toHaveProperty('text');
      expect(node).not.toHaveProperty('description');
    }
    for (const node of projected.snapshot.nodes.slice(2)) expect(node.actions).toEqual([]);
    const visible = JSON.stringify(projected.snapshot);
    const fingerprintInputs = JSON.stringify([...projected.fingerprints.values()]);
    for (const sentinel of [
      'PASSWORD_VALUE_71',
      'PASSWORD_SUBTREE_71',
      'AUTOFILL_HINT_71',
      'FILE_PATH_71',
      'UNKNOWN_SECRET_71',
      'AX_SOURCE_71',
      'BACKEND_ID_71',
      'TARGET_URL_71',
    ]) {
      expect(visible, `public:${sentinel}`).not.toContain(sentinel);
      expect(fingerprintInputs, `fingerprint:${sentinel}`).not.toContain(sentinel);
    }
    expect(fingerprintInputs).not.toContain('Ordinary value');
  });

  it('omits markup descriptions and refuses unknown-role action affordances', () => {
    const projected = output([
      item(0, { description: '<img src=x onerror="MARKUP_71">' }),
      item(1, { role: 'application', candidateActions: ['activate', 'insertText'] }),
    ]);
    expect(projected.snapshot.nodes).toHaveLength(2);
    expect(projected.snapshot.nodes[0]).not.toHaveProperty('description');
    expect(JSON.stringify(projected.snapshot)).not.toContain('MARKUP_71');
    expect(projected.snapshot.nodes[1]).toMatchObject({ role: 'unknown', actions: [] });
  });

  it('normalizes text without preserving unsafe controls or split surrogates', () => {
    const projected = output([item(0, { name: 'A\r\nB\rC\u0000\u0080\u202e\u2066🙂界\ud800' })]);
    expect(projected.snapshot.nodes[0].name).toBe('A\nB\nC🙂界');
    expect(projected.snapshot.completeness).toBe('complete');
  });

  it.each([
    ['name', 128, 512],
    ['description', 256, 1024],
    ['text', 512, 2048],
  ] as const)(
    'bounds %s by exact UTF8 bytes and makes an over-limit prefix globally read-only',
    (field, count, bytes) => {
      const healthy = output([item(0, { [field]: '🙂'.repeat(count) })]);
      expect(browserUtf8Bytes(healthy.snapshot.nodes[0][field]!)).toBe(bytes);
      expect(healthy.snapshot.completeness).toBe('complete');
      const limited = output([item(0, { [field]: '🙂'.repeat(count + 1) }), item(1)]);
      expect(limited.snapshot).toMatchObject({ completeness: 'truncated', reason: 'limit' });
      expect(browserUtf8Bytes(limited.snapshot.nodes[0][field]!)).toBe(bytes);
      expect(limited.snapshot.nodes.every((node) => node.actions.length === 0)).toBe(true);
      expect(SemanticSnapshotV1Schema.safeParse(limited.snapshot).success).toBe(true);
    }
  );

  it('never presents an editable prefix of an oversized ordinary value', () => {
    const healthy = output([item(0, { value: '🙂'.repeat(512) })]);
    expect(browserUtf8Bytes(healthy.snapshot.nodes[0].value!)).toBe(2048);
    expect(healthy.snapshot.nodes[0].editKind).toBe('plainText');
    const limited = output([item(0, { value: '🙂'.repeat(513) })]);
    expect(limited.snapshot.nodes[0]).toMatchObject({
      editKind: 'unsupported',
      truncated: true,
      actions: [],
    });
    expect(limited.snapshot.nodes[0]).not.toHaveProperty('value');
    expect(limited.snapshot.completeness).toBe('truncated');
  });

  it('preserves depth32 and publishes a reciprocal read-only prefix at depth33', () => {
    expect(output(chain(32)).snapshot.completeness).toBe('complete');
    const limited = output(chain(33)).snapshot;
    expect(limited.nodes).toHaveLength(32);
    expect(limited).toMatchObject({ completeness: 'truncated', reason: 'limit' });
    expect(limited.nodes[31].childRefs).toEqual([]);
    expect(limited.nodes.every((node) => node.actions.length === 0)).toBe(true);
    expect(SemanticSnapshotV1Schema.safeParse(limited).success).toBe(true);
  });

  it('bounds distinct supported frame documents and refuses inconsistent same-frame generations', () => {
    const subjects = Array.from({ length: 33 }, (_, index) =>
      item(index, { frameId: reference(500 + index) })
    );
    expect(output(subjects.slice(0, 32)).snapshot.completeness).toBe('complete');
    const limited = output(subjects).snapshot;
    expect(new Set(limited.nodes.map((node) => node.frameId)).size).toBe(32);
    expect(limited.completeness).toBe('truncated');
    expect(limited.nodes.every((node) => node.actions.length === 0)).toBe(true);
    const inconsistent = output([item(), item(1, { frameNavigationGeneration: 1 })]).snapshot;
    expect(inconsistent).toMatchObject({
      completeness: 'unavailable',
      reason: 'unstable',
      nodes: [],
    });
  });

  it('refuses an over-node supplied batch without claiming2000 public nodes fit the byte budget', () => {
    const subjects = Array.from({ length: 2001 }, (_, index) => item(index));
    const limited = output(subjects).snapshot;
    expect(limited).toMatchObject({ completeness: 'unavailable', reason: 'limit', nodes: [] });
    // Node-counter isolation is in the private reference-ledger test, not schema preflight.
    expect(output(subjects.slice(0, 2000)).snapshot.nodes.length).toBeGreaterThan(0);
    expect(output(subjects.slice(0, 2000)).snapshot.completeness).toBe('truncated');
  });

  it('counts the actual whole envelope and trims only a valid preordered suffix', () => {
    const subjects = Array.from({ length: 150 }, (_, index) =>
      item(index, {
        value: undefined,
        editKind: 'none',
        text: '界'.repeat(682),
        candidateActions: ['focus'],
      })
    );
    const one = output(subjects.slice(0, 1)).snapshot;
    expect(one.completeness).toBe('complete');
    const limited = output(subjects).snapshot;
    const actualBytes = browserUtf8Bytes(JSON.stringify(limited));
    expect(actualBytes).toBeLessThanOrEqual(262144);
    expect(limited.nodes.length).toBeGreaterThan(1);
    expect(limited.nodes.length).toBeLessThan(subjects.length);
    expect(limited).toMatchObject({ completeness: 'truncated', reason: 'limit' });
    expect(limited.nodes.every((node) => node.actions.length === 0)).toBe(true);
    expect(SemanticSnapshotV1Schema.safeParse(limited).success).toBe(true);
    // Independent raw sizing ensures this subject exercises the byte ceiling, not another limit.
    const rawNodes = subjects.map((subject) => ({
      ...one.nodes[0],
      nodeRef: subject.nodeRef,
      text: subject.text,
    }));
    expect(
      browserUtf8Bytes(
        JSON.stringify({ ...one, nodes: rawNodes, rootRefs: rawNodes.map((node) => node.nodeRef) })
      )
    ).toBeGreaterThan(262144);
  });

  it('rejects cycles/dangling parents and accessors without invoking supplied getters', () => {
    const dangling = output([item(0, { parentRef: reference(999) })]).snapshot;
    expect(dangling).toMatchObject({ completeness: 'unavailable', reason: 'unstable', nodes: [] });
    const cycle = output([
      item(0, { parentRef: reference(101) }),
      item(1, { parentRef: reference(100) }),
    ]).snapshot;
    expect(cycle.completeness).toBe('unavailable');
    let reads = 0;
    const subject = item();
    Object.defineProperty(subject, 'name', {
      enumerable: true,
      get: () => {
        reads++;
        return 'GETTER_71';
      },
    });
    expect(output([subject]).snapshot.completeness).toBe('unavailable');
    expect(reads).toBe(0);
  });
});
