import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMUNITY_DEPLOY_HELP,
  formatCommunityRecovery,
  formatIncompleteLaunches,
  runCommunityDispatcher,
} from '../community-dispatcher.js';
import { createInitialCommunityLaunchJournal } from '../resume.js';
import { initializeLaunchJournal, launchJournalPath } from '../journal.js';
import { createLaunchPlan } from '../plan.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('uncertain-create removal', () => {
  const plan = () =>
    createLaunchPlan({
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
  const context = (dorkHome: string) => ({
    cliVersion: '0.76.0',
    dorkHome,
    processEnv: { PATH: '' },
    parseRelease: () => {
      throw new Error('unused');
    },
  });
  const pendingRemoval = {
    provider: 'fly' as const,
    token: '4817203',
    resourceName: 'dorkos-community-test',
    proof: 'marker' as const,
    requestedAt: '2026-09-21T00:00:02.000Z',
  };
  const shapeA = (runId: string) => ({
    ...createInitialCommunityLaunchJournal(runId, plan(), '2026-09-21T00:00:00.000Z'),
    state: 'uncertain' as const,
    pendingIntent: {
      provider: 'fly' as const,
      organizationId: 'dork-labs',
      resourceName: 'dorkos-community-test',
      provenanceMarker: '7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
      requestedAt: '2026-09-21T00:00:01.000Z',
    },
    lastSafeError: {
      category: 'uncertain' as const,
      code: 'CREATION_OUTCOME_UNCERTAIN' as const,
    },
  });

  it('states the removal rule and both flags in help', () => {
    expect(COMMUNITY_DEPLOY_HELP).toContain(
      'never removes a resource without proof\nthat this run made it and your typed confirmation'
    );
    expect(COMMUNITY_DEPLOY_HELP).toContain('--remove-uncertain <run-id>');
    expect(COMMUNITY_DEPLOY_HELP).toContain('--confirm <id>');
    expect(COMMUNITY_DEPLOY_HELP).not.toContain('never removes resources automatically');
  });

  it('refuses --confirm without --remove-uncertain, and every flag it cannot be combined with', async () => {
    const dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-community-home-'));
    roots.push(dorkHome);
    const runId = randomUUID();
    await expect(
      runCommunityDispatcher(['deploy', '--confirm', '4817203'], context(dorkHome))
    ).rejects.toThrow('--confirm works only with --remove-uncertain');
    for (const extra of [
      ['--resume', runId],
      ['--dry-run'],
      ['--list-incomplete'],
      ['--app-name', 'x'],
      ['--machine-size', 'shared-cpu-1x'],
      ['--version', '0.76.0'],
    ]) {
      await expect(
        runCommunityDispatcher(['deploy', '--remove-uncertain', runId, ...extra], context(dorkHome))
      ).rejects.toThrow(`--remove-uncertain cannot be combined with ${extra[0]}`);
    }
  });

  it('refuses --resume while a removal is pending, before contacting anything', async () => {
    const dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-community-home-'));
    roots.push(dorkHome);
    const runId = randomUUID();
    await initializeLaunchJournal(launchJournalPath(dorkHome, runId), {
      ...shapeA(runId),
      pendingRemoval,
    });
    await expect(
      runCommunityDispatcher(['deploy', '--resume', runId], context(dorkHome))
    ).rejects.toThrow(
      `A removal is in progress for this run. Finish it first: dorkos community deploy --remove-uncertain ${runId}`
    );
  });

  it('answers nothing-pending for a run without an unresolved resource', async () => {
    const dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-community-home-'));
    roots.push(dorkHome);
    const runId = randomUUID();
    await initializeLaunchJournal(
      launchJournalPath(dorkHome, runId),
      createInitialCommunityLaunchJournal(runId, plan(), '2026-09-21T00:00:00.000Z')
    );
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      runCommunityDispatcher(['deploy', '--remove-uncertain', runId], context(dorkHome))
    ).resolves.toBe(0);
    expect(output.mock.calls.map(([value]) => String(value)).join('')).toContain(
      'This run has no unresolved resource.'
    );
  });

  it('offers the removal command only for a create with no recorded id', () => {
    const runId = randomUUID();
    const line = `Check whether DorkOS can prove this run made it and remove it: dorkos community deploy --remove-uncertain ${runId}`;
    expect(formatCommunityRecovery(shapeA(runId))).toContain(line);
    expect(
      formatCommunityRecovery({
        ...shapeA(runId),
        resources: { flyAppId: 'dorkos-community-test' },
      })
    ).not.toContain('--remove-uncertain');
    expect(formatCommunityRecovery({ ...shapeA(runId), pendingIntent: null })).not.toContain(
      '--remove-uncertain'
    );
    expect(formatCommunityRecovery({ ...shapeA(runId), pendingRemoval })).toContain(
      `A removal is in progress. Finish it with: dorkos community deploy --remove-uncertain ${runId}`
    );
  });

  it('lists a run with a removal in flight as removal pending', () => {
    const runId = randomUUID();
    expect(formatIncompleteLaunches([{ ...shapeA(runId), pendingRemoval }])).toContain(
      `${runId}  removal pending`
    );
  });
});
