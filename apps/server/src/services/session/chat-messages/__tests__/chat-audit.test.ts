/**
 * What `chat_send` and `chat_stop` leave in the audit log when an agent calls
 * them (spec `audit-trail` PR4 check, spec `spin-off-chats`): the real service
 * behind the real registry, with the real attribution observer and a real
 * audit trail, so the count is what a running server writes.
 *
 * Pinned as found: `chat_send` leaves ONE row, the registry's generic
 * `capability.invoked` (its target is the capability, not the chat it wrote
 * to; the message itself is in the chat-message store). `chat_stop` leaves
 * TWO: its own `chat.stopped` (the chat, the reason) and the same generic row,
 * the two-level layering `contributing/audit-trail.md` describes. A change to
 * either count is a decision, so it has to edit this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { ActivityService } from '../../../activity/activity-service.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import { createCapabilityAttributionObserver } from '../../../core/agent-identity/capability-attribution.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { wireAuditTrail } from '../../../audit/wire-audit-trail.js';
import { resetAuditTrail } from '../../../audit/audit-trail.js';
import { MessageQueueStore, setMessageQueueStore } from '../../message-queue-store.js';
import type { SessionFacts } from '../../../extensions/agent-send/agent-send-defaults.js';
import { ChatMessageStore } from '../chat-message-store.js';
import { ChatMessageService } from '../chat-message-service.js';
import { chatDomain } from '../chat-capabilities.js';
import type { ChatReadDeps } from '../chat-read.js';

const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-10-09T10:00:00.000Z',
} as AgentIdentity;

const agents = [
  { id: 'agent-ana', name: 'ana', displayName: 'Ana', projectPath: '/agents/ana' },
  { id: 'agent-bo', name: 'bo', displayName: 'Bo', projectPath: '/agents/bo' },
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

let db: Db;
let service: ChatMessageService;
let registry: CapabilityRegistry;

beforeEach(() => {
  db = createTestDb();
  const activity = new ActivityService(db);
  wireAuditTrail({ db, activity, installId: 'inst-1', readOwnerAccount: () => null });
  setMessageQueueStore(new MessageQueueStore(db));
  const facts = (id: string): SessionFacts => ({
    bound: true,
    launchOrigin: 'interactive',
    agentPath: id === 'chat-a' ? '/agents/ana' : '/agents/bo',
    startedByExtension: null,
    roomBound: false,
  });
  service = new ChatMessageService({
    store: new ChatMessageStore(db),
    meshCore: () =>
      ({
        get: (id: string) => agents.find((a) => a.id === id),
        getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
        listWithPaths: () => agents,
      }) as never,
    describeSession: async (id) => facts(id),
    chatTitle: async (id) => `Title of ${id}`,
    sessionCwd: async (id) => `/work/${id}`,
    isBusy: async () => false,
    dispatch: async (opts) =>
      ({
        accepted: true,
        queued: false,
        queuePosition: 1,
        outcome: { messageId: opts.messageId ?? 'm', requested: 'queue', applied: 'queue' },
      }) as never,
    interruptTurn: vi.fn(async () => true),
    steerInto: vi.fn(async () => true),
    canonicalId: async (id) => id,
    turnLevelOf: () => undefined,
    emitActivity: vi.fn(),
    onLifecycle: () => () => {},
    nonce: () => 'a0a0a0a0',
  });
  registry = composeRegistry(
    [chatDomain],
    {
      logger: noopLogger,
      chatMessageDeps: {
        service,
        read: {
          store: new ChatMessageStore(db),
          mayRead: async () => false,
          maySeeTitle: async () => true,
          history: async () => [],
          status: () => null,
          describe: async (id) => ({ title: `Title of ${id}`, agent: null }),
          search: async () => [],
        } satisfies ChatReadDeps,
      },
    },
    createCapabilityAttributionObserver(activity)
  );
});

afterEach(() => {
  service.stop();
  setMessageQueueStore(undefined);
  resetAuditTrail();
});

/** Every audit row so far, as `[action, actorKind]`. */
const rows = () =>
  db
    .select()
    .from(auditEvents)
    .all()
    .map((row) => [row.action, row.actorKind]);

const inChat = { identity: ANA, mcpServer: 'in-session' as const, sessionId: 'chat-a' };

describe('chat tools in the audit log', () => {
  it('chat_send leaves exactly one row, the generic one, naming the agent', async () => {
    await expect(
      registry.invoke('chat.send', { to: 'chat-b', message: 'Please review PR 12.' }, inChat)
    ).resolves.toMatchObject({ ok: true });
    await flush();

    expect(rows()).toEqual([['capability.invoked', 'agent']]);
  });

  it('chat_stop leaves its own chat.stopped row and the generic one, both naming the agent', async () => {
    await expect(
      registry.invoke('chat.stop', { chat: 'chat-b', reason: 'Wrong branch' }, inChat)
    ).resolves.toMatchObject({ ok: true, stopped: true });
    await flush();

    expect(rows()).toEqual([
      ['chat.stopped', 'agent'],
      ['capability.invoked', 'agent'],
    ]);
  });
});
