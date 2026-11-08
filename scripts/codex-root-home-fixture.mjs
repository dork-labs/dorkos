/** Privileged fixture preparation runs outside the unprivileged strace tree. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function prepareRootHome(run = spawnSync) {
  if (process.platform !== 'linux' || process.env.CI !== 'true')
    throw new Error('Root-owned Codex fixture requires Linux CI.');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-')));
  const chown = (args) => {
    const result = run('sudo', ['-n', 'chown', ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Root fixture chown failed: ${result.stderr}`);
  };
  const cleanup = () => {
    chown([`${process.getuid()}:${process.getgid()}`, root]);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    for (const name of ['codex-home', 'project', 'data', 'real-person-home'])
      fs.mkdirSync(path.join(root, name));
    fs.symlinkSync(path.join(root, 'real-person-home'), path.join(root, 'home'), 'dir');
    fs.chmodSync(root, 0o755);
    chown(['-h', '0:0', path.join(root, 'home')]);
    chown(['0:0', root]);
    if (fs.lstatSync(root).uid !== 0 || fs.lstatSync(path.join(root, 'home')).uid !== 0)
      throw new Error('Root-owned fixture ownership was not established.');
    return { root, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
