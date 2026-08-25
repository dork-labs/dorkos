import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { resolveCodexHome, resolveCodexRolloutRoots } from '../codex-home.js';

/**
 * The Codex CLI resolves its own home as `$CODEX_HOME`, else `~/.codex`, and the
 * search index reads the rollout files that CLI wrote — so resolving anything
 * else is the DOR-250 split-brain in a second runtime: one program writes here,
 * DorkOS reads there, and search returns a short list while reporting nothing
 * wrong.
 */
describe('resolving the Codex home', () => {
  it('honours CODEX_HOME', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/srv/codex' })).toBe('/srv/codex');
  });

  it('falls back to ~/.codex when the variable is unset', () => {
    expect(resolveCodexHome({})).toBe(path.join(os.homedir(), '.codex'));
  });

  it('treats an empty CODEX_HOME as unset rather than as the filesystem root', () => {
    // `CODEX_HOME=` in a shell profile is a plausible accident, and reading it
    // literally would point discovery at `/sessions`.
    expect(resolveCodexHome({ CODEX_HOME: '' })).toBe(path.join(os.homedir(), '.codex'));
  });

  it('reads both rollout roots, live threads first', () => {
    expect(resolveCodexRolloutRoots({ CODEX_HOME: '/srv/codex' })).toEqual([
      '/srv/codex/sessions',
      '/srv/codex/archived_sessions',
    ]);
  });
});
