/**
 * Reading an answered `extension.approval` row back, and deciding whether its
 * "Turn it on" can act in place (DOR-2517).
 */
import { describe, it, expect } from 'vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { canTurnOnInPlace, parseExtensionApprovalSubject } from '../lib/approval-subject';
import { extensionConsentCopy } from '../lib/consent-copy';

function record(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'flow',
    manifest: { id: 'flow', name: 'Flow', version: '1.2.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: false,
    ...overrides,
  };
}

describe('parseExtensionApprovalSubject', () => {
  it('splits the id from the version', () => {
    expect(parseExtensionApprovalSubject('flow@1.2.0')).toEqual({ id: 'flow', version: '1.2.0' });
  });

  it('answers null for anything not in that form', () => {
    expect(parseExtensionApprovalSubject('flow')).toBeNull();
    expect(parseExtensionApprovalSubject('@1.0.0')).toBeNull();
    expect(parseExtensionApprovalSubject('flow@')).toBeNull();
  });
});

describe('canTurnOnInPlace', () => {
  const subject = { id: 'flow', version: '1.2.0' };

  it('is true while the same version is still installed and still off', () => {
    expect(canTurnOnInPlace(subject, [record()])).toBe(true);
  });

  it('is false once it is on, turned off, gone, or a different version', () => {
    expect(canTurnOnInPlace(subject, [record({ approvedToRun: true })])).toBe(false);
    expect(canTurnOnInPlace(subject, [record({ status: 'disabled' })])).toBe(false);
    expect(canTurnOnInPlace(subject, [])).toBe(false);
    expect(canTurnOnInPlace(subject, undefined)).toBe(false);
    expect(
      canTurnOnInPlace(subject, [
        record({ manifest: { id: 'flow', name: 'Flow', version: '1.3.0' } }),
      ])
    ).toBe(false);
  });
});

describe('extensionConsentCopy', () => {
  it('names the reach of a server half only when there is one', () => {
    expect(extensionConsentCopy(true)).toContain('on this machine');
    expect(extensionConsentCopy(false)).not.toContain('on this machine');
    expect(extensionConsentCopy(false)).toMatch(/^None of it has run yet\./);
  });
});
