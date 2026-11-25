/**
 * A read through a connected app marks the turn it ran in (DOR-3969, spec §4.7): the mail, invite
 * or shared file it hands back is someone else's text. So a Gmail send later in that same turn at
 * Full gets a card, and nothing reaches the provider, through the real `connectors.execute_read`
 * and `connectors.execute_write` capabilities, their real preflight and the permission gate.
 *
 * The mark lasts until the chat's next real turn: a continuation (an approval's answer, a resume)
 * picks up the same words and keeps it. A caller that knows only the agent (external `/mcp`) sees
 * it too, until that chat's next turn starts.
 *
 * Same-source writes (DOR-4794, Security's six cases): a turn whose only outside words came from
 * one app writes back to that app with no card, when the person turned writes back on for it.
 * Anything else in the turn, another app, a deletion, or the switch off keeps the card.
 *
 * @vitest-environment node
 */
import os from 'node:os';
import path from 'node:path';
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
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
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
import {
  aliasTurnLevel,
  markRunningTurnOutsider,
  recordTurnLevels,
} from '../../../core/turn-power/turn-levels.js';
import { resetChosenTurns } from '../../../core/turn-power/full-autonomy.js';
import { noteOwnersCleanSend } from '../../../core/turn-power/held-chat-mark.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
import { carrySessionMarks } from '../../../core/turn-power/seat-marks.js';
import { resolveCallPermission } from '../../../core/capabilities/permission-enforcement.js';
import { setShouldAskActivity } from '../../../core/prompts/should-ask.js';
import { setWritesBack } from '../../access/writes-back-store.js';
import {
  linkSessionId,
  resetSessionKeys,
} from '../../../session/resolution/session-key-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import type { ConnectorExecutionBroker } from '../execution-broker.js';
import type { ConnectorAccessQueryService } from '../access-query-service.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';
import { recordToolUse } from '../../../audit/record-tool-use.js';
import { outsideTextHookMatcher } from '../../../runtimes/claude-code/tool-gate/outside-text-hook.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const CONNECTION_ID = 'connection-a';
const SEND_REVISION_ID = 'revision-send';
const READ_REVISION_ID = 'revision-read';
/** A second app, a tracker, beside the mail account (DOR-4794). */
const TRACKER_ID = 'connection-tracker';
const TRACKER_READ_ID = 'revision-tracker-read';
const TRACKER_WRITE_ID = 'revision-tracker-write';
const TRACKER_DELETE_ID = 'revision-tracker-delete';
const AGENT = {
  agentPath: '/agents/agent-a',
  displayName: 'Wren',
  createdAt: '2026-11-17T12:00:00.000Z',
};
const SCHEMA = {
  type: 'object',
  properties: {
    recipient_email: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    query: { type: 'string' },
  },
};

let counter = 0;
const fresh = () => `read-marks-${(counter += 1)}`;

/** Run one turn in a chat set to Full autonomy. */
async function ranAtFull(sessionId: string, opts?: MessageOpts) {
  await ranAt('bypassPermissions', sessionId, opts);
}

/** Run one turn in a chat set to `mode`: below Full for anything but `bypassPermissions`. */
async function ranAt(mode: string, sessionId: string, opts?: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => mode
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe('a connected-app read marks the turn it ran in, at Full', () => {
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let readFails = false;
  const sent = vi.fn();
  const execute = vi.fn(async (request: { capabilityId: string }) => {
    if (request.capabilityId === 'connectors.execute_read') {
      if (readFails) throw new Error('the app answered with an error');
      return {
        logicalOperationId: 'op-read',
        attemptCount: 1,
        result: { status: 'success', data: {} },
      };
    }
    sent();
    return {
      logicalOperationId: 'op-send',
      attemptCount: 1,
      result: { status: 'success', data: {} },
    };
  });

  /** A revision and the agent's grant to it, on the mail account unless another is named. */
  function revision(
    id: string,
    slug: string,
    classification: 'read' | 'write' | 'destructive',
    providerId: string,
    connection: { id: string; toolkit: string } = { id: CONNECTION_ID, toolkit: 'gmail' }
  ) {
    db.insert(connectorOperationRevisions)
      .values({
        id,
        providerInstanceId: providerId,
        toolkit: connection.toolkit,
        operationSlug: slug,
        toolkitVersion: '2026-09-01',
        schemaHash: `sha256:${id}`,
        providerRevisionRef: `provider-${id}`,
        capabilityClassification: classification,
        retryPolicy: 'never' as const,
        inputSchemaJson: JSON.stringify(SCHEMA),
        discoveredAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: `grant-${id}`,
        subjectType: 'agent' as const,
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: connection.id,
        operationRevisionId: id,
        createdBy: 'operator',
        createdAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
  }

  beforeEach(() => {
    execute.mockClear();
    sent.mockClear();
    readFails = false;
    resetChosenTurns();
    resetLiveOutsiderTurns();
    registerTestHomes([AGENT.agentPath]);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
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
    for (const [id, toolkit, ref] of [
      [CONNECTION_ID, 'gmail', 'provider-account-a'],
      [TRACKER_ID, 'linear', 'provider-account-tracker'],
    ] as const) {
      db.insert(connections)
        .values({
          id,
          providerInstanceId: provider.instanceId,
          externalAccountRef: ref as ConnectorExternalAccountRef,
          toolkit,
          label: 'Work',
          identityHint: 'work@example.com',
          status: 'active',
          lifecycleState: 'connected',
          enabled: true,
          grantReconciliationStatus: 'ready',
          createdAt: '2026-11-17T12:00:00.000Z',
          updatedAt: '2026-11-17T12:00:00.000Z',
        })
        .run();
    }
    revision(SEND_REVISION_ID, 'GMAIL_SEND_EMAIL', 'write', provider.instanceId);
    revision(READ_REVISION_ID, 'GMAIL_FETCH_EMAILS', 'read', provider.instanceId);
    const tracker = { id: TRACKER_ID, toolkit: 'linear' };
    revision(TRACKER_READ_ID, 'LINEAR_LIST_ISSUES', 'read', provider.instanceId, tracker);
    revision(TRACKER_WRITE_ID, 'LINEAR_UPDATE_ISSUE', 'write', provider.instanceId, tracker);
    revision(TRACKER_DELETE_ID, 'LINEAR_DELETE_ISSUE', 'destructive', provider.instanceId, tracker);
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

  afterEach(() => {
    setShouldAskActivity(undefined);
    resetCapabilityTierGate();
    resetPermissionGate();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    resetSessionKeys();
    clearTestHomes();
    vi.restoreAllMocks();
  });

  /** The verified caller: the agent, in this chat, or (no chat) as the external server sees it. */
  function caller(sessionId: string | undefined, runtimeTurn?: string) {
    if (runtimeTurn !== undefined) {
      // The connector loopback: a turn-bound runtime principal, and no session in the context.
      return {
        serverPrincipal: createServerPrincipal({
          kind: 'runtime',
          owner: OWNER,
          bindingId: 'binding-a',
          runtime: 'claude-code',
          canonicalSessionId: runtimeTurn,
          agentId: 'agent-a',
          agentPath: AGENT.agentPath,
          canonicalCwd: AGENT.agentPath,
        }),
        identity: AGENT,
      };
    }
    return {
      serverPrincipal: createServerPrincipal({
        kind: 'agent',
        owner: OWNER,
        agentId: 'agent-a',
        agentPath: AGENT.agentPath,
      }),
      identity: AGENT,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  /** Read the inbox from the chat; resolves whether or not the app answered. */
  async function read(sessionId: string | undefined, runtimeTurn?: string) {
    await registry
      .invoke(
        'connectors.execute_read',
        {
          connectionId: CONNECTION_ID,
          operationRevisionId: READ_REVISION_ID,
          arguments: { query: 'is:unread' },
        },
        caller(sessionId, runtimeTurn)
      )
      .catch(() => undefined);
  }

  /** Send one made-up email; the outcome and how many cards wait. */
  async function send(sessionId: string | undefined, runtimeTurn?: string) {
    const outcome = await registry
      .invoke(
        'connectors.execute_write',
        {
          connectionId: CONNECTION_ID,
          operationRevisionId: SEND_REVISION_ID,
          arguments: { recipient_email: 'ann@example.com', subject: 'Garden', body: 'Made up.' },
        },
        caller(sessionId, runtimeTurn)
      )
      .then(
        () => 'ran',
        (error: unknown) =>
          (error as { decision?: { outcome?: string } }).decision?.outcome ?? String(error)
      );
    return { outcome, cards: approvals.listPending().length };
  }

  /** Run one exact action from the chat; the outcome and how many cards wait. */
  async function act(
    capabilityId: string,
    connectionId: string,
    operationRevisionId: string,
    sessionId: string | undefined,
    runtimeTurn?: string
  ) {
    const outcome = await registry
      .invoke(
        capabilityId,
        { connectionId, operationRevisionId, arguments: { query: 'made up' } },
        caller(sessionId, runtimeTurn)
      )
      .then(
        () => 'ran',
        (error: unknown) =>
          (error as { decision?: { outcome?: string } }).decision?.outcome ?? String(error)
      );
    return { outcome, cards: approvals.listPending().length };
  }

  it('cards a send after a read in the same turn, and nothing is sent', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(sent).not.toHaveBeenCalled();
  });

  it('the card says it asks because the turn read outside words', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    await send(chat);
    expect(approvals.listPending()[0]?.serviceAction?.keptCardBecause).toBe('outside-words');
  });

  it('cards a send after a read the app answered with an error', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    readFails = true;
    await read(chat);
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(sent).not.toHaveBeenCalled();
  });

  it('lets a send from a turn that read nothing through, with no card', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    expect(await send(chat)).toEqual({ outcome: 'ran', cards: 0 });
    expect(sent).toHaveBeenCalledTimes(1);
  });

  // DOR-4515: the chat's transcript keeps what the read handed it, so only the owner's own clean
  // send ends the mark. A later turn nobody newly asked for re-reads it, and stays marked.
  it("keeps through the chat's next turn that is not the owner's own clean send", async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    await ranAtFull(chat);
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
  });

  it("ends with the owner's own clean send", async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    noteOwnersCleanSend('owner-read-1', chat);
    await ranAtFull(chat, { turnStarter: 'person', messageId: 'owner-read-1' });
    expect(await send(chat)).toEqual({ outcome: 'ran', cards: 0 });
  });

  it('a continuation picks up the same words and keeps it', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    await ranAtFull(chat, { permissionCeiling: 'runtime-default', continuationHold: true });
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
  });

  it('cards a send through the connector loopback, a runtime principal with no chat named', async () => {
    const born = fresh();
    const sdk = `${born}-sdk`;
    await ranAtFull(born);
    linkSessionId(born, sdk);
    await read(undefined, sdk);
    expect(await send(undefined, sdk)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(await send(born)).toMatchObject({ outcome: 'approval_required' });
    expect(sent).not.toHaveBeenCalled();
  });

  it('marks the agent for a caller that names no chat, until the owner’s own clean send in that chat', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    expect(await send(undefined)).toEqual({ outcome: 'approval_required', cards: 1 });
    await ranAtFull(chat);
    expect((await send(undefined)).outcome).toBe('approval_required');
    noteOwnersCleanSend('owner-read-2', chat);
    await ranAtFull(chat, { turnStarter: 'person', messageId: 'owner-read-2' });
    const after = await send(undefined);
    expect(after.outcome).toBe('ran');
  });
  describe('a read through a tool marks the turn too (PR 2)', () => {
    /** Claude Code's hook firing for one call in this chat, as the CLI fires it before the tool. */
    async function toolCall(sessionId: string, toolName: string, toolInput: object = {}) {
      const matcher = outsideTextHookMatcher(() => sessionId, AGENT.agentPath);
      if (!new RegExp(matcher.matcher!).test(toolName)) return;
      await matcher.hooks[0]!(
        {
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_input: toolInput,
          cwd: AGENT.agentPath,
        } as never,
        'call-1',
        { signal: new AbortController().signal }
      );
    }

    it('cards a send after a WebFetch in the same turn, and nothing is sent', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await toolCall(chat, 'WebFetch');
      expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
    });

    it("cards a send after another MCP server's tool", async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await toolCall(chat, 'mcp__notion__search');
      expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    it('lets a send from a turn that only read local files through', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await toolCall(chat, 'Read', { file_path: `${AGENT.agentPath}/notes.md` });
      await toolCall(chat, 'Grep', { pattern: 'garden', path: AGENT.agentPath });
      await toolCall(chat, 'Glob', { pattern: '**/*.md' });
      await toolCall(chat, 'Bash', { command: 'git status && git diff && pnpm test && ls' });
      expect(await send(chat)).toEqual({ outcome: 'ran', cards: 0 });
    });

    it('cards a send after a Bash command that fetches from the network', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await toolCall(chat, 'Bash', { command: 'curl -s https://example.com/notes' });
      expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
    });

    it('cards a send after reading a file in the temp folder', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await toolCall(chat, 'Read', { file_path: path.join(os.tmpdir(), 'made-up-page.html') });
      expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    /**
     * A runtime with no hook that runs first (Codex, OpenCode): its read starts in the stream, its
     * result comes back, and the model's next step is a send, made after the stream moved on.
     */
    async function streamTurn(runtimeType: string, toolName: string, input: object = {}) {
      const chat = fresh();
      let outcome: Awaited<ReturnType<typeof send>> | undefined;
      const runtime = recordToolUse(
        recordTurnLevels(
          {
            type: runtimeType,
            getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
            async *sendMessage(): AsyncGenerator<StreamEvent> {
              const data = { toolCallId: 'read-1', toolName };
              yield {
                type: 'tool_call_start',
                data: { ...data, input: JSON.stringify(input), status: 'running' },
              };
              yield {
                type: 'tool_result',
                data: { ...data, result: 'made up', status: 'complete' },
              };
              outcome = await send(chat);
              yield { type: 'done', data: {} } as StreamEvent;
            },
          } as unknown as AgentRuntime,
          () => 'bypassPermissions'
        )
      );
      for await (const _event of runtime.sendMessage(chat, 'hi')) {
        // drain
      }
      return outcome;
    }

    it("holds the next step's send after a Codex web search", async () => {
      expect(await streamTurn('codex', 'WebSearch')).toEqual({
        outcome: 'approval_required',
        cards: 1,
      });
      expect(sent).not.toHaveBeenCalled();
    });

    it("holds the next step's send after an OpenCode turn used another server's tool", async () => {
      expect(await streamTurn('opencode', 'notion_search')).toEqual({
        outcome: 'approval_required',
        cards: 1,
      });
    });

    it("holds the next step's send after a Codex turn started a helper", async () => {
      const chat = fresh();
      let outcome: Awaited<ReturnType<typeof send>> | undefined;
      const runtime = recordToolUse(
        recordTurnLevels(
          {
            type: 'codex',
            getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
            async *sendMessage(): AsyncGenerator<StreamEvent> {
              yield {
                type: 'background_task_started',
                data: { taskId: 'helper-1', taskType: 'agent', description: 'Look around' },
              } as StreamEvent;
              outcome = await send(chat);
              yield { type: 'done', data: {} } as StreamEvent;
            },
          } as unknown as AgentRuntime,
          () => 'bypassPermissions'
        )
      );
      for await (const _event of runtime.sendMessage(chat, 'hi')) {
        // drain
      }
      expect(outcome).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    it('lets the send through after a Codex turn that only ran local commands', async () => {
      const local = { command: 'git status && git diff && pnpm test', cwd: AGENT.agentPath };
      expect(await streamTurn('codex', 'Shell', local)).toEqual({ outcome: 'ran', cards: 0 });
    });

    it("holds the next step's send after a Codex command that fetches from the network", async () => {
      const fetches = { command: "bash -lc 'git pull --rebase'", cwd: AGENT.agentPath };
      expect(await streamTurn('codex', 'Shell', fetches)).toEqual({
        outcome: 'approval_required',
        cards: 1,
      });
      expect(sent).not.toHaveBeenCalled();
    });

    it("holds the next step's send after an OpenCode command that fetches from the network", async () => {
      expect(await streamTurn('opencode', 'bash', { command: 'gh issue view 12' })).toEqual({
        outcome: 'approval_required',
        cards: 1,
      });
    });

    it("holds the next step's send after OpenCode read a file in the temp folder", async () => {
      const filePath = path.join(os.tmpdir(), 'made-up-download.txt');
      expect(await streamTurn('opencode', 'read', { filePath })).toEqual({
        outcome: 'approval_required',
        cards: 1,
      });
    });

    it("holds the next step's send after a Bash command whose input streamed in pieces", async () => {
      const chat = fresh();
      let outcome: Awaited<ReturnType<typeof send>> | undefined;
      const runtime = recordToolUse(
        recordTurnLevels(
          {
            type: 'claude-code',
            getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
            async *sendMessage(): AsyncGenerator<StreamEvent> {
              const data = { toolCallId: 'bash-1', toolName: 'Bash' };
              yield { type: 'tool_call_start', data: { ...data, status: 'running' } };
              for (const input of ['{"command":"wget -q', ' -O- https://example.com/a"}']) {
                yield { type: 'tool_call_delta', data: { ...data, input } } as StreamEvent;
              }
              yield { type: 'tool_call_end', data: { ...data, status: 'running' } } as StreamEvent;
              yield {
                type: 'tool_result',
                data: { ...data, result: 'made up', status: 'complete' },
              };
              outcome = await send(chat);
              yield { type: 'done', data: {} } as StreamEvent;
            },
          } as unknown as AgentRuntime,
          () => 'bypassPermissions'
        )
      );
      for await (const _event of runtime.sendMessage(chat, 'hi')) {
        // drain
      }
      expect(outcome).toEqual({ outcome: 'approval_required', cards: 1 });
    });
  });

  describe('a write back to the one app the turn read (DOR-4794)', () => {
    /** Below Full, where a marked turn's write always asks. */
    const BELOW_FULL = 'acceptEdits';
    const readTracker = (chat: string | undefined, runtimeTurn?: string) =>
      act('connectors.execute_read', TRACKER_ID, TRACKER_READ_ID, chat, runtimeTurn);
    const writeTracker = (chat: string | undefined, runtimeTurn?: string) =>
      act('connectors.execute_write', TRACKER_ID, TRACKER_WRITE_ID, chat, runtimeTurn);
    const lines: { eventType: string; resourceId?: string | null }[] = [];

    beforeEach(() => {
      lines.length = 0;
      setShouldAskActivity({
        emit: async (event) => {
          lines.push(event);
        },
      });
      // Both apps have the switch on, so only where the turn's words came from decides. Mail is
      // off the app list, so its column is forced on here, as an old or hand-edited row could be.
      setWritesBack(db, OWNER, TRACKER_ID, true, new Date('2026-11-19T12:00:00.000Z'));
      db.update(connections)
        .set({ writesBackUnasked: true })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
    });

    // Spec case 1. Red without the gate: a marked turn below Full cards every write.
    it('lets a write back to the app the turn read run, with no card and one Activity line', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'ran', cards: 0 });
      expect(sent).toHaveBeenCalledTimes(1);
      expect(lines).toEqual([
        expect.objectContaining({ eventType: 'agent.same_source_write', resourceId: TRACKER_ID }),
      ]);
    });

    it('does the same at Full, where a tracker write reaches outside and would ask', async () => {
      const chat = fresh();
      await ranAtFull(chat);
      await readTracker(chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'ran', cards: 0 });
    });

    it('does the same through the connector loopback, a runtime principal with no chat named', async () => {
      const born = fresh();
      const sdk = `${born}-sdk`;
      await ranAt(BELOW_FULL, born);
      linkSessionId(born, sdk);
      // As the loopback's turn context does as it opens (`connector-turn-context.ts`).
      aliasTurnLevel(born, sdk);
      await readTracker(undefined, sdk);
      expect(await writeTracker(undefined, sdk)).toEqual({ outcome: 'ran', cards: 0 });
    });

    // Red if the switch were not read: everything else matches case 1.
    it('cards the write when the person has not turned writes back on for that app', async () => {
      setWritesBack(db, OWNER, TRACKER_ID, false, new Date());
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    });

    // Spec case 2. Red if the gate checked only that the source is an app, not which one: the
    // mail account has the switch on too.
    it('cards a send through another app after reading the tracker', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
    });

    // Security Must 1. A mail send is `write` class, and the turn's only words came from that same
    // mail account. Red without the app list: the send ran with no card.
    it('cards a mail send after a mail read, even with the mail row switched on', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await read(chat);
      expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    });

    it('cards the tracker write once the turn read the mail account too', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      await read(chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    // Spec case 3. Red if a source that is not an app were let through.
    it("cards the tracker write once the turn also read a stranger's room post", async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      // What `room-read-marks.ts` does for a post from outside the team.
      markRunningTurnOutsider(chat, AGENT.agentPath, { kind: 'room' });
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
    });

    // Red if the room-turn note (a mini app's post, DOR-4587) were not read.
    it('cards the tracker write in a room turn that answered someone from outside', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      noteRoomTurnWords(chat, true);
      await readTracker(chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    // Spec case 4. Red if the gate let a destructive class through: the action is the write
    // capability itself, so only the preflight's class tells them apart.
    it('keeps the ask for a destructive action, even through the write capability', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      const writeAction = { id: 'connectors.execute_write', tier: 'act' as const, area: null };
      const sameSource = { connectionId: TRACKER_ID, toolkit: 'linear', writesBackUnasked: true };
      const permission = (classification: 'write' | 'destructive') =>
        resolveCallPermission({
          action: writeAction,
          identity: AGENT,
          sessionId: chat,
          sameSource: { ...sameSource, classification },
        });
      expect(await permission('write')).toBeNull();
      expect(await permission('destructive')).toMatchObject({ state: 'ask' });
      expect(
        await act('connectors.execute_destructive', TRACKER_ID, TRACKER_DELETE_ID, chat)
      ).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
    });

    // Spec case 6. Red if a turn with no app source at all were let through.
    it('cards the tracker write after a WebFetch, a mark that is not an app', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      const matcher = outsideTextHookMatcher(() => chat, AGENT.agentPath);
      await matcher.hooks[0]!(
        { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {} } as never,
        'call-1',
        { signal: new AbortController().signal }
      );
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    // Red if the turn's start were not read: a carried mark has no source.
    it('cards the tracker write in a turn that started marked, read or not', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat, { carriedMarks: { outsider: true } });
      await readTracker(chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    it("cards the tracker write in the chat's next turn, which starts with the read's mark", async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      await ranAt(BELOW_FULL, chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });

    // Security's ruling (a), case (i). Red without recording the carried mark as unknown: the
    // turn started clean and its only read was the tracker, so nothing else would tell them apart.
    it('cards the tracker write after a moved seat carried a mark onto the chat', async () => {
      const oldSeat = fresh();
      const chat = fresh();
      await ranAt(BELOW_FULL, oldSeat, { carriedMarks: { outsider: true } });
      await ranAt(BELOW_FULL, chat);
      carrySessionMarks(oldSeat, chat);
      await readTracker(chat);
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
      expect(sent).not.toHaveBeenCalled();
    });

    // Security's ruling (a), case (ii). Red if a mark that names no source were left unrecorded.
    it('cards the tracker write when a mark with no source joins the tracker read', async () => {
      const chat = fresh();
      await ranAt(BELOW_FULL, chat);
      await readTracker(chat);
      markRunningTurnOutsider(chat, AGENT.agentPath);
      expect(await writeTracker(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    });
  });
});
