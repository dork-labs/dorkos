/**
 * Reading an answered `extension.approval` row back, and deciding whether its
 * "Turn it on" can act in place (DOR-2517).
 */
import { describe, it, expect } from 'vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { extensionApprovalSubjectId } from '@dorkos/shared/extension-approval-schemas';
import { canTurnOnInPlace, parseExtensionApprovalSubject } from '../lib/approval-subject';
import { extensionConsentCopy } from '../lib/consent-copy';

const COPY = {
  id: 'flow',
  path: '/h/.dork/plugins/flow/.dork/extensions/flow',
  plugin: 'flow',
  version: '1.2.0',
};

function record(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'flow',
    manifest: { id: 'flow', name: 'Flow', version: '1.2.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    sourcePlugin: 'flow',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: false,
    ...overrides,
  };
}

describe('parseExtensionApprovalSubject', () => {
  it('reads back the exact copy the row was about', () => {
    expect(parseExtensionApprovalSubject(extensionApprovalSubjectId(COPY))).toEqual(COPY);
    expect(
      parseExtensionApprovalSubject(extensionApprovalSubjectId({ ...COPY, plugin: null }))
    ).toEqual({ ...COPY, plugin: null });
  });

  it('answers null for anything not in that form', () => {
    expect(parseExtensionApprovalSubject('flow@1.2.0')).toBeNull();
    expect(parseExtensionApprovalSubject('{"id":"flow"}')).toBeNull();
    expect(parseExtensionApprovalSubject('null')).toBeNull();
  });
});

describe('canTurnOnInPlace', () => {
  it('is true while the same plugin and version is still installed and still off', () => {
    expect(canTurnOnInPlace(COPY, [record()])).toBe(true);
  });

  it('is false once it is on, turned off, gone, from another plugin, or another version', () => {
    expect(canTurnOnInPlace(COPY, [record({ approvedToRun: true })])).toBe(false);
    expect(canTurnOnInPlace(COPY, [record({ status: 'disabled' })])).toBe(false);
    expect(canTurnOnInPlace(COPY, [])).toBe(false);
    expect(canTurnOnInPlace(COPY, undefined)).toBe(false);
    expect(canTurnOnInPlace(COPY, [record({ sourcePlugin: 'fork' })])).toBe(false);
    expect(canTurnOnInPlace(COPY, [record({ sourcePlugin: undefined })])).toBe(false);
    expect(
      canTurnOnInPlace(COPY, [record({ manifest: { id: 'flow', name: 'Flow', version: '1.3.0' } })])
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
