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
import { formatRemovalOutcome, unprovedReasonText } from '../provenance/removal-output.js';
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
  it('only checks, with the committed gate, and names what is still unconfirmed', async () => {
    await initializeLaunchJournal(path, journal());
    const probe = markedApp();
    const { code, text } = await run(probe, { confirm: '4817203' });
    expect(code).toBe(0);
    expect(text).toContain('DorkOS will not remove anything for this run');
    expect(text).toContain('not yet confirmed this proof with Fly');
    expect(text).toContain('fly apps destroy community-acme');
    expect(probe.remove).not.toHaveBeenCalled();
    expect((await readLaunchJournal(path))?.revision).toBe(0);
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
    [{ outcome: 'absent' as const, provider: 'fly' as const }, 0, 'probably never landed'],
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

describe('--remove-uncertain with the gate open', () => {
  // The committed gate is closed; these override it through the module the command imports.
  beforeEach(() => {
    vi.resetModules();
  });

  it('shows the proof, and without a terminal or --confirm only prints the exact command', async () => {
    vi.doMock('../provenance/provenance-gate.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../provenance/provenance-gate.js')>()),
      PROVENANCE_ROUND_TRIP_PROVED: { fly: true, neon: true },
    }));
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
    vi.doUnmock('../provenance/provenance-gate.js');
  });

  it('removes after the internal id is typed at the prompt, and keeps it on Enter', async () => {
    vi.doMock('../provenance/provenance-gate.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../provenance/provenance-gate.js')>()),
      PROVENANCE_ROUND_TRIP_PROVED: { fly: true, neon: true },
    }));
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
    vi.doUnmock('../provenance/provenance-gate.js');
  });
});
