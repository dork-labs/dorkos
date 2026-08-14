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
import { agents, eq, type Db } from '@dorkos/db';
import { AgentBehaviorSchema } from '@dorkos/shared/mesh-schemas';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { TEAM_ROOM_WELL_KNOWN } from '@dorkos/shared/room-schemas';
import { configManager } from '../core/config-manager.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { ReadCursorService } from '../core/read-cursor-service.js';
import { ReadCursorStore } from '../core/read-cursor-store.js';
import { readOwnerAccount } from '../core/auth/index.js';
import { BridgeStore } from '../relay/chat-bridge/bridge-store.js';
import { AuthorRegistry } from './author-registry.js';
import { ensureHandles } from './handles/ensure-handles.js';
import type { EngagedWindow } from './engagement.js';
import { ReactionStore } from './reaction-store.js';
import { AttachmentRowStore } from './attachments/attachment-row-store.js';
import type { RoomAttachmentStore } from './attachments/room-attachment-store.js';
import type { RoomAgentLookup } from './room-errors.js';
import { RoomService } from './room-service.js';
import { RoomStore } from './room-store.js';
import { RoomBroadcaster } from './room-stream.js';
import type { RoomTurnRunner } from './room-trigger.js';
import { RoomTurnBudget, type TurnBudgetLimits } from './turn-budget.js';
import { createSessionRoomTurnRunner } from './room-turn-runner.js';
import { lastPersonSignalAt, WelcomeBackGreeter } from './welcome-back.js';
import { createSessionWorkSource } from './welcome-back-work.js';

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

/**
 * The live cascade ceiling, degrading to the shipped default rather than
 * throwing.
 *
 * `RoomService.post` reads this on EVERY write, so a config manager that is not
 * up yet — or a config file that cannot be read — must never be able to stop a
 * room accepting messages. Degrading to the schema's own default keeps the
 * guard ON: the failure mode is "the guard used its default", never "the guard
 * was absent", which is the only direction it is safe to fail in.
 */
function readMaxAgentDepth(): number {
  try {
    return configManager.get('rooms').maxAgentDepth;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms.maxAgentDepth;
  }
}

/**
 * The live hourly ceilings on automatic turns — per room, and across the whole
 * install — degrading the same way and for the same reason as
 * {@link readMaxAgentDepth}.
 */
const turnBudgetLimits: TurnBudgetLimits = {
  perRoom: () => {
    try {
      return configManager.get('rooms').maxAutomaticTurnsPerRoomPerHour;
    } catch {
      return USER_CONFIG_DEFAULTS.rooms.maxAutomaticTurnsPerRoomPerHour;
    }
  },
  global: () => {
    try {
      return configManager.get('rooms').maxAutomaticTurnsTotalPerHour;
    } catch {
      return USER_CONFIG_DEFAULTS.rooms.maxAutomaticTurnsTotalPerHour;
    }
  },
};

/**
 * A room-turn bound in milliseconds, read live from config and degrading to the
 * shipped default the same way {@link readMaxAgentDepth} does — a config
 * manager that is not up yet must never stop a room answering.
 *
 * @param field - Which `rooms.*` minutes field to read.
 */
function readRoomMinutesMs(field: 'replyWaitMinutes' | 'lateReplyCeilingMinutes'): number {
  try {
    return configManager.get('rooms')[field] * 60_000;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms[field] * 60_000;
  }
}

/**
 * The live engaged-window ceilings, degrading to the shipped defaults the same
 * way {@link readMaxAgentDepth} does.
 *
 * Failing to the defaults keeps the window BOUNDED, which is the only direction
 * it is safe to fail in: an unreadable config must never be able to leave an
 * agent engaged forever.
 */
function readEngagedWindow(): EngagedWindow {
  try {
    const rooms = configManager.get('rooms');
    return { minutes: rooms.engagedWindowMinutes, posts: rooms.engagedWindowPosts };
  } catch {
    return {
      minutes: USER_CONFIG_DEFAULTS.rooms.engagedWindowMinutes,
      posts: USER_CONFIG_DEFAULTS.rooms.engagedWindowPosts,
    };
  }
}

/**
 * How many files one message may carry, read live from `uploads.maxFiles` and
 * degrading to the shipped default the same way {@link readMaxAgentDepth} does.
 *
 * Failing to the default keeps the limit BOUNDED, which is the only safe
 * direction: an unreadable config must never let one message name every file in
 * the room.
 */
function readMaxAttachmentsPerEntry(): number {
  try {
    return configManager.get('uploads').maxFiles;
  } catch {
    return USER_CONFIG_DEFAULTS.uploads.maxFiles;
  }
}

/**
 * The live `welcomeBack` block, degrading to the shipped defaults the same way
 * {@link readMaxAgentDepth} does — and for one extra reason of its own.
 *
 * A config manager that is not up yet must never decide, by accident, that this
 * install has the feature ON or OFF. Falling back to the schema's own defaults
 * keeps the answer the one a person would get if they had never touched the
 * setting, which is the only honest reading of an unreadable config here.
 */
function readWelcomeBack(): UserConfig['welcomeBack'] {
  try {
    return configManager.get('welcomeBack') ?? USER_CONFIG_DEFAULTS.welcomeBack;
  } catch {
    return USER_CONFIG_DEFAULTS.welcomeBack;
  }
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
 */
export function createRoomSubsystem(opts: {
  db: Db;
  agents?: RoomAgentLookup;
  turns?: RoomTurnRunner;
  budget?: RoomTurnBudget;
  readCursors?: ReadCursorService;
}): RoomSubsystem {
  const store = new RoomStore(opts.db);
  const reactions = new ReactionStore(opts.db);
  const attachments = new AttachmentRowStore(opts.db);
  const agentLookup = opts.agents ?? createAgentLookup(opts.db);
  const authors = new AuthorRegistry(opts.db, agentLookup);
  const broadcaster = new RoomBroadcaster();
  const bridges = new BridgeStore(opts.db);
  const readCursors = opts.readCursors ?? new ReadCursorService(new ReadCursorStore(opts.db));
  const service = new RoomService({
    store,
    reactions,
    attachments,
    authors,
    broadcaster,
    bridges,
    agents: agentLookup,
    turns:
      opts.turns ??
      createSessionRoomTurnRunner({
        waitMs: () => readRoomMinutesMs('replyWaitMinutes'),
        ceilingMs: () => readRoomMinutesMs('lateReplyCeilingMinutes'),
      }),
    // The budget reads its own spent hour back out of this database at
    // construction, so the ceilings mean an hour of wall clock rather than an
    // hour of uptime (DOR-1205).
    budget: opts.budget ?? new RoomTurnBudget({ limits: turnBudgetLimits, db: opts.db }),
    // Read per write, not captured once: changing the ceiling in Settings has
    // to bound the very next cascade, not the next server start.
    maxAgentDepth: readMaxAgentDepth,
    // Read per dispatch, for the same reason: shortening the window in Settings
    // has to bind the very next message, not the next server start.
    engagedWindow: readEngagedWindow,
    // Read per post, for the same reason: lowering the limit in Settings has to
    // bind the very next message.
    maxAttachmentsPerEntry: readMaxAttachmentsPerEntry,
    // Read per check for the same reason, and for one more: an install becomes
    // owned partway through its life (the enable-login flow), so a value
    // captured at boot would leave the rooms domain believing forever that the
    // unbound `'local'` author is still the operator.
    isOwnerAuthor: (authorId) => authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
    readCursors,
  });
  // **Here, not at a boot-time hook, and the difference is the ordering bug the
  // reservation exists to prevent.** `dorkos` has to be held before ANY author
  // can be minted — an agent whose manifest name is `DorkOS` that joins a room
  // first would otherwise take it and leave the room's own voice as `dorkos-2`.
  // Wiring it into the subsystem's own construction makes that structural: the
  // registry cannot exist without the reservations existing, on every install
  // path there is, including the embedded one. The backfill rides along because
  // it wants the same guarantee — the reservations are taken before it derives.
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
  return { service, store, attachments, authors, broadcaster, bridges, readCursors, welcomeBack };
}

let active: RoomService | null = null;

/**
 * Register the active RoomService at bootstrap.
 *
 * @param service - The wired service.
 */
export function setRoomService(service: RoomService): void {
  active = service;
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

let activeAttachmentStore: RoomAttachmentStore | null = null;
let activeAttachmentRows: AttachmentRowStore | null = null;

/**
 * Register the attachment seams at bootstrap, beside {@link setRoomService}.
 *
 * Two of them because a room attachment is two things that must be able to move
 * apart: the BYTES, behind {@link RoomAttachmentStore}, and the ROWS, in
 * SQLite. The upload route needs both — it writes the bytes, then records what
 * it wrote — and the serve route needs both to answer one GET. Registered here
 * rather than constructed here because WHERE the bytes live is a deployment
 * decision, made once in `index.ts`, and this module must not make it.
 *
 * @param stores.attachments - Where the bytes go.
 * @param stores.rows - Where the metadata goes.
 */
export function setRoomAttachmentStores(stores: {
  attachments: RoomAttachmentStore;
  rows: AttachmentRowStore;
}): void {
  activeAttachmentStore = stores.attachments;
  activeAttachmentRows = stores.rows;
}

/** The active attachment byte store (throws if bootstrap has not run). */
export function getRoomAttachmentStore(): RoomAttachmentStore {
  if (!activeAttachmentStore) throw new Error('RoomAttachmentStore not initialized');
  return activeAttachmentStore;
}

/** The active attachment row store (throws if bootstrap has not run). */
export function getAttachmentRowStore(): AttachmentRowStore {
  if (!activeAttachmentRows) throw new Error('AttachmentRowStore not initialized');
  return activeAttachmentRows;
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
export { RoomService } from './room-service.js';
export { RoomError, type RoomErrorCode, type RoomAgentLookup } from './room-errors.js';
export { toAuthorRef, type AuthorRecord } from './author-registry.js';
export type { RoomTurnRunner } from './room-trigger.js';
export { RoomTurnBudget } from './turn-budget.js';
