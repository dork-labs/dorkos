/**
 * `POST /api/workspaces` names the chat a worktree is made for only from the
 * caller's own agent token (DOR-5265): an agent whose token a running chat
 * holds leaves that chat `opened` the worktree and its branch; a person, who
 * has no chat here, leaves nothing; and a chat named in the body is not read.
 *
 * Real git repositories, the real workspace service, real agent identity and
 * the real edge store behind the real `/api` chain.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { workLinks, type Db } from '@dorkos/db';
import workspaceRoutes from '../workspaces.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createWorkspaceSubsystem, setWorkspaceManager } from '../../services/workspace/index.js';
import {
  holdTokenChat,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { installWorkLinkStore, uninstallWorkLinkStore } from '../../services/work-graph/index.js';
import { wireWorktreeLinks } from '../../startup/steps/work-graph.js';

const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const OTHER_CHAT = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

const testServer = swappableServer();
let db: Db;
let base = '';
let source = '';
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

beforeEach(async () => {
  db = createTestDb();
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-route-link-')));
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
  initConfigManager(path.join(base, 'dork'));
  const sub = createWorkspaceSubsystem({
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
  testServer.mount(honoGroupListener({ path: '/api/workspaces', routes: workspaceRoutes }));
});

afterEach(async () => {
  stopWiring();
  uninstallWorkLinkStore();
  resetAgentIdentityService();
  await rm(base, { recursive: true, force: true });
});

const ensure = (body: Record<string, unknown> = {}) =>
  request(testServer.server)
    .post('/api/workspaces')
    .send({ projectKey: 'core', key: 'DOR-1', source, ...body });

describe('POST /api/workspaces and the chat a worktree is made for', () => {
  it('an agent whose token a running chat holds records that chat opened both', async () => {
    const token = await initAgentIdentityService(db).mint({
      agentPath: '/agents/ana',
      displayName: 'Ana',
    });
    holdTokenChat(token, CHAT);

    const res = await ensure().set('X-DorkOS-Agent', token);

    expect(res.status).toBe(201);
    expect(links()).toEqual([
      `dork:chat:${CHAT} opened branch:dork/DOR-1`,
      `dork:chat:${CHAT} opened worktree:DOR-1`,
    ]);
  });

  it('a person records nothing, and a chat named in the body is not read', async () => {
    const res = await ensure({ chatId: OTHER_CHAT });

    expect(res.status).toBe(201);
    expect(links()).toEqual([]);
  });
});
