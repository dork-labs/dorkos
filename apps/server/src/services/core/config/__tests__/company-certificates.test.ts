/**
 * What Settings is told about company certificates (DOR-3361): only what the
 * desktop app's server process actually recorded, and nothing elsewhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ DORKOS_MANAGED_BY: 'desktop' as 'desktop' | undefined }));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));
const stored = vi.hoisted(() => ({ network: { extraCaCertsPath: null as string | null } }));
vi.mock('../../config-manager.js', () => ({
  configManager: { get: (key: 'network') => stored[key] },
}));

import {
  COMPANY_CERTIFICATES_STATUS,
  describeCompanyCertificates,
  readCompanyCertificatesStatus,
} from '../company-certificates.js';

const globals = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete globals[COMPANY_CERTIFICATES_STATUS];
  mockEnv.DORKOS_MANAGED_BY = 'desktop';
  stored.network.extraCaCertsPath = null;
});

describe('company certificates status', () => {
  it('reports the count the desktop app recorded, beside the setting', () => {
    stored.network.extraCaCertsPath = '/Users/someone/company-ca.pem';
    globals[COMPANY_CERTIFICATES_STATUS] = {
      outcome: 'added',
      added: 3,
      path: '/Users/someone/company-ca.pem',
    };
    expect(describeCompanyCertificates()).toEqual({
      extraCaCertsPath: '/Users/someone/company-ca.pem',
      companyCertificates: { outcome: 'added', added: 3, path: '/Users/someone/company-ca.pem' },
    });
  });

  it('reports an exported variable it ignored', () => {
    globals[COMPANY_CERTIFICATES_STATUS] = { outcome: 'ignored-env', added: 0, path: null };
    expect(readCompanyCertificatesStatus()).toEqual({
      outcome: 'ignored-env',
      added: 0,
      path: null,
    });
  });

  it('says nothing when the desktop app does not run this server', () => {
    mockEnv.DORKOS_MANAGED_BY = undefined;
    globals[COMPANY_CERTIFICATES_STATUS] = { outcome: 'added', added: 3, path: '/x.pem' };
    expect(readCompanyCertificatesStatus()).toBeNull();
  });

  it('says nothing when the record is missing or malformed', () => {
    expect(readCompanyCertificatesStatus()).toBeNull();
    globals[COMPANY_CERTIFICATES_STATUS] = { outcome: 'added', added: -1, path: null };
    expect(readCompanyCertificatesStatus()).toBeNull();
  });
});
