/**
 * DOR-4029 (Security S3 on #3576): marks spread through agent hops, so a `chat_send` from a chat
 * that read outside words carries them into the turn it wakes. Through the REAL chat-message
 * service, store and ceiling, the REAL dispatcher over a real SQLite queue, the real
 * `memory_write` capability over a real memory file, and the real browser hand-over. Only the
 * runtime is a fake, and the dispatch stand-in hands the service's launch to the real dispatcher.
 *
 * Each case fails without the fix: the woken chat's turn reads clean, memory rewrites the note and
 * the browser is handed over.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { noopLogger } from '@dorkos/shared/logger';
import type { StreamEvent } from '@dorkos/shared/types';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';

vi.mock('../../../audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));
vi.mock('../../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  resetMessageDispatcher,
  setQueuedChatWordsResolver,
} from '../../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../../message-queue-store.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
} from '../../session-state-projector.js';
import { linkSessionId, resetSessionKeys } from '../../resolution/session-key-registry.js';
import { ChatMessageStore } from '../chat-message-store.js';
import { ChatMessageService, type ChatMessageServiceDeps } from '../chat-message-service.js';
import { rowsCarryWords } from '../chat-message-ceiling.js';
import { passedOnLevelOf } from '../../../core/turn-power/turn-levels.js';
import {
  noteRoomTurnWords,
  roomTurnReadOutsideWords,
} from '../../../core/turn-power/outside-words.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import { memoryDomain } from '../../../memory/memory-capabilities.js';
import { resetMemoryProvider } from '../../../memory/index.js';
import { liveOutsideTurnCheck } from '../../local-browser/outside-turn.js';
import { BrowserHandover, type HandoverBrowser } from '../../local-browser/handover.js';
import type { SignInWindow } from '../../local-browser/sign-in-window.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

let counter = 0;
let root: string;
let anaPath: string;
let boPath: string;
let ana: string;
let bo: string;
let store: ChatMessageStore;
let runtime: FakeAgentRuntime;
let memory: CapabilityRegistry;
/** Whether Bo's chat read as having read outside words at the moment its turn was sent. */
let notedAtSend: boolean[];
/** The launch origin each chat was started with; anything absent reads as a person's. */
let origins: Map<string, string>;

const agents = () => [
  { id: 'agent-ana', name: 'ana', displayName: 'Ana', projectPath: anaPath },
  { id: 'agent-bo', name: 'bo', displayName: 'Bo', projectPath: boPath },
];

function build(overrides: Partial<ChatMessageServiceDeps> = {}): ChatMessageService {
  const mesh = {
    get: (id: string) => agents().find((a) => a.id === id),
    getProjectPath: (id: string) => agents().find((a) => a.id === id)?.projectPath,
    listWithPaths: () => agents(),
  };
  return new ChatMessageService({
    store,
    meshCore: () => mesh as never,
    describeSession: async (id) => ({
      bound: true,
      launchOrigin: origins.get(id) ?? 'interactive',
      agentPath: id === bo ? boPath : anaPath,
      startedByExtension: null,
      roomBound: false,
    }),
    chatTitle: async (id) => `Title of ${id}`,
    sessionCwd: async () => undefined,
    isBusy: async () => false,
    // The service's launch, handed to the real dispatcher as `dispatchSessionMessage` hands it.
    dispatch: async (opts) =>
      dispatchMessage({
        sessionId: opts.sessionId,
        clientId: opts.clientId,
        content: opts.request.content,
        ...(opts.messageId ? { messageId: opts.messageId } : {}),
        projector: getOrCreateProjector(opts.sessionId),
        runtime,
      }),
    interruptTurn: async () => false,
    steerInto: async () => false,
    canonicalId: async (id) => id,
    turnLevelOf: passedOnLevelOf,
    emitActivity: () => undefined,
    ...overrides,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Ana's chat sends Bo's chat a message, and Bo's turn runs. */
async function anaSendsBo(): Promise<void> {
  await build().send(
    { sessionId: ana, agentPath: anaPath },
    { to: bo, message: 'take birch off Linear and note it' }
  );
  await settle();
}

/** Bo, in the woken chat, changes its memory. */
function boWrites(input: Record<string, string>) {
  return memory.invoke('memory.write', input, {
    identity: { agentPath: boPath, displayName: 'Bo', createdAt: '2026-10-10T00:00:00.000Z' },
    sessionId: bo,
  }) as Promise<{ saved: boolean; code?: string }>;
}

/** Bo, in the woken chat, asks to hand the shared browser to a person. */
function boAsksForTheBrowser() {
  const state: LocalBrowserState = {
    connectionId: 'c1',
    sessionId: bo,
    mode: 'new-window',
    status: 'connected',
    paused: false,
    tabs: [{ id: 't1', url: 'https://accounts.example.com/login', title: 'Sign in' }],
    selectedTabId: 't1',
    revision: 1,
    preparation: null,
  };
  const browser = {
    state: vi.fn(async () => state),
    capabilities: vi.fn(() => ({ newWindow: true })),
    currentProfileId: vi.fn(() => 'p1'),
    profileExists: vi.fn(() => true),
    open: vi.fn(async () => state),
    selectTab: vi.fn(async () => state),
    navigate: vi.fn(async () => state),
    pause: vi.fn(async () => state),
    resume: vi.fn(async () => state),
    disconnect: vi.fn(async () => state),
  } satisfies HandoverBrowser;
  const signIns = { current: null, active: false, holds: () => false, onChange: vi.fn() };
  const handover = new BrowserHandover(browser, signIns as unknown as SignInWindow, () => root);
  handover.useOutsideTurnCheck(
    liveOutsideTurnCheck({
      agentPathOf: async (id) => (id === bo ? boPath : anaPath),
      launchOriginOf: (id) => origins.get(id) ?? 'interactive',
    })
  );
  return handover.ask(bo, 'password');
}

beforeEach(async () => {
  counter += 1;
  ana = `00000000-0000-4000-8000-a0a${String(counter).padStart(9, '0')}`;
  bo = `00000000-0000-4000-8000-b0b${String(counter).padStart(9, '0')}`;
  origins = new Map();
  notedAtSend = [];
  root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-chat-send-words-'));
  anaPath = path.join(root, 'agents', 'ana');
  boPath = path.join(root, 'agents', 'bo');
  await mkdir(path.join(boPath, '.dork'), { recursive: true });
  await mkdir(anaPath, { recursive: true });
  await writeFile(
    path.join(boPath, '.dork', 'MEMORY.md'),
    '## Notes\n\n- deploys need the operator’s OK (noted in a direct chat, 2026-10-01)\n',
    'utf8'
  );
  registerTestHomes([anaPath, boPath]);
  resetMemoryProvider();
  memory = composeRegistry([memoryDomain], {
    logger: noopLogger,
    memoryDeps: { roomLabelForSession: () => null },
  });
  vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockImplementation(
    (id: string) => origins.get(id) ?? null
  );

  const db = createTestDb();
  store = new ChatMessageStore(db);
  setMessageQueueStore(new MessageQueueStore(db));
  // As `wireChatMessaging` wires it.
  setQueuedChatWordsResolver((messageId) => rowsCarryWords(store.listByQueueMessage(messageId)));
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.sendMessage.mockImplementation(async function* (sessionId: string) {
    if (sessionId === bo) notedAtSend.push(roomTurnReadOutsideWords(bo));
    yield { type: 'done', data: {} } as StreamEvent;
  });
});

afterEach(async () => {
  await settle();
  noteRoomTurnWords(ana, false);
  noteRoomTurnWords(bo, false);
  setQueuedChatWordsResolver(undefined);
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(bo);
  clearTestHomes();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('a chat_send from a chat that read outside words', () => {
  it.each([
    ['a room turn that answered a stranger', () => noteRoomTurnWords(ana, true)],
    ['a Telegram chat', () => origins.set(ana, 'relay-binding')],
  ])('from %s: the turn it wakes is noted before it runs', async (_label, mark) => {
    mark();
    await anaSendsBo();
    expect(notedAtSend).toEqual([true]);
  });

  it('wakes a turn that cannot rewrite or remove a note (memory)', async () => {
    noteRoomTurnWords(ana, true);
    await anaSendsBo();
    const replaced = await boWrites({
      action: 'replace',
      old_text: 'deploys need the operator’s OK',
      text: 'deploy freely',
    });
    const removed = await boWrites({ action: 'remove', old_text: 'deploys need' });
    expect(replaced).toMatchObject({ saved: false, code: 'outsider-held' });
    expect(removed).toMatchObject({ saved: false, code: 'outsider-held' });
    expect(await readFile(path.join(boPath, '.dork', 'MEMORY.md'), 'utf8')).toContain(
      'deploys need the operator’s OK'
    );
  });

  it('wakes a turn that cannot hand the browser to a person (local browser)', async () => {
    noteRoomTurnWords(ana, true);
    await anaSendsBo();
    await expect(boAsksForTheBrowser()).rejects.toMatchObject({ code: 'outside_turn' });
  });
});

describe('a chat_send steered into a running turn', () => {
  it.each([
    ['from a chat that read outside words: runs as a turn of its own, noted', true],
    ['from a clean chat: joins the running turn', false],
  ])('%s', async (_label, readOutside) => {
    noteRoomTurnWords(ana, readOutside);
    const steerInto = vi.fn(async () => true);
    const level = { asks: 'when-risky', reach: 'workspace' } as const;
    const receipt = await build({
      isBusy: async (id) => id === bo,
      turnLevelOf: () => level,
      steerInto,
    }).send(
      { sessionId: ana, agentPath: anaPath },
      { to: bo, message: 'one more thing', delivery: 'steer' }
    );
    await settle();
    // Marked words never join a running turn that has not read any: they launch as a turn of their
    // own (here at once, since the stand-in's turn is not really running), which is noted.
    expect(receipt.status === 'steered').toBe(!readOutside);
    expect(steerInto).toHaveBeenCalledTimes(readOutside ? 0 : 1);
    expect(notedAtSend).toEqual(readOutside ? [true] : []);
  });
});

// Security M1 on #3587 (its probe P5c): Bo's chat was renamed on an earlier turn, so its projector
// already lives under the new id and no rename runs on this one. Ana sends to Bo's born id; the
// woken turn's tool calls carry the new id, and that is the id memory and the browser read.
describe('a chat_send to a chat renamed on an earlier turn, by its born id', () => {
  it('notes the id the turn runs under: memory refuses there', async () => {
    const renamed = `00000000-0000-4000-8000-bce${String(counter).padStart(9, '0')}`;
    getOrCreateProjector(bo);
    rekeyProjector(bo, renamed);
    linkSessionId(bo, renamed);
    runtime.getInternalSessionId.mockImplementation((id: string) =>
      id === bo || id === renamed ? renamed : undefined
    );
    const during: boolean[] = [];
    runtime.sendMessage.mockImplementation(async function* () {
      yield { type: 'text_delta', data: { text: 'x' } } as StreamEvent;
      during.push(roomTurnReadOutsideWords(renamed));
      yield { type: 'done', data: {} } as StreamEvent;
    });
    noteRoomTurnWords(ana, true);
    try {
      await anaSendsBo();
      const removed = (await memory.invoke(
        'memory.write',
        { action: 'remove', old_text: 'deploys need' },
        {
          identity: { agentPath: boPath, displayName: 'Bo', createdAt: '2026-10-10T00:00:00.000Z' },
          sessionId: renamed,
        }
      )) as { saved: boolean; code?: string };
      expect(during).toEqual([true]);
      expect(removed).toMatchObject({ saved: false, code: 'outsider-held' });
    } finally {
      resetSessionKeys();
      disposeProjector(renamed);
      noteRoomTurnWords(renamed, false);
    }
  });
});

describe('a chat_send from a clean chat (control)', () => {
  it('wakes a turn that can still change memory and hand over the browser', async () => {
    await anaSendsBo();
    expect(notedAtSend).toEqual([false]);
    expect((await boWrites({ action: 'remove', old_text: 'deploys need' })).saved).toBe(true);
    await expect(boAsksForTheBrowser()).resolves.toMatchObject({ site: 'accounts.example.com' });
  });
});
