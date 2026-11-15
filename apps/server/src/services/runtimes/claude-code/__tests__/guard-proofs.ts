/**
 * Claude Code's proofs for the safety guards it declares (`RuntimeCapabilities.guards`,
 * DOR-3596). Each runs the functions a launch builds its deny rules and its shell hook from,
 * against a protected path and an ordinary one, so a rule that refused nothing or everything
 * fails. They prove the guard's pieces, not that a launch still wires them in.
 *
 * Handed to `runtimeGuardConformance` from `conformance.test.ts`, and run under the
 * matrix rows' own ids in `safety-guards.test.ts`.
 *
 * @module services/runtimes/claude-code/__tests__/guard-proofs
 */
import type { HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import type { RuntimeGuardProofs } from '@dorkos/test-utils';
import {
  DATA_FOLDER_SECRET_PATHS,
  PERSON_ONLY_DATA_PATHS,
} from '../../shared/policy/protected-paths.js';
import { homeWriteDenyRules } from '../folder-settings/launch-folder-config.js';
import { applyPersonOnlyDataDeny } from '../messaging/directory-grants.js';
import { secretReadDenyRules } from '../secret-files/secret-read-deny.js';
import type { ShellChecker } from '../shell-guard/guard-host.js';
import { checkShellCommand, type ShellGuardRoots } from '../shell-guard/shell-check.js';
import { createShellPathGuardHook } from '../shell-guard/shell-path-guard.js';

/** A data folder and account folder no test machine has, so nothing real is read. */
const DORK_HOME = '/guard-proof/dork';
const ACCOUNT = '/guard-proof/claude';
const PROJECT = '/guard-proof/project';
const AGENT_HOME = '/guard-proof/agents/atlas';

/** The deny rules a launch's settings carry. */
function denyOf(options: Options): string[] {
  const settings = options.settings as { permissions?: { deny?: string[] } } | undefined;
  return settings?.permissions?.deny ?? [];
}

/** Whether any rule for one of these tools names this path, not merely a sibling that starts like it. */
function names(rules: readonly string[], tools: readonly string[], target: string): boolean {
  return rules.some((rule) =>
    tools.some((tool) => rule.startsWith(`${tool}(`) && /^[/)*]/.test(rule.split(target)[1] ?? ''))
  );
}

/** The shell check in this process, as the guard's own process runs it. */
const check: ShellChecker = async (command, roots, reads) => ({
  outcome: 'checked',
  ...(await checkShellCommand(command, roots, reads)),
});

/** What Claude Code's shell hook answers for one command at one level: ask, deny, or nothing. */
async function shellAnswer(
  permissionMode: string,
  roots: ShellGuardRoots,
  command: string
): Promise<string | undefined> {
  const hook = createShellPathGuardHook({ permissionMode } as never, {
    check,
    roots: () => roots,
    recordRefusal: () => {},
    log: { info: () => {}, warn: () => {} },
  });
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_guard_proof',
  } as unknown as HookInput;
  const answer = await hook(input, undefined, { signal: new AbortController().signal });
  return (answer as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
}

/** Run a proof against a real data folder, project and agent home, removed afterwards. */
async function inTempFolders(
  proof: (where: { roots: ShellGuardRoots; cookies: string; agentFile: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'dorkos-guard-proof-'));
  try {
    const dorkHome = path.join(root, 'dork');
    const project = path.join(root, 'project');
    const home = path.join(dorkHome, 'agents', 'atlas');
    const cookies = path.join(dorkHome, 'browser-profiles', 'work', 'Cookies');
    const agentFile = path.join(home, '.dork', 'agent.json');
    for (const file of [cookies, agentFile, path.join(project, 'README.md')]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
    const roots: ShellGuardRoots = {
      cwd: project,
      dorkHome,
      home: path.join(root, 'home'),
      accounts: [path.join(root, 'claude')],
      env: {},
      agentHomes: () => [home],
    };
    await proof({ roots, cookies, agentFile });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * File tools refuse the protected reads at every level and the protected writes below Full, and
 * below Full a shell command that reads a protected file goes to a person first.
 */
async function protectedPaths(): Promise<void> {
  // Reads: every data-folder secret is named in a Read rule; an ordinary file is not.
  const reads = secretReadDenyRules({
    dorkHome: DORK_HOME,
    accountRoot: ACCOUNT,
    otherAccountRoots: [],
  });
  for (const entry of DATA_FOLDER_SECRET_PATHS) {
    expect({
      secret: entry.path,
      denied: names(reads, ['Read'], `${DORK_HOME}/${entry.path}`),
    }).toEqual({
      secret: entry.path,
      denied: true,
    });
  }
  // The entry named browser profiles rely on, spelled out so it can't leave the list unnoticed.
  expect(names(reads, ['Read'], `${DORK_HOME}/browser-profiles`)).toBe(true);
  expect(names(reads, ['Read'], `${DORK_HOME}/notes.md`)).toBe(false);

  // Writes: below Full, every person-only data path is denied to the write tools.
  const launch: Options = { permissionMode: 'default' };
  applyPersonOnlyDataDeny(launch, DORK_HOME);
  const writes = denyOf(launch);
  for (const entry of PERSON_ONLY_DATA_PATHS) {
    expect({
      path: entry.path,
      denied: names(writes, ['Edit', 'Write'], `${DORK_HOME}/${entry.path}`),
    }).toEqual({
      path: entry.path,
      denied: true,
    });
  }
  expect(names(writes, ['Edit', 'Write'], `${PROJECT}/README.md`)).toBe(false);

  // The shell, through the hook a launch installs: below Full a read of a profile's sign-ins asks
  // and an ordinary read runs. The check reads only paths that exist, so the files are real.
  await inTempFolders(async ({ roots, cookies }) => {
    expect(await shellAnswer('default', roots, `cat "${cookies}"`)).toBe('ask');
    expect(await shellAnswer('default', roots, 'cat README.md')).toBeUndefined();
  });
}

/**
 * Below Full the file tools can't change the agent's own setup, at any level they can't change its
 * `.dork/agent.json`, and a shell command that plainly writes it is refused even at Full.
 */
async function ownFolder(): Promise<void> {
  const closed = homeWriteDenyRules(AGENT_HOME) ?? [];
  for (const setup of ['.claude', '.agents', '.mcp.json', '.dork/agent.json']) {
    expect({ setup, denied: names(closed, ['Edit', 'Write'], `${AGENT_HOME}/${setup}`) }).toEqual({
      setup,
      denied: true,
    });
  }
  const open = homeWriteDenyRules(AGENT_HOME, true) ?? [];
  expect(names(open, ['Edit', 'Write'], `${AGENT_HOME}/.dork/agent.json`)).toBe(true);
  expect(names(open, ['Edit', 'Write'], `${AGENT_HOME}/.claude`)).toBe(false);

  await inTempFolders(async ({ roots, agentFile }) => {
    const write = `echo {} > "${agentFile}"`;
    expect(await shellAnswer('bypassPermissions', roots, write)).toBe('deny');
    expect(await shellAnswer('bypassPermissions', roots, 'echo hi > notes.txt')).toBeUndefined();
  });
}

/** Claude Code's proof for each guard it declares. */
export const CLAUDE_CODE_GUARD_PROOFS: RuntimeGuardProofs = { protectedPaths, ownFolder };
