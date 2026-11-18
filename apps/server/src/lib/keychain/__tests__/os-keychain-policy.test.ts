/**
 * Every macOS Keychain read the server can make asks `mayReadOsKeychain` first
 * (DOR-4423), so a server on the test runtime never reaches the person's real
 * login Keychain, whatever home folders it was started with.
 *
 * The census reads the source of the server, the desktop shell and every
 * package for a DIRECT Keychain read: the `security` CLI, the `keytar` module,
 * or Electron's `safeStorage`. Each file it finds must be on the list below and
 * must call the guard in its code, not only in a comment. A listed file that no
 * longer reads the Keychain fails too, so the list only changes on purpose. That
 * the guard sits in front of each read is proved by each listed file's own test
 * (`claude-sign-in-expiry.test.ts`, `credential-provider.test.ts`); this census
 * is the net for a new file.
 *
 * Commands that read the Keychain THEMSELVES are not seen by a text search, so
 * they are listed in {@link SELF_READING_COMMANDS} with why each cannot reach it
 * under the test runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeOnly } from '../../../../../../scripts/lib/code-only.mjs';
import { env } from '../../../env.js';
import { mayReadOsKeychain } from '../os-keychain-policy.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

const SCANNED = ['apps/server/src', 'apps/desktop/src', 'packages'];
/** Tests, build output, and `scripts/` folders: developer tools a server never runs. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__tests__', 'scripts']);

/** Files that read the Keychain directly, and what each reads. */
const KEYCHAIN_CALL_SITES: Record<string, string> = {
  'apps/server/src/services/runtimes/claude-code/tooling/claude-sign-in-expiry.ts':
    "The Claude sign-in's expiry, read from Claude Code's own Keychain entry.",
  'apps/server/src/services/core/credential-provider.ts':
    'A `keychain:` credential reference a person set for a runtime.',
};

/** Files that name a Keychain command without ever running one, and why. */
const NAMES_ONLY: Record<string, string> = {
  'packages/evals/src/suite/unblock-oracles.ts':
    "A pattern that spots a Keychain command in an eval agent's output; it runs nothing.",
};

/**
 * Commands the server starts that read the Keychain themselves on macOS, by the
 * file that starts them, with why none reaches it under the test runtime. A
 * guarded one must call the guard; the others are unreachable by wiring.
 */
const SELF_READING_COMMANDS: Record<string, { command: string; guarded: boolean; why: string }> = {
  'apps/server/src/services/runtimes/claude-code/tooling/claude-cli-auth.ts': {
    command: 'claude auth status',
    guarded: false,
    why: 'Run only by ClaudeCodeRuntime, which startup never builds under the test runtime.',
  },
  'apps/server/src/services/runtimes/connect/delegated-login.ts': {
    command: 'claude auth login',
    guarded: true,
    why: 'No login command on a Mac whenever mayReadOsKeychain() is false.',
  },
  'apps/server/src/services/heartbeats/gatherers/workspace.ts': {
    command: 'gh pr checks',
    guarded: true,
    why: 'Skipped on a Mac whenever mayReadOsKeychain() is false.',
  },
};

/**
 * A direct Keychain read: the `security` CLI's Keychain verbs or its absolute
 * path, a process started as `security` (arguments may wrap onto the next
 * line), `keytar`, or Electron `safeStorage`.
 */
const KEYCHAIN_READ =
  /-(?:generic|internet)-password\b|\b(?:unlock|dump|show|list|create|default|login)-keychain\b|\bfind-(?:certificate|identity|key)\b|\/usr\/bin\/security\b|\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|exec|execSync|execAsync|execa)\s*\(\s*['"`]security['"`]|\bkeytar\b|\bsafeStorage\b/;

/** A call to the guard. */
const GUARD_CALL = /\bmayReadOsKeychain\(\)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (
      /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) &&
      !/\.test\.|\.spec\./.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('mayReadOsKeychain', () => {
  const realTestRuntime = env.DORKOS_TEST_RUNTIME;

  afterEach(() => {
    env.DORKOS_TEST_RUNTIME = realTestRuntime;
    vi.unstubAllEnvs();
  });

  it('is false whenever the test runtime is on, on every platform', () => {
    env.DORKOS_TEST_RUNTIME = true;
    vi.stubEnv('DORKOS_TEST_RUNTIME', 'false');
    expect(mayReadOsKeychain()).toBe(false);
  });

  it('is false when the flag was set after startup, as an in-process test server does', () => {
    env.DORKOS_TEST_RUNTIME = false;
    vi.stubEnv('DORKOS_TEST_RUNTIME', 'true');
    expect(mayReadOsKeychain()).toBe(false);
  });

  it('follows the platform when the test runtime is off', () => {
    env.DORKOS_TEST_RUNTIME = false;
    vi.stubEnv('DORKOS_TEST_RUNTIME', '');
    expect(mayReadOsKeychain()).toBe(process.platform === 'darwin');
  });
});

describe('Keychain call-site census', () => {
  // Raw text for finding reads, so nothing a lexer blanks can hide one; code
  // alone (comments and strings blanked) for finding the guard call.
  const raw = new Map(
    SCANNED.flatMap((root) => sourceFiles(path.join(REPO, root))).map((file) => [
      path.relative(REPO, file).split(path.sep).join('/'),
      fs.readFileSync(file, 'utf-8'),
    ])
  );
  const sources = new Map([...raw].map(([file, text]) => [file, codeOnly(text, file)]));
  const found = [...raw]
    .filter(([file]) => !(file in NAMES_ONLY))
    .filter(([, source]) => KEYCHAIN_READ.test(source))
    .map(([file]) => file)
    .sort();

  it('finds exactly the listed Keychain call sites', () => {
    expect(found).toEqual(Object.keys(KEYCHAIN_CALL_SITES).sort());
  });

  it.each(Object.keys(NAMES_ONLY))('%s still names one, and runs nothing', (file) => {
    const source = raw.get(file) ?? '';
    expect(source).toMatch(KEYCHAIN_READ);
    expect(source).not.toMatch(/\b(?:execFile|spawn|exec|execa)\w*\s*\(/);
  });

  it.each(Object.keys(KEYCHAIN_CALL_SITES))('%s asks mayReadOsKeychain in its code', (file) => {
    expect(sources.get(file) ?? '').toMatch(GUARD_CALL);
  });

  it.each(Object.entries(SELF_READING_COMMANDS))(
    '%s still starts the command it is listed for, guarded as listed',
    (file, entry) => {
      const text = raw.get(file);
      expect(text, `${file} is gone: update the list`).toBeDefined();
      // The program is often a resolved path, so its arguments are what is literal.
      for (const word of entry.command.split(' ').slice(1)) expect(text).toContain(`'${word}'`);
      if (entry.guarded) expect(sources.get(file)).toMatch(GUARD_CALL);
    }
  );
});
