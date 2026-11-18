import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stopServerAndRemove, whenExited } from '../stop-server.js';

/** A child that writes into `dir` until it is told to stop, then for a little longer. */
function writer(dir: string, script: string) {
  const child = spawn(process.execPath, ['-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, exited: whenExited(child) };
}

/** Resolves once the child has printed `ready`. */
function ready(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) =>
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve();
    })
  );
}

describe('stopServerAndRemove', () => {
  it('retains the owned data folder when signals do not confirm exit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stop-server-unconfirmed-'));
    await writeFile(path.join(dir, 'retained'), 'owned evidence');
    // Synthetic ChildProcess boundary only: no process is spawned or signalled.
    const child = new ChildProcess();
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
    const exited = whenExited(child);
    vi.useFakeTimers();
    try {
      const stopped = stopServerAndRemove(child, exited, dir);
      const refused = expect(stopped).rejects.toThrow('did not confirm exit');
      void refused.catch(() => {});
      await vi.advanceTimersByTimeAsync(10_000 + 5_000);
      await refused;
      expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
      expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(existsSync(path.join(dir, 'retained'))).toBe(true);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes the folder only after a child still writing on SIGTERM has exited', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stop-server-'));
    const { child, exited } = writer(
      dir,
      `const fs = require('node:fs'), path = require('node:path'), dir = process.argv[1];
       let n = 0;
       const write = () => fs.writeFileSync(path.join(dir, 'f' + n++), 'x');
       process.on('SIGTERM', () => {
         const t = setInterval(write, 5);
         setTimeout(() => { clearInterval(t); process.exit(0); }, 300);
       });
       write(); console.log('ready'); setInterval(() => {}, 1000);`
    );
    await ready(child);
    await stopServerAndRemove(child, exited, dir);
    expect(child.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it('kills a child that ignores SIGTERM once the grace period is up', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stop-server-'));
    const { child, exited } = writer(
      dir,
      `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`
    );
    await ready(child);
    await stopServerAndRemove(child, exited, dir, 200);
    expect(child.signalCode).toBe('SIGKILL');
    expect(existsSync(dir)).toBe(false);
  });

  it('returns at once for a child a signal already ended', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stop-server-'));
    await writeFile(path.join(dir, 'left'), 'x');
    const { child, exited } = writer(dir, `console.log('ready'); setInterval(() => {}, 1000);`);
    await ready(child);
    child.kill('SIGKILL');
    await exited;
    // exitCode stays null after a signal; a check on exitCode alone waits forever here.
    await stopServerAndRemove(child, exited, dir);
    expect(existsSync(dir)).toBe(false);
  }, 2_000);
});
