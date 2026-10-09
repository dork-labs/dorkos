import { describe, it, expect } from 'vitest';
import { projectOriginalVMSemanticSnapshot } from '../semantic-projection.mjs';
const ref = (v: string) => v.repeat(22);
const identity = () => ({
  version: 1 as const,
  browserId: ref('b'),
  browserGeneration: 2,
  tabId: ref('t'),
  navigationGeneration: 3,
  viewportVersion: 4,
  treeId: ref('h'),
  semanticLeaseId: ref('l'),
  epoch: 5,
  inputGeneration: 6,
  grantRevision: 7,
});
const observation = () => ({
  guestLease: ref('g'),
  treeRef: ref('r'),
  revision: 9,
  capturedAt: new Date().toISOString(),
  expiresInMs: 2000,
  rootRefs: [],
  nodes: [],
  focusedRef: null,
  focusState: 'none',
  focusRevision: 0,
  completeness: 'unavailable',
  reason: 'engineUnavailable',
});
describe('VM semantic content projection (no origin or authorization mint)', () => {
  it('retains host identity while mapping a sanitized guest observation', () => {
    const host = identity(),
      guest = observation(),
      row = projectOriginalVMSemanticSnapshot(guest, host);
    expect(row.snapshot).toMatchObject(host);
    expect(row.snapshot.treeRevision).toBe(9);
    expect(row.snapshot.semanticLeaseId).not.toBe(guest.guestLease);
    expect(row.snapshot.treeId).not.toBe(guest.treeRef);
    expect(row.guestLease).toBe(guest.guestLease);
  });
  it('rejects guest attempts to graft host identity or native targets', () => {
    for (const key of [
      'browserId',
      'grantRevision',
      'semanticLeaseId',
      'treeId',
      'backendNodeId',
      'nativeFrameId',
    ])
      expect(() =>
        projectOriginalVMSemanticSnapshot(
          { ...observation(), [key]: identity().browserId },
          identity()
        )
      ).toThrow();
  });
  it('uses the actual canonical graph/sensitive node validator', () => {
    expect(() =>
      projectOriginalVMSemanticSnapshot({ ...observation(), rootRefs: [ref('n')] }, identity())
    ).toThrow();
    expect(() =>
      projectOriginalVMSemanticSnapshot({ ...observation(), expiresInMs: 2001 }, identity())
    ).toThrow();
    expect(() =>
      projectOriginalVMSemanticSnapshot(
        { ...observation(), nodes: [{ nodeRef: ref('n'), value: 'secret' }] },
        identity()
      )
    ).toThrow();
  });
  it('rejects missing, malformed and unbounded guest identity observations', () => {
    const value = observation();
    delete (value as Partial<typeof value>).focusRevision;
    expect(() => projectOriginalVMSemanticSnapshot(value, identity())).toThrow();
    expect(() =>
      projectOriginalVMSemanticSnapshot(
        { ...observation(), guestLease: 'not-a-reference' },
        identity()
      )
    ).toThrow();
    expect(() =>
      projectOriginalVMSemanticSnapshot(
        { ...observation(), revision: Number.MAX_SAFE_INTEGER + 1 },
        identity()
      )
    ).toThrow();
  });
});
