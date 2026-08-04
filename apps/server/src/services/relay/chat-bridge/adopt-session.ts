/**
 * Session adoption at bridge time, gated on a real transcript probe
 * (chats-as-channels spec §7.1–§7.4).
 *
 * When a chat that already has a live private-pipe session is bridged, its
 * agent should not forget the conversation so far. So the bridge MAY adopt that
 * session as the room's `(room, agent)` session. But adoption is not safe
 * unconditionally: `BindingRouter` is not an `onProjectorRekey` listener
 * (`apps/server/src/index.ts` registers only the connector service), so a
 * session id in `sessions.json` can name a session that was rekeyed out from
 * under it. Adopting a stale id would resume a conversation that no longer
 * exists, or worse, the wrong one.
 *
 * The rule this module implements, in order:
 *
 * 1. **Take the single `{bindingId}:chat:{chatId}` sessionMap entry** (the
 *    router's {@link BridgeSessionAdopterDeps.takeChatSession}). Zero or many
 *    candidates: start fresh.
 * 2. **Probe the DURABLE transcript** — the JSONL file on disk, via the existing
 *    `TranscriptReader.hasTranscript`, never the in-process session map (which is
 *    empty after a restart and would make adoption fail for every bridge created
 *    shortly after launch). The probe is gated PER RUNTIME: only claude-code has
 *    a durable transcript to read. A binding whose agent runs on codex or
 *    opencode has no equivalent probe, so it takes the fresh-start path rather
 *    than a fabricated answer.
 * 3. **Probe passes** → write the id into the room-session ledger for
 *    `(room, boundAgent)` and post the pointer notice.
 * 4. **Probe fails** (no candidate, unprobeable runtime, or no transcript) →
 *    start fresh and post the pointer-less notice.
 *
 * **The room log never gains the old messages** — the platform gives bots no
 * history read, and the session transcript is runtime-owned (ADR-0310), so
 * copying it in would be DorkOS asserting a record it did not witness. The notice
 * says exactly this ({@link buildBridgeHistoryNotice}).
 *
 * @module server/services/relay/chat-bridge/adopt-session
 */

/**
 * The per-runtime transcript probe. Only claude-code answers it; every other
 * runtime reports it cannot, and the adopter starts fresh rather than guessing.
 *
 * Backed by the claude-code `TranscriptReader.hasTranscript` in production
 * (threaded from the composition root so the runtime SDK stays confined to its
 * adapter dir), and by a fixture reader in tests.
 */
export interface TranscriptProbe {
  /**
   * Whether this runtime has a durable transcript this probe can read. `true`
   * only for `'claude-code'`; codex and opencode own their session storage
   * differently and have no equivalent stat-only existence check.
   *
   * @param runtimeType - The session's resolved runtime type.
   */
  canProbe(runtimeType: string): boolean;
  /**
   * Whether a JSONL transcript exists on disk for this session, in any account.
   * A stat-only check — the same durable signal `hasStarted` names ("the JSONL
   * file exists"). Only ever called after {@link TranscriptProbe.canProbe}.
   *
   * @param vaultRoot - The agent's project root, whose slug the transcript is
   *   filed under (the path a fresh session was created against).
   * @param sessionId - The candidate session id.
   */
  hasTranscript(vaultRoot: string, sessionId: string): Promise<{ exists: boolean }>;
}

/** The room-domain writes adoption performs — satisfied by `RoomService`. */
export interface AdoptRoomOps {
  /**
   * Bind an adopted session into the `(room, agent)` ledger, first-write-wins,
   * before the room's first turn (chats-as-channels spec §7.3, step 3).
   *
   * @param roomId - The bridged room.
   * @param agentAuthorId - The bound agent's author id in this room.
   * @param sessionId - The transcript-probed session to adopt.
   */
  bindAdoptedSession(roomId: string, agentAuthorId: string, sessionId: string): void;
  /**
   * Post the history notice into the room (chats-as-channels spec §7.3): pointer
   * when a session was adopted, pointer-less when the bridge started fresh.
   *
   * @param roomId - The bridged room.
   * @param priorSession - Whether an existing session was adopted.
   */
  postBridgeHistoryNotice(roomId: string, priorSession: boolean): void;
}

/** Everything {@link BridgeSessionAdopter} is constructed from. */
export interface BridgeSessionAdopterDeps {
  /**
   * Take (find, remove, persist) the single `{bindingId}:chat:{chatId}`
   * sessionMap entry — `BindingRouter.takeChatSession`. `undefined` when there
   * is not exactly one candidate.
   */
  takeChatSession(bindingId: string, chatId: string): Promise<{ sessionId: string } | undefined>;
  /**
   * Resolve a session's runtime type, inferring `'claude-code'` for a legacy
   * session with no recorded metadata — `runtimeRegistry.getSessionRuntimeType`.
   */
  getSessionRuntimeType(sessionId: string): Promise<string>;
  /** The per-runtime durable transcript probe (§7.3, step 2). */
  probe: TranscriptProbe;
  /**
   * The bound agent's project root, for the claude-code probe's `vaultRoot` —
   * `meshCore.getProjectPath(agentId)`. `undefined` when the agent is not
   * resolvable, which fails the probe like any other unverifiable session.
   */
  resolveAgentRoot(agentId: string): string | undefined;
  /** The room-domain writes — the real `RoomService`. */
  rooms: AdoptRoomOps;
}

/** What one adoption attempt is told about the freshly bridged chat. */
export interface AdoptInput {
  /** The binding being bridged. */
  bindingId: string;
  /** The platform chat id the bridge is for. */
  chatId: string;
  /** The bound agent's id, for resolving the probe's project root. */
  agentId: string;
  /** The bridged room the session would be adopted into. */
  roomId: string;
  /** The bound agent's author id in that room. */
  agentAuthorId: string;
}

/** The verdict of one adoption attempt. */
export interface AdoptResult {
  /** Whether an existing session was adopted into the room's ledger. */
  adopted: boolean;
  /** The adopted session id, when one was. */
  sessionId?: string;
}

/**
 * Adopts an existing chat session into a bridged room's ledger when — and only
 * when — a durable transcript proves it is real (chats-as-channels spec §7.3).
 *
 * Stateless: every attempt reads the current sessionMap and probes the current
 * disk, so two bridges of two chats never share a snapshot.
 */
export class BridgeSessionAdopter {
  private readonly deps: BridgeSessionAdopterDeps;

  constructor(deps: BridgeSessionAdopterDeps) {
    this.deps = deps;
  }

  /**
   * Run the §7.3 rule for one freshly bridged chat: take its sessionMap entry,
   * probe the transcript per runtime, and either adopt the session into the
   * room's ledger (pointer notice) or start fresh (pointer-less notice).
   *
   * Always posts exactly one history notice, whichever branch it takes, so the
   * room log always says where the conversation's history is. Never throws for a
   * missing candidate or an unprobeable runtime — those are ordinary fresh-start
   * outcomes, not errors.
   *
   * @param input - Which chat, which room, which agent.
   * @returns Whether a session was adopted, and which one.
   */
  async adoptAtBridge(input: AdoptInput): Promise<AdoptResult> {
    const candidate = await this.deps.takeChatSession(input.bindingId, input.chatId);
    if (!candidate) return this.fresh(input.roomId);

    const runtimeType = await this.deps.getSessionRuntimeType(candidate.sessionId);
    if (!this.deps.probe.canProbe(runtimeType)) return this.fresh(input.roomId);

    const vaultRoot = this.deps.resolveAgentRoot(input.agentId);
    if (!vaultRoot) return this.fresh(input.roomId);

    const { exists } = await this.deps.probe.hasTranscript(vaultRoot, candidate.sessionId);
    if (!exists) return this.fresh(input.roomId);

    // Probe passed: the JSONL is on disk, so this id names a real, resumable
    // conversation. Bind it before the first turn (first-write-wins) so the turn
    // resumes it, and tell the room where the earlier messages live.
    this.deps.rooms.bindAdoptedSession(input.roomId, input.agentAuthorId, candidate.sessionId);
    this.deps.rooms.postBridgeHistoryNotice(input.roomId, true);
    return { adopted: true, sessionId: candidate.sessionId };
  }

  /** Start fresh: post the pointer-less notice and adopt nothing. */
  private fresh(roomId: string): AdoptResult {
    this.deps.rooms.postBridgeHistoryNotice(roomId, false);
    return { adopted: false };
  }
}
