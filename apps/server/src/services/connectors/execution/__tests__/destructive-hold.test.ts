/**
 * The 60-second cancel window before an agent's irreversible action in a
 * connected app (spec `trusted-by-default-flip` §5.6, DOR-2739).
 *
 * Driven through the real capability registry, the real connector capability
 * domains, the real hold service and the real tier gate, with only the
 * preflight, the broker, the approval store and the turn's recorded level
 * faked. So "nothing runs before 60 seconds" is a fact about the path an
 * agent's tool call takes, not about the hold service on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { ActivityItem } from '@dorkos/shared/activity-schemas';
import { lastTurnLevelOf } from '../../../core/turn-power/turn-levels.js';
import {
  CapabilityGateRefusal,
  composeRegistry,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
  type CapabilityRegistry,
} from '../../../core/capabilities/index.js';
import { CapabilityToolError } from '../../../core/capabilities/mcp-envelope.js';
import type { ApprovalService } from '../../../core/approvals/index.js';
import { createCapabilityAuthorityBinding } from '../../principal/capability-authority-binding.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';
import { connectorHoldDomain } from '../hold-capabilities.js';
import {
  DESTRUCTIVE_HOLD_MS,
  DestructiveHoldService,
  HOLD_EVENT_TYPES,
  RELEASED_REPORT_MS,
  heldActionLink,
  type DestructiveHoldDeps,
} from '../destructive-hold.js';
import { openHoldsFrom } from '../hold-activity.js';
import { notificationEntry } from '../../../notifications/notification-registry.js';

/** The identity the store answers for the requesting agent; `undefined` for none. */
let storedIdentity:
  { agentPath: string; displayName: string; createdAt: string; inactive?: 'revoked' } | undefined;

vi.mock('../../../core/agent-identity/agent-identity-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../core/agent-identity/agent-identity-service.js')
  >()),
  getAgentIdentityService: () => ({ describeAgent: async () => storedIdentity }),
}));

vi.mock('../../../core/turn-power/turn-levels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/turn-power/turn-levels.js')>()),
  lastTurnLevelOf: vi.fn(),
}));

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const SESSION = 'session-a';
const REQUESTER_PATH = '/agents/scout';
const DIGEST = 'digest-a';
const TARGET = {
  connectionId: 'connection-a',
  operationRevisionId: 'revision-delete',
  arguments: { message_id: 'm-1' },
};
const NEVER_ASKS: TurnPermissionLevel = { asks: 'never', reach: 'everything' };

/** A runtime principal: an identified agent in a chat. */
function runtimePrincipal(sessionId = SESSION) {
  return createServerPrincipal({
    kind: 'runtime',
    owner: OWNER,
    bindingId: 'binding-a',
    runtime: 'claude-code',
    canonicalSessionId: sessionId,
    agentId: 'agent-scout',
    agentPath: REQUESTER_PATH,
    canonicalCwd: REQUESTER_PATH,
  });
}

/** Event types the log refuses to save, and a gate a save of one waits on. */
let failingTypes: Set<string>;
let saveGate: { type: string; until: Promise<void> } | undefined;

/** An Activity log that keeps what it is given, so a later process can read it. */
function memoryActivity(log: ActivityItem[] = []) {
  return {
    log,
    tryEmit: vi.fn(async (event: Record<string, unknown>) => {
      if (saveGate && event.eventType === saveGate.type) await saveGate.until;
      if (failingTypes.has(event.eventType as string)) return false;
      log.push({
        id: `evt-${log.length}`,
        occurredAt: new Date().toISOString(),
        actorId: null,
        resourceType: null,
        resourceId: null,
        resourceLabel: null,
        linkPath: null,
        metadata: null,
        ...event,
      } as ActivityItem);
      return true;
    }),
    listByEventTypes: vi.fn(async (types: readonly string[]) =>
      log.filter((event) => types.includes(event.eventType))
    ),
  };
}

/** A hold service over a log, with the test's notification and push spies. */
function holdServiceOver(log: ReturnType<typeof memoryActivity>): DestructiveHoldService {
  return new DestructiveHoldService({
    activity: log as unknown as DestructiveHoldDeps['activity'],
    notify: raise as unknown as DestructiveHoldDeps['notify'],
    push: push as unknown as DestructiveHoldDeps['push'],
  });
}

let registry: CapabilityRegistry;
let holds: DestructiveHoldService;
let execute: ReturnType<typeof vi.fn>;
let raise: ReturnType<typeof vi.fn>;
let push: ReturnType<typeof vi.fn>;
let approvalsRequested: ReturnType<typeof vi.fn>;
let activity: ReturnType<typeof memoryActivity>;
let preset: 'careful' | 'trusted' | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(lastTurnLevelOf).mockReturnValue(NEVER_ASKS);
  preset = null;
  initPermissionGate({
    readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }) as never,
  });
  approvalsRequested = vi.fn(() => ({
    approvalId: 'approval-1',
    token: 'token-1',
    expiresAt: '2026-10-13T14:00:00.000Z',
  }));
  initCapabilityTierGate({
    approvals: {
      request: approvalsRequested,
      consume: vi.fn(() => ({ outcome: 'unknown' })),
    } as unknown as ApprovalService,
  });
  failingTypes = new Set();
  saveGate = undefined;
  storedIdentity = {
    agentPath: REQUESTER_PATH,
    displayName: 'Scout',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  raise = vi.fn(async () => ({ notification: { id: 'row' }, deduped: false }));
  push = vi.fn();
  activity = memoryActivity();
  holds = holdServiceOver(activity);
  execute = vi.fn(async () => ({
    logicalOperationId: 'op-1',
    attemptCount: 1,
    result: { status: 'success', data: {} },
  }));
  registry = composeRegistry([connectorExecutionDomain, connectorHoldDomain], {
    logger: noopLogger,
    connectorExecutionDeps: {
      authorization: {
        preflight: vi.fn(async () => ({
          authorityBinding: createCapabilityAuthorityBinding({
            digest: DIGEST,
            ownerKind: 'local_install',
            ownerId: 'install-a',
            agentId: 'agent-scout',
            sessionId: SESSION,
            connectionId: TARGET.connectionId,
            operationRevisionId: TARGET.operationRevisionId,
          }),
          approvalServiceAction: {
            serviceId: 'gmail',
            serviceName: 'Gmail',
            accountLabel: 'work@acme.com',
            actionName: 'Delete message',
            details: [],
          },
        })),
      } as never,
      broker: { execute } as never,
      access: {} as never,
      holds,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  resetCapabilityTierGate();
  resetPermissionGate();
});

/** Call the destructive action the way an agent's turn does. */
function callDestructive(
  extra: {
    signal?: AbortSignal;
    approvalToken?: string;
    principal?: unknown;
    sessionId?: string;
  } = {}
) {
  return registry.invoke('connectors.execute_destructive', TARGET, {
    serverPrincipal: (extra.principal ?? runtimePrincipal()) as never,
    sessionId: extra.sessionId ?? SESSION,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.approvalToken ? { approvalToken: extra.approvalToken } : {}),
  });
}

/** The hold the waiting notification names. */
function heldId(): string {
  const raised = raise.mock.calls.find(([kind]) => kind === 'connector.destructive_pending');
  if (!raised) throw new Error('No hold was announced.');
  return (raised[1] as { holdId: string }).holdId;
}

/** Let the registry's awaited preflight and window decision settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('the cancel window, for an eligible call', () => {
  it('tells everyone, runs nothing before 60 seconds, then runs on a hold bound to its authority', async () => {
    const result = callDestructive();
    await settle();

    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({
        agentName: 'Scout',
        actionName: 'Delete message',
        serviceName: 'Gmail',
        sessionId: SESSION,
      })
    );
    // The push opens the Inbox on this hold's row, where Cancel is.
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Runs in 60 seconds unless someone cancels.',
        deepLink: heldActionLink(heldId()),
      })
    );
    expect(approvalsRequested).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS - 1);
    expect(execute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ logicalOperationId: 'op-1' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      target: TARGET,
      approval: { via: 'hold', holdId: heldId(), authorityBindingDigest: DIGEST },
    });
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_executed',
      expect.objectContaining({ holdId: heldId(), outcome: 'success' })
    );
    expect(activity.log.map((event) => event.eventType)).toEqual([
      HOLD_EVENT_TYPES.held,
      HOLD_EVENT_TYPES.released,
      HOLD_EVENT_TYPES.executed,
    ]);
  });

  it('never runs when a person cancels it, and the agent is told who cancelled', async () => {
    const result = callDestructive();
    await settle();

    expect(holds.cancel(heldId(), { kind: 'person' })).toEqual({ ok: true });
    await expect(result).rejects.toSatisfy(
      (err) =>
        err instanceof CapabilityToolError &&
        (err.payload as { code: string; cancelledBy: string }).code === 'CANCELLED' &&
        (err.payload as { cancelledBy: string }).cancelledBy === 'A person'
    );
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS * 2);
    expect(execute).not.toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({ ended: { reason: 'cancelled', by: 'A person' } })
    );
    expect(activity.log.map((event) => event.eventType)).toEqual([
      HOLD_EVENT_TYPES.held,
      HOLD_EVENT_TYPES.cancelled,
    ]);
  });

  it('never runs when another agent cancels it with the cancel tool', async () => {
    const result = callDestructive();
    await settle();

    await expect(
      registry.invoke(
        'connectors.cancel_held_action',
        { holdId: heldId() },
        {
          identity: {
            agentPath: '/agents/atlas',
            displayName: 'Atlas',
            createdAt: '2026-10-01T00:00:00.000Z',
          },
          sessionId: 'session-atlas',
        }
      )
    ).resolves.toEqual({ status: 'cancelled', holdId: heldId() });
    await expect(result).rejects.toMatchObject({
      payload: { code: 'CANCELLED', cancelledBy: 'Atlas' },
    });
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS * 2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a cancel from the agent that asked, and the action still runs', async () => {
    const result = callDestructive();
    await settle();

    await expect(
      registry.invoke(
        'connectors.cancel_held_action',
        { holdId: heldId() },
        {
          identity: {
            agentPath: REQUESTER_PATH,
            displayName: 'Scout',
            createdAt: '2026-10-01T00:00:00.000Z',
          },
          sessionId: 'another-chat',
        }
      )
    ).rejects.toMatchObject({ payload: { code: 'HOLD_REQUESTER' } });
    // Nor from its own chat, when it names no identity at all.
    expect(holds.cancel(heldId(), { kind: 'unidentified', sessionId: SESSION })).toEqual({
      ok: false,
      code: 'HOLD_REQUESTER',
    });

    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    await expect(result).resolves.toMatchObject({ logicalOperationId: 'op-1' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('is cancelled when the turn is aborted, and never runs', async () => {
    const controller = new AbortController();
    const result = callDestructive({ signal: controller.signal });
    await settle();

    controller.abort();
    await expect(result).rejects.toMatchObject({ payload: { code: 'CANCELLED' } });
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS * 2);
    expect(execute).not.toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({ ended: { reason: 'stopped' } })
    );
  });

  it('writes the released line before anything is sent', async () => {
    execute.mockImplementation(async () => {
      expect(activity.log.map((event) => event.eventType)).toContain(HOLD_EVENT_TYPES.released);
      return { logicalOperationId: 'op-1', attemptCount: 1, result: { status: 'success' } };
    });
    const result = callDestructive();
    await settle();
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    await expect(result).resolves.toMatchObject({ logicalOperationId: 'op-1' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the install moved to Careful during the wait', async () => {
    const result = callDestructive();
    await settle();
    preset = 'careful';
    const refused = expect(result).rejects.toMatchObject({
      payload: { code: 'HOLD_NO_LONGER_ALLOWED' },
    });
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    await refused;
    expect(execute).not.toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({ ended: { reason: 'changed' } })
    );
    expect(activity.log.map((event) => event.eventType)).toEqual([
      HOLD_EVENT_TYPES.held,
      HOLD_EVENT_TYPES.cancelled,
    ]);
  });

  it('sends nothing when the agent was switched off during the wait', async () => {
    const result = callDestructive();
    await settle();
    storedIdentity = { ...storedIdentity!, inactive: 'revoked' };
    const refused = expect(result).rejects.toMatchObject({
      payload: { code: 'HOLD_NO_LONGER_ALLOWED' },
    });
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    await refused;
    expect(execute).not.toHaveBeenCalled();
  });

  it('records an outcome DorkOS could not confirm when the call never reports back', async () => {
    execute.mockImplementation(() => new Promise(() => undefined));
    void callDestructive();
    await settle();
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    expect(execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RELEASED_REPORT_MS);
    const swept = raise.mock.calls.find(([kind]) => kind === 'connector.destructive_executed');
    expect(swept?.[1]).toMatchObject({ outcome: 'outcome_unknown' });
    // Never a claim that it ran: only that it may have.
    expect(notificationEntry('connector.destructive_executed').title(swept![1])).toBe(
      'Scout may have run “Delete message” in Gmail'
    );
  });

  it('still records an outcome that arrives after the sweep', async () => {
    let answer!: (value: unknown) => void;
    execute.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const result = callDestructive();
    await settle();
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS + RELEASED_REPORT_MS);

    answer({ logicalOperationId: 'op-1', attemptCount: 1, result: { status: 'success' } });
    await result;
    expect(raise).toHaveBeenLastCalledWith(
      'connector.destructive_executed',
      expect.objectContaining({ outcome: 'success' })
    );
    expect(activity.log.at(-1)).toMatchObject({
      eventType: HOLD_EVENT_TYPES.executed,
      metadata: expect.objectContaining({ outcome: 'success', lateReport: true }),
    });
  });

  it('sends nothing when the released line could not be saved', async () => {
    failingTypes.add(HOLD_EVENT_TYPES.released);
    const result = callDestructive();
    await settle();
    const refused = expect(result).rejects.toMatchObject({
      payload: { code: 'HOLD_NO_LONGER_ALLOWED' },
    });
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    await refused;
    expect(execute).not.toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({ ended: { reason: 'changed' } })
    );
  });

  it('lets a cancel win while the end-of-wait checks run, naming who cancelled', async () => {
    let open!: () => void;
    saveGate = { type: HOLD_EVENT_TYPES.released, until: new Promise((r) => (open = r)) };
    const result = callDestructive();
    await settle();
    const cancelled = expect(result).rejects.toMatchObject({
      payload: { code: 'CANCELLED', cancelledBy: 'A person' },
    });
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);

    // The wait is over and the release is being saved: nothing sent yet.
    expect(holds.cancel(heldId(), { kind: 'person' })).toEqual({ ok: true });
    open();
    await cancelled;
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers a cancel for a hold that already ran as not found', async () => {
    const result = callDestructive();
    await settle();
    const holdId = heldId();
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    await result;

    expect(holds.cancel(holdId, { kind: 'person' })).toEqual({
      ok: false,
      code: 'HOLD_NOT_FOUND',
    });
  });
});

describe('every call that is not eligible keeps the approval card', () => {
  /** The call raised a card at once, and nothing was held or run. */
  async function expectCard(call: Promise<unknown>): Promise<void> {
    await expect(call).rejects.toSatisfy(
      (err) => err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required'
    );
    expect(approvalsRequested).toHaveBeenCalledTimes(1);
    expect(raise).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }

  it('on Careful', async () => {
    preset = 'careful';
    await expectCard(callDestructive());
  });

  it('in a prompting chat', async () => {
    vi.mocked(lastTurnLevelOf).mockReturnValue({ asks: 'when-risky', reach: 'everything' });
    await expectCard(callDestructive());
  });

  it('in a chat whose level this process never recorded', async () => {
    vi.mocked(lastTurnLevelOf).mockReturnValue(undefined);
    await expectCard(callDestructive());
  });

  it("in a turn that read a stranger's words", async () => {
    vi.mocked(lastTurnLevelOf).mockReturnValue({ ...NEVER_ASKS, outsider: true });
    await expectCard(callDestructive());
  });

  it('from a caller in no chat (an agent principal, as the /mcp server has)', async () => {
    const noChat = createServerPrincipal({
      kind: 'agent',
      owner: OWNER,
      agentId: 'agent-scout',
      agentPath: REQUESTER_PATH,
    });
    await expectCard(callDestructive({ principal: noChat }));
  });

  it('from an agent that was switched off', async () => {
    const call = registry.invoke('connectors.execute_destructive', TARGET, {
      serverPrincipal: runtimePrincipal(),
      sessionId: SESSION,
      identity: {
        agentPath: REQUESTER_PATH,
        displayName: 'Scout',
        createdAt: '2026-10-01T00:00:00.000Z',
        inactive: 'revoked',
      },
    });
    // Refused outright by the gate; never held.
    await expect(call).rejects.toBeInstanceOf(CapabilityGateRefusal);
    expect(raise).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('when nobody could be told: the waiting row was not written', async () => {
    raise.mockResolvedValue({ notification: null, deduped: false });
    await expect(callDestructive()).rejects.toSatisfy(
      (err) => err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required'
    );
    expect(approvalsRequested).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    // The record it started is closed, so a restart reports nothing about it.
    expect(activity.log.map((event) => event.eventType)).toEqual([
      HOLD_EVENT_TYPES.held,
      HOLD_EVENT_TYPES.cancelled,
    ]);
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS * 2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('when the hold could not be recorded: nothing is announced or pushed', async () => {
    failingTypes.add(HOLD_EVENT_TYPES.held);
    await expect(callDestructive()).rejects.toSatisfy(
      (err) => err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required'
    );
    expect(raise).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS * 2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('for an agent DorkOS cannot name', async () => {
    storedIdentity = undefined;
    await expectCard(callDestructive());
  });

  it.each([
    ['the canonical id', 'session-canonical'],
    ['the id the surface resolved', SESSION],
  ])('when the chat asks under %s, whatever the other id says', async (_label, asking) => {
    vi.mocked(lastTurnLevelOf).mockImplementation((id) =>
      id === asking ? { asks: 'always', reach: 'everything' } : NEVER_ASKS
    );
    await expectCard(
      callDestructive({ principal: runtimePrincipal('session-canonical'), sessionId: SESSION })
    );
  });

  it('when the caller already holds an approval token', async () => {
    // A token is the card's own retry: it is decided by the gate, never held.
    await expect(callDestructive({ approvalToken: 'token-x' })).rejects.toBeInstanceOf(
      CapabilityGateRefusal
    );
    expect(raise).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('a restart', () => {
  it('drops a hold it never finished, unexecuted, and says so once', async () => {
    const result = callDestructive();
    await settle();
    const holdId = heldId();
    void result.catch(() => undefined);

    // The process ends here. A new one reads the same Activity log at boot.
    raise.mockClear();
    const afterRestart = holdServiceOver(memoryActivity(activity.log));
    await expect(afterRestart.dropOpenHolds()).resolves.toBe(1);
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({ holdId, ended: { reason: 'restarted' } })
    );
    expect(activity.log.at(-1)).toMatchObject({
      eventType: HOLD_EVENT_TYPES.dropped,
      resourceId: holdId,
    });
    expect(execute).not.toHaveBeenCalled();

    // Closed once: a second boot finds nothing left open.
    await expect(afterRestart.dropOpenHolds()).resolves.toBe(0);
  });

  it('says a hold released before the restart may have run, and to check the app', async () => {
    execute.mockImplementation(() => new Promise(() => undefined));
    void callDestructive();
    await settle();
    const holdId = heldId();
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    expect(execute).toHaveBeenCalledTimes(1);

    // The process ends mid-send. A new one reads the same Activity log at boot.
    raise.mockClear();
    const afterRestart = holdServiceOver(memoryActivity(activity.log));
    await expect(afterRestart.dropOpenHolds()).resolves.toBe(1);
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({ holdId, ended: { reason: 'interrupted' } })
    );
    expect(activity.log.at(-1)).toMatchObject({
      eventType: HOLD_EVENT_TYPES.dropped,
      metadata: expect.objectContaining({ mayHaveRun: true }),
    });
  });

  it('closes a hold whose ending shares its start line’s millisecond, whatever their order', () => {
    const at = '2026-10-13T12:00:00.000Z';
    const line = (eventType: string) =>
      ({
        id: eventType,
        occurredAt: at,
        eventType,
        resourceId: 'hold-1',
        metadata: {
          agentPath: REQUESTER_PATH,
          agentName: 'Scout',
          sessionId: SESSION,
          actionName: 'Delete message',
          serviceName: 'Gmail',
        },
      }) as unknown as ActivityItem;
    const notLive = () => false;
    expect(
      openHoldsFrom([line(HOLD_EVENT_TYPES.cancelled), line(HOLD_EVENT_TYPES.held)], notLive)
    ).toEqual([]);
    expect(
      openHoldsFrom([line(HOLD_EVENT_TYPES.held), line(HOLD_EVENT_TYPES.cancelled)], notLive)
    ).toEqual([]);
    expect(openHoldsFrom([line(HOLD_EVENT_TYPES.held)], notLive)).toHaveLength(1);
  });

  it('leaves a hold that ended alone', async () => {
    const result = callDestructive();
    await settle();
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_HOLD_MS);
    await result;

    const afterRestart = holdServiceOver(memoryActivity(activity.log));
    await expect(afterRestart.dropOpenHolds()).resolves.toBe(0);
  });
});
