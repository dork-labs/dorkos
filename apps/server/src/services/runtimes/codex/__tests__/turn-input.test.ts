/**
 * Folder grants in Codex's thread options (spec `agent-home-desk` §4.3).
 *
 * The options are what the SDK turns into `--add-dir` on every run, so these
 * assert the options themselves; the conformance suite drives the same grants
 * through a real `sendMessage` on two turns of one thread.
 */
import { describe, it, expect } from 'vitest';
import { projectThreadOptions } from '../turn-input.js';

const CWD = '/agents/ana';

describe('projectThreadOptions and folder grants', () => {
  it('hands a write grant as a writable directory and a read grant as nothing', () => {
    const options = projectThreadOptions({ permissionMode: 'acceptEdits' }, CWD, [
      { path: '/rooms/r1/worktrees/ana', access: 'write' },
      { path: '/rooms/r1/repo', access: 'read' },
    ]);

    // The sandbox already reads outside the workspace; a read grant needs no flag.
    expect(options.additionalDirectories).toEqual(['/rooms/r1/worktrees/ana']);
    expect(options.sandboxMode).toBe('workspace-write');
  });

  it('leaves the option off entirely when a turn has no write grant', () => {
    expect('additionalDirectories' in projectThreadOptions({}, CWD)).toBe(false);
    expect(
      'additionalDirectories' in
        projectThreadOptions({}, CWD, [{ path: '/rooms/r1/repo', access: 'read' }])
    ).toBe(false);
  });

  it('refuses an invalid set before any thread is started', () => {
    expect(() =>
      projectThreadOptions({}, CWD, [{ path: `${CWD}/inside`, access: 'write' }])
    ).toThrow(/inside it/);
    expect(() =>
      projectThreadOptions({}, undefined, [{ path: '/rooms/r1/repo', access: 'read' }])
    ).toThrow(/working directory/);
  });
});
