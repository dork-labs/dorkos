import { describe, expect, it } from 'vitest';
import { formatCommunityRecovery } from '../community-dispatcher.js';
import { createLaunchPlan } from '../plan.js';
import { ProviderMutationError } from '../provider-mutation.js';
import { createInitialCommunityLaunchJournal } from '../resume.js';
import {
  describeStoppedLaunch,
  recordLaunchFailure,
  stopExitCode,
} from '../runtime/stop-record.js';

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
  it('says a stop resumes as is, in words that match the journal and not its cause', () => {
    const line = describeStoppedLaunch(stopped);
    expect(line).toBe(
      'Setup was stopped. What it made so far is kept: run the resume command above to carry on.'
    );
    expect(line).not.toMatch(/[A-Z]{3,}_[A-Z]/u);
    // SIGTERM takes the same path as Control-C, so the line names neither.
    expect(line).not.toMatch(/Control-C|you /u);
    expect(stopExitCode('SIGINT')).toBe(130);
    expect(stopExitCode('SIGTERM')).toBe(143);
  });

  it('points at reconciliation steps only when the recovery prints them', () => {
    const uncertain = {
      ...stopped,
      state: 'uncertain' as const,
      lastSafeError: {
        category: 'uncertain' as const,
        code: 'CREATION_OUTCOME_UNCERTAIN' as const,
      },
    };
    const withIntent = {
      ...uncertain,
      pendingIntent: {
        provider: 'neon' as const,
        organizationId: 'org-dorian',
        resourceName: 'dor2170-v96d-d172',
      },
    };
    expect(formatCommunityRecovery(withIntent)).toContain('Manual reconciliation required');
    // The Neon project's id is recorded here, so --resume checks it itself.
    expect(formatCommunityRecovery(withIntent)).toContain('Resume with:');
    expect(describeStoppedLaunch(withIntent)).toContain(
      'Follow the steps above before you resume.'
    );
    // With no id recorded, the recovery offers --remove-uncertain and no resume (DOR-2701), and
    // the stop line must agree with it.
    const unrecorded = { ...withIntent, resources: { flyAppId: 'app-id' } };
    expect(formatCommunityRecovery(unrecorded)).not.toContain('Resume with:');
    expect(describeStoppedLaunch(unrecorded)).toContain(
      'Run the --remove-uncertain command above: it checks, then tells you how to carry on.'
    );
    expect(describeStoppedLaunch(unrecorded)).not.toContain('resume');

    expect(formatCommunityRecovery(uncertain)).not.toContain('Manual reconciliation required');
    const noSteps = describeStoppedLaunch(uncertain);
    expect(noSteps).toContain('cannot tell yet whether that change happened');
    expect(noSteps).not.toContain('steps above');
    expect(noSteps).toContain(
      'Check the resources listed above, then run the resume command above.'
    );
    expect(noSteps).not.toContain('CREATION_OUTCOME_UNCERTAIN');
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
    // True also for a command that finished with an error, and points at the way forward.
    const uncertain = new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN').message;
    expect(uncertain).toContain('did not finish cleanly');
    expect(uncertain).toContain('run the resume command printed above');
    expect(uncertain).not.toContain('run setup again');
    // An exported token is not a "signed-in account": every credential it could be is named.
    const denied = new ProviderMutationError('ACCESS_DENIED').message;
    expect(denied).not.toContain('signed-in account');
    for (const name of ['FLY_API_TOKEN', 'FLY_ACCESS_TOKEN', 'NEON_API_KEY', 'saved sign-in']) {
      expect(denied).toContain(name);
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

  it('saves a failure code in the journal, never over a more specific one', () => {
    const now = '2026-10-03T23:18:32.000Z';
    // The live run: a resume failed after an earlier Control-C, and the journal kept CANCELLED.
    const failed = recordLaunchFailure(
      stopped,
      new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN'),
      now
    );
    expect(failed).toMatchObject({
      revision: stopped.revision + 1,
      state: 'secrets_staged',
      pendingIntent: null,
      resources: stopped.resources,
      lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
      updatedAt: now,
    });
    expect(
      recordLaunchFailure({ ...stopped, lastSafeError: null }, { code: 'ACCESS_DENIED' }, now)
        ?.lastSafeError
    ).toEqual({ category: 'authorization', code: 'ACCESS_DENIED' });

    const specific = {
      ...stopped,
      lastSafeError: {
        category: 'invalid-response' as const,
        code: 'MISSING_TIGRIS_SECRETS' as const,
      },
    };
    expect(recordLaunchFailure(specific, { code: 'INVALID_RESPONSE' }, now)).toBeNull();
    expect(recordLaunchFailure(stopped, new Error('no code'), now)).toBeNull();
    expect(recordLaunchFailure(stopped, { code: 'not-a-journal-code' }, now)).toBeNull();
    expect(
      recordLaunchFailure({ ...stopped, state: 'complete' }, { code: 'EXIT' }, now)
    ).toBeNull();
  });
});
