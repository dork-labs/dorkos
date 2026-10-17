/**
 * The computer's answers to relayed requests (spec `everything-is-a-space`
 * B2): the owner's own DorkOS on the web listing an agent's chats, holding a
 * chat's stream open, sending and stopping, all over the one connection this
 * computer dialed out to its pinned hub.
 *
 * Who is calling is decided here, not by the protocol: everything that
 * arrives over the relay is the `relayed` caller, never a person and never
 * "at this computer". So:
 *
 * - it serves only a person's own chats with a registered, non-system agent
 *   (`relay-serves.ts`), and a chat it does not serve is answered exactly as
 *   one that does not exist;
 * - a message starts its turn as `session-relay`, held to
 *   `RELAY_TURN_CEILING` (`relay-send.ts`), so it asks before anything that
 *   needs a person, whatever the chat's own level (spec B2, option 2);
 * - an approval, and an answer to a question, are refused until they can carry
 *   a passkey proof (spec B4): an answer puts words into a turn a person
 *   started at full power. So neither `interaction.approval` nor
 *   `interaction.question` is advertised, and nothing here approves a tool or
 *   answers a question;
 * - nothing a request carries names a folder, a runtime, an account or a
 *   permission: a new chat's folder comes from Mesh, never from the request;
 * - every request, stream and the connection's end is written to the audit
 *   log as the owner, on the `relay` surface, naming the chat but never what
 *   was said.
 *
 * Every dependency is injected, so the rules are tested with fakes; the live
 * wiring is `index.ts`.
 *
 * @module services/core/session-relay/relay-request-server
 */
import { randomUUID } from 'node:crypto';
import type { MeshCore } from '@dorkos/mesh';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import type { InterruptReceipt, QueuedMessage } from '@dorkos/shared/schemas';
import {
  RelayRequestSchema,
  SESSION_RELAY_MAX_INFLIGHT_REQUESTS,
  SESSION_RELAY_MAX_OPEN_STREAMS,
  type RelayComputerFrame,
  type RelayError,
  type RelayRequest,
  type RelayWebFrame,
  type SessionRelayFeature,
} from '@dorkos/shared/session-relay';
import { BoundaryError } from '../../../lib/boundary.js';
import { logger } from '../../../lib/logger.js';
import type { RecordAuditInput } from '../../audit/audit-trail.js';
import type {
  DispatchSessionMessageOpts,
  DispatchSessionMessageResult,
} from '../../session/launch/launch-session.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import type { DurableStreamSink } from '../streams/durable-stream-sink.js';
import type { SessionStreamPlan } from '../streams/session-stream-delivery.js';
import type { RelayRequestServer } from './relay-dialer.js';
import {
  relayAgentById,
  relayAgentForSession,
  type RelayAgent,
  type RelaySessionFacts,
} from './relay-serves.js';
import {
  RELAY_ANSWER_REFUSED,
  RELAY_APPROVAL_REFUSED,
  RELAY_INTERNAL,
  RELAY_INVALID,
  RELAY_NO_AGENT,
  RELAY_NOT_FOUND,
  RELAY_OUTSIDE_BOUNDARY,
  RELAY_RATE_LIMITED,
  RELAY_TOO_MANY_NEW_CHATS,
  relayLaunchRefusal,
} from './relay-errors.js';
import { recordRelayAudit, type RelayAuditEntry } from './relay-audit.js';
import { relayChatSummaries } from './relay-chat-list.js';
import { relayClientId } from './relay-client-id.js';
import { RELAY_TURN_CEILING, relayedMessage } from './relay-send.js';
import { RelayStreamSink } from './relay-stream-sink.js';

/**
 * What this computer serves over the relay. `interaction.approval` and
 * `interaction.question` are left out on purpose: an approval or an answer
 * from the web needs a passkey proof (spec B4).
 */
export const RELAY_SERVED_FEATURES: readonly SessionRelayFeature[] = [
  'chats.list',
  'session.stream',
  'session.send',
  'session.interrupt',
];

/** The few things the relay asks of a chat's runtime. */
export interface RelayRuntime {
  /** The runtime's type, for a synthesized interrupt receipt. */
  readonly type: string;
  /** Stop the chat's running turn. */
  interruptQuery(sessionId: string): Promise<InterruptReceipt>;
}

/** Everything the request server reads and calls. */
export interface RelayRequestServerDeps {
  /** Every registered agent, read fresh for each request. */
  agents: () => readonly RelayAgent[];
  /**
   * The server's records for one chat, or `null` when no such chat exists. A
   * chat that exists is never `null`, even when it cannot be served, so a
   * `newChat` can never land on it.
   */
  locateSession: (sessionId: string) => Promise<RelaySessionFacts | null>;
  /** The chats listed in an agent's folder, with their records. */
  listAgentSessions: (agent: RelayAgent) => Promise<RelaySessionFacts[]>;
  /** Everything a chat's stream needs but the reader, resuming after `resume` when given. */
  resolveStreamPlan: (
    facts: RelaySessionFacts,
    resume: string | undefined
  ) => Promise<Omit<SessionStreamPlan, 'principal'>>;
  /** Deliver a chat's durable stream to a sink until either side ends it. */
  deliverSessionStream: (sink: DurableStreamSink, plan: SessionStreamPlan) => Promise<void>;
  /** Start or feed a chat from one message. */
  dispatchSessionMessage: (
    opts: DispatchSessionMessageOpts
  ) => Promise<DispatchSessionMessageResult>;
  /** Mesh, when it is running; the send path checks a new chat's agent against it. */
  meshCore: () => MeshCore | undefined;
  /** The room binding port, passed through to the send path. */
  roomSessionPlace: () => RoomSessionPlacePort | undefined;
  /** The runtime that owns a chat. */
  resolveRuntime: (sessionId: string) => Promise<RelayRuntime>;
  /** Empty a chat's queue, returning what was waiting. */
  clearQueuedMessages: (sessionId: string) => QueuedMessage[];
  /** Write one audit entry. */
  recordAudit: (input: RecordAuditInput) => void;
  /** The owner of this computer, as the audit log names them. */
  owner: () => AuditActor;
  /** Mints the per-connection client id; injectable for tests. */
  mintClientId?: () => string;
}

/** One stream slot: reserved when asked for, holding its sink once open. */
interface StreamSlot {
  sink: RelayStreamSink | null;
  /** The web side closed it before it opened. */
  closedEarly: boolean;
}

/** What one relay connection holds. Replaced whole when the connection ends. */
interface Connection {
  clientId: string;
  inflight: number;
  streams: Map<string, StreamSlot>;
}

/**
 * How many chats started over the relay may be running a turn at once, across
 * every connection. The in-flight cap ends when a send is accepted, long
 * before its turn does, so without this a hub could start chats without end.
 */
export const RELAY_MAX_LIVE_NEW_CHATS = 4;

/** Answers the requests one computer's relay connection carries. */
export class SessionRelayRequestServer implements RelayRequestServer {
  private conn: Connection;
  /** Chats this server started whose first turn has not settled yet. */
  private liveNewChats = 0;

  /**
   * Hold the server's dependencies.
   *
   * @param deps - See {@link RelayRequestServerDeps}.
   */
  constructor(private readonly deps: RelayRequestServerDeps) {
    this.conn = this.freshConnection();
  }

  /** {@inheritDoc RelayRequestServer.features} */
  features(): readonly string[] {
    return RELAY_SERVED_FEATURES;
  }

  /** {@inheritDoc RelayRequestServer.handle} */
  handle(frame: RelayWebFrame, emit: (frame: RelayComputerFrame) => void): void {
    try {
      if (frame.type === 'stream.close') {
        this.closeStream(frame.streamId);
        return;
      }
      if (frame.type !== 'request') return;
      this.accept(frame.id, frame.request, emit);
    } catch (error) {
      // Never out of `handle`: the dialer's listener would drop the connection.
      logger.warn('[SessionRelay] A relayed request failed', { error: (error as Error).name });
      if (frame.type === 'request')
        emit({ type: 'error', id: frame.id, ok: false, error: RELAY_INTERNAL });
    }
  }

  /** {@inheritDoc RelayRequestServer.endStream} */
  endStream(streamId: string, error: RelayError): boolean {
    const sink = this.conn.streams.get(streamId)?.sink;
    if (!sink) return false;
    sink.fail(error);
    return true;
  }

  /** {@inheritDoc RelayRequestServer.closeAll} */
  closeAll(): void {
    const ended = this.conn;
    this.conn = this.freshConnection();
    for (const slot of ended.streams.values()) {
      if (slot.sink) slot.sink.closeWithConnection();
      else slot.closedEarly = true;
    }
    ended.streams.clear();
    this.audit({
      action: 'relay.connection.closed',
      operation: 'access',
      outcome: 'ok',
      summary: 'The connection to DorkOS on the web closed',
    });
  }

  private freshConnection(): Connection {
    const mint = this.deps.mintClientId ?? (() => relayClientId(randomUUID()));
    return { clientId: mint(), inflight: 0, streams: new Map() };
  }

  /** Check the limits, then run the request with exactly one answer. */
  private accept(id: string, raw: unknown, emit: (frame: RelayComputerFrame) => void): void {
    // The dialer already parsed the frame; parsed again here so this server
    // never trusts a caller it did not check itself.
    const parsed = RelayRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.audit({
        action: 'relay.request',
        operation: 'access',
        outcome: 'refused',
        summary: 'Refused a request from the web that was not valid',
      });
      emit({ type: 'error', id, ok: false, error: RELAY_INVALID });
      return;
    }
    const request = parsed.data;
    const conn = this.conn;
    const limited = (error: RelayError): void => {
      this.audit({
        action: `relay.${request.op}`,
        operation: 'access',
        outcome: 'refused',
        sessionId: 'sessionId' in request ? request.sessionId : undefined,
        summary: 'Refused a request from the web: too many at once',
      });
      refuse(error);
    };
    const refuse = (error: RelayError): void => {
      if (request.op === 'session.stream') {
        emit({ type: 'stream.end', streamId: request.streamId, error });
      } else {
        emit({ type: 'error', id, ok: false, error });
      }
    };
    if (conn.inflight >= SESSION_RELAY_MAX_INFLIGHT_REQUESTS) {
      limited(RELAY_RATE_LIMITED);
      return;
    }
    if (request.op === 'session.stream') {
      if (conn.streams.has(request.streamId)) {
        // An `error`, never a `stream.end` for that id: the open stream with
        // the same id is still live, and the hub must not think it ended.
        emit({
          type: 'error',
          id,
          ok: false,
          error: { ...RELAY_INVALID, message: 'That stream is already open.' },
        });
        return;
      }
      if (conn.streams.size >= SESSION_RELAY_MAX_OPEN_STREAMS) {
        limited(RELAY_RATE_LIMITED);
        return;
      }
      conn.streams.set(request.streamId, { sink: null, closedEarly: false });
    }
    conn.inflight += 1;
    void this.run(conn, id, request, emit, refuse).finally(() => {
      conn.inflight -= 1;
    });
  }

  private async run(
    conn: Connection,
    id: string,
    request: RelayRequest,
    emit: (frame: RelayComputerFrame) => void,
    refuse: (error: RelayError) => void
  ): Promise<void> {
    const answer = (body: unknown): void => emit({ type: 'result', id, ok: true, body });
    try {
      switch (request.op) {
        case 'chats.list':
          return await this.listChats(request.agentId, answer, refuse);
        case 'session.stream':
          return await this.openStream(conn, request, emit);
        case 'session.send':
          return await this.send(conn, request, answer, refuse);
        case 'session.interrupt':
          return await this.interrupt(request.sessionId, answer, refuse);
        case 'interaction.challenge':
          this.refuseApproval(request.sessionId, refuse);
          return;
        case 'interaction.respond':
          if (request.answer.kind === 'answer') this.refuseAnswer(request.sessionId, refuse);
          else this.refuseApproval(request.sessionId, refuse);
          return;
      }
    } catch (error) {
      logger.warn('[SessionRelay] A relayed request failed', {
        op: request.op,
        error: (error as Error).name,
      });
      const sessionId = 'sessionId' in request ? request.sessionId : undefined;
      this.audit({
        action: `relay.${request.op}`,
        operation: 'access',
        outcome: 'failed',
        sessionId,
        summary: 'A request from DorkOS on the web failed',
      });
      if (request.op === 'session.stream') {
        const slot = conn.streams.get(request.streamId);
        if (slot?.sink) slot.sink.fail(RELAY_INTERNAL);
        else {
          conn.streams.delete(request.streamId);
          refuse(RELAY_INTERNAL);
        }
        return;
      }
      refuse(RELAY_INTERNAL);
    }
  }

  /** Whether the relay serves this chat: the one check every chat request makes. */
  async relayServesSession(sessionId: string): Promise<RelaySessionFacts | null> {
    const facts = await this.deps.locateSession(sessionId);
    return facts && relayAgentForSession(facts, this.deps.agents()) ? facts : null;
  }

  /** Whether the relay serves this agent: registered, and not a system agent. */
  relayServesAgent(agentId: string): RelayAgent | null {
    return relayAgentById(this.deps.agents(), agentId);
  }

  private async listChats(
    agentId: string,
    answer: (body: unknown) => void,
    refuse: (error: RelayError) => void
  ): Promise<void> {
    const agent = this.relayServesAgent(agentId);
    if (!agent) {
      this.audit({
        action: 'relay.chats.list',
        operation: 'access',
        outcome: 'refused',
        summary: "Refused to list an agent's chats from the web",
      });
      refuse(RELAY_NO_AGENT);
      return;
    }
    const chats = relayChatSummaries(
      await this.deps.listAgentSessions(agent),
      agent,
      this.deps.agents()
    );
    this.audit({
      action: 'relay.chats.list',
      operation: 'access',
      outcome: 'ok',
      target: { type: 'agent', id: agent.id },
      summary: "Listed an agent's chats from the web",
    });
    answer({ chats });
  }

  private async openStream(
    conn: Connection,
    request: Extract<RelayRequest, { op: 'session.stream' }>,
    emit: (frame: RelayComputerFrame) => void
  ): Promise<void> {
    const { streamId, sessionId } = request;
    const slot = conn.streams.get(streamId);
    if (!slot) return;
    const facts = await this.relayServesSession(sessionId);
    if (!facts) {
      conn.streams.delete(streamId);
      this.audit({
        action: 'relay.session.stream',
        operation: 'access',
        outcome: 'refused',
        sessionId,
        summary: 'Refused to open a chat from the web',
      });
      emit({ type: 'stream.end', streamId, error: RELAY_NOT_FOUND });
      return;
    }
    const plan = await this.deps.resolveStreamPlan(facts, request.resume);
    // Closed by the viewer, or by the connection, while the plan resolved.
    if (slot.closedEarly || conn !== this.conn) {
      conn.streams.delete(streamId);
      if (conn === this.conn) emit({ type: 'stream.end', streamId });
      return;
    }
    const sink = new RelayStreamSink(streamId, emit, (ending) => {
      if (conn.streams.get(streamId) === slot) conn.streams.delete(streamId);
      this.audit({
        action: 'relay.session.stream.closed',
        operation: 'access',
        outcome: 'ok',
        sessionId,
        summary:
          ending === 'closed-by-viewer'
            ? 'Closed a chat on the web'
            : "A chat's stream to the web ended",
      });
    });
    slot.sink = sink;
    this.audit({
      action: 'relay.session.stream',
      operation: 'access',
      outcome: 'ok',
      sessionId,
      summary: 'Opened a chat from the web',
    });
    // The relayed caller sees pending questions and approvals, so the page can
    // draw them (`askEntitlement`); answering is decided per request above.
    void this.deps
      .deliverSessionStream(sink, { ...plan, principal: { kind: 'relayed' } })
      .catch(() => sink.fail(RELAY_INTERNAL))
      .finally(() => sink.end());
  }

  private closeStream(streamId: string): void {
    const slot = this.conn.streams.get(streamId);
    if (!slot) return;
    if (slot.sink) slot.sink.closeByViewer();
    else slot.closedEarly = true;
  }

  private async send(
    conn: Connection,
    request: Extract<RelayRequest, { op: 'session.send' }>,
    answer: (body: unknown) => void,
    refuse: (error: RelayError) => void
  ): Promise<void> {
    const { sessionId } = request;
    const refused = (error: RelayError): void => {
      this.audit({
        action: 'relay.session.send',
        operation: 'execute',
        outcome: 'refused',
        sessionId,
        summary: 'Refused a message from the web',
      });
      refuse(error);
    };
    const facts = await this.deps.locateSession(sessionId);
    const placed = relayedMessage(request, facts, this.deps.agents());
    if (!placed.ok) {
      refused(placed.error);
      return;
    }
    // A new chat holds a slot from here until its first turn settles; a
    // message into an existing chat adds at most one turn to a chat the owner
    // already has, so it is not counted.
    let release = (): void => undefined;
    if (placed.startsChat) {
      if (this.liveNewChats >= RELAY_MAX_LIVE_NEW_CHATS) {
        refused(RELAY_TOO_MANY_NEW_CHATS);
        return;
      }
      this.liveNewChats += 1;
      let held = true;
      release = () => {
        if (!held) return;
        held = false;
        this.liveNewChats -= 1;
      };
    }
    let result: DispatchSessionMessageResult;
    try {
      result = await this.deps.dispatchSessionMessage({
        origin: { kind: 'session-relay' },
        sessionId,
        request: placed.message,
        clientId: conn.clientId,
        meshCore: this.deps.meshCore(),
        roomSessionPlace: this.deps.roomSessionPlace(),
        permissionCeiling: RELAY_TURN_CEILING,
        onSettled: () => release(),
      });
    } catch (error) {
      release();
      if (!(error instanceof BoundaryError)) throw error;
      refused(RELAY_OUTSIDE_BOUNDARY);
      return;
    }
    if ('refused' in result) {
      release();
      refused(relayLaunchRefusal(result.refused));
      return;
    }
    // Nothing runs for a message the dispatcher did not accept.
    if (!result.accepted) release();
    this.audit({
      action: 'relay.session.send',
      operation: placed.startsChat ? 'create' : 'execute',
      outcome: result.accepted ? 'ok' : 'failed',
      sessionId,
      summary: placed.startsChat ? 'Started a chat from the web' : 'Sent a message from the web',
    });
    const id = result.canonicalId;
    answer({ sessionId: id && /^[0-9a-f-]{36}$/.test(id) ? id : sessionId });
  }

  private async interrupt(
    sessionId: string,
    answer: (body: unknown) => void,
    refuse: (error: RelayError) => void
  ): Promise<void> {
    if (!(await this.relayServesSession(sessionId))) {
      this.audit({
        action: 'relay.session.interrupt',
        operation: 'execute',
        outcome: 'refused',
        sessionId,
        summary: 'Refused to stop a chat from the web',
      });
      refuse(RELAY_NOT_FOUND);
      return;
    }
    const runtime = await this.deps.resolveRuntime(sessionId);
    // As the Stop button: the queue first, then the turn, and whatever was
    // waiting goes back to the web side's composer on every outcome.
    const cancelledQueued = this.deps.clearQueuedMessages(sessionId);
    let receipt: InterruptReceipt;
    try {
      receipt = await runtime.interruptQuery(sessionId);
    } catch {
      receipt = { outcome: 'failed', reason: 'delivery-failed', runtime: runtime.type };
    }
    this.audit({
      action: 'relay.session.interrupt',
      operation: 'execute',
      outcome: receipt.outcome === 'failed' ? 'failed' : 'ok',
      sessionId,
      summary: 'Stopped a chat from the web',
    });
    answer({ receipt, cancelledQueued });
  }

  /** An approval, or a challenge for one: refused until B4's passkey proof. */
  private refuseApproval(sessionId: string, refuse: (error: RelayError) => void): void {
    this.audit({
      action: 'relay.interaction.approval',
      operation: 'execute',
      outcome: 'refused',
      sessionId,
      summary: 'Refused an approval from the web',
    });
    refuse(RELAY_APPROVAL_REFUSED);
  }

  /** An answer to a question: refused until B4's passkey proof, as an approval is. */
  private refuseAnswer(sessionId: string, refuse: (error: RelayError) => void): void {
    this.audit({
      action: 'relay.interaction.respond',
      operation: 'execute',
      outcome: 'refused',
      sessionId,
      summary: 'Refused an answer from the web',
    });
    refuse(RELAY_ANSWER_REFUSED);
  }

  /** Record one relayed action (see `relay-audit.ts`). */
  private audit(entry: RelayAuditEntry): void {
    recordRelayAudit(this.deps, entry);
  }
}
