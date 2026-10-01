import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LaunchJournalSchema,
  initializeLaunchJournal,
  launchJournalPath,
  readLaunchJournal,
  type LaunchJournal,
} from '../journal.js';
import { runRemoveUncertainCommand } from '../provenance/removal-command.js';
import {
  formatRemovalOffer,
  formatRemovalOutcome,
  unprovedReasonText,
} from '../provenance/removal-output.js';
import type { UncertainResourceProbe } from '../provenance/uncertain-removal.js';

const RUN_ID = '3f2c9a1e-1111-4111-8111-111111111111';
const MARKER = '7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a';

function journal(update: Partial<LaunchJournal> = {}): LaunchJournal {
  return LaunchJournalSchema.parse({
    schemaVersion: 1,
    runId: RUN_ID,
    revision: 0,
    planHash: 'b'.repeat(64),
    releaseDigest: `sha256:${'a'.repeat(64)}`,
    recoveryContext: {
      version: '0.82.0',
      flyOrganization: 'acme',
      flyRegion: 'ord',
      appName: 'community-acme',
      machineSize: 'shared-cpu-1x',
      neonOrganization: 'org-acme',
      neonRegion: 'aws-us-east-2',
      neonProjectName: 'community-acme',
      bucketName: 'community-acme',
    },
    state: 'uncertain',
    pendingIntent: {
      provider: 'fly',
      organizationId: 'acme',
      resourceName: 'community-acme',
      provenanceMarker: MARKER,
      requestedAt: '2026-09-23T10:31:03.000Z',
    },
    resources: {},
    verifiedBindings: [],
    completedSteps: ['planned'],
    lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
    createdAt: '2026-09-23T10:30:00.000Z',
    updatedAt: '2026-09-23T10:31:10.000Z',
    ...update,
  });
}

function markedApp(): UncertainResourceProbe {
  let present = true;
  return {
    find: vi.fn(async () =>
      present
        ? {
            kind: 'fly' as const,
            app: {
              token: '4817203',
              name: 'community-acme',
              organization: 'acme',
              network: `dorkos-${MARKER}`,
              createdAt: '2026-09-23T10:31:07Z',
              machines: 0,
              volumes: 0,
              ipAddresses: 0,
              certificates: 0,
              secretNames: [],
            },
          }
        : { kind: 'absent' as const }
    ),
    remove: vi.fn(async () => {
      present = false;
    }),
    isGone: vi.fn(async () => !present),
    isNameReleased: vi.fn(async () => false),
  };
}

let root: string;
let path: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dorkos-removal-command-'));
  path = launchJournalPath(root, RUN_ID);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function terminal(tty: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 120 });
  let text = '';
  output.on('data', (chunk) => (text += String(chunk)));
  return { input, output, text: () => text };
}

async function run(
  probe: UncertainResourceProbe,
  options: { tty?: boolean; confirm?: string; answer?: string } = {}
) {
  const streams = terminal(options.tty ?? false);
  const signals = new EventEmitter() as unknown as Pick<NodeJS.Process, 'once' | 'removeListener'>;
  if (options.answer !== undefined) {
    const answer = options.answer;
    streams.output.on('data', (chunk) => {
      if (String(chunk).includes('press Enter to keep it')) streams.input.write(`${answer}\r`);
    });
  }
  const code = await runRemoveUncertainCommand({
    runId: RUN_ID,
    journalPath: path,
    ...(options.confirm === undefined ? {} : { confirmToken: options.confirm }),
    serviceOptions: () => {
      throw new Error('no service may be contacted in this test');
    },
    input: streams.input,
    output: streams.output,
    resumeCommand: () => `dorkos community deploy --resume ${RUN_ID} --app-name community-acme`,
    recovery: () => 'RECOVERY REPORT',
    probeFor: () => probe,
    signals,
  });
  return { code, text: streams.text() };
}

describe('--remove-uncertain command', () => {
  it('removes a proved app with the committed gate and the right --confirm', async () => {
    await initializeLaunchJournal(path, journal());
    const probe = markedApp();
    const { code, text } = await run(probe, { confirm: '4817203' });
    expect(code).toBe(0);
    expect(text).toContain('Removed Fly app community-acme (internal id 4817203)');
    expect(probe.remove).toHaveBeenCalledOnce();
    expect(await readLaunchJournal(path)).toMatchObject({ pendingIntent: null, state: 'planned' });
  });
});

describe('--remove-uncertain output', () => {
  const context = {
    runId: RUN_ID,
    journal: journal(),
    resumeCommand: `dorkos community deploy --resume ${RUN_ID}`,
    recovery: 'RECOVERY REPORT',
  };
  const target = {
    provider: 'fly' as const,
    token: '4817203',
    resourceName: 'community-acme',
    organization: 'acme',
    proof: 'marker' as const,
    appName: 'community-acme',
  };

  it.each([
    [{ outcome: 'nothing-pending' as const }, 0, 'This run has no unresolved resource.'],
    [{ outcome: 'resume-first' as const }, 0, `--resume ${RUN_ID}`],
    [{ outcome: 'not-a-create' as const }, 0, 'RECOVERY REPORT'],
    [
      { outcome: 'absent' as const, provider: 'fly' as const, cleared: false },
      0,
      'This run cannot be resumed',
    ],
    [
      { outcome: 'absent' as const, provider: 'fly' as const, cleared: true },
      0,
      'it no longer shows in --list-incomplete',
    ],
    [
      {
        outcome: 'absent' as const,
        provider: 'fly' as const,
        cleared: false,
        clearableAfter: '2026-09-23T10:43:03.000Z',
        clearableInMs: 483_000,
      },
      0,
      `Run dorkos community deploy --remove-uncertain ${RUN_ID} again in about 9 minutes (after 10:44 UTC) to check once more and clear it.`,
    ],
    [
      {
        outcome: 'absent' as const,
        provider: 'fly' as const,
        cleared: false,
        clearableAfter: '2026-09-23T10:44:00.000Z',
        clearableInMs: 1_000,
      },
      0,
      'again in about 1 minute (after 10:44 UTC)',
    ],
    [{ outcome: 'unreachable' as const, provider: 'neon' as const }, 1, 'could not read Neon'],
    [{ outcome: 'changed' as const }, 1, 'nothing was removed'],
    [
      {
        outcome: 'wrong-token' as const,
        target: { ...target, createdAt: '', proofValue: '', contents: '' },
      },
      1,
      'not the internal id',
    ],
    [{ outcome: 'removal-uncertain' as const, target }, 1, 'could not confirm it is gone'],
    [{ outcome: 'removed' as const, target, nameReleased: false }, 0, 'wait a few minutes'],
    [{ outcome: 'removed' as const, target, nameReleased: true }, 0, 'Fly has released the name'],
    [
      {
        outcome: 'unproved' as const,
        provider: 'fly' as const,
        reason: 'not-the-same' as const,
        candidates: [],
        removalPending: true as const,
      },
      0,
      `Then run dorkos community deploy --remove-uncertain ${RUN_ID} again. It will see the resource is gone and finish the removal, and --resume will work again.`,
    ],
  ])('explains %o', (outcome, exitCode, phrase) => {
    const result = formatRemovalOutcome(outcome, context);
    expect(result.exitCode).toBe(exitCode);
    expect(result.text).toContain(phrase);
  });

  // DOR-2646: Fly deletes the bucket but leaves its Tigris access key active. The bucket and its app
  // have different names here, so a key name taken from the app instead of the bucket goes red.
  describe('a removed Tigris bucket', () => {
    const bucket = {
      provider: 'tigris' as const,
      token: 'addon-5',
      resourceName: 'files-acme',
      organization: 'acme',
      proof: 'binding' as const,
      appName: 'community-acme',
    };

    it('says the access key is still active in Tigris and how to delete it', () => {
      const { text, exitCode } = formatRemovalOutcome(
        { outcome: 'removed', target: bucket, nameReleased: null },
        context
      );
      expect(exitCode).toBe(0);
      expect(text).toContain(
        'Removed Tigris bucket files-acme (add-on id addon-5) and took its access key off app community-acme.'
      );
      expect(text).toContain(
        'Tigris still has the access key Fly made for bucket files-acme, and it still works.'
      );
      expect(text).toContain('fly storage dashboard --org acme');
      expect(text).toContain(
        'The key is named after the bucket, usually files-acme_access_key: look for it in the list and delete it.'
      );
      expect(text).toContain('tigris login oauth            (choose "Sign in with Fly")');
      expect(text).toContain('its id starts with tid_');
      expect(text).toContain('tigris access-keys delete <id>');
      expect(text).not.toContain('community-acme_access_key');
      // Never claims the key itself was removed.
      expect(text).not.toMatch(/and its (two )?access keys?/iu);
      expect(text).not.toMatch(/provider|adapter|connector|integration/iu);
    });

    it('says on the confirmation screen that Tigris keeps the key', () => {
      const text = formatRemovalOffer(
        {
          ...bucket,
          createdAt: '2026-09-23T10:31:07Z',
          proofValue: `dorkos-${MARKER}`,
          contents: 'no files',
        },
        [],
        context
      );
      expect(text).toContain(
        'Removing it deletes this bucket and every file in it, and takes its access key off app community-acme. Tigris keeps the key itself until you delete it, and DorkOS shows you how once the bucket is gone.'
      );
      expect(text).not.toMatch(/removes its (two )?access keys?/iu);
    });

    it('names the access key in the steps for removing the bucket by hand', () => {
      const { text } = formatRemovalOutcome(
        {
          outcome: 'unproved',
          provider: 'tigris',
          reason: 'no-match',
          candidates: [],
        },
        {
          ...context,
          journal: journal({
            pendingIntent: {
              provider: 'tigris',
              organizationId: 'acme',
              resourceName: 'files-acme',
              requestedAt: '2026-09-23T10:31:03.000Z',
            },
          }),
        }
      );
      expect(text).toContain('Remove:  fly storage destroy files-acme');
      expect(text).toContain('usually files-acme_access_key');
      expect(text).not.toContain('community-acme_access_key');
    });

    it('leaves Fly apps and Neon projects without the access-key steps', () => {
      const { text } = formatRemovalOutcome(
        { outcome: 'removed', target, nameReleased: true },
        context
      );
      expect(text).not.toContain('access key');
    });
  });

  it('keeps the retired nouns out of every reason', () => {
    const reasons = [
      'too-old',
      'no-marker',
      'different-marker',
      'other-organization',
      'other-region',
      'outside-window',
      'several',
      'no-match',
      'incomplete-list',
      'bound-app-unproved',
      'not-confirmed',
      'grown',
      'not-the-same',
    ] as const;
    for (const reason of reasons) {
      for (const provider of ['fly', 'neon', 'tigris'] as const) {
        expect(unprovedReasonText(reason, provider)).not.toMatch(
          /provider|adapter|connector|integration/iu
        );
      }
    }
  });
});

describe('--remove-uncertain with the committed gate', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('shows the proof, and without a terminal or --confirm only prints the exact command', async () => {
    const { runRemoveUncertainCommand: runOpen } = await import('../provenance/removal-command.js');
    await initializeLaunchJournal(path, journal());
    const probe = markedApp();
    const streams = terminal(false);
    const code = await runOpen({
      runId: RUN_ID,
      journalPath: path,
      serviceOptions: () => {
        throw new Error('unused');
      },
      input: streams.input,
      output: streams.output,
      resumeCommand: () => null,
      recovery: () => '',
      probeFor: () => probe,
      signals: new EventEmitter() as unknown as Pick<NodeJS.Process, 'once' | 'removeListener'>,
    });
    expect(code).toBe(0);
    const text = streams.text();
    expect(text).toContain('DorkOS can prove that run made it');
    expect(text).toContain('community-acme  (internal id 4817203)');
    expect(text).toContain('4 seconds after the run asked for it');
    expect(text).toContain('dorkos-7f3e…c21a');
    expect(text).toContain(`--remove-uncertain ${RUN_ID} --confirm 4817203`);
    expect(probe.remove).not.toHaveBeenCalled();
  });

  it('removes after the internal id is typed at the prompt, and keeps it on Enter', async () => {
    const { runRemoveUncertainCommand: runOpen } = await import('../provenance/removal-command.js');
    await initializeLaunchJournal(path, journal());
    const drive = async (answer: string) => {
      const probe = markedApp();
      const streams = terminal(true);
      streams.output.on('data', (chunk) => {
        if (String(chunk).includes('press Enter to keep it')) streams.input.write(`${answer}\r`);
      });
      const code = await runOpen({
        runId: RUN_ID,
        journalPath: path,
        serviceOptions: () => {
          throw new Error('unused');
        },
        input: streams.input,
        output: streams.output,
        resumeCommand: () => 'RESUME',
        recovery: () => '',
        probeFor: () => probe,
        signals: new EventEmitter() as unknown as Pick<NodeJS.Process, 'once' | 'removeListener'>,
      });
      return { code, probe, text: streams.text() };
    };
    const kept = await drive('');
    expect(kept.code).toBe(0);
    expect(kept.text).toContain('Kept Fly app community-acme');
    expect(kept.probe.remove).not.toHaveBeenCalled();

    const removed = await drive('4817203');
    expect(removed.code).toBe(0);
    expect(removed.probe.remove).toHaveBeenCalledTimes(1);
    expect(removed.text).toContain('Removed Fly app community-acme (internal id 4817203)');
    expect(removed.text).toContain('Continue with: RESUME');
  });
});

// A service whose gate is closed is only ever checked, however the operator confirms.
describe('--remove-uncertain with a gate still closed', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('only checks, and names what is still unconfirmed', async () => {
    vi.doMock('../provenance/provenance-gate.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../provenance/provenance-gate.js')>()),
      PROVENANCE_ROUND_TRIP_PROVED: { fly: false, neon: true },
    }));
    const { runRemoveUncertainCommand: runClosed } =
      await import('../provenance/removal-command.js');
    await initializeLaunchJournal(path, journal());
    const probe = markedApp();
    const streams = terminal(false);
    const code = await runClosed({
      runId: RUN_ID,
      journalPath: path,
      confirmToken: '4817203',
      serviceOptions: () => {
        throw new Error('unused');
      },
      input: streams.input,
      output: streams.output,
      resumeCommand: () => null,
      recovery: () => '',
      probeFor: () => probe,
      signals: new EventEmitter() as unknown as Pick<NodeJS.Process, 'once' | 'removeListener'>,
    });
    expect(code).toBe(0);
    expect(streams.text()).toContain('not yet confirmed this proof with Fly');
    expect(probe.remove).not.toHaveBeenCalled();
    expect((await readLaunchJournal(path))?.revision).toBe(0);
    vi.doUnmock('../provenance/provenance-gate.js');
  });
});
