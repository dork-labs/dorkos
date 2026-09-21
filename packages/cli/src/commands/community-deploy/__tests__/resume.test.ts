import { describe, expect, it } from 'vitest';
import { createLaunchPlan } from '../plan.js';
import {
  assertCommunityLaunchPlanUnchanged,
  CommunityLaunchPlanDriftError,
  createInitialCommunityLaunchJournal,
} from '../resume.js';

const plan = createLaunchPlan({
  dorkosVersion: '0.76.0',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  fly: {
    organizationId: 'dork-labs',
    organizationName: 'Dork Labs',
    appName: 'dorkos-community-test',
    region: 'ord',
    machineSize: 'shared-cpu-1x',
  },
  neon: {
    organizationId: 'org-dorian',
    organizationName: 'Dorian',
    projectName: 'dorkos-community-test',
    region: 'aws-us-east-2',
  },
  tigris: { bucketName: 'dorkos-community-test', private: true },
});

describe('Community launch resume', () => {
  it('creates a validated revision-zero journal bound to the whole plan', () => {
    const journal = createInitialCommunityLaunchJournal(
      '11111111-1111-4111-8111-111111111111',
      plan,
      '2026-09-21T00:00:00.000Z'
    );
    expect(journal).toMatchObject({
      revision: 0,
      state: 'planned',
      releaseDigest: plan.imageDigest,
      completedSteps: ['planned'],
    });
    expect(() => assertCommunityLaunchPlanUnchanged(journal, plan)).not.toThrow();
  });

  it('rejects organization, region, resource, topology, or release drift before writes', () => {
    const journal = createInitialCommunityLaunchJournal(
      '11111111-1111-4111-8111-111111111111',
      plan,
      '2026-09-21T00:00:00.000Z'
    );
    const changed = [
      createLaunchPlan({ ...plan, fly: { ...plan.fly, organizationId: 'personal' } }),
      createLaunchPlan({ ...plan, neon: { ...plan.neon, region: 'aws-eu-central-1' } }),
      createLaunchPlan({ ...plan, tigris: { ...plan.tigris, bucketName: 'different-bucket' } }),
      createLaunchPlan({ ...plan, fly: { ...plan.fly, machineSize: 'shared-cpu-2x' } }),
      createLaunchPlan({ ...plan, imageDigest: `sha256:${'c'.repeat(64)}` }),
    ];
    for (const candidate of changed) {
      expect(() => assertCommunityLaunchPlanUnchanged(journal, candidate)).toThrowError(
        new CommunityLaunchPlanDriftError()
      );
    }
  });
});
