/**
 * The stand-in runner reads no system or personal git config, and switches the
 * file-system monitor off with an empty value (DOR-3298 M3, Security's review
 * at `f50b40afd7`). Both are run against a real git, not read off the code.
 *
 * @module services/runtimes/claude-code/repo-settings/__tests__/safe-git-interim
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSafeGitBuffer } from '../safe-git-interim.js';

let root: string;
let repo: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-git-interim-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo], {
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  // A personal config the person never meant these reads to see.
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[dorkos]\n\tleak = from-home\n');
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** What git says a key is, or `null` when it has no value. */
async function configValue(key: string): Promise<string | null> {
  try {
    return (await runSafeGitBuffer(['config', '--get', key], repo)).toString('utf8').trim();
  } catch {
    return null;
  }
}

describe('the stand-in git runner', () => {
  it("does not read the person's own git config, even with HOME set", async () => {
    expect(await configValue('dorkos.leak')).toBeNull();
  });

  it('switches the file-system monitor off with an empty value, never a program name', async () => {
    expect(await configValue('core.fsmonitor')).toBe('');
  });
});
