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
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { configManager } from '../core/config-manager.js';
import { AuthorRegistry } from './author-registry.js';
import type { RoomAgentLookup } from './room-errors.js';
import { RoomService } from './room-service.js';
import { RoomStore } from './room-store.js';
import { RoomBroadcaster } from './room-stream.js';
import type { RoomTurnRunner } from './room-trigger.js';
import { RoomTurnBudget } from './turn-budget.js';
import { createSessionRoomTurnRunner } from './room-turn-runner.js';

/** The wired rooms subsystem. */
export interface RoomSubsystem {
  service: RoomService;
  store: RoomStore;
  authors: AuthorRegistry;
  broadcaster: RoomBroadcaster;
}

/**
 * Read an agent's handle, display name and manifest `responseMode` out of the
 * mesh cache, keyed on its directory. The default {@link RoomAgentLookup}.
 *
 * Keyed on `agents.project_path` (`NOT NULL UNIQUE`) rather than the manifest
 * ULID, so a reconciler rebuild that re-registers every agent under a fresh
 * ULID changes nothing here (ADR 260726-170126).
 *
 * @param db - The consolidated DB handle.
 */
function createAgentLookup(db: Db): RoomAgentLookup {
  return {
    byPath(agentPath) {
      const row = db.select().from(agents).where(eq(agents.projectPath, agentPath)).get();
      if (!row) return null;
      const behavior = AgentBehaviorSchema.safeParse(safeJson(row.behaviorJson));
      return {
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
 * The live hourly ceiling on automatic turns, degrading the same way and for
 * the same reason as {@link readMaxAgentDepth}.
 */
function readMaxAutomaticTurnsPerHour(): number {
  try {
    return configManager.get('rooms').maxAutomaticTurnsPerHour;
  } catch {
    return USER_CONFIG_DEFAULTS.rooms.maxAutomaticTurnsPerHour;
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
 */
export function createRoomSubsystem(opts: {
  db: Db;
  agents?: RoomAgentLookup;
  turns?: RoomTurnRunner;
  budget?: RoomTurnBudget;
}): RoomSubsystem {
  const store = new RoomStore(opts.db);
  const authors = new AuthorRegistry(opts.db);
  const broadcaster = new RoomBroadcaster();
  const service = new RoomService({
    store,
    authors,
    broadcaster,
    agents: opts.agents ?? createAgentLookup(opts.db),
    turns: opts.turns ?? createSessionRoomTurnRunner(),
    budget: opts.budget ?? new RoomTurnBudget({ maxPerWindow: readMaxAutomaticTurnsPerHour }),
    // Read per write, not captured once: changing the ceiling in Settings has
    // to bound the very next cascade, not the next server start.
    maxAgentDepth: readMaxAgentDepth,
  });
  return { service, store, authors, broadcaster };
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

// The barrel carries only what leaves this domain: the service the routes call,
// the typed refusals they map onto status codes, and the author shape the
// caller-resolution helper returns. Everything else — the store, the roster,
// the broadcaster, and the pure addressing/cascade/mention rules — is imported
// from its own module by the code that uses it, so this file does not accrue a
// re-export for every symbol the domain happens to have.
export { RoomService } from './room-service.js';
export { RoomError, type RoomErrorCode, type RoomAgentLookup } from './room-errors.js';
export type { AuthorRecord } from './author-registry.js';
export type { RoomTurnRunner } from './room-trigger.js';
export { RoomTurnBudget } from './turn-budget.js';
