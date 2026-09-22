import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommunityLiveGateError,
  receiveClipboard,
  whileLauncherRuns,
  writePrivateClipboardShim,
} from '../../scripts/community-deploy-live-capture.js';

const SECRET = 'a'.repeat(40);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function socketPath(): Promise<string> {
  // Short on purpose: a Unix socket path over ~104 bytes fails to bind on macOS.
  const directory = await mkdtemp(join(tmpdir(), 'dlc-'));
  directories.push(directory);
  return join(directory, 'b.sock');
}

/** Write `value` to the socket the way the shim does, resolving once the peer has it. */
function send(path: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => socket.end(value, () => resolve()));
    socket.once('error', reject);
  });
}

/** Whether anything is still accepting connections on `path`. */
function listening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Collect unhandled rejections for the length of `run`, plus a few turns of the loop after. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('bootstrap capture', () => {
  it('gives up with a gate error and stops listening when no secret arrives in time', async () => {
    const path = await socketPath();
    const capture = await receiveClipboard(path);
    try {
      const error = await capture.next(50).then(
        () => null,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(CommunityLiveGateError);
      expect((error as CommunityLiveGateError).step).toBe('bootstrap-capture-timeout');
      // A listening server alone keeps Node alive, so a timeout that left it open would still hang.
      expect(await listening(path)).toBe(false);
    } finally {
      await capture.close();
    }
  });

  it('hands over a secret that arrives before the deadline, and does not fail later', async () => {
    const path = await socketPath();
    const capture = await receiveClipboard(path);
    try {
      const unhandled = await unhandledDuring(async () => {
        const pending = capture.next(100);
        await send(path, SECRET);
        await expect(pending).resolves.toBe(SECRET);
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(unhandled).toEqual([]);
      expect(await listening(path)).toBe(true);
    } finally {
      await capture.close();
    }
  });

  it('fails a pending wait when the capture is closed', async () => {
    const capture = await receiveClipboard(await socketPath());
    const pending = capture.next(60_000);
    await capture.close();
    await expect(pending).rejects.toBeInstanceOf(CommunityLiveGateError);
  });
});

describe('waiting while the resumed launcher runs', () => {
  it('surfaces a launcher that dies mid-wait as a gate error, not an unhandled rejection', async () => {
    let failLauncher!: (reason: Error) => void;
    const launcher = new Promise<void>((_resolve, reject) => {
      failLauncher = reject;
    });
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('secret'), 200));
    let outcome: unknown;
    const unhandled = await unhandledDuring(async () => {
      const waiting = whileLauncherRuns(launcher, work).then(
        () => 'resolved',
        (reason: unknown) => reason
      );
      failLauncher(new Error('pty exploded with provider output'));
      outcome = await waiting;
    });
    expect(unhandled).toEqual([]);
    expect(outcome).toBeInstanceOf(CommunityLiveGateError);
    // The raw failure may carry provider output; only a stable step name survives.
    expect((outcome as CommunityLiveGateError).step).toBe('published-launcher');
  });

  it('keeps the launcher gate error it was given', async () => {
    const launcher = Promise.reject(new CommunityLiveGateError('launcher-timeout'));
    await expect(
      whileLauncherRuns(launcher, new Promise<never>(() => undefined))
    ).rejects.toMatchObject({ step: 'launcher-timeout' });
  });

  it('observes a launcher that fails after the wait has already finished', async () => {
    let failLauncher!: (reason: Error) => void;
    const launcher = new Promise<void>((_resolve, reject) => {
      failLauncher = reject;
    });
    const unhandled = await unhandledDuring(async () => {
      await expect(whileLauncherRuns(launcher, Promise.resolve('proof'))).resolves.toBe('proof');
      failLauncher(new Error('late'));
    });
    expect(unhandled).toEqual([]);
  });

  it('does not end the wait when the launcher exits cleanly', async () => {
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('proof'), 30));
    await expect(whileLauncherRuns(Promise.resolve(), work)).resolves.toBe('proof');
  });
});

describe('clipboard shim', () => {
  async function runShim(shim: string, stdin: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = execFile(shim, [], { env: {}, timeout: 5000 }, (error) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve(typeof error?.code === 'number' ? error.code : 0);
      });
      child.stdin?.end(stdin);
    });
  }

  it('forwards a secret, lets the launcher test text and clear through, and refuses the rest', async () => {
    const path = await socketPath();
    const directory = await mkdtemp(join(tmpdir(), 'dlc-shim-'));
    directories.push(directory);
    const shim = await writePrivateClipboardShim(directory, path);
    const capture = await receiveClipboard(path);
    try {
      // The launcher's capability check and its clipboard clear must still succeed, or the real
      // launcher would stop before its first provider write.
      expect(await runShim(shim, 'DorkOS clipboard capability check')).toBe(0);
      expect(await runShim(shim, '')).toBe(0);
      // A value that is neither fails the launcher's copy loudly instead of being dropped.
      expect(await runShim(shim, 'not a bootstrap secret')).toBe(1);
      expect(await runShim(shim, SECRET)).toBe(0);
      await expect(capture.next(1000)).resolves.toBe(SECRET);
    } finally {
      await capture.close();
    }
  });
});
