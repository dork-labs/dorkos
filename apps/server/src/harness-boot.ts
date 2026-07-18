/**
 * In-process server boot for the eval harness (`@dorkos/evals`, spec
 * eval-harness). Wires the SUBSET of `index.ts start()` that a driven turn
 * needs — the config store, the consolidated DB + migrations, the durable
 * session-event store, and a registered `TestModeRuntime` as the default — then
 * builds the app via `createApp()` / `finalizeApp()`. Everything is scoped to
 * `dorkHome`, so a boot never touches the developer's real `~/.dork`.
 *
 * WHY THIS EXISTS: `createApp()` alone mounts only routes. The runtime registry,
 * the DB handle, and the session-event store are process-global singletons that
 * `start()` wires and `createApp()` does not — so a bare `createApp()` server
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
import type { Express } from 'express';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { createApp, finalizeApp } from './app.js';
import { initBoundary } from './lib/boundary.js';
import { initConfigManager } from './services/core/config-manager.js';
import { runtimeRegistry } from './services/core/runtime-registry.js';
import { SessionEventStore, setSessionEventStore } from './services/session/index.js';

/** A booted in-process harness server: the Express app plus a DB-closing teardown. */
export interface InProcessTestServer {
  /** The configured Express app (routes + a registered test-mode runtime). */
  app: Express;
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
 * @returns The built app and a teardown that closes the DB.
 */
export async function bootInProcessTestServer(dorkHome: string): Promise<InProcessTestServer> {
  // Config store first — `sessionGate` reads it on every request; without it
  // `createApp()` 500s (spec eval-harness Errata, in-process boot recipe).
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
  runtimeRegistry.setDb(db);

  // Register the deterministic TestModeRuntime as default — a dynamic import so
  // it never enters a production module graph (the guard index.ts uses too).
  const { TestModeRuntime } = await import('./services/runtimes/test-mode/test-mode-runtime.js');
  runtimeRegistry.register(new TestModeRuntime());
  runtimeRegistry.setDefault('test-mode');

  const app = createApp();
  finalizeApp(app);

  return {
    app,
    dispose: () => {
      // Close the underlying better-sqlite3 handle so the sandbox teardown can
      // remove the db (and its WAL sidecars) without a lingering open descriptor.
      db.$client.close();
    },
  };
}
