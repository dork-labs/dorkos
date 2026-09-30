/**
 * The live gate's optional hold: keep a finished, proven community alive for a capped time so an
 * attended run can drive it (the two-Desktop driver's remote mode, a backup and restore), then
 * clean it up no matter how the hold ends.
 *
 * Everything here runs after provider resources exist, so the one property that matters is that
 * nothing in it can skip cleanup: not the hold timing out, not the operator's `done` file, not
 * Control-C, and not an error thrown part way through. It has no provider boundary, so every one
 * of those paths is proven with a fake clock and a fake cleanup.
 *
 * The handoff file holds two account passwords and an invitation link. It is written `0600` in a
 * fresh `0700` directory, only its path is ever printed, and the directory is removed before
 * cleanup starts.
 */
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { CommunityLiveGateError } from './community-deploy-live-capture.js';
import {
  CommunityLiveProofError,
  type CommunityLiveAccess,
} from './community-deploy-live-proof.js';

/** How often the hold looks for the `done` file. */
export const HOLD_POLL_MS = 5_000;

/** The handoff file's name inside its private directory. */
export const HANDOFF_FILE_NAME = 'handoff.json';

/** The sibling file an operator creates to end the hold early. */
export const HOLD_DONE_FILE_NAME = 'done';

/** Why a hold ended. */
export type CommunityLiveHoldEnd =
  /** The operator created the `done` file. */
  | 'done'
  /** The capped time ran out. */
  | 'timeout'
  /** Control-C (SIGINT) or SIGTERM. */
  | 'interrupt';

/** The receipt's record of a hold: no path, no credential. */
export interface CommunityLiveHeldReceipt {
  minutes: number;
  endedBy: CommunityLiveHoldEnd;
}

/** A written handoff: its private directory and the file inside it. */
export interface CommunityLiveHandoffFile {
  directory: string;
  file: string;
}

/**
 * Write the handoff file the two-Desktop driver reads (`DORKOS_TWO_DESKTOP_COMMUNITY_HANDOFF`,
 * `apps/e2e/community-two-desktop/config.ts`): exactly the contract's fields, as a `0600` regular
 * file in a fresh `0700` directory. The modes are set explicitly rather than trusted to the umask,
 * and the file is created exclusively, so a file planted at that path is never written through.
 *
 * @param parent - The existing directory to create the private handoff directory in.
 * @param access - The proven community and its two accounts.
 */
export async function writeCommunityLiveHandoff(
  parent: string,
  access: CommunityLiveAccess
): Promise<CommunityLiveHandoffFile> {
  const directory = await mkdtemp(join(parent, 'handoff-'));
  const file = join(directory, HANDOFF_FILE_NAME);
  try {
    await chmod(directory, 0o700);
    // Built field by field, so nothing added to the access object later can reach the file.
    const body = {
      origin: access.origin,
      communityId: access.communityId,
      channelId: access.channelId,
      owner: { email: access.owner.email, password: access.owner.password },
      member: { email: access.member.email, password: access.member.password },
      inviteLink: access.inviteLink,
    };
    await writeFile(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
  } catch (error) {
    // A partial write can leave both passwords on disk; never hand back without removing it.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, file };
}

/** The clock and file checks the hold makes, injectable for tests. */
export interface HoldClock {
  now(): number;
  /** Wait `ms`, or less if `signal` aborts first; never rejects. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Whether a file exists at `path`. */
  exists(path: string): Promise<boolean>;
}

const realClock: HoldClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false
    ),
};

/**
 * Hold the community: write the handoff, print only its path, and wait until the time runs out,
 * the `done` file appears, or `signal` aborts. The handoff directory is removed on every way out,
 * including a throw, before this returns.
 *
 * @param input.parent - Where the private handoff directory is created (never the repository).
 * @param input.access - The proven community and its two accounts.
 * @param input.minutes - The hold, already checked to be 1 to 45.
 * @param input.signal - Aborted by Control-C, SIGTERM, SIGHUP or a stray error; ends the hold at once.
 * @param input.write - Where the one progress line goes (stdout in the gate).
 * @param input.clock - Injected by tests.
 */
export async function holdCommunityLive(input: {
  parent: string;
  access: CommunityLiveAccess;
  minutes: number;
  signal: AbortSignal;
  write: (text: string) => void;
  clock?: HoldClock;
}): Promise<CommunityLiveHeldReceipt> {
  const clock = input.clock ?? realClock;
  const handoff = await writeCommunityLiveHandoff(input.parent, input.access);
  try {
    const doneFile = join(handoff.directory, HOLD_DONE_FILE_NAME);
    const deadline = clock.now() + input.minutes * 60_000;
    input.write(
      `Holding the community for up to ${input.minutes} minute${input.minutes === 1 ? '' : 's'}. Handoff file: ${handoff.file}\n` +
        `End the hold early with: touch ${doneFile}   (or press Control-C). Cleanup runs either way.\n`
    );
    let endedBy: CommunityLiveHoldEnd;
    for (;;) {
      if (input.signal.aborted) {
        endedBy = 'interrupt';
        break;
      }
      if (await clock.exists(doneFile)) {
        endedBy = 'done';
        break;
      }
      const left = deadline - clock.now();
      if (left <= 0) {
        endedBy = 'timeout';
        break;
      }
      await clock.sleep(Math.min(HOLD_POLL_MS, left), input.signal);
    }
    return { minutes: input.minutes, endedBy };
  } finally {
    await rm(handoff.directory, { recursive: true, force: true });
  }
}

/**
 * Whether `child` is `parent` or inside it, comparing real paths, so a symlink on either side
 * cannot hide that one is inside the other. `child` need not exist yet: its nearest existing
 * ancestor is resolved and the rest of the path appended.
 *
 * @param child - The path to test, for example the gate's retained directory.
 * @param parent - The directory it must not be inside, for example this checkout.
 */
export async function isWithinDirectory(child: string, parent: string): Promise<boolean> {
  const resolveExisting = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch {
      const up = dirname(path);
      // The filesystem root always resolves, so this ends.
      return up === path ? path : join(await resolveExisting(up), basename(path));
    }
  };
  const fromParent = relative(await resolveExisting(parent), await resolveExisting(child));
  return !fromParent.startsWith('..') && !isAbsolute(fromParent);
}

/** The process events the held phase listens to. */
export type HeldPhaseEvent =
  'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'uncaughtException' | 'unhandledRejection';

/** The process, or a fake in tests: where the held phase listens for signals and stray errors. */
export interface SignalSource {
  on(event: HeldPhaseEvent, listener: (...args: unknown[]) => void): unknown;
  off(event: HeldPhaseEvent, listener: (...args: unknown[]) => void): unknown;
}

/** An output stream whose late errors must not crash cleanup. */
export interface OutputStream {
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/**
 * A writer that can never throw: once the terminal is gone a write can fail (EPIPE, EIO), and a
 * note about cleanup must not be what stops cleanup.
 *
 * @param stream - Where to write, such as `process.stdout`.
 */
export function quietWriter(stream: { write(text: string): unknown }): (text: string) => void {
  return (text) => {
    try {
      stream.write(text);
    } catch {
      // The terminal is gone; there is no one left to tell.
    }
  };
}

/**
 * A failure inside the held phase, reported only after cleanup has finished. It names the step and
 * says the community is gone, so the operator is not sent after resources that no longer exist.
 */
export class CommunityLiveHeldPhaseError extends CommunityLiveGateError {
  /** Wrap a held-phase failure as a fixed, non-secret gate error. */
  constructor(step: string) {
    super(step, null, 'cleanup finished; the community was removed');
    this.name = 'CommunityLiveHeldPhaseError';
  }
}

/** The step a held-phase failure is reported as, from a fixed vocabulary only. */
function heldPhaseStep(error: unknown): string {
  // Both carry only fixed step names (the second-member proof's are all `member-*`).
  if (error instanceof CommunityLiveProofError || error instanceof CommunityLiveGateError)
    return error.step;
  return 'hold';
}

/** Signals that end the hold and start cleanup. SIGHUP is the terminal closing. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Stray errors that would otherwise end the process before cleanup. */
const FATAL_EVENTS = ['uncaughtException', 'unhandledRejection'] as const;

/**
 * Run the held phase (the second-member proof, then the hold if one was asked for), then clean up
 * whatever happened in it.
 *
 * For the whole of this call the process's catchable ways of dying are caught, because each would
 * leave a paid community running and the handoff (two passwords) on disk:
 *
 * - Control-C, SIGTERM and SIGHUP (the terminal closing): the first aborts the phase, so the hold
 *   ends at once and cleanup starts. A later one is ignored with a note, because stopping cleanup
 *   part way would leave paid resources running.
 * - An uncaught exception or unhandled rejection anywhere in the process: it aborts the phase the
 *   same way, and the run is reported as failed after cleanup.
 * - An `error` on stdout or stderr (EPIPE, EIO once the terminal is gone): swallowed. These
 *   listeners stay for the rest of the process, since the gate still writes after cleanup.
 *
 * SIGKILL cannot be caught by anything. A phase that throws still gets its cleanup, and its error
 * is reported afterwards as a {@link CommunityLiveHeldPhaseError}. A cleanup that throws is
 * reported as itself, since then resources may remain.
 *
 * @param input.phase - The held phase; must honour its abort signal.
 * @param input.cleanup - The gate's identity-checked cleanup; called exactly once.
 * @param input.signals - The process, or a fake in tests.
 * @param input.streams - Output streams to guard (stdout and stderr in the gate).
 * @param input.write - Where the notes about signals and stray errors go (stderr in the gate).
 */
export async function runHeldPhaseThenCleanUp<P, C>(input: {
  phase: (signal: AbortSignal) => Promise<P>;
  cleanup: () => Promise<C>;
  signals: SignalSource;
  streams?: readonly OutputStream[];
  write: (text: string) => void;
}): Promise<{ phase: P; cleanup: C }> {
  const controller = new AbortController();
  const write = quietWriter({ write: input.write });
  let noted = false;
  let fatal = false;
  const onSignal = () => {
    if (!controller.signal.aborted) return controller.abort();
    if (noted) return;
    noted = true;
    write('Cleaning up the community first; the gate exits when cleanup finishes.\n');
  };
  const onFatal = () => {
    // Only a fixed sentence: the error itself may carry provider text or a credential.
    if (!fatal) write('An unexpected error stopped the run; cleaning up the community.\n');
    fatal = true;
    controller.abort();
  };
  for (const stream of input.streams ?? []) stream.on('error', () => undefined);
  for (const event of STOP_SIGNALS) input.signals.on(event, onSignal);
  for (const event of FATAL_EVENTS) input.signals.on(event, onFatal);
  try {
    let failure: { error: unknown } | null = null;
    let phase: P | undefined;
    try {
      phase = await input.phase(controller.signal);
    } catch (error) {
      failure = { error };
    }
    const cleanup = await input.cleanup();
    if (fatal) throw new CommunityLiveHeldPhaseError('unexpected-error');
    if (failure)
      throw new CommunityLiveHeldPhaseError(
        controller.signal.aborted ? 'interrupted' : heldPhaseStep(failure.error)
      );
    return { phase: phase as P, cleanup };
  } finally {
    for (const event of STOP_SIGNALS) input.signals.off(event, onSignal);
    for (const event of FATAL_EVENTS) input.signals.off(event, onFatal);
  }
}
