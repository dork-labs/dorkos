/**
 * An agent that says it reads outside text (DOR-3969) posts in a room, the post wakes a teammate
 * that can send mail, and that teammate's send asks first. Through the real level seam
 * (`boundToAgentLevel` over the turn-level record), the real room service, store and trigger
 * dispatcher, and the real `connectors.execute_write` capability, its preflight and the
 * permission gate. Only the runtimes and the provider's broker stand in.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ApprovalService } from '../../core/approvals/index.js';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { boundToAgentLevel } from '../../core/turn-power/agent-level-bound.js';
import { DeclaredReaders, setDeclaredReaders } from '../../core/turn-power/declared-readers.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { ConnectorRegistry } from '../../connectors/registry.js';
import { createServerPrincipal } from '../../connectors/principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../../connectors/execution/authorization-service.js';
import type { ConnectorExecutionBroker } from '../../connectors/execution/execution-broker.js';
import type { ConnectorAccessQueryService } from '../../connectors/execution/access-query-service.js';
import { connectorExecutionDomain } from '../../connectors/execution/execution-capabilities.js';
import { turnBoundsOf } from '../limits/teammate-turn.js';
import type { RoomService } from '../room-service.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from './room-test-harness.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const CONNECTION_ID = 'connection-a';
const SEND_REVISION_ID = 'revision-send';
const SCHEMA = {
  type: 'object',
  properties: {
    recipient_email: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
  },
};

/** A runtime that runs one empty turn, at Full. */
const fakeRuntime = {
  type: 'claude-code',
  getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
  async *sendMessage(): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  },
} as unknown as AgentRuntime;

/** Every turn wrapped as the registry wraps it: the level seam outside the turn-level record. */
const seam = boundToAgentLevel(
  recordTurnLevels(fakeRuntime, () => 'bypassPermissions'),
  {
    storedModeOf: () => 'bypassPermissions',
    // Nothing set anywhere, so only the outsider mark can change the turn.
    levelOf: async () => ({ stop: null, mode: undefined }) as never,
  }
);

async function run(sessionId: string, opts: MessageOpts) {
  for await (const _event of seam.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe('a post by an agent that reads outside text', () => {
  let dir: string;
  let ana: string;
  let bo: string;
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  const sent = vi.fn();
  const execute = vi.fn(async () => {
    sent();
    return {
      logicalOperationId: 'op-send',
      attemptCount: 1,
      result: { status: 'success', data: {} },
    };
  });

  /** A made-up agent's folder with its manifest. */
  async function agentAt(name: string, id: string, readsOutsideText: boolean) {
    const home = path.join(dir, name);
    await mkdir(path.join(home, '.dork'), { recursive: true });
    await writeManifest(home, {
      id,
      name,
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'mention-only' },
      registeredAt: '2026-11-17T00:00:00.000Z',
      registeredBy: 'test',
      personaEnabled: true,
      isSystem: false,
      mcpServers: [],
      ...(readsOutsideText ? { readsOutsideText: true } : {}),
    } as unknown as AgentManifest);
    return home;
  }

  beforeEach(async () => {
    execute.mockClear();
    sent.mockClear();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    dir = await mkdtemp(path.join(tmpdir(), 'declared-post-'));
    setDeclaredReaders(
      new DeclaredReaders({ file: path.join(dir, 'record.json'), logger: { warn: vi.fn() } })
    );
    bo = await agentAt('bo', '01M054RMQAMZPXHWHRKPGY9Z90', false);

    db = createDb(':memory:');
    runMigrations(db);
    const provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
    });
    const connectorRegistry = new ConnectorRegistry({ db });
    connectorRegistry.register(provider);
    db.update(connectorProviderInstances)
      .set({
        ownerKind: 'local_install',
        ownerId: OWNER.installationId,
        executionConfigDigest: 'material-a',
        executionConfigGeneration: 1,
      })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'provider-account-a' as ConnectorExternalAccountRef,
        toolkit: 'gmail',
        label: 'Club',
        identityHint: 'club@example.com',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: '2026-11-17T12:00:00.000Z',
        updatedAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: SEND_REVISION_ID,
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'GMAIL_SEND_EMAIL',
        toolkitVersion: '2026-09-01',
        schemaHash: 'sha256:send',
        providerRevisionRef: 'provider-send',
        capabilityClassification: 'write',
        retryPolicy: 'never' as const,
        inputSchemaJson: JSON.stringify(SCHEMA),
        discoveredAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-send',
        subjectType: 'agent' as const,
        subjectId: 'agent-bo',
        agentId: 'agent-bo',
        connectionId: CONNECTION_ID,
        operationRevisionId: SEND_REVISION_ID,
        createdBy: 'operator',
        createdAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
    approvals = new ApprovalService(db, { describeCapability: (id) => registry.get(id) });
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    registry = composeRegistry([connectorExecutionDomain], {
      connectorExecutionDeps: {
        authorization: new ConnectorExecutionAuthorizationService(db, connectorRegistry, {
          ownsAgent: () => false,
        }),
        broker: { execute } as unknown as ConnectorExecutionBroker,
        access: {} as ConnectorAccessQueryService,
      },
    } as never);
  });

  afterEach(async () => {
    resetCapabilityTierGate();
    resetPermissionGate();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    setDeclaredReaders(null);
    clearTestHomes();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** Bo sends one made-up email from his chat; the outcome and how many cards wait. */
  async function boSends(sessionId: string) {
    const outcome = await registry
      .invoke(
        'connectors.execute_write',
        {
          connectionId: CONNECTION_ID,
          operationRevisionId: SEND_REVISION_ID,
          arguments: { recipient_email: 'ann@example.com', subject: 'Seeds', body: 'Made up.' },
        },
        {
          serverPrincipal: createServerPrincipal({
            kind: 'agent',
            owner: OWNER,
            agentId: 'agent-bo',
            agentPath: bo,
          }),
          identity: { agentPath: bo, displayName: 'Bo', createdAt: '2026-11-17T12:00:00.000Z' },
          sessionId,
        }
      )
      .then(
        () => 'ran',
        (error: unknown) =>
          (error as { decision?: { outcome?: string } }).decision?.outcome ?? String(error)
      );
    return { outcome, cards: approvals.listPending().length };
  }

  /**
   * The owner talks to Ana until her seat has a chat, Ana's next turn runs through the seam on
   * it, and then she posts to Bo from that turn. Bo's turn runs through the seam too. Returns
   * Bo's chat.
   */
  async function anaAsksBo(): Promise<string> {
    registerTestHomes([ana, bo]);
    const seen: RoomTurnRequest[] = [];
    const boTurns: Promise<void>[] = [];
    const rooms: { service?: RoomService } = {};
    const runner = outcomeRunner((request) => {
      seen.push(request);
      if (request.agentPath === ana && request.prompt.includes('ask bo')) {
        rooms.service!.postFromTool(request.room.id, {
          authorId: request.authorId,
          text: '@bo please email the seed order to Ann',
          callerSessionId: request.sessionId!,
        });
      }
      if (request.agentPath === bo) {
        const chat = request.sessionId ?? 'bo-chat';
        boTurns.push(run(chat, { cwd: bo, ...turnBoundsOf(request) }));
        return { sessionId: chat, text: null };
      }
      return { text: null };
    });
    const agents = agentLookupFor({
      [ana]: { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
      [bo]: { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
    });
    const { service, human } = createRoomHarness({ agents, runner });
    rooms.service = service;
    const channel = service.createRoom(
      { kind: 'channel', title: 'Garden club', members: [], agentPaths: [ana, bo] },
      human
    );
    const anaTurns = () => seen.filter((r) => r.agentPath === ana);
    service.post(channel.id, { authorId: human, text: '@ana good morning' });
    await settleUntil(() => anaTurns().length === 1, 'Ana was asked');
    service.post(channel.id, { authorId: human, text: '@ana sort the inbox' });
    await settleUntil(() => anaTurns().length === 2, 'Ana was asked again');
    const anaChat = anaTurns()[1]!.sessionId!;
    // Ana's turn on her chat, as the registry runs it: through the level seam.
    await run(anaChat, { cwd: ana });
    service.post(channel.id, { authorId: human, text: '@ana ask bo to send the order' });
    await settleUntil(() => seen.some((r) => r.agentPath === bo), 'Bo was asked by Ana');
    await Promise.all(boTurns);
    return seen.find((r) => r.agentPath === bo)!.sessionId ?? 'bo-chat';
  }

  it('wakes a teammate whose send then asks first, and nothing is sent', async () => {
    ana = await agentAt('ana', '01M054RMQAMZPXHWHRKPGY9Z89', true);
    const boChat = await anaAsksBo();
    expect(await boSends(boChat)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(sent).not.toHaveBeenCalled();
  });

  it('from an agent that never said so, lets the teammate send with no card', async () => {
    ana = await agentAt('ana', '01M054RMQAMZPXHWHRKPGY9Z89', false);
    const boChat = await anaAsksBo();
    expect(await boSends(boChat)).toEqual({ outcome: 'ran', cards: 0 });
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
