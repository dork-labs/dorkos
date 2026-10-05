import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { ownFixtureManager } from './fixture-manager-custody.js';

it('observes a genuine pre-ready exit and returns every original pipe without waiting for a message', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.stderr.write("setup-failed");process.exitCode=1'],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  const owner = ownFixtureManager(child);
  try {
    await expect(owner.ready()).rejects.toThrow('FIXTURE_MANAGER_CLOSED_BEFORE_READY');
    expect(await owner.close()).toMatchObject({ observed: true, forced: false });
    expect(child.exitCode).toBe(1);
  } finally {
    await owner.close();
  }
});

it('a genuine manager that ignores close is terminated through its original child, with no invented acknowledgement', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("message",()=>{});process.send({ready:true});setInterval(()=>{},1000)'],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  const owner = ownFixtureManager(child);
  try {
    expect(await owner.ready()).toEqual({ ready: true });
    expect(await owner.close()).toMatchObject({
      observed: true,
      forced: true,
      failures: ['FIXTURE_COOPERATIVE_CLOSE_EXPIRED'],
    });
    expect(child.signalCode).toBe('SIGTERM');
  } finally {
    await owner.close();
  }
}, 10000);
