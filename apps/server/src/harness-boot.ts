/**
 * In-process server boot for the eval harness (`@dorkos/evals`, spec
 * eval-harness). Wires the SUBSET of `index.ts start()` that a driven turn
 * needs — the config store, the consolidated DB + migrations, the durable
 * session-event store, and a registered `TestModeRuntime` as the default — then
 * builds the app via `composeFrontDoor()`. Everything is scoped to `dorkHome`,
 * so a boot never touches the developer's real `~/.dork`.
 *
 * WHY THIS EXISTS: `composeFrontDoor()` alone mounts only routes. The runtime
 * registry, the DB handle, and the session-event store are process-global
 * singletons that `start()` wires and the routes do not — so a bare server
 * answers `/api/health` but 400s / 500s the moment a real turn is triggered (no
 * runtime registered). The harness needs a REAL turn to stream on `test-mode`
 * (the `widget-round-trip` eval), which requires exactly that wiring.
 *
 * This is a TEST / HARNESS surface — never on the production `start()` path.
 * Because it mutates the process-global singletons (registry, DB handle, event
 * store), in-process harness servers boot SERIALLY: the credentialed
 * child-process tier is where per-eval isolation gets real.
 *
 * @module harness-boot
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { MeshCore } from '@dorkos/mesh';
import { frontDoorListener } from './http/front-door.js';
import { composeFrontDoor } from './http/hono-api.js';
import { MainRequestAdmission } from './services/core/lifecycle/main-request-admission.js';
import { initBoundary } from './lib/boundary.js';
import { logger } from './lib/logger.js';
import { initConfigManager } from './services/core/config-manager.js';
import { initAgentIdentityService } from './services/core/agent-identity/index.js';
import { composeDorkOsCapabilityRegistry } from './services/core/self-description/dorkos-registry.js';
import { runtimeRegistry } from './services/core/runtime-registry.js';
import { setContinuationHoldDb } from './services/core/turn-power/continuation-hold.js';
import {
  SessionEventStore,
  StagedContextStore,
  setSessionEventStore,
  setStagedContextStore,
} from './services/session/index.js';
import {
  createRoomSubsystem,
  setRoomAttachmentStores,
  setRoomInternals,
  setRoomService,
} from './services/rooms/index.js';
import { LocalRoomAttachmentStore } from './services/rooms/attachments/local-room-attachment-store.js';

/** A booted in-process harness server: its routing plus a DB-closing teardown. */
export interface InProcessTestServer {
  /**
   * The server's routing, as the running server serves it: the front door
   * built by `composeFrontDoor()`, with every route group mounted on the
   * chain (routes + a registered test-mode runtime).
   */
  listener: RequestListener;
  /** Close the sandbox DB handle so the sandbox directory can be removed cleanly. */
  dispose: () => void;
}

/**
 * Boot an in-process `test-mode` server against a sandbox `DORK_HOME`. Registers
 * the deterministic `TestModeRuntime` as the default so a triggered turn streams
 * end-to-end with no real model. Safe to call repeatedly in one process — the
 * registry, DB handle, and event store are OVERWRITTEN each boot (serial only).
 *
 * KEEP IN SYNC with `start()` in `index.ts`: this mirrors the subset of its
 * singleton wiring a driven turn needs (config store, boundary, DB + event
 * store, runtime registration), with NO compile-time link between the two. If
 * `start()` grows a new process-global singleton that the turn path reads,
 * this boot must wire it too — the eval harness's structural self-test
 * (`@dorkos/evals` widget-round-trip on test-mode) is the tripwire that goes
 * red when they drift.
 *
 * @param dorkHome - The sandbox data directory every wired singleton is scoped to.
 * @returns The server's routing and a teardown that closes the DB.
 */
export async function bootInProcessTestServer(dorkHome: string): Promise<InProcessTestServer> {
  // Config store first — the session gate reads it on every request; without
  // it every request 500s (spec eval-harness Errata, in-process boot recipe).
  initConfigManager(dorkHome);

  // Filesystem boundary — the `/events` subscribe (and cwd validation) call
  // `getBoundary()`, which throws until this runs. Scope it to the sandbox ROOT
  // (the parent of `dorkHome`, which also holds the project cwd) so a turn's cwd
  // validates while nothing outside the sandbox is reachable.
  await initBoundary(path.dirname(dorkHome));

  // Consolidated DB + migrations, scoped to the sandbox.
  const db: Db = createDb(path.join(dorkHome, 'dork.db'));
  runMigrations(db);

  // The log-backed turn path (test-mode IS log-backed) persists + hydrates
  // through the durable session-event store and the registry's DB handle.
  setSessionEventStore(new SessionEventStore(db));
  // Staged words fold into the next dispatch on test-mode too, and the receipt
  // for them is durable, so the hold behind it is (DOR-1324).
  setStagedContextStore(new StagedContextStore(db));
  runtimeRegistry.setDb(db);
  setContinuationHoldDb(db);

  // **Agent identity, because a rooms case has to be able to act AS an agent.**
  // `POST /api/test/agent-token` mints through this service, and an eval that
  // drives `post_to_room` presents the token it hands back — without it the
  // route answers 503 and the case cannot reach the mechanism it is about
  // (spec `tool-only-room-replies` §D13). Scoped to the sandbox DB like
  // everything else here.
  initAgentIdentityService(db);

  // Register the deterministic TestModeRuntime as default — a dynamic import so
  // it never enters a production module graph (the guard index.ts uses too).
  const { TestModeRuntime } = await import('./services/runtimes/test-mode/test-mode-runtime.js');
  runtimeRegistry.register(new TestModeRuntime());
  runtimeRegistry.setDefault('test-mode');

  // Mesh, then rooms. A room resolves an agent through the mesh cache
  // (`agents.project_path`), so an agent an eval seeded on disk is invisible to
  // `POST /api/rooms/:id/members` until this reconcile adopts it — which is
  // what lets a rooms eval seed the SAME way on both tiers: write the manifest
  // under `<DORK_HOME>/agents/<slug>/` and let the server find it, exactly as
  // `start()` does.
  const agentsHomeDir = path.join(dorkHome, 'agents');
  // Created before the reconcile so a sandbox with no agents in it does not warn
  // on every boot: the scanner logs an ENOENT for a missing agents home, which
  // is noise on the eval runs that seat no agents and a distraction on the ones
  // that do. `start()` never sees it because `ensureDorkBot()` has already made
  // the directory by the time it reconciles.
  await mkdir(agentsHomeDir, { recursive: true });
  const mesh = new MeshCore({ db, agentsHomeDir, logger });
  await mesh.reconcileOnStartup();

  // The rooms graph. `/api/rooms` is mounted unconditionally,
  // so without this every room route answers 500 ("RoomService not initialized")
  // — including the SSE stream a rooms eval collects.
  const rooms = createRoomSubsystem({ db });
  setRoomService(rooms.service);
  setRoomInternals(rooms.bridges, rooms.authors);
  setRoomAttachmentStores({
    attachments: new LocalRoomAttachmentStore(dorkHome),
    rows: rooms.attachments,
  });

  const admission = new MainRequestAdmission();

  // **The capability invoke route, with the rooms domain on it.** The Hono
  // `/api` app mounts `POST /api/capabilities/:id/invoke` (and the catalog)
  // only when it is handed a registry, which `start()` composes — so without
  // this there was no way to reach `post_to_room` at all on this boot, and a
  // rooms eval about the flip could only assert what the room did with a turn's
  // TEXT.
  //
  // Deliberately the rooms domain and nothing else: every other bag
  // `composeDorkOsCapabilityRegistry` takes is optional, and a harness that
  // composed the marketplace or the connectors would be wiring surfaces no eval
  // drives. The tier gate is left UNARMED, which is the safe direction — until
  // `initCapabilityTierGate` runs it refuses destructive invocations rather than
  // allowing them, and both rooms writes are `act`.
  const capabilities = composeDorkOsCapabilityRegistry({
    logger,
    roomDeps: { rooms: rooms.service },
  });

  // **The test-control routes, mounted by handing them their deps.**
  // `env.ts` validates the environment ONCE at module load, so a gate on
  // `DORKOS_TEST_RUNTIME` reads whatever it was when the server's module graph
  // was first imported — which, in the eval harness, is before the runner sets
  // it (the CLI loads the suite, and the suite imports `@dorkos/server`
  // subpaths, at startup). The visible symptom was `/api/test/scenario`
  // answering 404 on a server that IS running the test-mode runtime, so a rooms
  // case could not hold a turn open long enough to stop it.
  //
  // This boot needs no env var to know the answer: it registers
  // `TestModeRuntime` itself, unconditionally, so these routes belong on it by
  // construction (`http/hono-api.ts` mounts them once either way).

  return {
    listener: frontDoorListener(
      composeFrontDoor(admission, {
        // The session routes read the registry. `POST /api/test/seed-agent`
        // gets it too; harness cases seed on disk instead, but a route that
        // answers 500 for a missing registry is worse than one wired.
        sessions: { meshCore: mesh },
        capabilities,
        onboarding: { meshCore: () => mesh },
        testControl: { meshCore: () => mesh },
      })
    ),
    dispose: () => {
      // Close the underlying better-sqlite3 handle so the sandbox teardown can
      // remove the db (and its WAL sidecars) without a lingering open descriptor.
      db.$client.close();
    },
  };
}
