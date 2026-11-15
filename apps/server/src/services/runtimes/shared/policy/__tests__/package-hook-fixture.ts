/**
 * A throwaway project with a real "guard" package installed under
 * `.dork/plugins` for the package-hook tests (DOR-4379). Nothing is mocked:
 * the real scan reads the package and the real consent decision runs, against
 * lists the test supplies through the runner's `_internal.decisions` seam.
 *
 * The guard keeps the Safety Hooks contract: it reads Claude Code's
 * `PreToolUse` stdin, ignores anything but `Bash`, and refuses `git stash` and
 * `pkill` with exit 2 and a reason on stderr.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { hookApprovalEntry } from '../../../../harness/hook-consent.js';
import { scanHookRequests } from '../../../../harness/project-with-consent.js';
import { _internal } from '../package-hooks.js';

/** The guard script, standing in for Safety Hooks' git and process guards. */
const GUARD = String.raw`
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const log = process.argv[2];
if (log) writeFileSync(log, input);
const payload = JSON.parse(input);
if (payload.tool_name !== 'Bash') process.exit(0);
const command = String(payload.tool_input?.command ?? '');
if (/\bgit\s+stash\b/.test(command)) {
  console.error('Blocked: git stash is shared by every worktree.');
  process.exit(2);
}
if (/\bpkill\b|\bkillall\b/.test(command)) {
  console.error('Blocked: pkill / killall stop other people\'s processes.');
  process.exit(2);
}
process.exit(0);
`;

/** The package's name in every test. */
export const PACKAGE = 'example-guards';

/** A hook as a package declares it in `hooks/hooks.json`. */
export interface FixtureHook {
  event: string;
  matcher?: string;
  command: string;
}

/** One temp project and the package a test installs into it. */
export interface GuardProject {
  /** The project folder; sessions run here. */
  dir: string;
  /** The package's guard, as its `hooks.json` names it. */
  guardCommand: string;
  /** Install the package with these hooks, allowed by a person unless told otherwise. */
  install(hooks: FixtureHook[], decision?: 'allowed' | 'refused' | 'unasked'): void;
  /** Take the package out again. */
  uninstall(): void;
  /** Read the stdin the guard last received, parsed. */
  lastPayload(): Record<string, unknown> | undefined;
  /** Remove both folders and restore the seam. */
  cleanup(): void;
}

/** Make a temp project and a temp DorkOS data directory. */
export function makeGuardProject(): GuardProject {
  const dir = mkdtempSync(join(tmpdir(), 'dorkos-package-hooks-'));
  const home = mkdtempSync(join(tmpdir(), 'dorkos-package-hooks-home-'));
  vi.stubEnv('DORK_HOME', home);
  const plugin = join(dir, '.dork', 'plugins', PACKAGE);
  const payloadLog = join(dir, 'payload.json');
  const decide = (approved: string[], refused: string[]) => {
    _internal.decisions = () => ({ approved, refused, full: false });
  };
  decide([], []);
  return {
    dir,
    guardCommand: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs" "${payloadLog}"`,
    install(hooks, decision = 'allowed') {
      mkdirSync(join(plugin, '.dork'), { recursive: true });
      mkdirSync(join(plugin, 'hooks'), { recursive: true });
      writeFileSync(
        join(plugin, '.dork', 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          name: PACKAGE,
          version: '1.0.0',
          type: 'plugin',
          description: 'Refuses risky shell commands',
          layers: ['hooks'],
        })
      );
      writeFileSync(join(plugin, 'hooks', 'guard.mjs'), GUARD);
      const groups = new Map<string, { matcher?: string; hooks: object[] }[]>();
      for (const hook of hooks) {
        const list = groups.get(hook.event) ?? [];
        list.push({
          ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
          hooks: [{ type: 'command', command: hook.command }],
        });
        groups.set(hook.event, list);
      }
      writeFileSync(
        join(plugin, 'hooks', 'hooks.json'),
        JSON.stringify(Object.fromEntries(groups))
      );
      const [request] = scanHookRequests(dir, home);
      if (!request) throw new Error('fixture: the package did not scan');
      const entry = hookApprovalEntry(request);
      if (decision === 'allowed') decide([entry], []);
      else if (decision === 'refused') decide([], [entry]);
      else decide([], []);
    },
    uninstall() {
      rmSync(plugin, { recursive: true, force: true });
    },
    lastPayload: () =>
      existsSync(payloadLog)
        ? (JSON.parse(readFileSync(payloadLog, 'utf8')) as Record<string, unknown>)
        : undefined,
    cleanup() {
      _internal.decisions = () => undefined;
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}
