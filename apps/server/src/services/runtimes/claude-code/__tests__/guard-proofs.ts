/**
 * Claude Code's proofs for the safety guards it declares (`RuntimeCapabilities.guards`,
 * DOR-3596). Each runs the code a real launch runs, against a protected path and an
 * ordinary one, so a rule that refused nothing or everything fails.
 *
 * Handed to `runtimeGuardConformance` from `conformance.test.ts`, and run under the
 * matrix rows' own ids in `safety-guards.test.ts`.
 *
 * @module services/runtimes/claude-code/__tests__/guard-proofs
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
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
import { resolveOwnFolderOpen } from '../folder-settings/own-folder-open.js';
import { applyPersonOnlyDataDeny } from '../messaging/directory-grants.js';
import { secretReadDenyRules } from '../secret-files/secret-read-deny.js';
import { commandReachesProtectedRead, type ShellGuardRoots } from '../shell-guard/shell-check.js';

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

/** Whether any rule for one of these tools names this path. */
function names(rules: readonly string[], tools: readonly string[], target: string): boolean {
  return rules.some(
    (rule) => tools.some((tool) => rule.startsWith(`${tool}(`)) && rule.includes(target)
  );
}

/** Every file tool refuses the protected list, and the shell is held off its protected reads. */
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

  // The shell: a command that reads a browser profile's sign-ins is caught; an ordinary read is
  // not. The shell check reads only paths that exist, so both files are real.
  const root = mkdtempSync(path.join(tmpdir(), 'dorkos-guard-proof-'));
  try {
    const dorkHome = path.join(root, 'dork');
    const project = path.join(root, 'project');
    const cookies = path.join(dorkHome, 'browser-profiles', 'work', 'Cookies');
    mkdirSync(path.dirname(cookies), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(cookies, '');
    writeFileSync(path.join(project, 'README.md'), '');
    const roots: ShellGuardRoots = {
      cwd: project,
      dorkHome,
      home: path.join(root, 'home'),
      accounts: [path.join(root, 'claude')],
      env: {},
      agentHomes: () => [],
    };
    expect(await commandReachesProtectedRead(`cat "${cookies}"`, roots)).toBe(true);
    expect(await commandReachesProtectedRead(`cat README.md`, roots)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Below Full the agent's own setup is closed, and its `.dork/agent.json` stays closed at Full. */
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

  // A turn below Full never opens it, whatever the agent's own file says.
  expect(
    await resolveOwnFolderOpen({
      home: AGENT_HOME,
      turnMode: 'default',
      session: {} as never,
      sessionId: 'guard-proof',
    })
  ).toBe(false);
}

/** Claude Code's proof for each guard it declares. */
export const CLAUDE_CODE_GUARD_PROOFS: RuntimeGuardProofs = { protectedPaths, ownFolder };
