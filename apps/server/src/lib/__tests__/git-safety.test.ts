/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the mocked `git --version` prints, or an error code to fail with. */
let gitAnswer: { stdout: string } | { code: string } = { stdout: 'git version 2.49.1\n' };

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      setImmediate(() =>
        'code' in gitAnswer
          ? cb(Object.assign(new Error('spawn git'), { code: gitAnswer.code }))
          : cb(null, { stdout: gitAnswer.stdout, stderr: '' })
      );
    }
  ),
}));

const warn = vi.fn();
vi.mock('../logger.js', () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

import { hardenedGitEnv } from '../git-safety.js';

/** A fresh module, so its once-per-process git read sees this test's answer. */
async function freshSafety() {
  vi.resetModules();
  return import('../git-safety.js');
}

describe('the installed git (DOR-2326)', () => {
  beforeEach(() => warn.mockClear());

  it.each([
    ['git version 2.30.0\n', 'is too old'],
    ['git version 2.37.1 (Apple Git-136)\n', 'only partly'],
  ])('warns at startup on %j, naming 2.38', async (stdout, words) => {
    gitAnswer = { stdout };
    await (await freshSafety()).warnAboutGitProtection();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(words);
    expect(String(warn.mock.calls[0]![0])).toContain('2.38');
  });

  it.each([
    ['git 2.38', { stdout: 'git version 2.38.0\n' }],
    ['no git at all', { code: 'ENOENT' }],
  ])('says nothing for %s', async (_label, answer) => {
    gitAnswer = answer;
    await (await freshSafety()).warnAboutGitProtection();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads git once and shares the answer with the health line', async () => {
    gitAnswer = { stdout: 'git version 2.30.0\n' };
    const mod = await freshSafety();
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockClear();
    await mod.warnAboutGitProtection();
    expect((await mod.installedGitProtection()).status).toBe('warn');
    expect(vi.mocked(execFile)).toHaveBeenCalledOnce();
  });
});

describe('hardenedGitEnv', () => {
  it('confines git to the https/ssh/git transports (blocks ext::/file::)', () => {
    expect(hardenedGitEnv().GIT_ALLOW_PROTOCOL).toBe('https:ssh:git');
  });

  it('disables the interactive credential prompt so a private URL cannot hang', () => {
    expect(hardenedGitEnv().GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('inherits the parent environment so git keeps its PATH', () => {
    expect(hardenedGitEnv().PATH).toBe(process.env.PATH);
  });
});
