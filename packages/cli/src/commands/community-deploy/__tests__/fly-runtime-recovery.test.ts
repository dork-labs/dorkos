/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { isInterruptedFlyDeployment } from '../fly-mutate.js';

const digest = `sha256:${'a'.repeat(64)}`;

// DOR-2169: only what a cut-off deploy leaves behind may be deployed over on resume.
describe('isInterruptedFlyDeployment', () => {
  const repository = 'ghcr.io/dork-labs/dorkos-community';
  const interrupted = () => ({
    machines: [
      {
        id: 'machine_01',
        name: 'machine',
        state: 'started',
        region: 'ord',
        imageDigest: digest,
        imageRepository: repository,
        checks: [{ name: 'health', status: 'passing' }],
      },
    ],
    releases: [
      {
        id: 'release_01',
        imageRef: `${repository}@${digest}`,
        status: 'interrupted',
        stable: false,
        version: 1,
      },
    ],
    addresses: [{ address: '203.0.113.1', type: 'v4', region: '' }],
  });
  const other = `sha256:${'b'.repeat(64)}`;

  it.each([
    ['an interrupted release of the pinned image', () => interrupted()],
    [
      'a failed release of the pinned image',
      () => ({
        ...interrupted(),
        releases: [{ ...interrupted().releases[0]!, status: 'failed' }],
      }),
    ],
    [
      'failing checks under an interrupted release (the redeploy is proved in full)',
      () => {
        const value = interrupted();
        value.machines[0]!.checks = [{ name: 'health', status: 'critical' }];
        return value;
      },
    ],
  ])('re-deploys over %s', (_label, inventory) => {
    expect(isInterruptedFlyDeployment(inventory(), repository, digest)).toBe(true);
  });

  it.each([
    [
      "a Machine running another image (an operator's own deploy)",
      () => {
        const value = interrupted();
        value.machines[0]!.imageDigest = other;
        return value;
      },
    ],
    ['no Machine', () => ({ ...interrupted(), machines: [] })],
    [
      'two Machines',
      () => ({
        ...interrupted(),
        machines: [...interrupted().machines, ...interrupted().machines],
      }),
    ],
    [
      'a stopped Machine',
      () => {
        const value = interrupted();
        value.machines[0]!.state = 'stopped';
        return value;
      },
    ],
    [
      'a complete release (an unhealthy or address-less app that crashes on start)',
      () => ({
        ...interrupted(),
        releases: [{ ...interrupted().releases[0]!, status: 'complete' }],
      }),
    ],
    [
      'an interrupted release of another image',
      () => ({
        ...interrupted(),
        releases: [{ ...interrupted().releases[0]!, imageRef: `${repository}@${other}` }],
      }),
    ],
    ['no release at all', () => ({ ...interrupted(), releases: [] })],
    [
      'a newer complete release above an older interrupted one',
      () => ({
        ...interrupted(),
        releases: [
          ...interrupted().releases,
          { ...interrupted().releases[0]!, id: 'release_02', status: 'complete', version: 2 },
        ],
      }),
    ],
  ])('stops for %s', (_label, inventory) => {
    expect(isInterruptedFlyDeployment(inventory(), repository, digest)).toBe(false);
  });
});
