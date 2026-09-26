/**
 * Folder grants on OpenCode, answered at the sidecar's ask (spec
 * `agent-home-desk` §4.4). The ask shapes are the ones the 1.18.31 tools send,
 * read off the binary and a live sidecar (NOTES.md "Folder grants").
 *
 * Real folders on disk, because the symlink cases are about what the
 * filesystem resolves and a mocked `realpath` would only echo the assumption.
 */
import { afterAll, beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import type { ApprovalEvent, StreamEvent } from '@dorkos/shared/types';
import { resolveGrantVerdict, validatedGrants } from '../messaging/directory-grants.js';
import {
  enforceApprovals,
  PendingApprovalStore,
  type ApprovalGateDeps,
} from '../messaging/approvals.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import type { OpenCodeSessionRegistry } from '../sessions/session-registry.js';
import { mapPermissionAsked } from '../events/session-event-mapper.js';
import { logger } from '../../../../lib/logger.js';

let base: string;
let worktree: string;
let repo: string;
let outside: string;
let grants: DirectoryGrant[];

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-oc-grants-')));
  worktree = path.join(base, 'worktrees', 'ana');
  repo = path.join(base, 'repo');
  outside = path.join(base, 'secrets');
  await mkdir(worktree, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'key'), 'x');
  // A committed symlink pointing out of the granted folder.
  await symlink(outside, path.join(worktree, 'escape'));
  grants = [
    { path: worktree, access: 'write' },
    { path: repo, access: 'read' },
  ];
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** An `external_directory` ask the way `Tool.assertExternalDirectory` sends it. */
function externalAsk(file: string): Pick<ApprovalEvent, 'toolName' | 'input'> {
  const dir = path.dirname(file);
  return {
    toolName: 'external_directory',
    input: JSON.stringify({ patterns: [path.join(dir, '*')], filepath: file, parentDir: dir }),
  };
}

/** An `edit` ask the way the edit and write tools send it (worktree-relative pattern). */
function editAsk(file: string): Pick<ApprovalEvent, 'toolName' | 'input'> {
  return {
    toolName: 'edit',
    input: JSON.stringify({ patterns: [path.relative('/', file)], filepath: file, diff: '' }),
  };
}

describe('resolveGrantVerdict', () => {
  it('allows reaching a file inside any grant, read or write', () => {
    expect(resolveGrantVerdict(externalAsk(path.join(worktree, 'a.ts')), grants)).toBe('allow');
    expect(resolveGrantVerdict(externalAsk(path.join(repo, 'README.md')), grants)).toBe('allow');
  });

  it('says nothing about a folder no grant covers, leaving it to the mode', () => {
    expect(resolveGrantVerdict(externalAsk(path.join(outside, 'key')), grants)).toBeUndefined();
    // A sibling sharing the prefix is not inside.
    expect(
      resolveGrantVerdict(externalAsk(`${repo}-backup/file`), grants),
      'string-prefix matching would hand `repo-backup` the repo’s grant'
    ).toBeUndefined();
  });

  it('does not let a symlink inside a grant stretch it to where the link points', () => {
    expect(
      resolveGrantVerdict(externalAsk(path.join(worktree, 'escape', 'key')), grants)
    ).toBeUndefined();
  });

  it('allows a shell command only when every folder it names is granted', () => {
    const bash = (directories: string[]) => ({
      toolName: 'external_directory',
      input: JSON.stringify({
        command: 'ls',
        directories,
        patterns: directories.map((dir) => path.join(dir, '*')),
      }),
    });
    expect(resolveGrantVerdict(bash([worktree, repo]), grants)).toBe('allow');
    expect(resolveGrantVerdict(bash([worktree, outside]), grants)).toBeUndefined();
  });

  it('refuses a file write inside a read grant, and says nothing about one inside a write grant', () => {
    expect(resolveGrantVerdict(editAsk(path.join(repo, 'README.md')), grants)).toBe('deny');
    expect(resolveGrantVerdict(editAsk(path.join(worktree, 'a.ts')), grants)).toBeUndefined();
  });

  it('refuses a patch that touches a read grant among other files', () => {
    const patch = {
      toolName: 'edit',
      input: JSON.stringify({
        filepath: 'worktrees/ana/a.ts, repo/README.md',
        files: [
          { filePath: path.join(worktree, 'a.ts') },
          { filePath: path.join(repo, 'README.md') },
        ],
      }),
    };
    expect(resolveGrantVerdict(patch, grants)).toBe('deny');
  });

  it('lets a read folder win over a write grant nested in it', () => {
    const nested: DirectoryGrant[] = [
      { path: repo, access: 'read' },
      { path: path.join(repo, '.git'), access: 'write' },
    ];
    expect(resolveGrantVerdict(editAsk(path.join(repo, '.git', 'HEAD')), nested)).toBe('deny');
  });

  it('refuses a write into a read grant spelled through a symlink, whichever spelling the ask uses', async () => {
    // `/tmp` for `/private/tmp` on macOS is the everyday case of this.
    const alias = path.join(base, 'alias');
    await symlink(base, alias);
    const spelledViaLink: DirectoryGrant[] = [{ path: path.join(alias, 'repo'), access: 'read' }];

    expect(resolveGrantVerdict(editAsk(path.join(repo, 'README.md')), spelledViaLink)).toBe('deny');
    expect(
      resolveGrantVerdict(editAsk(path.join(alias, 'repo', 'README.md')), [
        { path: repo, access: 'read' },
      ])
    ).toBe('deny');
    // And the adapter refuses that spelling before the turn starts.
    expect(() => validatedGrants(spelledViaLink, '/agents/ana')).toThrow(/not realpath-resolved/);
  });

  it('says nothing when the turn carries no grants, whatever the ask', () => {
    expect(resolveGrantVerdict(externalAsk(path.join(worktree, 'a.ts')), [])).toBeUndefined();
    expect(resolveGrantVerdict(editAsk(path.join(repo, 'README.md')), [])).toBeUndefined();
  });
});

describe('enforceApprovals with folder grants', () => {
  const respond = vi.fn(async () => ({ data: true }));
  const provider = {
    getClient: async () => ({ postSessionIdPermissionsPermissionId: respond }),
    peekClient: () => null,
  } as unknown as OpenCodeClientProvider;

  function deps(permissionMode: string): ApprovalGateDeps {
    return {
      provider,
      approvals: new PendingApprovalStore(),
      registry: { get: () => ({ permissionMode }) } as unknown as OpenCodeSessionRegistry,
    };
  }

  function asked(ask: Pick<ApprovalEvent, 'toolName' | 'input'>): StreamEvent {
    return {
      type: 'approval_required',
      data: { toolCallId: 'per_1', timeoutMs: 1000, startedAt: 0, ...ask },
    } as StreamEvent;
  }

  async function run(
    permissionMode: string,
    ask: Pick<ApprovalEvent, 'toolName' | 'input'>,
    turnGrants: DirectoryGrant[] | undefined
  ): Promise<StreamEvent[]> {
    const gate = deps(permissionMode);
    const out: StreamEvent[] = [];
    for await (const event of enforceApprovals(
      gate,
      {
        sessionId: 's1',
        ocSessionId: 'oc-1',
        cwd: '/agents/ana',
        permissions: { pendingPermissionSessions: new Map() } as never,
        ...(turnGrants ? { grants: turnGrants } : {}),
      },
      asked(ask)
    )) {
      out.push(event);
    }
    gate.approvals.clearSession('s1');
    return out;
  }

  afterEach(() => {
    respond.mockClear();
  });

  it('refuses a write into a read grant even under bypassPermissions', async () => {
    const out = await run('bypassPermissions', editAsk(path.join(repo, 'README.md')), grants);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'reject' } }));
    expect(out).toEqual([]);
  });

  it('answers a reach inside a grant with no card, even in default mode', async () => {
    const out = await run('default', externalAsk(path.join(worktree, 'a.ts')), grants);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'once' } }));
    expect(out).toEqual([]);
  });

  it('asks the person, as before, when the same reach comes from a turn without the grant', async () => {
    // I5: a grant an earlier turn carried is not consulted by a later one.
    const out = await run('default', externalAsk(path.join(worktree, 'a.ts')), undefined);

    expect(respond).not.toHaveBeenCalled();
    expect(out.map((event) => event.type)).toEqual(['approval_required']);
  });

  it('forwards a refusal it could not deliver to the person, never to bypass', async () => {
    respond.mockRejectedValueOnce(new Error('sidecar gone'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const out = await run('bypassPermissions', editAsk(path.join(repo, 'README.md')), grants);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(out.map((event) => event.type)).toEqual(['approval_required']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('folder-grant answer failed'),
      expect.anything()
    );
    warn.mockRestore();
  });
});

describe('the asks a live 1.18.31 sidecar sent (captured 2026-09-26)', () => {
  // Verbatim `permission.asked` properties from a real sidecar with a local
  // model: a read reaching outside the session's folder, and an edit of the
  // same file. Run through the real mapper, so a change to either the wire
  // shape or the mapper's `input` shows up here rather than as a grant that
  // silently stopped matching.
  const GATE = '/private/var/tmp/dor2408-gate';
  const liveGrants: DirectoryGrant[] = [
    { path: `${GATE}/W`, access: 'write' },
    { path: `${GATE}/R`, access: 'read' },
  ];
  const externalRead = {
    id: 'per_0df037b44001Sx3O2dH4FILnV2',
    sessionID: 'ses_f20fdedcfffe9f6Y38pjgl0ivc',
    permission: 'external_directory',
    patterns: [`${GATE}/R/*`],
    metadata: { filepath: `${GATE}/R/r.txt`, parentDir: `${GATE}/R` },
    always: [`${GATE}/R/*`],
    tool: { messageID: 'msg_0df021cfd001X6etihLctQekzw', callID: 'call_lv3nf8om' },
  };
  const edit = {
    id: 'per_0df04f609001RD5qMIZWGGO0tz',
    sessionID: 'ses_f20fc55c6ffejBby08UrDeNkfM',
    permission: 'edit',
    // Worktree-relative, which is why a `deny` rule on the absolute folder
    // never matched it (NOTES.md "Folder grants").
    patterns: ['private/var/tmp/dor2408-gate/R/r.txt'],
    metadata: { filepath: `${GATE}/R/r.txt`, diff: '-alpha\n+beta\n' },
    always: ['*'],
    tool: { messageID: 'msg_0df03ae43001MVXpX5T3dOhlIQ', callID: 'call_uv74av1v' },
  };

  function mapped(properties: unknown): ApprovalEvent {
    const [event] = mapPermissionAsked(properties, { pendingPermissionSessions: new Map() });
    return event!.data as ApprovalEvent;
  }

  it('allows the read inside the grant and refuses the edit inside the read grant', () => {
    expect(resolveGrantVerdict(mapped(externalRead), liveGrants)).toBe('allow');
    expect(resolveGrantVerdict(mapped(edit), liveGrants)).toBe('deny');
  });

  it('leaves the edit to the mode when the same folder is a write grant', () => {
    const writable: DirectoryGrant[] = [{ path: `${GATE}/R`, access: 'write' }];
    expect(resolveGrantVerdict(mapped(edit), writable)).toBeUndefined();
  });
});
