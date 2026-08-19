/**
 * The Approve/Deny card a room-bound Ask sends into a bridged chat (spec
 * `ask-entitlement` §5.2).
 *
 * Driven through the REAL projector registry rather than by calling the
 * delivery's handler directly: `onProjectorInteractionChange` is the seam this
 * whole feature hangs off, and a test that called the private handler would be
 * downstream of the subscription — which is exactly the wiring an operator
 * depends on and the part a refactor drops.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BridgedAskDelivery, type BridgedAskDeliveryDeps } from '../ask-card.js';
import type { Bridge } from '../bridge-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  type RawSessionEvent,
} from '../../../session/session-state-projector.js';

const ROOM_SESSION = 'ask-card-room-session';
const LONE_SESSION = 'ask-card-lone-session';
const TIMEOUT_MS = 10 * 60 * 1000;
const ROOM_ID = 'room_ops';
const AGENT_AUTHOR = 'author-ana';
const APPROVER_AUTHOR = 'author-miguel';

/** The approver's stored natural key, in the shape `AuthorRegistry` mints. */
const APPROVER_KEY = 'platform:telegram:tg-main:145223';
/** The same person, reached through a different bot entirely. */
const OTHER_BOT_KEY = 'platform:slack:slack-acme:145223';
/** Somebody on the roster who is not on the allowlist. */
const STRANGER_KEY = 'platform:telegram:tg-main:999999';

/**
 * A live bridge on a private Telegram chat.
 *
 * @param overrides - What this case varies.
 */
function bridgeOn(overrides: Partial<Bridge> = {}): Bridge {
  return {
    roomId: ROOM_ID,
    adapterId: 'tg-main',
    chatId: '145223',
    channelType: null,
    platformChatType: 'private',
    bindingId: 'binding-ana',
    visibility: null,
    visibilityCheckedAt: null,
    platformTitle: null,
    deliverNotices: true,
    lastDeliveredSeq: 0,
    lastActivityAt: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

/** What one case wants the world to look like. */
interface World {
  bridge?: Bridge | null;
  members?: { authorId: string }[];
  keys?: Record<string, string>;
  approvers?: unknown;
  subject?: string | null;
}

let publish: ReturnType<typeof vi.fn>;
let delivery: BridgedAskDelivery;

/**
 * Build and start a delivery over one world.
 *
 * @param world - What this case varies from the eligible default: a live
 *   private bridge, one allowlisted approver on the roster, and a subject.
 */
function startDelivery(world: World = {}): void {
  const bridge = world.bridge === undefined ? bridgeOn() : world.bridge;
  const members = world.members ?? [{ authorId: AGENT_AUTHOR }, { authorId: APPROVER_AUTHOR }];
  const keys = world.keys ?? { [AGENT_AUTHOR]: '/agents/ana', [APPROVER_AUTHOR]: APPROVER_KEY };
  const deps: BridgedAskDeliveryDeps = {
    bindings: {
      bindingForSession: (sessionId) =>
        sessionId === ROOM_SESSION ? { roomId: ROOM_ID, authorId: AGENT_AUTHOR } : undefined,
    },
    bridges: { findBridgeByRoom: () => bridge },
    members: { listMembers: () => members },
    authors: { getById: (id) => (keys[id] ? { naturalKey: keys[id] } : null) },
    approverAllowlistFor: () => (world.approvers === undefined ? ['145223'] : world.approvers),
    resolveSubject: () =>
      world.subject === undefined ? 'relay.human.telegram.tg-main.145223' : world.subject,
    publisher: { publish: publish as never },
  };
  delivery = new BridgedAskDelivery(deps);
  delivery.start();
}

/**
 * Park a session on an interaction, as a runtime does.
 *
 * @param sessionId - The session to park.
 * @param event - The raw projector event.
 */
function park(sessionId: string, event: Record<string, unknown>): void {
  getOrCreateProjector(sessionId, '/work/alpha').ingest(event as unknown as RawSessionEvent);
}

/** A tool-approval prompt, the one kind that produces a card. */
function approvalEvent(id = 'tc-1'): Record<string, unknown> {
  return {
    type: 'approval_required',
    id,
    startedAt: Date.now(),
    remainingMs: TIMEOUT_MS,
    timeoutMs: TIMEOUT_MS,
    toolName: 'Bash',
    input: JSON.stringify({ command: 'rm -rf /work/alpha/build' }),
    hasSuggestions: false,
  };
}

beforeEach(() => {
  publish = vi.fn(async () => ({
    messageId: 'm-1',
    deliveredTo: 1,
    adapterResult: { success: true },
  }));
});

afterEach(() => {
  delivery.stop();
  disposeProjector(ROOM_SESSION);
  disposeProjector(LONE_SESSION);
  vi.restoreAllMocks();
});

describe('BridgedAskDelivery', () => {
  it('sends one approval card, on the chat’s subject, with an initiate principal', async () => {
    startDelivery();

    park(ROOM_SESSION, approvalEvent());
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    const [subject, payload, options] = publish.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(subject).toBe('relay.human.telegram.tg-main.145223');
    expect(payload).toMatchObject({
      type: 'approval_required',
      data: {
        // The interaction's OWN id — the same value `POST /api/sessions/:id/approve`
        // passes to `approveTool`, so the click round-trips to one place.
        toolCallId: 'tc-1',
        toolName: 'Bash',
        ccaSessionKey: ROOM_SESSION,
        agentId: AGENT_AUTHOR,
      },
    });
    expect(
      options.from,
      'an Ask card is DorkOS starting a message, so it must claim initiate'
    ).toBe('relay.bridge.initiate.tg-main.145223');
    expect(options.serverBridgePrincipal).toBe(true);
  });

  it('sends nothing for an Ask in a session no room owns', async () => {
    startDelivery();

    park(LONE_SESSION, approvalEvent());

    await expectNoPublish();
  });

  it('sends nothing when the room has no live bridge', async () => {
    startDelivery({ bridge: null });

    park(ROOM_SESSION, approvalEvent());

    await expectNoPublish();
  });

  it('sends nothing into a group chat, however many approvers are in it', async () => {
    startDelivery({ bridge: bridgeOn({ platformChatType: 'group' }) });

    park(ROOM_SESSION, approvalEvent());

    await expectNoPublish();
  });

  it('sends nothing when the chat’s person is not on the approver list', async () => {
    startDelivery({ keys: { [AGENT_AUTHOR]: '/agents/ana', [APPROVER_AUTHOR]: STRANGER_KEY } });

    park(ROOM_SESSION, approvalEvent());

    await expectNoPublish();
  });

  it('reads the allowlist the way the setup form stores it, one id per line', async () => {
    startDelivery({ approvers: ' 145223 \n 999999 ' });

    park(ROOM_SESSION, approvalEvent());
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  });

  it('sends nothing when the roster’s only outsider came through a different bot', async () => {
    startDelivery({ keys: { [AGENT_AUTHOR]: '/agents/ana', [APPROVER_AUTHOR]: OTHER_BOT_KEY } });

    park(ROOM_SESSION, approvalEvent());

    await expectNoPublish();
  });

  it('sends nothing when the chat’s subject cannot be built', async () => {
    startDelivery({ subject: null });

    park(ROOM_SESSION, approvalEvent());

    await expectNoPublish();
  });

  it('sends nothing for a question, which the button path cannot carry', async () => {
    startDelivery();

    park(ROOM_SESSION, {
      type: 'question_prompt',
      id: 'q-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      timeoutMs: TIMEOUT_MS,
      questions: [{ question: 'Which branch?', header: 'Branch' }],
    });

    await expectNoPublish();
  });

  it('sends nothing for an elicitation, which needs a form', async () => {
    startDelivery();

    park(ROOM_SESSION, {
      type: 'elicitation_prompt',
      id: 'e-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      timeoutMs: TIMEOUT_MS,
      serverName: 'linear',
      message: 'Sign in to Linear',
    });

    await expectNoPublish();
  });

  describe('the standing-card record', () => {
    it('says a card is standing for the agent it sent one for, and only that one', async () => {
      startDelivery();

      park(ROOM_SESSION, approvalEvent());
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

      expect(delivery.hasStandingCard(ROOM_ID, AGENT_AUTHOR)).toBe(true);
      expect(delivery.hasStandingCard(ROOM_ID, 'author-someone-else')).toBe(false);
      expect(delivery.hasStandingCard('room_other', AGENT_AUTHOR)).toBe(false);
      expect(delivery.hasStandingCard(ROOM_ID, undefined)).toBe(false);
    });

    it('says nothing is standing when no card was sent', async () => {
      startDelivery({ bridge: null });

      park(ROOM_SESSION, approvalEvent());
      await expectNoPublish();

      expect(delivery.hasStandingCard(ROOM_ID, AGENT_AUTHOR)).toBe(false);
    });

    it('records nothing when the consent gate refused the card', async () => {
      // `canInitiate: false` comes back as a REJECTION, not a throw. Recording
      // it would suppress the waiting sentence in exchange for a card that was
      // never sent, and the approver would get silence — which is the failure
      // this whole path exists to end.
      publish.mockResolvedValue({
        messageId: 'm-1',
        deliveredTo: 0,
        rejected: [{ endpointHash: 'e', reason: 'initiate_denied' }],
      });
      startDelivery();

      park(ROOM_SESSION, approvalEvent());
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

      expect(delivery.hasStandingCard(ROOM_ID, AGENT_AUTHOR)).toBe(false);
    });

    it('records nothing when the platform refused the send', async () => {
      publish.mockResolvedValue({
        messageId: 'm-1',
        deliveredTo: 1,
        adapterResult: { success: false, error: 'chat not found' },
      });
      startDelivery();

      park(ROOM_SESSION, approvalEvent());
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

      expect(delivery.hasStandingCard(ROOM_ID, AGENT_AUTHOR)).toBe(false);
    });

    it('records nothing when no adapter handled the publish at all', async () => {
      publish.mockResolvedValue({ messageId: 'm-1', deliveredTo: 0 });
      startDelivery();

      park(ROOM_SESSION, approvalEvent());
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

      expect(delivery.hasStandingCard(ROOM_ID, AGENT_AUTHOR)).toBe(false);
    });

    it('forgets the card once the turn resolves, so suppression does not outlive it', async () => {
      startDelivery();
      park(ROOM_SESSION, approvalEvent());
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

      getOrCreateProjector(ROOM_SESSION, '/work/alpha').resolveInteraction('tc-1', 'approved');

      expect(delivery.hasStandingCard(ROOM_ID, AGENT_AUTHOR)).toBe(false);
    });
  });
});

/**
 * Assert nothing was published, having given the delivery's async path a turn
 * of the event loop to run.
 *
 * The `await` matters: `deliver` is async, so an assertion made synchronously
 * after `park` would pass even against a version that publishes to everyone.
 */
async function expectNoPublish(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  expect(publish).not.toHaveBeenCalled();
}
