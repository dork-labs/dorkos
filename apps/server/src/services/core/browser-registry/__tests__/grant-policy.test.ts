import { describe, expect, it } from 'vitest';
import type { BrowserGrant, BrowserPermission } from '@dorkos/shared/browser-schemas';
import { evaluateBrowserGrantMetadata, type BrowserGrantCorrespondence } from '../grant-policy.js';

const grantId = 'grant_abcdefghijklmnopqr';
const tabId = 'tab_abcdefghijklmnopqrst';
const sessionId = 'session_abcdefghijklmnop';
const roomId = 'room_abcdefghijklmnopqrs';
const expiry = Date.parse('2026-10-03T12:00:00.000Z');
const permissions: BrowserPermission[] = [
  'browser.view',
  'browser.control',
  'browser.secretInput',
  'browser.diagnostics',
  'browser.download',
  'browser.artifact',
  'browser.manageProfile',
];

function fixture(): { grant: BrowserGrant; scope: BrowserGrantCorrespondence } {
  return {
    grant: {
      grantId,
      grantRevision: 2,
      tabId,
      attachment: { kind: 'session', sessionId },
      permissions: ['browser.view'],
      expiresAt: '2026-10-03T12:00:00.000Z',
      revokedAt: null,
    },
    scope: { grantId, expectedRevision: 2, tabId, attachment: { kind: 'session', sessionId } },
  };
}

describe('browser grant metadata eligibility (not authority)', () => {
  it.each(permissions)('requires the explicit %s permission without a hierarchy', (permission) => {
    const { grant, scope } = fixture();
    grant.permissions = permissions.filter((item) => item !== permission);
    expect(evaluateBrowserGrantMetadata(grant, scope, permission, expiry - 1)).toBe('inaccessible');
    grant.permissions.push(permission);
    expect(evaluateBrowserGrantMetadata(grant, scope, permission, expiry - 1)).toBe(
      'metadataEligible'
    );
  });

  it('refuses at expiry equality and afterward, accepting the same metadata immediately before', () => {
    const { grant, scope } = fixture();
    expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', expiry - 1)).toBe(
      'metadataEligible'
    );
    for (const now of [expiry, expiry + 1, NaN, Infinity, -Infinity, -1]) {
      expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', now)).toBe('inaccessible');
    }
  });

  it('refuses any recorded revocation even when its timestamp is later than the supplied clock', () => {
    const { grant, scope } = fixture();
    expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', expiry - 1)).toBe(
      'metadataEligible'
    );
    grant.revokedAt = '2026-10-04T12:00:00.000Z';
    expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', expiry - 1)).toBe(
      'inaccessible'
    );
  });

  it('requires correspondence rather than treating a valid grant as access', () => {
    const { grant, scope } = fixture();
    for (const absent of [null, undefined]) {
      expect(evaluateBrowserGrantMetadata(grant, absent, 'browser.view', expiry - 1)).toBe(
        'inaccessible'
      );
    }
    expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', expiry - 1)).toBe(
      'metadataEligible'
    );
  });

  it('isolates grant identity, revision, tab and attachment mismatches', () => {
    const { grant, scope } = fixture();
    const mismatches: BrowserGrantCorrespondence[] = [
      { ...scope, grantId: 'other_abcdefghijklmnopqr' },
      { ...scope, expectedRevision: 1 },
      { ...scope, tabId: 'other_abcdefghijklmnopqr' },
      { ...scope, attachment: { kind: 'session', sessionId: 'other_abcdefghijklmnopqr' } },
      { ...scope, attachment: { kind: 'room', roomId: sessionId } },
    ];
    for (const mismatch of mismatches) {
      expect(evaluateBrowserGrantMetadata(grant, mismatch, 'browser.view', expiry - 1)).toBe(
        'inaccessible'
      );
    }
    expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', expiry - 1)).toBe(
      'metadataEligible'
    );
  });

  it('supports exact room correspondence without converting it into session membership', () => {
    const { grant, scope } = fixture();
    grant.attachment = { kind: 'room', roomId };
    expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', expiry - 1)).toBe(
      'inaccessible'
    );
    const roomScope = { ...scope, attachment: { kind: 'room' as const, roomId } };
    expect(evaluateBrowserGrantMetadata(grant, roomScope, 'browser.view', expiry - 1)).toBe(
      'metadataEligible'
    );
    expect(
      evaluateBrowserGrantMetadata(
        grant,
        { ...roomScope, attachment: { kind: 'room', roomId: sessionId } },
        'browser.view',
        expiry - 1
      )
    ).toBe('inaccessible');
  });

  it('gives malformed, unknown and tampered projections the same refusal', () => {
    const { grant, scope } = fixture();
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      { ...grant, expiresAt: 'not-time' },
      { ...grant, grantRevision: NaN },
      { ...grant, permissions: ['browser.unknown'] },
      { ...grant, actor: 'operator' },
      { ...grant, permissions: ['browser.view', 'browser.view'] },
      Object.defineProperty({ ...grant }, 'tabId', { get: () => tabId }),
    ];
    for (const candidate of invalid) {
      expect(evaluateBrowserGrantMetadata(candidate, scope, 'browser.view', expiry - 1)).toBe(
        'inaccessible'
      );
    }
    expect(evaluateBrowserGrantMetadata(grant, scope, 'browser.view', expiry - 1)).toBe(
      'metadataEligible'
    );
  });

  it('fails closed on malformed server correspondence and unknown operation permissions', () => {
    const { grant, scope } = fixture();
    for (const bad of [
      { ...scope, expectedRevision: NaN },
      { ...scope, tabId: '' },
    ]) {
      expect(evaluateBrowserGrantMetadata(grant, bad, 'browser.view', expiry - 1)).toBe(
        'inaccessible'
      );
    }
    expect(
      evaluateBrowserGrantMetadata(grant, scope, 'browser.unknown' as BrowserPermission, expiry - 1)
    ).toBe('inaccessible');
  });
});
