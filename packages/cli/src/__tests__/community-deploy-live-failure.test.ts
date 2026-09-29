import { describe, expect, it, vi } from 'vitest';
import { CommunityLiveGateError } from '../../scripts/community-deploy-live-capture.js';
import { CommunityLiveGateCleanupError } from '../../scripts/community-deploy-live-cleanup.js';
import { CommunityLiveGateNotArmedError } from '../../scripts/community-deploy-live-config.js';
import {
  AFTER_CLEANUP_STEP,
  CLEANED_UP_DETAIL,
  describeCommunityLiveGateFailure,
  describeLauncherStop,
  explainCommunityLiveGateFailure,
  PUBLISHED_LAUNCHER_STEP,
} from '../../scripts/community-deploy-live-failure.js';

const RECOVERY = 'npx -y dorkos@1.2.3 community deploy --resume run-1';

describe('explainCommunityLiveGateFailure', () => {
  // The final inventory read, the receipt and removing the run's state all come after cleanup has
  // deleted everything the run created. A failure there used to print a recovery command for
  // resources already gone, because the catch re-found the launch journal, which stays on disk
  // until the run ends.
  it('reports a failure after cleanup honestly, with no recovery command', async () => {
    const findRecoveryCommand = vi.fn(async () => RECOVERY);
    const explained = await explainCommunityLiveGateFailure(
      new Error('EACCES: receipt directory'),
      { cleanedUp: true, recoveryCommand: RECOVERY },
      findRecoveryCommand
    );
    expect(explained).toBeInstanceOf(CommunityLiveGateError);
    expect(explained).toMatchObject({ step: AFTER_CLEANUP_STEP, recoveryCommand: null });
    expect((explained as Error).message).toBe(
      'Community live gate failed (after-cleanup): cleanup finished; a later step failed'
    );
    expect(CLEANED_UP_DETAIL).toBe('cleanup finished; a later step failed');
    expect(findRecoveryCommand).not.toHaveBeenCalled();
    expect(describeCommunityLiveGateFailure(explained)).not.toContain('Retained resources');
  });

  it('keeps the recovery command the run already holds before cleanup', async () => {
    const findRecoveryCommand = vi.fn(async () => 'another');
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateError('bootstrap-rotation'),
      { cleanedUp: false, recoveryCommand: RECOVERY },
      findRecoveryCommand
    );
    expect(explained).toMatchObject({ step: 'bootstrap-rotation', recoveryCommand: RECOVERY });
    expect(findRecoveryCommand).not.toHaveBeenCalled();
  });

  // Cleanup stops at the first refusal and knows exactly which resources it had not deleted yet.
  // Reporting it as `execution` hid both the step and which of Fly, Neon and Tigris still exist.
  it("keeps a cleanup refusal's own step and what it left, beside the recovery command", async () => {
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateCleanupError('provider-operation', ['fly-app-1', 'neon-project-1']),
      { cleanedUp: false, recoveryCommand: RECOVERY },
      async () => null
    );
    expect(explained).toMatchObject({ step: 'provider-operation', recoveryCommand: RECOVERY });
    expect(describeCommunityLiveGateFailure(explained)).toBe(
      'Community live gate failed (provider-operation): retained: fly-app-1, neon-project-1\n' +
        `Retained resources can be reconciled with:\n  ${RECOVERY}\n`
    );
  });

  it('says a cleanup refusal left unknown resources when it could not name them', async () => {
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateCleanupError('journal-identity', []),
      { cleanedUp: false, recoveryCommand: RECOVERY },
      async () => null
    );
    expect((explained as Error).message).toBe(
      'Community live gate failed (journal-identity): retained: unknown'
    );
  });

  it('finds a journal the run had not read yet, and names a raw failure only as execution', async () => {
    const explained = await explainCommunityLiveGateFailure(
      new Error('provider said something private'),
      { cleanedUp: false, recoveryCommand: null },
      async () => RECOVERY
    );
    expect(explained).toMatchObject({ step: 'execution', recoveryCommand: RECOVERY });
    expect((explained as Error).message).not.toContain('private');
  });

  it('passes the error through when nothing may remain and the lookup finds or fails', async () => {
    const error = new CommunityLiveGateError('published-version');
    await expect(
      explainCommunityLiveGateFailure(
        error,
        { cleanedUp: false, recoveryCommand: null },
        async () => null
      )
    ).resolves.toBe(error);
    await expect(
      explainCommunityLiveGateFailure(error, { cleanedUp: false, recoveryCommand: null }, () =>
        Promise.reject(new Error('ENOENT'))
      )
    ).resolves.toBe(error);
  });
});

// The shape a real stopped launch saved (DOR-2169 live gate, dorkos@0.89.0), with synthetic ids.
const STOPPED_JOURNAL = {
  schemaVersion: 1,
  state: 'uncertain',
  pendingIntent: { provider: 'neon', organizationId: 'org-fixture', resourceName: 'dorkos-gate-x' },
  resources: { flyAppId: 'dorkos-gate-x', neonProjectId: 'fixture-project-1' },
  secretDigests: { COMMUNITY_BOOTSTRAP_SECRET: 'digest-should-never-print' },
  lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
};

describe('describeLauncherStop', () => {
  it("names the launcher's saved error code and the provider it was creating", () => {
    expect(describeLauncherStop(STOPPED_JOURNAL)).toBe(
      'launcher stopped with CREATION_OUTCOME_UNCERTAIN (neon)'
    );
  });

  it('names the code alone when no creation was pending', () => {
    expect(describeLauncherStop({ ...STOPPED_JOURNAL, pendingIntent: null })).toBe(
      'launcher stopped with CREATION_OUTCOME_UNCERTAIN'
    );
  });

  it.each([
    ['no saved error', { ...STOPPED_JOURNAL, lastSafeError: null }],
    ['a code outside the fixed vocabulary', { lastSafeError: { code: 'sk_live_SECRETVALUE' } }],
    ['a journal that is not an object', 'not a journal'],
  ])('says nothing for %s', (_label, journal) => {
    expect(describeLauncherStop(journal)).toBeNull();
  });

  // The code is checked against this checkout's list, so a code only a newer published launcher
  // knows is dropped: the failure stays the bare step rather than printing something unchecked.
  it('says nothing for a code only a newer launcher knows', () => {
    expect(
      describeLauncherStop({
        ...STOPPED_JOURNAL,
        lastSafeError: { category: 'uncertain', code: 'SOME_FUTURE_CODE' },
      })
    ).toBeNull();
  });

  it('never repeats a provider it does not recognise', () => {
    expect(
      describeLauncherStop({ ...STOPPED_JOURNAL, pendingIntent: { provider: 'token=abc' } })
    ).toBe('launcher stopped with CREATION_OUTCOME_UNCERTAIN');
  });
});

describe('explainCommunityLiveGateFailure with a stopped launcher', () => {
  // The live gate on dorkos@0.89.0 reported only `published-launcher`; why it stopped was in the
  // journal on disk. The report now carries the saved code, beside the recovery command.
  it('adds why the launcher stopped to its failure, beside the recovery command', async () => {
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateError(PUBLISHED_LAUNCHER_STEP),
      { cleanedUp: false, recoveryCommand: null },
      async () => RECOVERY,
      async () => describeLauncherStop(STOPPED_JOURNAL)
    );
    const printed = describeCommunityLiveGateFailure(explained);
    expect(printed).toBe(
      'Community live gate failed (published-launcher): launcher stopped with ' +
        `CREATION_OUTCOME_UNCERTAIN (neon)\nRetained resources can be reconciled with:\n  ${RECOVERY}\n`
    );
    expect(printed).not.toContain('digest-should-never-print');
  });

  it('adds the reason even when no recovery command was found', async () => {
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateError(PUBLISHED_LAUNCHER_STEP),
      { cleanedUp: false, recoveryCommand: null },
      async () => null,
      async () => 'launcher stopped with AUTH_REQUIRED (fly)'
    );
    expect(explained).toMatchObject({ step: PUBLISHED_LAUNCHER_STEP, recoveryCommand: null });
    expect((explained as Error).message).toBe(
      'Community live gate failed (published-launcher): launcher stopped with AUTH_REQUIRED (fly)'
    );
  });

  it('keeps the bare step when the journal cannot be read', async () => {
    const error = new CommunityLiveGateError(PUBLISHED_LAUNCHER_STEP);
    await expect(
      explainCommunityLiveGateFailure(
        error,
        { cleanedUp: false, recoveryCommand: null },
        async () => null,
        () => Promise.reject(new Error('ENOENT'))
      )
    ).resolves.toBe(error);
  });

  it('reads the journal only for a failed launcher, not for other steps', async () => {
    const findLauncherStop = vi.fn(async () => 'launcher stopped with AUTH_REQUIRED');
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateError('bootstrap-rotation'),
      { cleanedUp: false, recoveryCommand: RECOVERY },
      async () => null,
      findLauncherStop
    );
    expect((explained as Error).message).toBe('Community live gate failed (bootstrap-rotation)');
    expect(findLauncherStop).not.toHaveBeenCalled();
  });
});

describe('describeCommunityLiveGateFailure', () => {
  it('prints the recovery command under a gate error that carries one', () => {
    expect(
      describeCommunityLiveGateFailure(new CommunityLiveGateError('bootstrap-rotation', RECOVERY))
    ).toBe(
      `Community live gate failed (bootstrap-rotation)\nRetained resources can be reconciled with:\n  ${RECOVERY}\n`
    );
  });

  it('shows the not-armed refusal as it is', () => {
    const error = new CommunityLiveGateNotArmedError(['DORKOS_COMMUNITY_LIVE']);
    expect(describeCommunityLiveGateFailure(error)).toBe(`${error.message}\n`);
  });

  it('never prints the message of an error it does not own', () => {
    expect(describeCommunityLiveGateFailure(new Error('token=abc'))).toBe(
      'Community live gate failed\n'
    );
  });
});
