/**
 * The real core-stores startup step wires the work graph's write sites: after
 * `wireCoreStores` runs, with no wiring call of the test's own, a to-do an
 * agent makes through its tool from a chat's turn records the chat `produced`
 * it (DOR-5266). A boot that forgot `wireTodoLinks()` would lose every link
 * while the write-site tests, which wire it themselves, stayed green.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, workLinks, type Db } from '@dorkos/db';
import type { CapabilityDeps } from '../../../services/core/capabilities/index.js';
import type { AgentIdentity } from '../../../services/core/agent-identity/agent-identity-service.js';
import { initConfigManager } from '../../../services/core/config-manager.js';
import { TodoPromiseService } from '../../../services/todos/todo-promise-service.js';
import { TodoPromiseStore } from '../../../services/todos/todo-promise-store.js';
import { TodoService } from '../../../services/todos/todo-service.js';
import { TodoStore } from '../../../services/todos/todo-store.js';
import { todosDomain } from '../../../services/todos/todo-capabilities.js';
import type { ServerRefs } from '../../server-refs.js';
import { wireCoreStores } from '../core-stores.js';

const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

let root: string;
let db: Db;
let promises: TodoPromiseService;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'core-stores-graph-')));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('DORK_HOME', path.join(root, 'dork'));
  initConfigManager(path.join(root, 'dork'));
  db = createTestDb();
  await wireCoreStores({} as ServerRefs, {
    dorkHome: path.join(root, 'dork'),
    db,
    firstBoot: true,
    backupsDir: path.join(root, 'backups'),
  });
});

afterAll(async () => {
  promises?.stop();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('records the chat produced a to-do its agent made, with no wiring but the boot’s', async () => {
  promises = new TodoPromiseService({ store: new TodoPromiseStore(db) });
  const todos = new TodoService({
    store: new TodoStore(db),
    agentExists: (id) => id === 'agent-bo',
    mayAssign: () => true,
    rearm: (id) => promises.track(id),
  });
  const deps = {
    logger: noopLogger,
    todoDeps: {
      todos,
      agentIdForPath: (agentPath: string) =>
        agentPath === '/agents/ana' ? 'agent-ana' : undefined,
      parentOf: () => undefined,
      readSource: () => undefined,
      agentInRoom: () => false,
    },
  } as unknown as CapabilityDeps;
  const add = todosDomain.capabilities.find((c) => c.id === 'todos.add')!;

  const made = (await add.invoke(
    deps,
    add.input.parse({ what: 'Review it', assignee: 'agent-bo' }),
    {
      identity: { agentPath: '/agents/ana', displayName: 'Ana', createdAt: '' } as AgentIdentity,
      sessionId: CHAT,
    }
  )) as { ok: boolean; todo: { id: string } };

  expect(made.ok).toBe(true);
  expect(
    db
      .select()
      .from(workLinks)
      .where(eq(workLinks.relation, 'produced'))
      .all()
      .map((row) => `${row.fromRef} ${row.toRef}`)
  ).toEqual([`dork:chat:${CHAT} dork:todo:${made.todo.id}`]);
});
