/** Collating symbols, equivalence classes and ranges ending in `[` cannot hide a setup-file write (N2, R1). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GuardHost } from '../guard-host.js';
import { resolveGuardChild } from '../guard-child-file.js';
import { createShellPathGuardHook } from '../shell-path-guard.js';
import { checkShellCommand, shellWriteVerdict, type ShellGuardRoots } from '../shell-check.js';

let root: string;
let agent: string;
let roots: ShellGuardRoots;
let host: GuardHost;
const forms = ['[[.c.]]', '[[=c=]]', '[[.hyphen.]c]', '[a-[.z.]]', '[[.a.]-z]'];
const cases = [
  ...forms.map((form) => [`.m${form}p.json`, '.mcp.json']),
  ...forms.map((form) => [`.${form}laude/settings.json`, '.claude/settings.json']),
  ['.cl[[.a.]]ude/settings.json', '.claude/settings.json'],
  ['.claude/settings.js[[=o=]]n', '.claude/settings.json'],
];
// A range that ends in `[` (R1): bash and zsh read `,-[` as one range, and it holds `.`.
const rangeEnds = ['[,-[]', '[+-[]', '[--[]'];
const rangeCases = [
  ...rangeEnds.map((form) => [`.mcp${form}json`, '.mcp.json']),
  ...rangeEnds.map((form) => [`.claude/settings${form}json`, '.claude/settings.json']),
];
const shells = ['/bin/bash', '/bin/zsh'];

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shell-brackets-')));
  agent = path.join(root, 'data', 'agents', 'scout');
  mkdirSync(path.join(agent, '.claude'), { recursive: true });
  mkdirSync(path.join(root, 'home'));
  mkdirSync(path.join(root, 'claude'));
  writeFileSync(path.join(agent, '.claude', 'settings.json'), '{}');
  writeFileSync(path.join(agent, '.mcp.json'), '{}');
  roots = {
    cwd: agent,
    dorkHome: path.join(root, 'data'),
    home: path.join(root, 'home'),
    accounts: [],
    env: {},
    agentHomes: () => [agent],
  };
  vi.stubEnv('DORK_HOME', roots.dorkHome);
  host = new GuardHost({ childFile: resolveGuardChild, log: { warn: () => {} } });
});
afterAll(() => {
  host.stop();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Bash bracket forms', () => {
  for (const permissionMode of [
    'bypassPermissions',
    'default',
    'acceptEdits',
    'dontAsk',
    'plan',
    'auto',
  ]) {
    it.each([
      '.cl[[.a.]]ude/settings.json',
      '.m[[.c.]]p.json',
      '.claude/settings.js[[=o=]]n',
      '.m[[=c=]]p.json',
    ])(`the real child and hook refuse and record %s at ${permissionMode}`, async (pattern) => {
      const recordRefusal = vi.fn();
      const hook = createShellPathGuardHook({ permissionMode } as never, {
        check: host.check,
        roots: () => roots,
        recordRefusal,
        log: { info: () => {}, warn: () => {} },
      });
      const command = `/bin/zsh -c "/bin/bash -c 'printf x > ${agent}/${pattern}'"`;
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          tool_use_id: 'bracket-proof',
        } as never,
        undefined,
        { signal: new AbortController().signal }
      );
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      expect(recordRefusal).toHaveBeenCalledOnce();
    });
  }

  it.each(cases)('refuses the setup write spelled %s', (pattern) => {
    expect(shellWriteVerdict(`printf x > ${agent}/${pattern}`, roots)).toBe('writes');
  });

  it.each(['.m[[.c]p.json', '.m[[=c]p.json', '.m[[:alpha]p.json'])(
    'refuses an unclosed special bracket instead of reading it as a plain set: %s',
    async (pattern) => {
      expect(await checkShellCommand(`printf x > ${agent}/${pattern}`, roots, false)).toMatchObject(
        { write: 'unreadable' }
      );
    }
  );

  for (const locale of ['C', 'en_US.UTF-8']) {
    it.runIf(process.platform === 'darwin').each(cases)(
      `matches the real Bash write under ${locale}: %s`,
      (pattern, file) => {
        const command = `printf bracket-proof > ${agent}/${pattern}`;
        const result = spawnSync('/bin/bash', ['-c', command], {
          cwd: agent,
          env: {
            LC_ALL: locale,
            HOME: roots.home,
            DORK_HOME: roots.dorkHome,
            CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
          },
        });
        expect(result.status, result.stderr.toString()).toBe(0);
        expect(readFileSync(path.join(agent, file!), 'utf8')).toBe('bracket-proof');
        expect(shellWriteVerdict(command, roots)).toBe('writes');
      }
    );
  }

  it.each(rangeCases)('refuses the setup write through a range ending in [: %s', (pattern) => {
    expect(shellWriteVerdict(`printf x > ${agent}/${pattern}`, roots)).toBe('writes');
    expect(shellWriteVerdict(`cp /dev/null ${agent}/${pattern}`, roots)).toBe('writes');
  });

  it.each(rangeCases)(
    'the real child and hook refuse a range ending in [ at Full: %s',
    async (pattern) => {
      const recordRefusal = vi.fn();
      const hook = createShellPathGuardHook({ permissionMode: 'bypassPermissions' } as never, {
        check: host.check,
        roots: () => roots,
        recordRefusal,
        log: { info: () => {}, warn: () => {} },
      });
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: `printf '{"hooks":1}' > ${agent}/${pattern}` },
          tool_use_id: 'range-proof',
        } as never,
        undefined,
        { signal: new AbortController().signal }
      );
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      expect(recordRefusal).toHaveBeenCalledOnce();
    }
  );

  for (const shell of shells) {
    for (const locale of ['C', 'en_US.UTF-8']) {
      it.runIf(process.platform === 'darwin').each(rangeCases)(
        `matches the real ${shell} write under ${locale}: %s`,
        (pattern, file) => {
          const command = `printf range-proof > ${agent}/${pattern}`;
          const result = spawnSync(shell, ['-c', command], {
            cwd: agent,
            env: {
              LC_ALL: locale,
              HOME: roots.home,
              DORK_HOME: roots.dorkHome,
              CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
            },
          });
          expect(result.status, result.stderr.toString()).toBe(0);
          expect(readFileSync(path.join(agent, file!), 'utf8')).toBe('range-proof');
          expect(shellWriteVerdict(command, roots)).toBe('writes');
        }
      );
    }
  }

  it.runIf(process.platform === 'darwin')(
    'refuses Bash launched from zsh with an equivalence class',
    () => {
      const command = `/bin/bash -c 'printf nested-proof > ${agent}/.m[[=c=]]p.json'`;
      const result = spawnSync('/bin/zsh', ['-c', command], {
        cwd: agent,
        env: {
          LC_ALL: 'C',
          HOME: roots.home,
          DORK_HOME: roots.dorkHome,
          CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        },
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(readFileSync(path.join(agent, '.mcp.json'), 'utf8')).toBe('nested-proof');
      expect(shellWriteVerdict(command, roots)).toBe('writes');
    }
  );
});
