/**
 * GITHUB_TOKEN reaches git only on a repository DorkOS just made (DOR-5481):
 * a template download keeps the real token; git or gh in a working tree an
 * agent can write never sees it, since that tree's settings can name a program.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardenedGitEnv } from '../lib/git-safety.js';
import { runCommand } from '../services/heartbeats/gatherers/workspace.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-git-token-'));
  vi.stubEnv('GITHUB_TOKEN', 'fixture-real-token');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GITHUB_TOKEN and DorkOS’s git', () => {
  it('a template download’s clone keeps the real token', () => {
    expect(hardenedGitEnv().GITHUB_TOKEN).toBe('fixture-real-token');
  });

  it.skipIf(process.platform === 'win32')(
    'a workspace-gatherer gh call in an agent’s tree sees no token',
    async () => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      execFileSync('git', ['init', '-q', repo]);
      // A stand-in gh that says whether it was handed a token.
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "token=${GITHUB_TOKEN:-none}"\n', {
        mode: 0o755,
      });
      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
      const out = await runCommand('gh', ['pr', 'checks'], {
        cwd: repo,
        signal: new AbortController().signal,
      });
      expect(String(out).trim()).toBe('token=none');
    }
  );
});
