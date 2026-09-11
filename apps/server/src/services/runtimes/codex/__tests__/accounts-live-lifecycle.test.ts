import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { drainAccountsTurn, withAccountsHome } from './accounts-live-lifecycle.js';

describe('isolated Accounts probe cleanup', () => {
  it('removes its copied login after setup failure', async () => {
    let root = '';
    await expect(
      withAccountsHome('synthetic login', async (value) => {
        root = value;
        if (process.platform !== 'win32')
          expect((await stat(join(root, 'private/codex/auth.json'))).mode & 0o777).toBe(0o600);
        throw new Error('setup failed');
      })
    ).rejects.toThrow('setup failed');
    await expect(access(root)).rejects.toThrow();
  });
  it('drains a real owned child on timeout and removes the isolated login', async () => {
    let root = '';
    let pid: number | undefined;
    await expect(
      withAccountsHome('synthetic login', async (value) => {
        root = value;
        const child = spawn(
          process.execPath,
          ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        );
        pid = child.pid;
        const exited = once(child, 'exit').then(() => undefined);
        await once(child.stdout!, 'data');
        // Same cancellation/drain helper used by the fixture's timeout handler.
        await drainAccountsTurn(async () => {
          child.kill('SIGTERM');
        }, exited);
        throw new Error('turn timed out');
      })
    ).rejects.toThrow('turn timed out');
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
    await expect(access(root)).rejects.toThrow();
  });
});
