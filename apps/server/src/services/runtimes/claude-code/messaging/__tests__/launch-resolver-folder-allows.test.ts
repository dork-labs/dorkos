import { isolatedRequiredLaunchOwner } from './required-launch-fixture.js';
/**
 * The launch hands an agent's own folder allow list to Claude Code only once a
 * person has approved it, and says why a Never ask chat refuses while it waits
 * (DOR-3039, DOR-3042).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAgentHomeRegistry } from '../../../../core/agent-identity/index.js';
import type { MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { resolveLaunch } from '../launch-resolver.js';
import { folderAllowsWaitingStatus } from '../../folder-settings/apply-folder-allows.js';
import {
  lastApprovedRules,
  recordFolderAllowApproval,
} from '../../folder-settings/folder-allow-consent.js';
import { FOLDER_RULE_ASK_REASON } from '../../tool-gate/held-turn-hook.js';
import {
  _internal,
  setFolderAllowApprovalGateway,
  type FolderAllowApprovalGateway,
} from '../../folder-settings/folder-allow-approval.js';
import { pinRepoBaseline } from '../../repo-settings/repo-baseline.js';
import {
  isolateGitEnv,
  makeRepo,
  writeFile,
  type RepoFixture,
} from '../../repo-settings/__tests__/git-fixture.js';

const requiredLaunches = isolatedRequiredLaunchOwner();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
const store = vi.hoisted(() => ({
  permissions: { approvedFolderAllows: [] as string[], refusedFolderAllows: [] as string[] },
  harness: {} as Record<string, unknown>,
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'permissions' ? store.permissions : key === 'harness' ? store.harness : undefined,
    set: (key: string, value: never) => {
      if (key === 'permissions') store.permissions = value;
      if (key === 'harness') store.harness = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../../core/agent-identity/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/agent-identity/index.js')>()),
  resolveAgentTokenEnv: vi.fn().mockResolvedValue({}),
}));

const RULE = 'Bash(scripts/claim-check:*)';
const AGENT = { id: '01AGENT', name: 'dorkos-marketing', displayName: 'DorkOS Marketing' };
let root: string;
let home: string;
let asked: unknown[];

function makeSession(permissionMode: AgentSession['permissionMode'] = 'dontAsk'): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode,
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

function makeOpts(cwd: string): MessageSenderOpts {
  return {
    cwd,
    requiredLaunches,
    onSdkSessionRebind: async () => {},
    meshCore: {
      getByPath: (dir: string) => (dir === home ? AGENT : undefined),
      updateLastSeen: () => {},
    } as unknown as MessageSenderOpts['meshCore'],
  };
}

const launch = (
  cwd: string,
  extra: {
    teammate?: boolean;
    mode?: AgentSession['permissionMode'];
    taskApprovedAllow?: string[];
  } = {}
) =>
  resolveLaunch({
    sessionId: 's1',
    content: 'hello',
    session: makeSession(extra.mode),
    opts: makeOpts(cwd),
    ...(extra.teammate || extra.taskApprovedAllow
      ? {
          messageOpts: {
            ...(extra.teammate ? { roomTurn: { teammate: true } } : {}),
            ...(extra.taskApprovedAllow ? { taskApprovedAllow: extra.taskApprovedAllow } : {}),
          } as never,
        }
      : {}),
    effectiveCwd: cwd,
  });

const allowOf = (settings: unknown) =>
  (settings as { permissions?: { allow?: string[] } } | undefined)?.permissions?.allow;
const denyOf = (settings: unknown) =>
  (settings as { permissions?: { deny?: string[] } } | undefined)?.permissions?.deny ?? [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'launch-folder-allows-')));
  home = path.join(root, 'agent');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: [RULE], defaultMode: 'bypassPermissions' } })
  );
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === home,
    listRegisteredHomes: () => [home],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  store.permissions = { approvedFolderAllows: [], refusedFolderAllows: [] };
  store.harness = {};
  asked = [];
  const gateway: FolderAllowApprovalGateway = {
    request: (input) => {
      asked.push(input);
      return {
        approvalId: 'a1',
        token: 't1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    consume: () => ({ outcome: 'expired' }) as never,
  };
  setFolderAllowApprovalGateway(gateway);
  _internal.forgetOpenCards();
});

afterEach(() => {
  setFolderAllowApprovalGateway(null);
  setAgentHomeRegistry(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('an agent folder allow list at launch', () => {
  it('passes nothing, raises a card, and says why in a Never ask chat, while unapproved', async () => {
    const resolved = await launch(home);
    expect(allowOf(resolved.sdkOptions.settings)).toBeUndefined();
    expect(resolved.sdkOptions.allowedTools).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(resolved.statusEvents).toContainEqual({
      type: 'system_status',
      data: { message: folderAllowsWaitingStatus('DorkOS Marketing') },
    });
  });

  it('says it once per chat, not on every turn', async () => {
    const session = makeSession();
    const again = () =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hi',
        session,
        opts: makeOpts(home),
        effectiveCwd: home,
      });
    const notice = {
      type: 'system_status',
      data: { message: folderAllowsWaitingStatus('DorkOS Marketing') },
    };
    expect((await again()).statusEvents).toContainEqual(notice);
    expect((await again()).statusEvents).not.toContainEqual(notice);
  });

  it('shows no notice in a chat that still asks', async () => {
    const resolved = await launch(home, { mode: 'default' });
    expect(resolved.statusEvents).not.toContainEqual(
      expect.objectContaining({ data: { message: folderAllowsWaitingStatus('DorkOS Marketing') } })
    );
  });

  it('passes the approved rules in settings, and nothing else from the file', async () => {
    recordFolderAllowApproval({ agentId: AGENT.id, home, rules: [RULE] });
    const resolved = await launch(home);
    expect(allowOf(resolved.sdkOptions.settings)).toEqual([RULE]);
    expect(resolved.sdkOptions.allowedTools).toBeUndefined();
    expect(resolved.sdkOptions.permissionMode).toBe('dontAsk');
    expect(asked).toHaveLength(0);
  });

  it('applies a task rule with self-grant denies to one launch without writing settings', async () => {
    const taskRule = 'Bash(/abs/path/script.sh --once)';
    const settingsDir = path.join(home, '.claude');
    rmSync(settingsDir, { recursive: true, force: true });

    const scheduled = await launch(home, { taskApprovedAllow: [taskRule] });
    const plain = await launch(home);

    expect(allowOf(scheduled.sdkOptions.settings)).toContain(taskRule);
    expect(
      denyOf(scheduled.sdkOptions.settings).some((rule) => rule.includes(`${home}/.claude`))
    ).toBe(true);
    expect(existsSync(settingsDir)).toBe(false);
    expect(allowOf(plain.sdkOptions.settings)).toBeUndefined();
    expect(scheduled.sdkOptions.allowedTools).toBeUndefined();
  });

  it('denies the self-grant files beside an applied list, and only then (M1)', async () => {
    // The home's own three are denied on every launch (DOR-3068); the rest of
    // the self-grant set rides only beside an applied list.
    const before = denyOf((await launch(home)).sdkOptions.settings);
    expect(before).toContain(`Edit(/${home}/.claude/**)`);
    // Where `.claude/skills/<x>` really points, so the skill itself.
    expect(before).toContain(`Edit(/${home}/.agents/**)`);
    // Write rules only: every launch now also carries read denies on the account files (DOR-3299).
    expect(before.some((rule) => rule.startsWith('Edit(') && rule.includes('~/.claude.json'))).toBe(
      false
    );

    recordFolderAllowApproval({ agentId: AGENT.id, home, rules: [RULE] });
    const deny = denyOf((await launch(home)).sdkOptions.settings);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(deny).toContain(`${tool}(/${home}/.claude/**)`);
      expect(deny).toContain(`${tool}(/${home}/.mcp.json)`);
      expect(deny).toContain(`${tool}(/${home}/.dork/agent.json)`);
      // Every other agent home's skills too, not only this one's.
      expect(
        deny.some((rule) => rule.startsWith(`${tool}(`) && rule.endsWith('/agents/*/.agents/**)'))
      ).toBe(true);
      expect(deny).toContain(`${tool}(~/.claude.json)`);
      expect(deny).toContain(`${tool}(~/.dork/config.json)`);
    }
  });

  it('passes an approved list on a teammate’s turn too (DOR-3440)', async () => {
    recordFolderAllowApproval({ agentId: AGENT.id, home, rules: [RULE] });
    const resolved = await launch(home, { teammate: true });
    expect(allowOf(resolved.sdkOptions.settings)).toContain(RULE);
  });

  it('passes nothing for a folder no agent is registered at', async () => {
    const plain = path.join(root, 'plain');
    mkdirSync(path.join(plain, '.claude'), { recursive: true });
    writeFileSync(
      path.join(plain, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: [RULE] } })
    );
    const resolved = await launch(plain);
    expect(allowOf(resolved.sdkOptions.settings)).toBeUndefined();
    // No folder-allow card: no agent lives here. The unreviewed allow rule is
    // the repo settings check's to ask about (DOR-3298), and only that card shows.
    const capabilities = asked.map((input) => (input as { capabilityId?: string }).capabilityId);
    expect(capabilities.filter((id) => !id?.startsWith('runtime.apply_repo_'))).toHaveLength(0);
  });
});

describe('folder settings below Full (DOR-5237)', () => {
  const PROBE = { command: 'touch probe-file' };

  /** What every PreToolUse hook the launch carries answers for one Bash call. */
  function hookAnswers(options: Awaited<ReturnType<typeof launch>>['sdkOptions']) {
    return hookAnswersFor(options, 'Bash', PROBE);
  }

  /** What every PreToolUse hook the launch carries answers for one call. */
  async function hookAnswersFor(
    options: Awaited<ReturnType<typeof launch>>['sdkOptions'],
    toolName: string,
    toolInput: Record<string, unknown>
  ) {
    const answers: unknown[] = [];
    for (const entry of options.hooks?.PreToolUse ?? []) {
      if (entry.matcher && !new RegExp(entry.matcher).test(toolName)) continue;
      for (const hook of entry.hooks) {
        answers.push(
          await hook(
            {
              hook_event_name: 'PreToolUse',
              session_id: 'sdk-1',
              transcript_path: path.join(root, 't.jsonl'),
              cwd: home,
              tool_name: toolName,
              tool_input: toolInput,
              tool_use_id: 'tool-1',
            } as never,
            'tool-1',
            { signal: new AbortController().signal }
          )
        );
      }
    }
    return answers;
  }
  const folderAsk = expect.objectContaining({
    hookSpecificOutput: expect.objectContaining({
      permissionDecision: 'ask',
      permissionDecisionReason: FOLDER_RULE_ASK_REASON,
    }),
  });

  beforeEach(() => {
    writeFileSync(
      path.join(home, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } })
    );
  });

  it('puts to a person a call only a rule nobody approved allows', async () => {
    const resolved = await launch(home, { mode: 'default' });
    expect(await hookAnswers(resolved.sdkOptions)).toContainEqual(folderAsk);
  });

  it('counts a folder this turn was granted as opened, and asks before any other', async () => {
    const shared = path.join(root, 'shared');
    mkdirSync(shared, { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    writeFileSync(
      path.join(home, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { additionalDirectories: [shared] } })
    );
    const resolved = await resolveLaunch({
      sessionId: 's1',
      content: 'hello',
      session: makeSession('default'),
      opts: makeOpts(home),
      messageOpts: { additionalDirectories: [{ path: shared, access: 'read' }] } as never,
      effectiveCwd: home,
    });
    // A write: a read inside a granted folder is let through on its own.
    const asked = (file: string) =>
      hookAnswersFor(resolved.sdkOptions, 'Write', { file_path: file, content: 'x' });
    expect(await asked(path.join(shared, 'a.md'))).not.toContainEqual(folderAsk);
    // Any folder nobody opened puts every file call to a person, wherever it points.
    writeFileSync(
      path.join(home, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { additionalDirectories: [shared, elsewhere] } })
    );
    expect(await asked(path.join(elsewhere, 'a.md'))).toContainEqual(folderAsk);
  });

  it('asks after a live drop from Full, whatever the folder’s committed settings say', async () => {
    const plain = path.join(root, 'plain');
    mkdirSync(path.join(plain, '.claude'), { recursive: true });
    writeFileSync(
      path.join(plain, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } })
    );
    const session = makeSession('bypassPermissions');
    const resolved = await resolveLaunch({
      sessionId: 's1',
      content: 'hello',
      session,
      opts: makeOpts(plain),
      effectiveCwd: plain,
    });
    expect(await hookAnswers(resolved.sdkOptions)).not.toContainEqual(folderAsk);
    // The person lowers the chat while the process keeps running.
    session.permissionMode = 'default';
    expect(await hookAnswers(resolved.sdkOptions)).toContainEqual(folderAsk);
  });

  describe('in a git worktree', () => {
    let repo: RepoFixture;
    let restoreEnv: () => void;
    let wt: string;

    beforeEach(async () => {
      restoreEnv = isolateGitEnv();
      repo = makeRepo({ '.claude/settings.json': { permissions: { allow: ['Bash'] } } });
      // As the upgrade pins a repo DorkOS already knew.
      await pinRepoBaseline(repo.main);
      wt = repo.addWorktree('wt');
    });

    afterEach(() => {
      repo.cleanup();
      restoreEnv();
    });

    const launchIn = (cwd: string, session: AgentSession) =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hello',
        session,
        opts: makeOpts(cwd),
        effectiveCwd: cwd,
      });

    it('asks for a shell call after a live drop from Full', async () => {
      const below = await launchIn(wt, makeSession('default'));
      expect(await hookAnswers(below.sdkOptions)).not.toContainEqual(folderAsk);
      const session = makeSession('bypassPermissions');
      const resolved = await launchIn(wt, session);
      expect(await hookAnswers(resolved.sdkOptions)).not.toContainEqual(folderAsk);
      session.permissionMode = 'default';
      expect(await hookAnswers(resolved.sdkOptions)).toContainEqual(folderAsk);
    });

    it('leaves out local settings nobody approved, wherever the launch reads them', async () => {
      writeFile(path.join(repo.main, '.claude/settings.local.json'), {
        hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'true' }] }] },
      });
      for (const cwd of [wt, path.join(wt, 'sub')]) {
        mkdirSync(cwd, { recursive: true });
        const resolved = await launchIn(cwd, makeSession('default'));
        expect(resolved.sdkOptions.settingSources).not.toContain('local');
      }
    });
  });

  it('asks nothing at Full', async () => {
    const resolved = await launch(home, { mode: 'bypassPermissions' });
    expect(await hookAnswers(resolved.sdkOptions)).not.toContainEqual(folderAsk);
  });

  it('keeps a person’s Always allow, so the call stops asking', async () => {
    writeFileSync(path.join(home, '.claude', 'settings.local.json'), JSON.stringify({}));
    const session = makeSession('default');
    const resolved = await resolveLaunch({
      sessionId: 's1',
      content: 'hello',
      session,
      opts: makeOpts(home),
      effectiveCwd: home,
    });
    const suggestions = [
      {
        type: 'addRules' as const,
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
        rules: [{ toolName: 'Bash', ruleContent: 'touch probe-file *' }],
      },
    ];
    const answer = resolved.sdkOptions.canUseTool!('Bash', PROBE, {
      signal: new AbortController().signal,
      suggestions,
      toolUseID: 'tool-1',
    } as never);
    await vi.waitFor(() => expect(session.pendingInteractions.has('tool-1')).toBe(true));
    const pending = session.pendingInteractions.get('tool-1') as { resolve: (r: unknown) => void };
    pending.resolve(suggestions);
    expect(await answer).toMatchObject({ behavior: 'allow', updatedPermissions: suggestions });
    expect(lastApprovedRules(AGENT.id, home)).toEqual(['Bash(touch probe-file *)']);
  });
});
