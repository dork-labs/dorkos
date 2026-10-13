import {
  createRoomLimitsResolver,
  readRoomMinutesMs,
  readViewerOverrides,
  readEngagedWindow,
  readCollectWindow,
  readResponseGate,
  readMaxAttachmentsPerEntry,
  readMaxCanvasOpsPerTurn,
  readMaxConcurrentTurnsPerAgent,
  readMaxPostsPerTurn,
  readRoomMuted,
  readWelcomeBack,
} from './limits/room-configuration.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../connectors/principal/server-principal.js';
/**
 * Rooms subsystem barrel + factory (spec `rooms`, ADR 260726-170125).
 *
 * `createRoomSubsystem` wires the store, author registry, live broadcaster and
 * service from the DB handle; `set/getRoomService` provide the module singleton
 * the routes read, mirroring the `workspace` domain and the `runtimeRegistry`
 * access idiom.
 *
 * @module server/services/rooms
 */
import { agents, authors as authorRows, sessionMetadata, eq, type Db } from '@dorkos/db';
import { AgentBehaviorSchema } from '@dorkos/shared/mesh-schemas';
import { TEAM_ROOM_WELL_KNOWN } from '@dorkos/shared/room-schemas';
import { nameForAgents } from './room-context.js';
import { readOperatorDisplayName } from '../core/config/operator-display-name.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { onProjectorTurnBoundary } from '../session/session-state-projector.js';
import { ReadCursorService } from '../core/read-cursor-service.js';
import { ReadCursorStore } from '../core/read-cursor-store.js';
import { readOwnerAccount } from '../core/auth/index.js';
import { indexRoomEntry, roomsSource, searchMessages } from '../search/index.js';
import { BridgeStore } from '../relay/chat-bridge/bridge-store.js';
import { AuthorRegistry, isOwnerRecord } from './author-registry.js';
import { ensureHandles } from './handles/ensure-handles.js';
import { ReactionBudget } from './reactions/reaction-budget.js';
import { ReactionStore } from './reactions/reaction-store.js';
import {
  CanvasDocumentStore,
  CanvasService,
  SESSION_AGENT_AUTHOR,
  parseScope,
  publishSessionCanvas,
  sessionCanvasViewers,
  setCanvasService,
  clearCanvasService,
} from '../canvas/index.js';
import { AttachmentRowStore } from './attachments/attachment-row-store.js';
import type { RoomAttachmentStore } from './attachments/room-attachment-store.js';
import type { RoomRepoService } from './repo/room-repo-service.js';
import type { RoomFilesService } from './repo/room-files.js';
import type { RoomFileEditor } from './repo/room-file-editor.js';
import type { RoomWorktreeManager } from './repo/room-worktree-manager.js';
import type { RoomMergeService } from './repo/room-merge-service.js';
import type { RoomAgentLookup } from './data/room-errors.js';
import { createTurnBudgetLimits } from './limits/room-limits.js';
import { RoomService } from './room-service.js';
import type { RoomMirrorAccess, RoomMirrorWritePolicy } from './service/room-service-deps.js';
import { RoomStore } from './room-store.js';
import { createRoomMessageLookup } from './session-bindings/room-message-lookup.js';
import { setRoomMessageLookup } from '../session/chat-messages/room-message-stamps.js';
import { RoomBroadcaster } from './room-stream.js';
import type { RoomTurnRunner } from './room-trigger.js';
import { RoomTurnBudget } from './limits/turn-budget.js';
import { createSessionRoomTurnRunner } from './room-turn-runner.js';
import { storedUsageLimit } from './notices/usage-limit.js';
import { clearStaleReceipts } from './receipts/turn-receipts.js';
import { lastPersonSignalAt, WelcomeBackGreeter } from './welcome-back/greeter.js';
import { createSessionWorkSource } from './welcome-back/work-source.js';

/** The wired rooms subsystem. */
export interface RoomSubsystem {
  service: RoomService;
  store: RoomStore;
  /** The attachment ROW store. The bytes live behind `RoomAttachmentStore`. */
  attachments: AttachmentRowStore;
  authors: AuthorRegistry;
  broadcaster: RoomBroadcaster;
  /** The bridge identity/ref store `createBridgedRoom` writes through. */
  bridges: BridgeStore;
  /**
   * The user-side read-state service these rooms read and write — whichever one
   * the caller passed, or the default built over the same database.
   *
   * Handed back so a caller wiring a server can register THE SAME instance as
   * the module singleton `PUT /api/read-cursors/:kind/:id` resolves. Two
   * instances over one database behave identically, but two over DIFFERENT ones
   * (which is what a test that builds a subsystem and forgets this gets) leave
   * the two routes writing to two tables.
   */
  readCursors: ReadCursorService;
  /**
   * What your agents may say when you come back after being away
   * (spec `team-room-home` D5.2).
   *
   * Handed back so the read-state route can tell it a person is here — the one
   * signal on this server that a REQUEST the person's own client made, rather
   * than a tab that happens to be open, says somebody is at the keyboard.
   */
  welcomeBack: WelcomeBackGreeter;
  /** The canvas service built and registered over this database. */
  canvas: CanvasService;
  /** Same physical document store used by canvas commands and lifecycle transactions. */
  canvasDocuments: CanvasDocumentStore;
}

/** Builds persisted remote-mirror policy only after room stores and authors exist. */
export interface RoomMirrorRuntime {
  mirrorAccess: RoomMirrorAccess;
  mirrorWrites: RoomMirrorWritePolicy;
}

/**
 * Read an agent's handle, display name and manifest `responseMode` out of the
 * mesh cache, keyed on its directory. The default {@link RoomAgentLookup}.
 *
 * Keyed on `agents.project_path` (`NOT NULL UNIQUE`) rather than the manifest
 * ULID (ADR 260726-170126). The row's `id` is carried on the ANSWER, which is a
 * different thing: it is what lets the handle and dispatch seams tell the
 * current occupant of a directory from a previous one whose author row is still
 * around (ADR 260801-003051).
 *
 * **A missing row is what makes an author a ghost**, and the absence of a status
 * filter here is deliberate: an `unreachable` agent — a laptop that closed its
 * lid — still has a row, still resolves, and keeps its name mid-conversation.
 *
 * Exported so the tests that pin ghost and stale-generation behaviour drive the
 * reader that ships, rather than a second one written beside it: M2 and M3 must
 * agree about which agent occupies a directory, and they only do because both
 * read this table.
 *
 * @param db - The consolidated DB handle.
 */
export function createAgentLookup(db: Db): RoomAgentLookup {
  return {
    byPath(agentPath) {
      const row = db.select().from(agents).where(eq(agents.projectPath, agentPath)).get();
      if (!row) return null;
      const behavior = AgentBehaviorSchema.safeParse(safeJson(row.behaviorJson));
      return {
        id: row.id,
        name: row.name,
        displayName: row.displayName ?? row.name,
        responseMode: behavior.success ? behavior.data.responseMode : 'always',
        emoji: row.icon,
        color: row.color,
      };
    },
  };
}

/** Parse a JSON column, degrading to an empty object rather than throwing. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Wire the rooms subsystem from the DB handle.
 *
 * @param opts.db - The consolidated DB handle.
 * @param opts.agents - Agent lookup override; defaults to the mesh-cache reader.
 * @param opts.turns - Turn runner override; defaults to the real session path.
 * @param opts.budget - Turn budget override; defaults to the configured hourly cap.
 * @param opts.readCursors - The install's user-side read-state service. Pass the
 *   one the rest of the server holds — a second instance over the same database
 *   behaves identically, so the default exists for tests and for the embedded
 *   transport, not as a second source of truth.
 * @param opts.canvasNow - The clock the canvas judges an edit lock against, so a
 *   test can move past its 45-second TTL without waiting.
 * @param opts.mirrorAccess - Persisted remote-mirror authorization. This is
 *   consulted before local owner-wide room visibility.
 * @param opts.mirrorWrites - Trusted remote-mirror outbox policy. The writer
 *   derives it from persisted mirror and enrollment state; callers cannot
 *   suppress dispatch themselves.
 * @param opts.createMirrorRuntime - Production composition hook for a mirror
 *   runtime that needs this factory's one store and author registry.
 */
export function createRoomSubsystem(opts: {
  db: Db;
  agents?: RoomAgentLookup;
  turns?: RoomTurnRunner;
  /** Passive launch DATA; no request, constructor origin, or permission is exposed. */
  observeOriginalLaunch?: (data: Readonly<{ sessionId: string; roomId: string }>) => void;
  budget?: RoomTurnBudget;
  readCursors?: ReadCursorService;
  canvasNow?: () => number;
  runtimePrincipalCurrent?: (proof: ServerPrincipalProof) => boolean;
  mirrorAccess?: RoomMirrorAccess;
  mirrorWrites?: RoomMirrorWritePolicy;
  createMirrorRuntime?: (deps: {
    store: RoomStore;
    authors: AuthorRegistry;
    attachments: AttachmentRowStore;
  }) => RoomMirrorRuntime;
}): RoomSubsystem {
  const store = new RoomStore(opts.db);
  const limitsFor = createRoomLimitsResolver(store);
  const reactions = new ReactionStore(opts.db);
  // Receipts a restart left behind (DOR-2823).
  clearStaleReceipts(reactions);
  const canvasDocuments = new CanvasDocumentStore(opts.db);
  const attachments = new AttachmentRowStore(opts.db);
  const agentLookup = opts.agents ?? createAgentLookup(opts.db);
  const authors = new AuthorRegistry(opts.db, agentLookup);
  // A room post that reaches a room-attached chat shows its real author there (DOR-2113).
  setRoomMessageLookup(createRoomMessageLookup(store, authors));
  const mirrorRuntime = opts.createMirrorRuntime?.({ store, authors, attachments });
  const broadcaster = new RoomBroadcaster();
  // **One canvas service per process, built here and registered here.** It is
  // the single writer for every scope (spec `canvas-agent-seat` §1.2), and this
  // is the only place that holds both halves of what it needs: the rows, and the
  // room broadcaster a room frame goes out on. Session frames ride the projector
  // instead, which is what `publishSessionCanvas` reaches — so the routing
  // decision lives in one function rather than inside the service.
  const canvas = new CanvasService({
    documents: canvasDocuments,
    resolveOpener: (scope, authorId, tx, principal) => {
      const parsed = parseScope(canvasDocuments.lifecycle.resolveScope(scope));
      let agentPath: string | undefined;
      let runtime: string | null | undefined;
      let authorStamp: string | null | undefined;
      if (parsed.kind === 'session') {
        if (
          authorId !== SESSION_AGENT_AUTHOR ||
          !isServerPrincipal(principal) ||
          principal.claims.kind !== 'runtime' ||
          opts.runtimePrincipalCurrent?.(principal) !== true
        )
          return null;
        const claims = principal.claims;
        if (
          canvasDocuments.lifecycle.resolveScope(`session:${claims.canonicalSessionId}`) !== scope
        )
          return null;
        const session = tx
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, parsed.id))
          .get();
        agentPath = session?.agentPath ?? undefined;
        runtime = session?.runtime;
        if (claims.agentPath !== agentPath || claims.runtime !== runtime) return null;
        authorStamp = claims.agentId;
      } else if (parsed.kind === 'room') {
        const author = tx.select().from(authorRows).where(eq(authorRows.id, authorId)).get();
        if (author?.kind !== 'agent' || author.retiredAt) return null;
        agentPath = author.naturalKey;
        authorStamp = author.mintedForManifestId;
      }
      if (!agentPath) return null;
      const agent = tx.select().from(agents).where(eq(agents.projectPath, agentPath)).get();
      if (
        !agent ||
        agent.status !== 'active' ||
        (authorStamp !== undefined && authorStamp !== agent.id) ||
        (runtime !== undefined && agent.runtime !== runtime)
      )
        return null;
      return agent.id;
    },
    channels: {
      publish: (scope, frame) => {
        const parsed = parseScope(scope);
        if (parsed.kind === 'room') broadcaster.publish(parsed.id, frame);
        else if (parsed.kind === 'session') publishSessionCanvas(parsed.id, frame);
      },
      viewers: (scope) => {
        const parsed = parseScope(scope);
        if (parsed.kind === 'room') return broadcaster.subscriberCount(parsed.id);
        if (parsed.kind === 'session') return sessionCanvasViewers(parsed.id);
        return 0;
      },
    },
    // Named as an agent reads them: this text reaches agents (DOR-2458).
    displayNameFor: (authorId) =>
      nameForAgents(
        {
          authors,
          isOwnerAuthor: (id) => authors.isOwner(id, readOwnerAccount()?.id ?? null),
          operatorName: readOperatorDisplayName,
        },
        authorId,
        { sentenceStart: true }
      ) ?? 'Somebody',
    // Read per call, never captured: a person who tells DorkOS in Settings to
    // open CSVs in the plain editor must get that answer from the agent's next
    // open too, and both sides resolve through `canvasContentForFile`.
    viewerOverrides: () => readViewerOverrides(),
    ...(opts.canvasNow ? { now: opts.canvasNow } : {}),
  });
  setCanvasService(canvas);
  let enteredService: RoomService | undefined;
  try {
    const bridges = new BridgeStore(opts.db);
    const readCursors = opts.readCursors ?? new ReadCursorService(new ReadCursorStore(opts.db));
    const service = new RoomService({
      ...(opts.observeOriginalLaunch ? { observeOriginalLaunch: opts.observeOriginalLaunch } : {}),
      store,
      ...((mirrorRuntime?.mirrorAccess ?? opts.mirrorAccess)
        ? { mirrorAccess: mirrorRuntime?.mirrorAccess ?? opts.mirrorAccess }
        : {}),
      ...((mirrorRuntime?.mirrorWrites ?? opts.mirrorWrites)
        ? { mirrorWrites: mirrorRuntime?.mirrorWrites ?? opts.mirrorWrites }
        : {}),
      reactions,
      canvasDocuments,
      canvas,
      attachments,
      authors,
      broadcaster,
      // Read usage at the original failure-time lookup frontier.
      usageLimitFor: storedUsageLimit,
      bridges,
      agents: agentLookup,
      turns:
        opts.turns ??
        createSessionRoomTurnRunner({
          waitMs: () => readRoomMinutesMs('replyWaitMinutes'),
          ceilingMs: () => readRoomMinutesMs('lateReplyCeilingMinutes'),
        }),
      // Read per turn, never captured: the manager is registered later in
      // bootstrap (it needs this very service's claim map), and an install with no
      // repo machinery answers `null` forever, which puts every turn in the
      // agent's own directory exactly as before.
      worktrees: () => tryGetRoomWorktreeManager(),
      // The budget reads its own spent hour back out of this database at
      // construction, so the ceilings mean an hour of wall clock rather than an
      // hour of uptime (DOR-1205).
      budget:
        opts.budget ??
        new RoomTurnBudget({ limits: createTurnBudgetLimits(limitsFor, opts.db), db: opts.db }),
      // Recovered from the reactions themselves rather than a counter table, so an
      // agent that spent its hour and met a restart comes back spent
      // (ADR 260814-195522).
      reactionBudget: new ReactionBudget({ db: opts.db }),
      // The message index, behind its port. Composed here rather than imported by
      // the service so the rooms domain neither knows the index is FTS5 nor which
      // `sourceId` its own rows carry.
      findMessages: ({ rooms: scoped, query, limit }) =>
        searchMessages(opts.db, {
          scopes: [
            {
              sourceId: roomsSource.id,
              visibility: 'containers',
              containers: scoped.map((room) => ({
                originKey: room.roomId,
                afterOrdinal: room.afterSeq,
              })),
            },
          ],
          query,
          limit,
        }).map((hit) => ({ roomId: hit.originKey, seq: hit.ordinal })),
      // The write half of that port: an entry is indexed the moment it is
      // committed, so a person can find what they just said instead of waiting up
      // to five minutes for the reconciler (spec Amendment 6). It never throws —
      // a failure logs and leaves the sweep to catch this room up.
      indexEntry: ({ roomId, seq }) => indexRoomEntry(opts.db, roomId, seq),
      // Resolved per write, not captured once: changing a ceiling in Settings —
      // or on the room — has to bound the very next cascade, not the next server
      // start. Turning limits back ON is the direction that must never wait for a
      // restart.
      limitsFor,
      // Read per dispatch, for the same reason: shortening the window in Settings
      // has to bind the very next message, not the next server start.
      engagedWindow: readEngagedWindow,
      // Read per burst, for the same reason: lengthening the gathering window in
      // Settings has to bind the very next message.
      collect: readCollectWindow,
      // Read per sweep, for the same reason: switching the gate off in Settings
      // has to bind the very next burst.
      responseGate: readResponseGate,
      // Read per tick, for the same reason: shortening how long a room waits on a
      // busy agent has to bind the wait that is already running.
      holdCeilingMs: () => readRoomMinutesMs('lateReplyCeilingMinutes'),
      // Read at every claim decision, for the same reason: raising it in Settings
      // has to let the very next message start, and lowering it has to hold the
      // very next one — neither may wait for a restart.
      maxConcurrentTurnsPerAgent: readMaxConcurrentTurnsPerAgent,
      // Read per post, for the same reason: lowering the limit in Settings has to
      // bind the very next message.
      maxAttachmentsPerEntry: readMaxAttachmentsPerEntry,
      // Read per post, for the same reason and one more: posting is the agent's
      // only voice in a room, so an operator who feels this number is wrong must
      // be able to move it without waiting for anything to restart.
      maxPostsPerTurn: readMaxPostsPerTurn,
      // Read per operation, for the same reason and one more: a room's canvas is
      // a shared surface, so an operator who feels one agent is taking too much of
      // it must be able to narrow the bound without waiting for a restart.
      maxCanvasOpsPerTurn: readMaxCanvasOpsPerTurn,
      // Resolved per read rather than captured: the repo service is registered
      // later in bootstrap, and an install with no repo machinery answers `null`
      // forever — which is exactly right, because then no room has a shared tree
      // and every file document belongs to whoever opened it.
      roomRepoPath: (roomId) => {
        const repos = tryGetRoomRepoService();
        if (!repos) return null;
        return repos.repoPathFor(roomId);
      },
      // Read per check for the same reason, and for one more: an install becomes
      // owned partway through its life (the enable-login flow), so a value
      // captured at boot would leave the rooms domain believing forever that the
      // unbound `'local'` author is still the operator.
      isOwnerAuthor: (authorId) => authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
      // Read per turn: the person can rename themselves at any time, and the
      // next turn's context has to call them by the new name (DOR-2458).
      operatorName: readOperatorDisplayName,
      // The record-based twin, for a caller that already fetched a batch of
      // rows and would otherwise pay `isOwnerAuthor`'s re-query per member.
      isOwnerRecord: (record) => isOwnerRecord(record, readOwnerAccount()?.id ?? null),
      // A THIRD question, not a third spelling of the two above: whose WORDS these
      // are, which the platform-identity link widens and the two authority
      // predicates deliberately do not (DOR-1778, `isOwnerVoiceRecord`). Read per
      // check for the same reason they are — an install becomes owned partway
      // through its life, and a link made in the app has to silence the very next
      // message.
      isOwnerVoice: (authorId) => authors.isOwnerVoice(authorId, readOwnerAccount()?.id ?? null),
      readCursors,
      // Read per post, for the same reason as every reader above: muting a room
      // in the sidebar has to silence the very next `dm.received`, not the next
      // server start.
      isRoomMuted: readRoomMuted,
    });
    enteredService = service;
    // **Here, not at a boot-time hook, and the difference is the ordering bug the
    // reservation exists to prevent.** `dorkos` has to be held before ANY author
    // can be minted — an agent whose manifest name is `DorkOS` that joins a room
    // first would otherwise take it and leave the room's own voice as `dorkos-2`.
    // Wiring it into the subsystem's own construction makes that structural: the
    // registry cannot exist without the reservations existing, on every install
    // path that can take them. The backfill rides along because it wants the same
    // guarantee — the reservations are taken before it derives.
    //
    // A READ-ONLY subsystem is the one exception, and it does not weaken the
    // invariant: it cannot mint a handle either, so there is no race for it to
    // lose, and the reservations it would take are already in the database that
    // whichever DorkOS wrote it took them in.
    ensureHandles(opts.db, authors);
    const welcomeBack = new WelcomeBackGreeter({
      settings: readWelcomeBack,
      // Resolved per return rather than captured: #team is seeded during boot and
      // an install can be greeted before this factory has ever seen it.
      teamRoomId: () => store.findByWellKnown(TEAM_ROOM_WELL_KNOWN)?.id ?? null,
      work: createSessionWorkSource({
        store,
        authors,
        // Read per call: a runtime registered after boot (an OpenCode sidecar
        // that came up late) has sessions that count too.
        runtimes: () => runtimeRegistry.listRuntimes(),
      }),
      // The ordinary guarded path, deliberately — a welcome-back line is a post
      // like any other, so membership, the cascade stamp and the turn budget
      // bind it without this module restating any of them. The entry id comes
      // back because an offer turn is framed around the line it follows.
      post: (roomId, input) => service.post(roomId, input).id,
      // The one thing here that can spend a model turn, and only when
      // `welcomeBack.offersEnabled` says it may. It goes through the room's own
      // turn machinery, so the session binding, both busy ceilings and the
      // automatic-turn budget bind an offer exactly as they bind a reply.
      offers: { ask: (input) => service.askAside(input) },
      lastSeenAt: (userId) => lastPersonSignalAt(opts.db, userId),
    });
    return {
      service,
      store,
      attachments,
      authors,
      broadcaster,
      bridges,
      readCursors,
      welcomeBack,
      canvas,
      canvasDocuments,
    };
  } catch (cause) {
    // The caller never received this canvas if post-publication setup failed.
    // A replacement installed by reentry belongs to that later bootstrap.
    try {
      enteredService?.canvas.dispose();
    } catch {
      /* Preserve the original setup cause. */
    }
    try {
      clearCanvasService(canvas);
    } catch {
      /* Independent exact-owner cleanup. */
    }
    throw cause;
  }
}

let active: RoomService | null = null;

// **The turn boundary is the only seam a targeted canvas write can close on**
// (spec `canvas-agent-seat` §9). A ONE-ON-ONE session has no turn id — that
// lives under `session.roomTurn`, threaded from the room runner — so the id a
// targeted write is charged and ledgered against is derived, and this is what
// ends it: one coalesced line per room it wrote to, and fresh allowances for the
// next turn.
//
// Wired at module scope, beside the canvas domain's own two listeners and for
// the reason its doc gives: both shells import this module and only one of them
// runs `index.ts`. It is a no-op until a room service is registered, a no-op on
// `interaction_resolved` (a person answering mid-turn is not a turn that ended),
// and a no-op for a session that targeted nothing — which is nearly all of them.
//
// A ROOM turn is untouched: its own `turnId` is still finished by the runner's
// collector, and `finishTargetedTurns` only ever closes ids in the `session:`
// namespace.
onProjectorTurnBoundary((sessionId, kind) => {
  if (kind !== 'turn_end') return;
  active?.canvas.finishTargetedTurns(sessionId);
});

/**
 * Register the active RoomService at bootstrap.
 *
 * @param service - The wired service.
 */
export function setRoomService(service: RoomService): void {
  active = service;
}

/** Retire only the exact singleton owned by the closing bootstrap. */
export function clearRoomService(expected: RoomService): boolean {
  if (active !== expected) return false;
  active = null;
  return true;
}

/** Read the active RoomService (throws if bootstrap has not run). */
export function getRoomService(): RoomService {
  if (!active) throw new Error('RoomService not initialized');
  return active;
}

let activeWelcomeBack: WelcomeBackGreeter | null = null;

/**
 * Register the active welcome-back greeter at bootstrap, beside
 * {@link setRoomService}.
 *
 * @param greeter - The wired greeter.
 */
export function setWelcomeBackGreeter(greeter: WelcomeBackGreeter): void {
  activeWelcomeBack = greeter;
}

/**
 * The active welcome-back greeter, or `null` when this process has none.
 *
 * **`null` rather than a throw**, unlike every other getter here, because its
 * one caller is a person's read-state write: a surface that runs without the
 * rooms graph (the embedded transport, a test that wired only what it needed)
 * must still be able to record what somebody has read. A greeting is the
 * feature that goes missing, and nothing else.
 */
export function getWelcomeBackGreeter(): WelcomeBackGreeter | null {
  return activeWelcomeBack;
}

// The two attachment seams live in their own module so the domain's own callers
// can reach them without importing this barrel; re-exported here so every
// existing caller is unchanged.
export {
  getAttachmentRowStore,
  getRoomAttachmentStore,
  setRoomAttachmentStores,
} from './attachments/attachment-stores.js';

let activeRepos: RoomRepoService | null = null;

/**
 * Register the room-repo service at bootstrap, beside
 * {@link setRoomAttachmentStores} and for the same reason: WHERE a room's files
 * live is a deployment decision made once in `index.ts`, and this module must
 * not make it.
 *
 * @param service - The wired service.
 */
export function setRoomRepoService(service: RoomRepoService): void {
  activeRepos = service;
}

/** The active room-repo service (throws if bootstrap has not run). */
export function getRoomRepoService(): RoomRepoService {
  if (!activeRepos) throw new Error('RoomRepoService not initialized');
  return activeRepos;
}

/**
 * The active room-repo service, or `null` when bootstrap has not registered
 * one.
 *
 * For callers on a TURN's path rather than a request's. A route that reaches
 * for a room's files was asked for them and should say so if the service is
 * missing; a room turn was asked to answer a message, and refusing it because
 * an optional subsystem is absent would take a room down over a feature it does
 * not use. The embedded read-only subsystem is the ordinary case: it never
 * bootstraps one, and every room there is simply a room without files.
 */
export function tryGetRoomRepoService(): RoomRepoService | null {
  return activeRepos;
}

let activeRoomFiles: RoomFilesService | null = null;

/**
 * Register the read-only room files service at bootstrap, beside
 * {@link setRoomRepoService} and for the same reason.
 *
 * Its own singleton rather than a method on the repo service: enabling a repo
 * is a write the operator makes once, reading its files is a request path every
 * member takes, and the two share nothing but the store.
 *
 * @param service - The wired service.
 */
export function setRoomFilesService(service: RoomFilesService): void {
  activeRoomFiles = service;
}

/** The active room files service (throws if bootstrap has not run). */
export function getRoomFilesService(): RoomFilesService {
  if (!activeRoomFiles) throw new Error('RoomFilesService not initialized');
  return activeRoomFiles;
}

let activeRoomFileEditor: RoomFileEditor | null = null;

/**
 * Register the room file editor at bootstrap, beside
 * {@link setRoomFilesService}.
 *
 * Its own singleton rather than a method on the read service, for the reason
 * that one gives about the repo service: reading a room's files is something
 * every member does on a request path, and saving one is a write into the
 * integration tree that has to hold the room's queue. They share a store and a
 * provenance walk, and nothing else.
 *
 * @param editor - The wired editor.
 */
export function setRoomFileEditor(editor: RoomFileEditor): void {
  activeRoomFileEditor = editor;
}

/** The active room file editor (throws if bootstrap has not run). */
export function getRoomFileEditor(): RoomFileEditor {
  if (!activeRoomFileEditor) throw new Error('RoomFileEditor not initialized');
  return activeRoomFileEditor;
}

let activeWorktrees: RoomWorktreeManager | null = null;

/**
 * Register the room-worktree manager at bootstrap, beside
 * {@link setRoomRepoService}.
 *
 * @param manager - The wired manager.
 */
export function setRoomWorktreeManager(manager: RoomWorktreeManager): void {
  activeWorktrees = manager;
}

/**
 * The active room-worktree manager, or `null` where none was wired.
 *
 * **Nullable, unlike every getter above it, and that is the point.** Its one
 * consumer is the cwd rung on the hot path of every room turn — the dispatcher's
 * `resolveCwd`, which feeds the session-cwd resolver — and it must place a turn
 * on an install whose repo machinery was never
 * bootstrapped. Throwing here would turn "this deployment has no room repos"
 * into "this room stopped answering".
 */
export function tryGetRoomWorktreeManager(): RoomWorktreeManager | null {
  return activeWorktrees;
}

let activeMerges: RoomMergeService | null = null;

/**
 * Register the room merge service at bootstrap, beside
 * {@link setRoomRepoService}.
 *
 * Its own singleton rather than a field on the repo service, because the two
 * answer different questions with different dependencies — one owns the binding
 * on disk, the other owns the integration tree and the room's log — and folding
 * them together would give the enable path a reason to know about the room
 * service.
 *
 * @param service - The wired service.
 */
export function setRoomMergeService(service: RoomMergeService): void {
  activeMerges = service;
}

/** The active room merge service (throws if bootstrap has not run). */
export function getRoomMergeService(): RoomMergeService {
  if (!activeMerges) throw new Error('RoomMergeService not initialized');
  return activeMerges;
}

let activeBridges: BridgeStore | null = null;
let activeAuthors: AuthorRegistry | null = null;

/**
 * Register the active bridge store and author registry at bootstrap, beside
 * {@link setRoomService}. These are the two seams a bridged room needs that the
 * `RoomService` does not expose publicly (the `room_bridges` visibility write
 * and the operator's own author id), and the test-control seed route reaches
 * them through the getters below — the same singleton pattern the runtime
 * registry already uses. Nothing on the production request path reads them.
 *
 * @param bridges - The wired bridge store.
 * @param authors - The wired author registry.
 */
export function setRoomInternals(bridges: BridgeStore, authors: AuthorRegistry): void {
  activeBridges = bridges;
  activeAuthors = authors;
}

/** Read the active bridge store (throws if bootstrap has not run). */
export function getBridgeStore(): BridgeStore {
  if (!activeBridges) throw new Error('BridgeStore not initialized');
  return activeBridges;
}

/** Read the active author registry (throws if bootstrap has not run). */
export function getRoomAuthors(): AuthorRegistry {
  if (!activeAuthors) throw new Error('AuthorRegistry not initialized');
  return activeAuthors;
}

// The barrel carries only what leaves this domain: the service the routes call,
// the typed refusals they map onto status codes, and the author shape the
// caller-resolution helper returns. Everything else — the store, the roster,
// the broadcaster, and the pure addressing/cascade/mention rules — is imported
// from its own module by the code that uses it, so this file does not accrue a
// re-export for every symbol the domain happens to have.
export { RoomService, type PostedEntry } from './room-service.js';
export {
  RoomError,
  RoomRepoConfigUnsafeError,
  roomRefusalFor,
  type RoomErrorCode,
  type RoomAgentLookup,
} from './data/room-errors.js';
export { isOwnerRecord, toAuthorRef, type AuthorRecord } from './author-registry.js';
export { resolveOperatorAuthor } from './operator-author.js';
export type { RoomTurnRunner } from './room-trigger.js';
export { RoomTurnBudget } from './limits/turn-budget.js';
