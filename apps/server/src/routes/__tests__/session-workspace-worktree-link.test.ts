/**
 * A chat's first message with a `workspaceKey` makes a worktree for that chat,
 * and the work graph records the chat `opened` the worktree and its branch
 * (DOR-5265). Through the person front door, the real launch, the real
 * workspace service over a real git repository in a temp folder, and the real
 * edge store wired as the composition root wires it.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
// A launch reads the rooms folder through the agent facts port, wired as boot does.
import '../../services/core/agent-identity/__tests__/wire-test-facts.js';
import { workLinks } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { initBoundary } from '../../lib/boundary.js';
import { configManager } from '../../services/core/config-manager.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  createChatRiseFacts,
  setChatRiseFacts,
} from '../../services/core/turn-power/chat-rise-facts.js';
import {
  onDispatchLifecycle,
  resetMessageDispatcher,
} from '../../services/session/message-dispatcher.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import { createWorkspaceSubsystem, setWorkspaceManager } from '../../services/workspace/index.js';
import { installWorkLinkStore, uninstallWorkLinkStore } from '../../services/work-graph/index.js';
import { wireWorktreeLinks } from '../../startup/steps/work-graph.js';
import { createSessionRoutes } from '../sessions.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

let root: string;
let project: string;
let source: string;
let stopWiring: (() => void) | undefined;
const scripted = new FakeAgentRuntime('test-mode');
const chats: string[] = [];

async function* reply(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'Worktree link fixture reply' } };
  yield { type: 'done', data: {} };
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'session-worktree-link-')));
  project = join(root, 'project');
  source = join(project, 'source');
  const home = join(root, 'home');
  await Promise.all([source, home].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('DORK_HOME', join(root, 'dork-home'));
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  git(['init', '-b', 'main'], source);
  git(['config', 'user.email', 't@example.com'], source);
  git(['config', 'user.name', 'Test'], source);
  await writeFile(join(source, 'README.md'), '# source\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'init'], source);
  await initBoundary(project);
});

const harness = frontDoorStepUpHarness(() => {
  const db = harness.db();
  const workspaces = createWorkspaceSubsystem({
    db,
    dorkHome: join(root, 'dork-home'),
    // The launch checks the checkout against the project boundary.
    config: { ...configManager.get('workspace'), rootPath: join(project, 'workspaces') },
  });
  setWorkspaceManager(workspaces.service);
  installWorkLinkStore(db);
  stopWiring = wireWorktreeLinks();
  runtimeRegistry.setDb(db);
  scripted.getInternalSessionId.mockReturnValue(undefined);
  scripted.withScenarios([reply, reply]);
  runtimeRegistry.register(scripted);
  runtimeRegistry.setDefault('test-mode');
  setChatRiseFacts(createChatRiseFacts(db));
  setMessageQueueStore(new MessageQueueStore(db));
  return [{ path: '/api/sessions', routes: createSessionRoutes({ personBirthDb: db }) }];
});

afterAll(async () => {
  stopWiring?.();
  uninstallWorkLinkStore();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  setChatRiseFacts(null);
  for (const id of chats) disposeProjector(id);
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

/** Post a chat's first message and wait for its turn to settle. */
async function startChat(body: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  chats.push(id);
  const settled = vi.fn();
  const stop = onDispatchLifecycle((event) => {
    if (event.phase === 'settled' && event.sessionId === id) settled();
  });
  try {
    const response = await harness.call('post', `/api/sessions/${id}/messages`).send({
      create: true,
      content: 'Worktree link fixture turn',
      runtime: 'test-mode',
      cwd: source,
      ...body,
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  } finally {
    stop();
  }
  return id;
}

/** The edges recorded from one chat, as `<relation> <to>`. */
function linksFrom(chatId: string): string[] {
  return harness
    .db()
    .select()
    .from(workLinks)
    .all()
    .filter((row) => row.fromRef === `dork:chat:${chatId}`)
    .map((row) => `${row.relation} ${row.toRef}`)
    .sort();
}

it('a chat whose first message names a workspaceKey opened the worktree and its branch', async () => {
  const id = await startChat({ workspaceKey: 'DOR-1' });

  expect(scripted.sendMessage).toHaveBeenLastCalledWith(
    id,
    'Worktree link fixture turn',
    expect.objectContaining({ cwd: join(project, 'workspaces', 'source', 'DOR-1') })
  );
  expect(linksFrom(id)).toEqual(['opened branch:dork/DOR-1', 'opened worktree:DOR-1']);
});

it('a chat with no workspaceKey makes no worktree and records none', async () => {
  const id = await startChat({});

  expect(linksFrom(id)).toEqual([]);
});
