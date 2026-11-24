import { describe, expect, it, vi } from 'vitest';
import { CommunityLiveGateError } from '../../scripts/community-deploy-live-capture.js';
import { CommunityLiveGateCleanupError } from '../../scripts/community-deploy-live-cleanup.js';
import {
  describeLauncherExit,
  AFTER_CLEANUP_STEP,
  CLEANED_UP_DETAIL,
  describeCommunityLiveGateFailure,
  describeLauncherStop,
  explainCommunityLiveGateFailure,
  PUBLISHED_LAUNCHER_STEP,
  withDorkosHostsContacted,
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
      'Community live gate failed (after-cleanup): ' + CLEANED_UP_DETAIL
    );
    expect(CLEANED_UP_DETAIL).toBe(
      "cleanup finished, apart from the bucket's Tigris access key (see the steps above); a later step failed"
    );
    expect(findRecoveryCommand).not.toHaveBeenCalled();
    expect(describeCommunityLiveGateFailure(explained)).not.toContain('Retained resources');
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
});

describe('describeCommunityLiveGateFailure', () => {
  it('prints the recovery command under a gate error that carries one', () => {
    expect(
      describeCommunityLiveGateFailure(new CommunityLiveGateError('bootstrap-rotation', RECOVERY))
    ).toBe(
      `Community live gate failed (bootstrap-rotation)\nRetained resources can be reconciled with:\n  ${RECOVERY}\n`
    );
  });

  it('never prints the message of an error it does not own', () => {
    expect(describeCommunityLiveGateFailure(new Error('token=abc'))).toBe(
      'Community live gate failed\n'
    );
  });
});

// A launcher that refuses its release stops before writing a launch record, so there is no
// journal to explain it (DOR-2169, a tarball packed past its release's migrations).
describe('describeLauncherExit', () => {
  // What a version from DOR-2653 on prints. Published versions before it said "Community".
  const failed = (message: string) =>
    `\u001b[1mDorkOS space server 0.95.0\u001b[0m\r\nResolving release…\r\n\u001b[31mSpace setup failed: ${message}\u001b[39m\r\n`;
  const failedBeforeRename = (message: string) =>
    `\u001b[1mDorkOS Community 0.92.0\u001b[0m\r\nResolving release…\r\n\u001b[31mCommunity setup failed: ${message}\u001b[39m\r\n`;

  it('names the launcher code from its last failure line', () => {
    expect(
      describeLauncherExit(
        failed('Space server release resolution failed (COMMUNITY_RELEASE_INVALID)')
      )
    ).toBe('launcher exited with COMMUNITY_RELEASE_INVALID');
  });

  // The gate runs published versions, and those printed the old wording until DOR-2653 shipped.
  it('still reads the failure line a version from before the rename prints', () => {
    expect(
      describeLauncherExit(
        failedBeforeRename('Community release resolution failed (COMMUNITY_RELEASE_INVALID)')
      )
    ).toBe('launcher exited with COMMUNITY_RELEASE_INVALID');
  });

  it('never carries anything but the code into the gate error', async () => {
    const transcript = failed('org dork-labs-secret says (COMMUNITY_RELEASE_INVALID)');
    const error = new CommunityLiveGateError(
      PUBLISHED_LAUNCHER_STEP,
      null,
      describeLauncherExit(transcript) ?? undefined
    );
    const explained = await explainCommunityLiveGateFailure(
      error,
      { cleanedUp: false, recoveryCommand: null },
      async () => null,
      async () => null
    );
    const text = describeCommunityLiveGateFailure(explained);
    expect(text).toBe(
      'Community live gate failed (published-launcher): launcher exited with COMMUNITY_RELEASE_INVALID before writing a launch record\n'
    );
    expect(text).not.toContain('dork-labs-secret');
  });

  // A resumed launcher can stop with a journal (and resources) already in place, and a journal whose
  // saved error is null is the normal state. It must never say nothing was written beside a
  // recovery command.
  it.each([
    ['a recovery command the run already holds', 'npx dorkos … --resume run-1', null],
    ['a journal found after the stop', null, 'npx dorkos … --resume run-1'],
  ])('never says nothing was written when there is %s', async (_label, held, found) => {
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateError(
        PUBLISHED_LAUNCHER_STEP,
        null,
        'launcher exited with COMMUNITY_RELEASE_NOT_READY'
      ),
      { cleanedUp: false, recoveryCommand: held },
      async () => found,
      // The journal exists but its lastSafeError is null.
      async () => describeLauncherStop({ lastSafeError: null, pendingIntent: null })
    );
    const text = describeCommunityLiveGateFailure(explained);
    expect(text).toBe(
      'Community live gate failed (published-launcher): launcher exited with COMMUNITY_RELEASE_NOT_READY\n' +
        'Retained resources can be reconciled with:\n  npx dorkos … --resume run-1\n'
    );
    expect(text).not.toContain('before writing a launch record');
  });
});

describe('withDorkosHostsContacted', () => {
  // Purpose: fails if a run whose launcher the guard refused reports only the step it tripped
  // over later, hiding the DorkOS contact that caused it (DOR-2593).
  it('adds the hosts to the failure, keeping its step and recovery command', () => {
    const failure = withDorkosHostsContacted(
      new CommunityLiveGateError('launch-journal', RECOVERY, 'no journal'),
      ['dorkos.ai']
    );
    expect(failure).toMatchObject({
      step: 'launch-journal',
      recoveryCommand: RECOVERY,
      detail: 'no journal; the launcher tried to reach dorkos.ai',
    });
  });
});
