import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The two-Desktop driver's own reader, imported rather than copied: if the driver's contract
// changes, this test fails against the gate's writer instead of a paid run failing later.
import { readHandoff } from '../../../../apps/e2e/community-two-desktop/config.js';
import {
  CommunityLiveHeldPhaseError,
  HOLD_DONE_FILE_NAME,
  HOLD_POLL_MS,
  holdCommunityLive,
  isWithinDirectory,
  quietWriter,
  runHeldPhaseThenCleanUp,
  type HeldPhaseEvent,
  writeCommunityLiveHandoff,
  type HoldClock,
} from '../../scripts/community-deploy-live-hold.js';
import { CommunityLiveProofError } from '../../scripts/community-deploy-live-proof.js';
import { CommunityLiveGateError } from '../../scripts/community-deploy-live-capture.js';
import {
  describeCommunityLiveGateFailure,
  explainCommunityLiveGateFailure,
} from '../../scripts/community-deploy-live-failure.js';

const access = {
  origin: 'https://dorkos-gate-012345abcdef.fly.dev',
  communityId: '7ea92c45-1e1d-4bb8-9602-e10816488828',
  channelId: 'b21ab2b5-cbfa-4f22-b71e-ae56f0f44634',
  owner: { email: 'gate-owner@community-gate.invalid', password: 'owner-password-FAKE' },
  member: { email: 'gate-member@community-gate.invalid', password: 'member-password-FAKE' },
  inviteLink:
    'https://dorkos-gate-012345abcdef.fly.dev/c/7ea92c45-1e1d-4bb8-9602-e10816488828/join#invite=invite-token-FAKE',
};
const SECRETS = [
  access.owner.password,
  access.member.password,
  'invite-token-FAKE',
  access.owner.email,
  access.member.email,
];

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function parent() {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-live-hold-'));
  directories.push(directory);
  return directory;
}

/** A clock whose sleeps advance time instantly, with a hook run at each poll. */
function fakeClock(onSleep: (poll: number) => void | Promise<void> = () => undefined) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const clock: HoldClock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      await onSleep(sleeps.length);
    },
    exists: async (path) => existsSync(path),
  };
  return { clock, sleeps };
}

/** A process stand-in: the listeners the phase registers, and a way to send it a signal. */
function fakeSignals() {
  const emitter = new EventEmitter();
  return {
    source: {
      on: (event: HeldPhaseEvent, listener: (...args: unknown[]) => void) =>
        emitter.on(event, listener),
      off: (event: HeldPhaseEvent, listener: (...args: unknown[]) => void) =>
        emitter.off(event, listener),
    },
    send: (event: HeldPhaseEvent, ...args: unknown[]) => emitter.emit(event, ...args),
    listening: () => emitter.eventNames().reduce((n, e) => n + emitter.listenerCount(e), 0),
  };
}

/** Run a hold inside the held phase with a fake cleanup that records what it saw. */
async function heldRun(input: {
  minutes?: number;
  onSleep?: (poll: number, handoff: { directory: string; file: string }) => void | Promise<void>;
  exists?: HoldClock['exists'];
  signals?: ReturnType<typeof fakeSignals>;
}) {
  const root = await parent();
  const signals = input.signals ?? fakeSignals();
  const output: string[] = [];
  let handoff: { directory: string; file: string } | null = null;
  const locate = async () => {
    const { readdirSync } = await import('node:fs');
    const name = readdirSync(root).find((entry) => entry.startsWith('handoff-'));
    return name ? { directory: join(root, name), file: join(root, name, 'handoff.json') } : null;
  };
  const { clock, sleeps } = fakeClock(async (poll) => {
    handoff ??= await locate();
    await input.onSleep?.(poll, handoff!);
  });
  if (input.exists) clock.exists = input.exists;
  const cleanup = vi.fn(async () => {
    // Recorded at the moment cleanup starts: the handoff must already be gone.
    return { handoffPresent: handoff ? existsSync(handoff.directory) : null };
  });
  const result = runHeldPhaseThenCleanUp({
    signals: signals.source,
    write: (text) => void output.push(text),
    phase: (signal) =>
      holdCommunityLive({
        parent: root,
        access,
        minutes: input.minutes ?? 45,
        signal,
        write: (text) => void output.push(text),
        clock,
      }),
    cleanup,
  });
  return { result, cleanup, output, sleeps, signals, root, handoff: () => handoff };
}

describe('Community live gate hold', () => {
  it('writes a handoff the two-Desktop driver reads back field for field', async () => {
    // Catches the gate's writer and the driver's reader (DOR-2592) drifting apart: a renamed
    // field, a loose mode, or a file the driver refuses.
    const { file, directory } = await writeCommunityLiveHandoff(await parent(), access);
    expect(dirname(file)).toBe(directory);
    expect(readHandoff(file)).toEqual(access);
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort()).toEqual(
      ['channelId', 'communityId', 'inviteLink', 'member', 'origin', 'owner'].sort()
    );
  });

  it('makes the handoff directory 0700 and the file 0600 whatever the umask', async () => {
    // Catches modes left to the umask: a 0022 umask would give 0644, which the driver refuses.
    const previous = process.umask(0o000);
    try {
      const { file, directory } = await writeCommunityLiveHandoff(await parent(), access);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it('ends on the done file, removes the handoff, then cleans up once', async () => {
    // Catches `done` being ignored, or cleanup starting while the credentials are still on disk.
    const run = await heldRun({
      onSleep: async (poll, handoff) => {
        if (poll === 2) await writeFile(join(handoff.directory, HOLD_DONE_FILE_NAME), '');
      },
    });
    const { phase, cleanup } = await run.result;
    expect(phase).toEqual({ minutes: 45, endedBy: 'done' });
    expect(run.cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toEqual({ handoffPresent: false });
    expect(run.sleeps).toEqual([HOLD_POLL_MS, HOLD_POLL_MS]);
  });

  it('ends on timeout after the capped minutes, polling every 5 s', async () => {
    // Catches a hold that outlives its cap, or polls at another rate.
    const run = await heldRun({ minutes: 1 });
    const { phase, cleanup } = await run.result;
    expect(phase).toEqual({ minutes: 1, endedBy: 'timeout' });
    expect(run.sleeps).toEqual(Array(12).fill(HOLD_POLL_MS));
    expect(run.cleanup).toHaveBeenCalledOnce();
    expect(cleanup.handoffPresent).toBe(false);
  });

  it('ends at once on Control-C, ignores a second one during cleanup, and cleans up once', async () => {
    // Catches Control-C killing the gate (skipping cleanup) or being able to stop cleanup half way.
    const signals = fakeSignals();
    const run = await heldRun({
      signals,
      onSleep: (poll) => {
        if (poll === 3) signals.send('SIGINT');
      },
    });
    run.cleanup.mockImplementationOnce(async () => {
      signals.send('SIGINT');
      signals.send('SIGTERM');
      return { handoffPresent: existsSync(run.handoff()!.directory) };
    });
    const { phase, cleanup } = await run.result;
    expect(phase).toEqual({ minutes: 45, endedBy: 'interrupt' });
    expect(run.sleeps).toHaveLength(3);
    expect(run.cleanup).toHaveBeenCalledOnce();
    expect(cleanup.handoffPresent).toBe(false);
    expect(run.output.filter((line) => line.startsWith('Cleaning up'))).toHaveLength(1);
    // The gate hands the process's own signal handling back once cleanup has finished.
    expect(signals.listening()).toBe(0);
  });

  it('ends on SIGTERM too', async () => {
    // Catches a hold that only listens for SIGINT, so `kill <pid>` would skip cleanup.
    const signals = fakeSignals();
    const run = await heldRun({ signals, onSleep: () => void signals.send('SIGTERM') });
    expect((await run.result).phase.endedBy).toBe('interrupt');
    expect(run.cleanup).toHaveBeenCalledOnce();
  });

  it('ends on SIGHUP, the terminal closing', async () => {
    // Catches a closed terminal killing the gate with the community running and the handoff on disk.
    const signals = fakeSignals();
    const run = await heldRun({ signals, onSleep: () => void signals.send('SIGHUP') });
    expect((await run.result).phase.endedBy).toBe('interrupt');
    expect(run.cleanup).toHaveBeenCalledOnce();
    expect(existsSync(run.handoff()!.directory)).toBe(false);
  });

  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'ends the hold on a stray %s, cleans up once, then reports the run failed',
    async (event) => {
      // Catches a stray error elsewhere in the process ending it before cleanup.
      const signals = fakeSignals();
      const run = await heldRun({
        signals,
        onSleep: (poll) => {
          if (poll === 2) signals.send(event, new Error('boom owner-password-FAKE'));
        },
      });
      const failure = await run.result.catch((error: unknown) => error);
      expect(run.cleanup).toHaveBeenCalledOnce();
      expect(existsSync(run.handoff()!.directory)).toBe(false);
      expect((failure as CommunityLiveHeldPhaseError).step).toBe('unexpected-error');
      expect(run.output.join('') + String(failure)).not.toContain('owner-password-FAKE');
      expect(signals.listening()).toBe(0);
    }
  );

  it('swallows output stream errors and writer throws, so a closed terminal cannot stop cleanup', async () => {
    // Catches an EPIPE/EIO on stdout or stderr (no listener means Node throws) crashing cleanup.
    const stream = new EventEmitter();
    const signals = fakeSignals();
    const cleanup = vi.fn(async () => {
      signals.send('SIGINT');
      stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      return 'cleaned';
    });
    const result = await runHeldPhaseThenCleanUp({
      signals: signals.source,
      streams: [stream],
      write: () => {
        throw Object.assign(new Error('write EIO'), { code: 'EIO' });
      },
      phase: async (signal) => {
        signals.send('SIGHUP');
        return signal.aborted;
      },
      cleanup,
    });
    expect(result).toEqual({ phase: true, cleanup: 'cleaned' });
    expect(() => stream.emit('error', new Error('later EPIPE'))).not.toThrow();
    expect(() =>
      quietWriter({
        write: () => {
          throw new Error('EIO');
        },
      })('x')
    ).not.toThrow();
  });

  it('removes the handoff directory when writing it fails part way', async () => {
    // Catches a failed write or chmod leaving a directory (and possibly passwords) behind.
    const root = await parent();
    const broken = {
      ...access,
      get member(): typeof access.member {
        throw new Error('write failed');
      },
    };
    await expect(writeCommunityLiveHandoff(root, broken)).rejects.toThrow('write failed');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(root)).toEqual([]);
  });

  it('sees a directory inside the checkout through a symlink on either side', async () => {
    // Catches the repository check comparing path text, which a symlinked DORK_HOME defeats.
    const { mkdir, symlink } = await import('node:fs/promises');
    const root = await parent();
    const repository = join(root, 'repository');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(join(repository, 'apps'), { recursive: true });
    await mkdir(elsewhere);
    await symlink(repository, join(root, 'repo-link'));
    await symlink(join(repository, 'apps'), join(elsewhere, 'home-link'));
    // Not yet existing children resolve through their nearest existing ancestor.
    expect(await isWithinDirectory(join(root, 'repo-link', '.dork', 'live-gate'), repository)).toBe(
      true
    );
    expect(await isWithinDirectory(join(elsewhere, 'home-link', 'live-gate'), repository)).toBe(
      true
    );
    expect(await isWithinDirectory(join(repository, 'x'), join(root, 'repo-link'))).toBe(true);
    expect(await isWithinDirectory(repository, repository)).toBe(true);
    expect(await isWithinDirectory(join(elsewhere, 'live-gate'), repository)).toBe(false);
    expect(await isWithinDirectory(join(root, 'repository-2', 'x'), repository)).toBe(false);
  });

  it('still removes the handoff and cleans up once when the hold throws', async () => {
    // Catches an error inside the hold skipping cleanup, or leaving the credentials on disk.
    let polls = 0;
    const run = await heldRun({
      exists: async () => {
        if (++polls === 2) throw new Error('disk gone owner-password-FAKE');
        return false;
      },
    });
    const failure = await run.result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommunityLiveHeldPhaseError);
    expect((failure as CommunityLiveHeldPhaseError).step).toBe('hold');
    expect(run.cleanup).toHaveBeenCalledOnce();
    expect(existsSync(run.handoff()!.directory)).toBe(false);
    expect(String(failure)).not.toContain('owner-password-FAKE');
  });

  it('cleans up after a failed second-member proof and reports it without a recovery command', async () => {
    // Catches a failed proof leaving the community running, or the failure pointing the operator
    // at resources cleanup already deleted.
    const signals = fakeSignals();
    const cleanup = vi.fn(async () => 'cleaned');
    const failure = await runHeldPhaseThenCleanUp({
      signals: signals.source,
      write: () => undefined,
      phase: async () => {
        throw new CommunityLiveProofError('member-file-integrity');
      },
      cleanup,
    }).catch((error: unknown) => error);
    expect(cleanup).toHaveBeenCalledOnce();
    const explained = await explainCommunityLiveGateFailure(
      failure,
      { cleanedUp: true, recoveryCommand: 'npx dorkos community deploy --resume run-1' },
      async () => 'npx dorkos community deploy --resume run-1'
    );
    expect(describeCommunityLiveGateFailure(explained)).toBe(
      'Community live gate failed (member-file-integrity): cleanup finished; the community was removed\n'
    );
  });

  it('says interrupted when Control-C aborts the second-member proof', async () => {
    // Catches an interrupted proof being misreported as a product failure.
    const signals = fakeSignals();
    const cleanup = vi.fn(async () => 'cleaned');
    const failure = await runHeldPhaseThenCleanUp({
      signals: signals.source,
      write: () => undefined,
      phase: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(new CommunityLiveProofError('member-join'))
          );
          signals.send('SIGINT');
        }),
      cleanup,
    }).catch((error: unknown) => error);
    expect(cleanup).toHaveBeenCalledOnce();
    expect((failure as CommunityLiveGateError).step).toBe('interrupted');
  });

  it('reports a cleanup failure as itself, so the recovery command is still printed', async () => {
    // Catches a phase error masking a cleanup that left resources behind.
    const signals = fakeSignals();
    const refusal = new CommunityLiveGateError('tigris-after-cleanup', 'npx recover');
    const failure = await runHeldPhaseThenCleanUp({
      signals: signals.source,
      write: () => undefined,
      phase: async () => {
        throw new Error('phase');
      },
      cleanup: async () => {
        throw refusal;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBe(refusal);
    expect(signals.listening()).toBe(0);
  });

  it('never prints or records a credential or the invitation', async () => {
    // Catches the handoff's contents reaching stdout, stderr or the receipt: only the path may.
    const signals = fakeSignals();
    const run = await heldRun({
      signals,
      onSleep: (poll) => {
        if (poll === 2) signals.send('SIGINT');
      },
    });
    const { phase } = await run.result;
    // The same fields main spreads into the receipt from the held phase.
    const receipt = JSON.stringify({
      secondMemberId: '4f0f3a53-0f64-4d69-9d1e-3a4b5c6d7e8f',
      secondMemberReplyEntryId: '0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6',
      secondMemberProof: true,
      held: phase,
    });
    const printed = run.output.join('');
    expect(printed).toContain('handoff.json');
    for (const secret of SECRETS) {
      expect(printed).not.toContain(secret);
      expect(receipt).not.toContain(secret);
    }
  });
});

/**
 * Write a child script that runs the real held phase with the real `process` and streams, the way
 * the gate does, and records what cleanup found in `marker`. Cleanup is slow on purpose, so a
 * second signal lands while it runs.
 */
async function writeChildScript(root: string, marker: string): Promise<string> {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const script = join(root, 'hold.mts');
  const module = pathToFileURL(
    resolve(import.meta.dirname, '../../scripts/community-deploy-live-hold.ts')
  ).href;
  await writeFile(
    script,
    `import { writeFileSync, readdirSync } from 'node:fs';
import { holdCommunityLive, quietWriter, runHeldPhaseThenCleanUp } from ${JSON.stringify(module)};
const root = ${JSON.stringify(root)};
const result = await runHeldPhaseThenCleanUp({
  signals: process,
  streams: [process.stdout, process.stderr],
  write: quietWriter(process.stderr),
  phase: (signal) => holdCommunityLive({
    parent: root, access: ${JSON.stringify(access)}, minutes: 1, signal,
    write: quietWriter(process.stdout),
  }),
  cleanup: async () => {
    await new Promise((done) => setTimeout(done, 500));
    // Written to a closed terminal after a hangup; must not stop cleanup.
    process.stderr.write('cleanup note\\n');
    const left = readdirSync(root).filter((name) => name.startsWith('handoff-'));
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ left }));
  },
});
process.stdout.write('ended by ' + result.phase.endedBy + '\\n');
`
  );
  return script;
}

describe('Community live gate hold, in a real process', () => {
  // The fakes above prove the decisions; these prove the wiring the operator actually meets. The
  // gate runs under tsx (`pnpm --filter dorkos test:community-live`), which relays SIGINT and
  // SIGTERM to its child but not SIGHUP. Anything Node's default handler turned into an exit would
  // skip cleanup and leave a paid community running. Nothing here touches a provider.
  it('ends the hold on SIGINT, removes the handoff, and finishes cleanup before exiting', async () => {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const root = await parent();
    const marker = join(root, 'cleanup-finished');
    const script = await writeChildScript(root, marker);
    const tsx = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const child = spawn(process.execPath, [tsx, script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => fail(new Error(`hold never started: ${stderr}`)), 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('Handoff file:')) {
          clearTimeout(timer);
          ready();
        }
      });
    });
    child.kill('SIGINT');
    await new Promise((done) => setTimeout(done, 100));
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    expect(stdout).toContain('ended by interrupt');
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ left: [] });
    for (const secret of SECRETS) expect(stdout + stderr).not.toContain(secret);
  }, 30_000);

  it('survives the terminal closing: SIGHUP to the whole group, with its output pipes gone', async () => {
    // A closed terminal sends SIGHUP to the foreground process group and leaves every later write
    // failing. The tsx parent dies of it (exit 129); the gate process must still clean up.
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const root = await parent();
    const marker = join(root, 'cleanup-finished');
    const script = await writeChildScript(root, marker);
    const tsx = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const child = spawn(process.execPath, [tsx, script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    try {
      let stdout = '';
      await new Promise<void>((ready, fail) => {
        const timer = setTimeout(() => fail(new Error('hold never started')), 15_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('Handoff file:')) {
            clearTimeout(timer);
            ready();
          }
        });
      });
      // Close our end of both pipes first, so every write after the hangup fails with EPIPE.
      child.stdout.destroy();
      child.stderr.destroy();
      process.kill(-child.pid!, 'SIGHUP');
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 100));
      expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ left: [] });
    } finally {
      // Only this test's own detached group, and only if something is still running in it.
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, 30_000);
});
