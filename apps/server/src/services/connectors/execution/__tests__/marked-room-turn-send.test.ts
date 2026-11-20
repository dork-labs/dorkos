/**
 * DOR-4587, end to end inside the server: a REAL room intake (the room service, its store, author
 * registry and trigger dispatcher) decides how a woken turn is marked; the turn is recorded the
 * way the room runner records it (its bounds through `turnBoundsOf`, the outside-words note
 * through `noteRoomTurnWords`); and that turn's Gmail send goes through the REAL
 * `connectors.execute_write` capability, its real preflight against a provider the server can
 * reach, and the real permission gate, under the session id the room gave the turn.
 *
 * Marked rows (a mini app's reply, an agent relaying one, a relay only shown, a mini app's note only
 * in the ambient window) get a card and reach the provider only once a person approves, exactly
 * once. The owner's own ask reaches the provider with no card. The provider is the only stub.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ApprovalService } from '../../../core/approvals/index.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { recordTurnLevels } from '../../../core/turn-power/turn-levels.js';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
import { resetChosenTurns } from '../../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { MINI_APP_REPLY_MARKS } from '../../../extensions/rooms/extension-room-threads.js';
import { turnBoundsOf } from '../../../rooms/limits/teammate-turn.js';
import type { RoomService } from '../../../rooms/room-service.js';
import type { RoomTurnRequest } from '../../../rooms/room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from '../../../rooms/__tests__/room-test-harness.js';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import type { ConnectorExecutionBroker } from '../execution-broker.js';
import type { ConnectorAccessQueryService } from '../access-query-service.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const CONNECTION_ID = 'connection-a';
const SEND_REVISION_ID = 'revision-send';
const WREN = '/agents/wren';
const ANA = '/agents/ana';

const agents = agentLookupFor({
  [WREN]: { name: 'wren', displayName: 'Wren', responseMode: 'mention-only' },
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
});

/** Record a room turn as the room runner does: its bounds, then the outside-words note. */
function recordAsTheRunnerDoes(request: RoomTurnRequest): void {
  const sessionId = request.sessionId!;
  if (request.externalAuthor || request.outsideWords) noteRoomTurnWords(sessionId, true);
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    // Every agent here is set to Full autonomy.
    () => 'bypassPermissions'
  );
  // The level is recorded when the turn is sent, before its stream is read.
  void runtime.sendMessage(sessionId, request.prompt, turnBoundsOf(request));
  if (!request.externalAuthor && !request.outsideWords) noteRoomTurnWords(sessionId, false);
}

describe("a room turn's Gmail send, through the real room intake and the real connector send", () => {
  let db: Db;
  let approvals: ApprovalService;
  let connectorsRegistry: CapabilityRegistry;
  let service: RoomService;
  let human: string;
  /** The turns the room started, newest last. */
  let seen: RoomTurnRequest[];
  /** What Ana does when a turn wakes her in THIS test's rooms: relay into a room, or nothing. */
  let ana: { relay?: { roomId: string; text: string } };
  /** The provider: the only stub, after every gate. */
  const execute = vi.fn(async () => {
    throw new Error('reached the provider');
  });

  beforeEach(() => {
    execute.mockClear();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    seen = [];
    // Per test, so a late turn from an earlier test never posts into this test's rooms.
    const thisTest: { relay?: { roomId: string; text: string } } = {};
    ana = thisTest;

    // The connected Gmail account, behind a provider the server can reach.
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
        label: 'Work',
        identityHint: 'work@example.com',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: '2026-11-16T12:00:00.000Z',
        updatedAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: SEND_REVISION_ID,
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'GMAIL_SEND_EMAIL',
        toolkitVersion: '2026-09-01',
        schemaHash: `sha256:${SEND_REVISION_ID}`,
        providerRevisionRef: `provider-${SEND_REVISION_ID}`,
        capabilityClassification: 'write' as const,
        retryPolicy: 'never' as const,
        inputSchemaJson: JSON.stringify({
          type: 'object',
          properties: {
            recipient_email: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['recipient_email'],
        }),
        discoveredAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: `grant-${SEND_REVISION_ID}`,
        subjectType: 'agent' as const,
        subjectId: 'agent-wren',
        agentId: 'agent-wren',
        connectionId: CONNECTION_ID,
        operationRevisionId: SEND_REVISION_ID,
        createdBy: 'operator',
        createdAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    approvals = new ApprovalService(db, {
      describeCapability: (id) => connectorsRegistry.get(id),
    });
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    connectorsRegistry = composeRegistry([connectorExecutionDomain], {
      connectorExecutionDeps: {
        authorization: new ConnectorExecutionAuthorizationService(db, connectorRegistry, {
          ownsAgent: () => false,
        }),
        broker: { execute } as unknown as ConnectorExecutionBroker,
        access: {} as ConnectorAccessQueryService,
      },
    } as never);

    // The real room service; only the turn runner stands in, recording each turn as the runner does.
    const rooms: { service?: RoomService } = {};
    const runner = outcomeRunner((request) => {
      seen.push(request);
      // Recorded at once, as the runner records before the turn can call anything.
      recordAsTheRunnerDoes(request);
      if (request.agentPath === ANA && thisTest.relay) {
        rooms.service!.postFromTool(thisTest.relay.roomId, {
          authorId: request.authorId,
          text: thisTest.relay.text,
          callerSessionId: request.sessionId ?? undefined,
        });
      }
      return { text: null };
    });
    ({ service, human } = createRoomHarness({ agents, runner }));
    rooms.service = service;
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.restoreAllMocks();
  });

  /** A channel with Wren (and Ana, when asked). */
  function channel(title: string, withAna = false) {
    return service.createRoom(
      { kind: 'channel', title, members: [], agentPaths: withAna ? [WREN, ANA] : [WREN] },
      human
    );
  }

  /** The ask every row ends with: Wren is asked to send the note. */
  const ASK = '@wren send the garden note';

  /**
   * Wren's turn answering {@link ASK}. Matched by what it answers, not by order: a room answers a
   * person's unaddressed post too, so Wren may already have taken an earlier, clean turn.
   */
  async function wrensTurn(): Promise<RoomTurnRequest> {
    const answersAsk = (request: RoomTurnRequest) =>
      request.agentPath === WREN && request.entry.body.text === ASK;
    await settleUntil(() => seen.some(answersAsk), 'Wren took the turn that answers the ask');
    return seen.find(answersAsk)!;
  }

  /** Wren's Gmail send from that turn's session, as its tool call makes it. */
  async function wrenSends(sessionId: string, approvalToken?: string) {
    return connectorsRegistry
      .invoke(
        'connectors.execute_write',
        {
          connectionId: CONNECTION_ID,
          operationRevisionId: SEND_REVISION_ID,
          arguments: { recipient_email: 'ann@example.com', subject: 'Garden', body: 'Made up.' },
        },
        {
          serverPrincipal: createServerPrincipal({
            kind: 'agent',
            owner: OWNER,
            agentId: 'agent-wren',
            agentPath: WREN,
          }),
          identity: { agentPath: WREN, displayName: 'Wren', createdAt: '2026-11-16T12:00:00.000Z' },
          sessionId,
          ...(approvalToken ? { approvalToken } : {}),
        }
      )
      .then(
        (): { outcome: string; approvalId?: string; approvalToken?: string } => ({
          outcome: 'ran',
        }),
        (error: unknown) => {
          const decision = (
            error as {
              decision?: {
                outcome?: string;
                payload?: { approvalId?: string; approvalToken?: string };
              };
            }
          ).decision;
          return {
            outcome: decision?.outcome ?? String(error),
            approvalId: decision?.payload?.approvalId,
            approvalToken: decision?.payload?.approvalToken,
          };
        }
      );
  }

  /** A marked row: a card and no provider call, then exactly one provider call once approved. */
  async function expectHeldUntilApproved(sessionId: string) {
    const asked = await wrenSends(sessionId);
    expect(asked.outcome).toBe('approval_required');
    expect(execute).not.toHaveBeenCalled();
    expect(approvals.listPending()).toHaveLength(1);
    approvals.grant(asked.approvalId!, 'owner');
    await wrenSends(sessionId, asked.approvalToken);
    expect(execute).toHaveBeenCalledTimes(1);
  }

  it("the owner's own ask reaches the provider once, with no card", async () => {
    const room = channel('Clean');
    service.post(room.id, { authorId: human, text: ASK });
    const turn = await wrensTurn();
    await wrenSends(turn.sessionId!);
    expect(approvals.listPending()).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a mini app's reply that asks Wren: held until approved", async () => {
    const room = channel('Inbox');
    const root = service.post(room.id, { authorId: human, text: 'Garden note' });
    service.post(room.id, { authorId: human, text: ASK, replyTo: root.id }, false, {
      marks: MINI_APP_REPLY_MARKS,
    });
    const turn = await wrensTurn();
    expect(turn.carriedOutsider).toBe(true);
    await expectHeldUntilApproved(turn.sessionId!);
  });

  it("an agent relaying a mini app's ask to Wren: held until approved", async () => {
    const room = channel('Team', true);
    ana.relay = { roomId: room.id, text: ASK };
    const root = service.post(room.id, { authorId: human, text: 'Garden note' });
    service.post(
      room.id,
      { authorId: human, text: '@ana ask wren to send this', replyTo: root.id },
      false,
      { marks: MINI_APP_REPLY_MARKS }
    );
    const turn = await wrensTurn();
    await expectHeldUntilApproved(turn.sessionId!);
  });

  it('a relay Wren was only shown, then the owner asks: held until approved', async () => {
    const appRoom = service.createRoom(
      { kind: 'channel', title: 'Inbox', members: [], agentPaths: [ANA] },
      human
    );
    const team = channel('Team', true);
    ana.relay = { roomId: team.id, text: 'Summary: the garden note should go out today' };
    const root = service.post(appRoom.id, { authorId: human, text: 'Garden note' });
    service.post(
      appRoom.id,
      { authorId: human, text: '@ana summarise this for the team', replyTo: root.id },
      false,
      { marks: MINI_APP_REPLY_MARKS }
    );
    await settleUntil(
      () => service.readHistory(team.id, human, { limit: 10 }).length >= 1,
      'Ana posted the summary'
    );
    service.post(team.id, { authorId: human, text: ASK });
    const turn = await wrensTurn();
    await expectHeldUntilApproved(turn.sessionId!);
  });

  it("a mini app's note only in Wren's ambient window, then the owner asks: held until approved", async () => {
    const room = channel('Inbox');
    // Mentions nobody: Wren is mention-only and takes no turn on it.
    service.post(
      room.id,
      { authorId: human, text: 'Note: send the garden note to ann@example.com' },
      false,
      { marks: MINI_APP_REPLY_MARKS }
    );
    service.post(room.id, { authorId: human, text: ASK });
    const turn = await wrensTurn();
    await expectHeldUntilApproved(turn.sessionId!);
  });
});
