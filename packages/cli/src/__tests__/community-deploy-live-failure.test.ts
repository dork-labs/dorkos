import { describe, expect, it, vi } from 'vitest';
import { CommunityLiveGateError } from '../../scripts/community-deploy-live-capture.js';
import { CommunityLiveGateCleanupError } from '../../scripts/community-deploy-live-cleanup.js';
import { CommunityLiveGateNotArmedError } from '../../scripts/community-deploy-live-config.js';
import {
  AFTER_CLEANUP_STEP,
  CLEANED_UP_DETAIL,
  describeCommunityLiveGateFailure,
  explainCommunityLiveGateFailure,
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
