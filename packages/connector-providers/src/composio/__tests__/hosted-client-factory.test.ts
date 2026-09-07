import { describe, expect, it } from 'vitest';

import { createComposioHostedClients } from '../hosted-client-factory.js';

describe('createComposioHostedClients', () => {
  it('returns a stable digest for the exact same construction material', () => {
    const first = createComposioHostedClients({
      apiKey: 'ck_project_one',
      serverUserId: 'tenant-user-a',
      authConfigByToolkit: { slack: 'ac_slack', gmail: 'ac_gmail' },
    });
    const reordered = createComposioHostedClients({
      apiKey: 'ck_project_one',
      serverUserId: 'tenant-user-a',
      authConfigByToolkit: { gmail: 'ac_gmail', slack: 'ac_slack' },
    });

    expect(first.executionConfigDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.executionConfigDigest).toBe(first.executionConfigDigest);
    expect(first.executionConfigDigest).not.toContain('ck_project_one');
  });

  it.each([
    { apiKey: 'ck_project_two' },
    { serverUserId: 'tenant-user-b' },
    { authConfigByToolkit: { gmail: 'ac_other' } },
    { baseUrl: 'http://127.0.0.1:9999' },
  ])('changes the digest when material changes: $apiKey$serverUserId$baseUrl', (override) => {
    const baseline = {
      apiKey: 'ck_project_one',
      serverUserId: 'tenant-user-a',
      authConfigByToolkit: { gmail: 'ac_gmail' },
    };
    expect(
      createComposioHostedClients({ ...baseline, ...override }).executionConfigDigest
    ).not.toBe(createComposioHostedClients(baseline).executionConfigDigest);
  });
});
