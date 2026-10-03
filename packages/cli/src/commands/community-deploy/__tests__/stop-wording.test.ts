import { describe, expect, it } from 'vitest';
import { describeCancelledLaunch, formatCommunityRecovery } from '../community-dispatcher.js';
import { createLaunchPlan } from '../plan.js';
import { ProviderMutationError } from '../provider-mutation.js';
import { createInitialCommunityLaunchJournal } from '../resume.js';

const plan = createLaunchPlan({
  dorkosVersion: '0.96.0',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  fly: {
    organizationId: 'personal',
    organizationName: 'Personal',
    appName: 'dor2170-v96d-d172',
    region: 'ord',
    machineSize: 'shared-cpu-1x',
  },
  neon: {
    organizationId: 'org-dorian',
    organizationName: 'Dorian',
    projectName: 'dor2170-v96d-d172',
    region: 'aws-us-east-2',
  },
  tigris: { bucketName: 'dor2170-v96d-d172', private: true },
});

const base = createInitialCommunityLaunchJournal(
  '28f2a212-6638-4588-b154-9d25bf59701c',
  plan,
  '2026-10-03T23:15:36.000Z'
);

// What the journal held after one Control-C during `fly deploy` (DOR-2170 L3, DOR-2702).
const stopped = {
  ...base,
  state: 'secrets_staged' as const,
  resources: {
    flyAppId: 'app-id',
    neonProjectId: 'morning-dew-75508785',
    tigrisBucketId: '60LQyPM0YLVwzuXbpNykyV',
  },
  lastSafeError: { category: 'transient' as const, code: 'CANCELLED' as const },
};

describe('what a person reads when setup stops (DOR-2702)', () => {
  it('says a Control-C stop resumes as is, in words that match the journal', () => {
    const line = describeCancelledLaunch(stopped);
    expect(line).toBe(
      'Setup stopped when you interrupted it. What it made so far is kept: run the resume command above to carry on.'
    );
    expect(line).not.toMatch(/[A-Z]{3,}_[A-Z]/u);

    // A stop in the middle of a create is the journal's uncertain state, and says so.
    const uncertain = describeCancelledLaunch({
      ...stopped,
      state: 'uncertain',
      lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
    });
    expect(uncertain).toContain('cannot tell yet whether that change happened');
    expect(uncertain).not.toContain('CREATION_OUTCOME_UNCERTAIN');
  });

  it('never prints a raw provider error code', () => {
    for (const code of [
      'INVALID_INPUT',
      'INVALID_RESPONSE',
      'PROVIDER_UNAVAILABLE',
      'ACCESS_DENIED',
      'CREATION_OUTCOME_UNCERTAIN',
    ] as const) {
      const error = new ProviderMutationError(code);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(code);
      expect(error.message).not.toContain('Provider mutation failed');
    }
  });

  it('names the bucket by its name and mentions the access key Tigris keeps', () => {
    const recovery = formatCommunityRecovery(stopped);
    expect(recovery).toContain('  Tigris bucket dor2170-v96d-d172 — owner personal;');
    expect(recovery).not.toContain('60LQyPM0YLVwzuXbpNykyV');
    expect(recovery).toContain(
      'Access key: usually dor2170-v96d-d172_access_key in Tigris. Removing the bucket does not remove this key'
    );
  });
});
