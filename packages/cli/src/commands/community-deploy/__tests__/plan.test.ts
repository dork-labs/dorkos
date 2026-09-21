/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { createLaunchPlan, hashLaunchPlan } from '../plan.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function input() {
  return {
    dorkosVersion: '0.76.0',
    imageDigest: DIGEST,
    fly: {
      organizationId: 'fly-org-1',
      organizationName: 'Dork Labs',
      appName: 'dorkos-community-example',
      region: 'ord',
      machineSize: 'shared-cpu-1x',
    },
    neon: {
      organizationId: 'neon-org-1',
      organizationName: 'Dork Labs',
      projectName: 'dorkos-community-example',
      region: 'aws-us-east-2',
    },
    tigris: { bucketName: 'dorkos-community-example', private: true as const },
  };
}

describe('Community launch plan', () => {
  it('freezes nested values and hashes identical inputs deterministically', () => {
    const first = createLaunchPlan(input());
    const second = createLaunchPlan(input());

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.fly)).toBe(true);
    expect(hashLaunchPlan(first)).toBe(hashLaunchPlan(second));
    expect(hashLaunchPlan(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['Fly organization', (value: ReturnType<typeof input>) => (value.fly.organizationId = 'other')],
    ['Fly region', (value: ReturnType<typeof input>) => (value.fly.region = 'iad')],
    ['Neon region', (value: ReturnType<typeof input>) => (value.neon.region = 'aws-us-west-2')],
    ['resource name', (value: ReturnType<typeof input>) => (value.fly.appName = 'another-app')],
    [
      'release digest',
      (value: ReturnType<typeof input>) => (value.imageDigest = `sha256:${'b'.repeat(64)}`),
    ],
  ])('changes the hash when %s changes', (_label, mutate) => {
    const original = createLaunchPlan(input());
    const changed = input();
    mutate(changed);
    expect(hashLaunchPlan(createLaunchPlan(changed))).not.toBe(hashLaunchPlan(original));
  });

  it('rejects mutable image tags and a public bucket', () => {
    expect(() => createLaunchPlan({ ...input(), imageDigest: 'latest' })).toThrow();
    expect(() =>
      createLaunchPlan({ ...input(), tigris: { ...input().tigris, private: false } } as never)
    ).toThrow();
  });

  it('accepts display names but rejects unsafe provider IDs and resource names', () => {
    expect(() =>
      createLaunchPlan({
        ...input(),
        fly: { ...input().fly, organizationName: 'Dork Labs & Friends' },
      })
    ).not.toThrow();
    expect(() =>
      createLaunchPlan({
        ...input(),
        fly: { ...input().fly, organizationId: 'org/unsafe' },
      })
    ).toThrow();
    expect(() =>
      createLaunchPlan({
        ...input(),
        neon: { ...input().neon, projectName: 'project with spaces' },
      })
    ).toThrow();
  });
});
