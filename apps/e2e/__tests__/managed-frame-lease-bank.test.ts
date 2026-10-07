import { describe, expect, it } from 'vitest';
import {
  OriginalFrameLeaseBank,
  originalFramePriorDraw,
  joinOriginalFrameLeaseSetup,
  parseOriginalFrameQueue,
} from '../fixtures/managed-frame-lease-bank';
const binding = {
  browserId: 'original_browser_fixture_0001',
  browserGeneration: 1,
  tabId: 'original_tab_fixture_00000001',
  navigationGeneration: 2,
  viewportVersion: 0,
  epoch: 3,
  inputGeneration: 4,
};
const viewer = (viewerId: string) => ({
  viewerId,
  binding: { ...binding },
  expiresAt: new Date(30_000).toISOString(),
});
describe('original page lease lineage (controlled HTTP observations, not native acceptance)', () => {
  it('keeps natural primary renewal in its original role and exact canonical scope', () => {
    const bank = new OriginalFrameLeaseBank();
    bank.record('primary', viewer('original_primary_viewer_0001'));
    bank.record('primary', viewer('original_primary_viewer_0002'));
    bank.record('secondary', viewer('original_second_viewer_00001'));
    expect(bank.role('original_primary_viewer_0001', binding)).toBe('primary');
    expect(bank.role('original_primary_viewer_0002', binding)).toBe('primary');
    expect(bank.role('original_second_viewer_00001', binding)).toBe('secondary');
  });
  it.each(['navigationGeneration', 'epoch', 'inputGeneration'] as const)(
    'rejects original lease with changed %s',
    (key) => {
      const bank = new OriginalFrameLeaseBank();
      bank.record('primary', viewer('original_primary_viewer_0001'));
      expect(() =>
        bank.role('original_primary_viewer_0001', { ...binding, [key]: binding[key] + 1 })
      ).toThrow('FRAME_ORIGINAL_LEASE_SCOPE_UNKNOWN');
    }
  );
  it('rejects unseen viewers and same-ID substitution between original pages', () => {
    const bank = new OriginalFrameLeaseBank();
    bank.record('primary', viewer('original_primary_viewer_0001'));
    expect(() => bank.role('unseen_original_viewer_00001', binding)).toThrow(
      'FRAME_ORIGINAL_LEASE_SCOPE_UNKNOWN'
    );
    expect(() => bank.record('secondary', viewer('original_primary_viewer_0001'))).toThrow(
      'FRAME_ORIGINAL_LEASE_SUBSTITUTED'
    );
  });
  it('admits only an actual fresh secondary lease, retaining the real expiration bound', () => {
    const bank = new OriginalFrameLeaseBank();
    const original = bank.record('secondary', viewer('original_second_viewer_00001'));
    expect(bank.assertStallLease(original.viewerId, binding, 1000).expiresAt).toBe(
      original.expiresAt
    );
    expect(() => bank.assertStallLease(original.viewerId, binding, 19_000)).toThrow(
      'FRAME_ORIGINAL_STALL_LEASE_TOO_SHORT'
    );
    bank.record('primary', viewer('original_primary_viewer_0001'));
    expect(() => bank.assertStallLease('original_primary_viewer_0001', binding, 1000)).toThrow(
      'FRAME_ORIGINAL_STALL_ROLE_UNKNOWN'
    );
  });
});

describe('original publisher queue shape', () => {
  const sample = {
    at: 10,
    binding,
    viewerId: 'original_primary_viewer_0001',
    pendingFrames: 0,
    pendingBytes: 0,
    encodingMs: null,
    droppedFrames: 0,
    closed: false,
  };
  it('retains honest initial null rows and actual finite encoder observations', () => {
    expect(parseOriginalFrameQueue({ samples: [sample, { ...sample, encodingMs: 2.5 }] })).toEqual([
      sample,
      { ...sample, encodingMs: 2.5 },
    ]);
  });
  it.each([
    { pendingFrames: 2 },
    { pendingBytes: 2097153 },
    { encodingMs: NaN },
    { droppedFrames: -1 },
  ])('refuses invalid actual publisher counters %j', (change) => {
    expect(() => parseOriginalFrameQueue({ samples: [{ ...sample, ...change }] })).toThrow();
  });
  it('refuses additional fields and oversized banks rather than silently dropping rows', () => {
    expect(() =>
      parseOriginalFrameQueue({ samples: [{ ...sample, ticket: 'not accepted' }] })
    ).toThrow();
    expect(() => parseOriginalFrameQueue({ samples: Array(8193).fill(sample) })).toThrow(
      'FRAME_ORIGINAL_QUEUE_BOUND'
    );
  });
});

describe('genuine first-next and response-body cleanup seams', () => {
  it('passes initial no-receipt next and validates subsequent original drawn receipt', () => {
    expect(originalFramePriorDraw({ viewer: { ticket: 'private-owned' } })).toBeNull();
    const receipt = {
      binding,
      viewerId: 'original_primary_viewer_0001',
      frameId: 'original_frame_fixture_00001',
      sequence: 1,
      stage: 'drawn',
      drawnAt: new Date(1000).toISOString(),
    };
    expect(originalFramePriorDraw({ receipt })).toEqual(receipt);
    expect(() => originalFramePriorDraw({ receipt: undefined })).toThrow();
    expect(() => originalFramePriorDraw({ receipt: null })).toThrow();
  });
  it.each([false, undefined])(
    'cancels primary before joining held body and retains first %s',
    async (cause) => {
      let releaseBody!: () => void, releaseSecondary!: () => void;
      const body = new Promise<void>((yes) => {
        releaseBody = yes;
      });
      const secondary = new Promise<void>((yes) => {
        releaseSecondary = yes;
      });
      let enterSecondary!: () => void;
      const secondaryEntered = new Promise<void>((yes) => {
        enterSecondary = yes;
      });
      const calls: string[] = [];
      let returned = false;
      const original = joinOriginalFrameLeaseSetup({
        first: { value: cause },
        originals: [body],
        async closePrimary() {
          calls.push('primary');
          releaseBody();
          throw new Error('later close failure');
        },
        async unrouteSecondary() {
          calls.push('unroute');
        },
        async closeSecondary() {
          calls.push('secondary');
          enterSecondary();
          await secondary;
        },
      });
      const result = original
        .then(
          () => ({ kind: 'resolved' as const }),
          (value) => ({ kind: 'rejected' as const, value })
        )
        .finally(() => {
          returned = true;
        });
      try {
        await secondaryEntered;
        expect(calls).toContain('primary');
        expect(returned).toBe(false);
        releaseSecondary();
        expect(await result).toEqual({ kind: 'rejected', value: cause });
        expect(calls).toEqual(['primary', 'unroute', 'secondary']);
      } finally {
        releaseBody();
        releaseSecondary();
        await result;
      }
    }
  );
});
