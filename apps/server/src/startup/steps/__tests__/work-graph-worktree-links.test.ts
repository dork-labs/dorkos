/**
 * A worktree DorkOS makes for a chat is recorded in the work graph (DOR-5265):
 * the chat `opened` the worktree and `opened` its branch. Driven through the
 * real workspace service over a real git repository in a temp folder, the
 * real edge store, and the composition root's own wiring.
 *
 * Nothing else is recorded: a create with no chat, a failed create, a clone,
 * a reused workspace, and an agent's own managed checkout (its home, reused by every
 * chat it runs). A listener that throws never fails the create.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { workLinks, type Db } from '@dorkos/db';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import {
  createWorkspaceSubsystem,
  onWorkspaceWorktreeCreated,
  setWorkspaceManager,
  workspaceGateFor,
  WorkspaceNeedsReviewError,
  type WorkspaceSubsystem,
} from '../../../services/workspace/index.js';
import { personWorkspaceGate } from '../../../services/workspace/workspace-gate.js';
import {
  resolveSessionCwd,
  sessionCwdDeps,
} from '../../../services/workspace/resolve-session-cwd.js';
import {
  installWorkLinkStore,
  recordChatRekey,
  recordChatWorktree,
  uninstallWorkLinkStore,
} from '../../../services/work-graph/index.js';
import { wireWorktreeLinks } from '../work-graph.js';

const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const NEW_CHAT_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const OTHER_CHAT = '7c6b5a49-3e2d-4c1b-9a08-f7e6d5c4b3a2';

let db: Db;
let base: string;
let source: string;
let sub: WorkspaceSubsystem;
let stopWiring: () => void;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Every recorded edge, as `<from> <relation> <to>`. */
function links(): string[] {
  return db
    .select()
    .from(workLinks)
    .all()
    .map((row) => `${row.fromRef} ${row.relation} ${row.toRef}`)
    .sort();
}

/** A person's gate, for `chatId` when given. */
const gate = (chatId?: string) =>
  workspaceGateFor({ trusted: true, name: 'core/w', carriesToken: false, chatId });

beforeEach(async () => {
  db = createTestDb();
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-links-')));
  source = path.join(base, 'source');
  const origin = path.join(base, 'origin.git');
  git(['init', '--bare', '-b', 'main', origin], base);
  git(['clone', origin, source], base);
  git(['config', 'user.email', 't@example.com'], source);
  git(['config', 'user.name', 'Test'], source);
  await writeFile(path.join(source, 'README.md'), '# source\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'init'], source);
  git(['push', '-u', 'origin', 'main'], source);
  sub = createWorkspaceSubsystem({
    db,
    dorkHome: base,
    config: {
      enabled: true,
      rootPath: path.join(base, 'workspaces'),
      portBase: 4250,
      portBlockSize: 10,
      defaultProvider: 'worktree',
      retentionCap: null,
    },
  });
  setWorkspaceManager(sub.service);
  installWorkLinkStore(db);
  stopWiring = wireWorktreeLinks();
});

afterEach(async () => {
  stopWiring();
  uninstallWorkLinkStore();
  await rm(base, { recursive: true, force: true });
});

describe('a worktree made for a chat', () => {
  it('records the chat opened the worktree, by folder name, and its branch, as given', async () => {
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source }, gate(CHAT));

    expect(ws.status).toBe('ready');
    expect(links()).toEqual([
      `dork:chat:${CHAT} opened branch:dork/DOR-1`,
      `dork:chat:${CHAT} opened worktree:DOR-1`,
    ]);
  });

  it('adds nothing on an exact repeat: a second record matches the first', async () => {
    await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source }, gate(CHAT));
    recordChatWorktree({ chatId: CHAT, worktree: 'DOR-1', branch: 'dork/DOR-1' });

    expect(db.select().from(workLinks).all()).toHaveLength(2);
  });

  it('is not announced when reused, even by another chat: only the chat it was made for opened it', async () => {
    await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source }, gate(CHAT));
    const again = await sub.service.ensure(
      { projectKey: 'core', key: 'DOR-1', source },
      gate(OTHER_CHAT)
    );

    expect(again.status).toBe('ready');
    expect(links()).toEqual([
      `dork:chat:${CHAT} opened branch:dork/DOR-1`,
      `dork:chat:${CHAT} opened worktree:DOR-1`,
    ]);
  });

  it('lands on the chat’s current id when the chat was re-keyed', async () => {
    recordChatRekey(CHAT, NEW_CHAT_ID);

    await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source }, gate(CHAT));

    expect(links()).toContain(`dork:chat:${NEW_CHAT_ID} opened worktree:DOR-1`);
    expect(links()).not.toContain(`dork:chat:${CHAT} opened worktree:DOR-1`);
  });

  it('is still made when a listener throws, and the work graph still records it', async () => {
    // Heard before the work graph, so the work graph is proved to hear it after a throw.
    stopWiring();
    const stop = onWorkspaceWorktreeCreated(() => {
      throw new Error('a listener that breaks');
    });
    stopWiring = wireWorktreeLinks();
    try {
      const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source }, gate(CHAT));

      expect(ws.status).toBe('ready');
      expect(sub.store.getByKey('core', 'DOR-1')?.status).toBe('ready');
      expect(links()).toHaveLength(2);
    } finally {
      stop();
    }
  });
});

describe('what records nothing', () => {
  it('a worktree made with no chat (a person in the app with no chat open)', async () => {
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source }, gate());

    expect(ws.status).toBe('ready');
    expect(links()).toEqual([]);
  });

  it('a create whose after_create hook fails, even for a chat', async () => {
    // The worktree is made, then its setup command fails, so the create fails.
    await mkdir(path.join(source, '.dork'), { recursive: true });
    await writeFile(
      path.join(source, '.dork', 'workspace.json'),
      JSON.stringify({ hooks: { after_create: ['exit 1'] } })
    );
    const req = { projectKey: 'core', key: 'DOR-1', source };
    // A person is shown the hook first, then says yes to exactly what was shown.
    // Their gate is built bare, so no decision is remembered anywhere.
    const shown = await sub.service
      .ensure(req, Object.assign(personWorkspaceGate(), { chatId: CHAT }))
      .catch((err: unknown) => err);
    expect(shown).toBeInstanceOf(WorkspaceNeedsReviewError);
    const { reviewHash } = (shown as WorkspaceNeedsReviewError).inspection;
    const approved = Object.assign(personWorkspaceGate(reviewHash), { chatId: CHAT });

    await expect(sub.service.ensure(req, approved)).rejects.toThrow(/after_create/);

    expect(sub.store.getByKey('core', 'DOR-1')?.status).toBe('failed');
    expect(links()).toEqual([]);
  });

  it('a clone, even for a chat: it is not a worktree', async () => {
    const ws = await sub.service.ensure(
      { projectKey: 'core', key: 'DOR-1', source, provider: 'clone' },
      gate(CHAT)
    );

    expect(ws.status).toBe('ready');
    expect(links()).toEqual([]);
  });

  it('an agent’s own managed checkout, made during a chat’s turn: it is the agent’s home', async () => {
    const agentPath = path.join(base, 'agents', 'api-bot');
    await mkdir(agentPath, { recursive: true });
    const manifest: AgentManifest = {
      id: '01HV7KJZZZ0000000000000000',
      name: 'api-bot',
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-08-27T00:00:00.000Z',
      registeredBy: 'test',
      personaEnabled: true,
      isSystem: false,
      mcpServers: [],
      workspace: { mode: 'managed', source },
    };

    const resolved = await resolveSessionCwd(
      { agentPath, sessionId: CHAT },
      sessionCwdDeps({
        readManifest: async () => manifest,
        sessionAgentPath: async () => null,
        sessionCwd: async () => undefined,
        validateAgentHome: async (p) => p,
        validateManagedCheckout: async (p) => p,
      }),
      { log: false }
    );

    expect(resolved.rung).toBe('agent-managed');
    expect(sub.store.list()).toHaveLength(1);
    expect(links()).toEqual([]);
  });
});
