/**
 * Server-side extension lifecycle management.
 *
 * Handles compilation, loading, and routing for extensions that declare
 * `serverCapabilities` or `dataProxy` in their manifest. Operates as a
 * collaborator to {@link ExtensionManager} — never called directly by routes.
 *
 * Two runtimes, chosen by the manifest after the approval gate and the
 * compile: an in-process server half is `require()`d here (ADR 0213); one
 * that asks to run separately (`runtime: "subprocess"`, DOR-2686) runs in its
 * own child process (`isolation/`), with a router that forwards to it, and is
 * restarted on a backoff when it stops on its own. Nothing here ever ends a
 * process other than an isolated extension's own child.
 *
 * @module services/extensions/extension-server-lifecycle
 */
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'node:module';
import { Router } from 'express';
import type { ExtensionRecord, ExtensionToolStatus } from '@dorkos/extension-api';
import type { ExtensionCompiler } from './extension-compiler.js';
import { createProxyRouter } from './extension-proxy.js';
import { createDataProviderContext } from './extension-server-api-factory.js';
import { toRecordError, type ActiveServerExtension } from './extension-manager-types.js';
import {
  EXTENSION_NOT_APPROVED_CODE,
  describeExtensionLoadRefusal,
  mayRunExtensionCode,
} from './extension-load-policy.js';
import { configManager } from '../core/config-manager.js';
import { getExtensionInbox } from './inbox/extension-inbox.js';
import { getAgentSendService } from './agent-send/agent-send.js';
import { logger } from '../../lib/logger.js';
import type { CapabilityRegistry } from '../core/capabilities/registry.js';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { RunningExtensionTools, type ToolBinding } from './agent-tools/tool-binding.js';
import { extensionDeclarationDigest } from './agent-tools/declaration-digest.js';
import { isolationKeyOf } from './isolation/isolation-view.js';
import { extensionServerErrorCopy } from '@dorkos/shared/extension-server-status';
import {
  IsolatedExtensionHost,
  type IsolatedExit,
  type IsolatedHostTimings,
  type IsolatedStartErrorCode,
} from './isolation/isolated-host.js';
import { resolveChildEntry } from './isolation/child-entry.js';
import { createIsolatedRouter } from './isolation/isolated-router.js';
import { RestartPolicy, type RestartPolicyOptions } from './isolation/restart-policy.js';
import { env } from '../../env.js';
import {
  RegistrationCustody,
  type RegistrationOccurrence,
} from './server-lifecycle/registration-custody.js';

const require = createRequire(import.meta.url);

/**
 * Everything the running instance of an extension was built from, as one
 * comparable string: the directory it was read from, the manifest fields that
 * decide what gets mounted, and — for an extension with a server entry — the
 * content hash of its compiled server bundle.
 *
 * This is what makes {@link ExtensionServerLifecycle.initialize} idempotent. The
 * client asks the server to initialize every server-side extension on every page
 * load and every tab, and before this each of those tore the extension down and
 * re-evaluated its module (DOR-1336).
 *
 * The server bundle's hash is the one that matters, not `record.sourceHash` —
 * that field is the CLIENT bundle's hash, which answers a different question and
 * would have missed an edited `server.ts`.
 *
 * The manifest's tool and skill declarations are covered too
 * ({@link extensionDeclarationDigest}): a running instance's tools are the
 * ones its manifest declared when it started, so a changed declaration needs
 * a restart to take effect (DOR-2685).
 *
 * The bundle hash covers everything `server.ts` imports, because it is the
 * hash of the bundled output (`ExtensionCompiler.compileServer`, DOR-2491): an
 * edit to a helper module changes the bundle and so restarts the extension,
 * while an edit that leaves the output identical does not.
 *
 * @param record - The extension's discovery record.
 * @param serverSourceHash - Content hash of the compiled server bundle, or
 *   `null` for a proxy-only extension (there is no server source to hash).
 */
function buildSourceKey(record: ExtensionRecord, serverSourceHash: string | null): string {
  return JSON.stringify({
    path: path.resolve(record.path),
    runPath: record.runPath ?? null,
    version: record.manifest.version,
    serverEntryPath: record.serverEntryPath ?? null,
    dataProxy: record.manifest.dataProxy ?? null,
    declarations: extensionDeclarationDigest(record.manifest),
    isolation: isolationKeyOf(record),
    separate: runsSeparately(record),
    serverSourceHash,
  });
}

/**
 * How long an extension's server `register()` may take to finish.
 *
 * Every re-scan runs one at a time (`ExtensionManager`), and starting a server
 * half is part of one. A `register()` that never settles would hold the queue
 * forever: installs would hang, and a copy that should have been stopped
 * would keep running. So DorkOS stops waiting, marks the extension as one
 * that couldn't start, releases everything it set up, and moves on.
 */
export const REGISTER_TIMEOUT_MS = 15_000;

/**
 * Why a server half did not start in time, as its card shows it. The
 * isolated host reports the same code for the same reason.
 */
const REGISTER_TIMEOUT_ERROR = 'server_start_timeout' satisfies IsolatedStartErrorCode;

/**
 * Where an isolated extension's server half stands between starts: a restart
 * pending after it stopped on its own, or the stop after too many of those
 * (DOR-2686, spec §9). Kept here, not on the record, because records are
 * rebuilt on every scan while this lasts; `ExtensionManager` lays it over the
 * public record.
 */
export interface SupervisedServerStatus {
  /** Why it is stopped and will not restart by itself. */
  serverError?: { code: string; message: string };
  /** When a pending restart is due (ISO 8601). */
  restartingAt?: string;
}

/** What {@link ExtensionServerLifecycle} needs besides its data directory and compiler. */
export interface ServerLifecycleOptions {
  /**
   * How long an extension's `register()` may take before DorkOS stops
   * waiting ({@link REGISTER_TIMEOUT_MS}). For an isolated extension it also
   * covers loading its code in the child.
   */
  registerTimeoutMs?: number;
  /** DorkOS's own HTTP port, which an isolated extension may never connect to. */
  dorkosPort?: number;
  /** The record discovery holds for an id right now (records are rebuilt on every scan). */
  recordOf?: (id: string) => ExtensionRecord | undefined;
  /** Called when an isolated extension's status changed on its own (it stopped, restarted or gave up). */
  onStatusChange?: (id: string) => void;
  /** The restart backoff and crash budget (tests shorten them). */
  restartPolicy?: RestartPolicyOptions;
  /** Watchdog and start timings for isolated children (tests shorten them). */
  isolatedTimings?: Partial<IsolatedHostTimings>;
}

/**
 * Manages the lifecycle of server-side extensions: compile, load, route, and teardown.
 *
 * Each active extension gets an Express Router mounted at `/api/ext/{id}/*`.
 * Proxy-only extensions (no server.ts) get auto-generated proxy routes.
 * Extensions with server.ts get custom routes + optional proxy alongside.
 */
export class ExtensionServerLifecycle {
  private serverExtensions = new Map<string, ActiveServerExtension>();
  private readonly registrationCustody = new RegistrationCustody();
  private readonly registrations = new WeakMap<ActiveServerExtension, RegistrationOccurrence>();
  /**
   * The live capability registry, once boot has composed it. Extensions start
   * before it exists; their tools wait on their running instance and are
   * handed over by {@link attachCapabilityRegistry}.
   */
  private capabilityRegistry: CapabilityRegistry | null = null;

  private readonly registerTimeoutMs: number;
  /** Per isolated extension: its crash budget and backoff. */
  private readonly restartPolicies = new Map<string, RestartPolicy>();
  /** Per isolated extension: the source its crash count is for. */
  private readonly policySources = new Map<string, string>();
  /** Per isolated extension: a pending restart. */
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  /** Per isolated extension: the source it gave up on, so a page load does not start it again. */
  private readonly gaveUp = new Map<string, string>();
  /** Per isolated extension: what its card says between starts. */
  private readonly supervised = new Map<string, SupervisedServerStatus>();

  /**
   * Build the lifecycle for one DorkOS data directory.
   *
   * @param dorkHome - DorkOS's data directory.
   * @param compiler - The shared extension compiler.
   * @param options - See {@link ServerLifecycleOptions}.
   */
  constructor(
    private readonly dorkHome: string,
    private readonly compiler: ExtensionCompiler,
    private readonly options: ServerLifecycleOptions = {}
  ) {
    this.registerTimeoutMs = options.registerTimeoutMs ?? REGISTER_TIMEOUT_MS;
  }

  /**
   * The tail of each extension's start/stop queue. `initialize` and
   * `shutdown` for one id run one at a time, in the order they were asked
   * for (DOR-2685 review). Without it, two starts racing (every tab asks for
   * one on load) could each store an instance, the first never stopped and
   * its tools left callable; and a stop arriving while `register()` ran found
   * nothing to stop, so the instance stored after it lived on.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Run `job` after every start or stop of `id` asked for before it. */
  private exclusive<T>(id: string, job: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }

  /**
   * Whether `record` may still start right now: its status still says on
   * (`disable` marks it off before it stops anything), and it is still
   * approved to run. Asked again after every wait inside a start, so a
   * turn-off or a revoke that lands while `register()` runs leaves nothing
   * running.
   */
  private stillWanted(record: ExtensionRecord): boolean {
    return (
      ['enabled', 'compiled', 'active'].includes(record.status) &&
      mayRunExtensionCode(record, configManager.get('extensions')) &&
      (!this.options.recordOf || this.options.recordOf(record.id) === record)
    );
  }

  /**
   * Give the lifecycle the live capability registry, so running extensions'
   * tools reach agents (DOR-2685). Boot starts extensions before the registry
   * is composed, so every instance already running hands its tools over now;
   * every instance started later hands them over as it starts.
   *
   * @param registry - The composed capability registry.
   */
  attachCapabilityRegistry(registry: CapabilityRegistry): void {
    this.capabilityRegistry = registry;
    for (const active of this.serverExtensions.values()) {
      active.agentTools?.contribute(registry);
    }
  }

  /**
   * Where each tool an extension declares stands right now, for
   * `GET /api/extensions` (DOR-2685). Read from discovery's decision and the
   * running instance, never stored on the record: records are rebuilt on every
   * scan while the instance keeps running.
   *
   * @param record - The extension's discovery record.
   * @returns One status per declared tool, or `undefined` when it declares none.
   */
  toolStatuses(record: ExtensionRecord): ExtensionToolStatus[] | undefined {
    const checks = record.toolChecks;
    if (!checks || checks.length === 0) return undefined;
    const running = this.serverExtensions.get(record.id)?.agentTools;
    return checks.map((check) => {
      const base = { name: check.name, title: check.title, tier: check.tier };
      if (!check.ok) {
        return { ...base, status: 'refused' as const, reason: check.reason ?? 'DorkOS refused it' };
      }
      const live = running?.statusOf(check.name);
      if (!live) return { ...base, status: 'inactive' as const };
      return { ...base, status: live.status, ...(live.reason ? { reason: live.reason } : {}) };
    });
  }

  /**
   * Initialize a server-side extension: compile, load, and register routes.
   *
   * ## The one place server-side extension code starts running
   *
   * Every route, tool, and internal flow that can make DorkOS execute an
   * extension's `server.ts` arrives here — startup (`ExtensionManager.initialize`),
   * `enable` (reached by `POST /api/extensions/:id/enable`, a marketplace install
   * via `install-plugin.ts`, and a Shape apply via `apply-shape.ts`),
   * `initializeServer` (`POST /api/extensions/:id/init-server`), and
   * `reloadExtension` (the `reload_extensions --id` tool). That is why the approval
   * gate below sits HERE rather than on each caller: the surfaces outnumber the
   * brief for this work by more than two to one, and a check on the tool would have
   * left every route walking around it — the DOR-467 shape. A new caller inherits
   * the gate by construction instead of having to remember it.
   *
   * ## Idempotent: asking twice is not asking for a restart
   *
   * An extension that is already running, built from the same source
   * ({@link buildSourceKey}), is left alone. The client POSTs
   * `/api/extensions/:id/init-server` for every server-side extension on every
   * page load and every tab, so the unconditional shutdown this used to start
   * with restarted the marketplace extension seconds after boot and again on
   * every tab — cancelling its scheduled work and re-evaluating its module for
   * no reason (DOR-1336).
   *
   * A caller that means "restart this, unchanged or not" calls {@link shutdown}
   * first, which is exactly what {@link ExtensionManager.reloadExtension} — the
   * `reload_extensions --id` tool — already does.
   *
   * Compilation now happens BEFORE the teardown, since its hash is what decides
   * whether to tear anything down. A compile failure therefore leaves the
   * running instance serving its old code rather than killing it, which is the
   * better of the two: a typo saved into an extension's `server.ts` no longer
   * takes the working version down with it. The record's `serverError` records
   * that, so "the old version is still serving" is something the cockpit shows
   * rather than something it hides — while `status` stays as it was, leaving the
   * extension's own client bundle loadable.
   *
   * @param id - Extension identifier
   * @param record - The extension's discovery record
   * @returns Result with ok flag and optional error message
   */
  initialize(id: string, record: ExtensionRecord): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(id, () => this.start(id, record));
  }

  /** The body of {@link initialize}, run inside the id's queue. */
  private async start(
    id: string,
    record: ExtensionRecord
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.registrationCustody.permits(id))
      return {
        ok: false,
        error: 'Extension server cleanup is unverified. Restart DorkOS before trying again.',
      };
    const active = this.serverExtensions.get(id);
    const hasServerCapability = record.hasServerEntry || record.hasDataProxy;
    if (!hasServerCapability || !['enabled', 'compiled', 'active'].includes(record.status)) {
      return { ok: false, error: 'Extension has no server entry or is not enabled' };
    }

    // A person approves an extension once before its code may run in this process
    // (DOR-516). Checked before compiling and before any mount, and it covers the
    // `dataProxy`-only branch below as well as the `require()` of a server entry:
    // a proxy hands extension-authored config the server's outbound reach and its
    // stored secrets, which is the same consent question one step quieter.
    if (!mayRunExtensionCode(record, configManager.get('extensions'))) {
      logger.warn(
        `[Extensions] Server init refused for ${id}: waiting for a person to approve it ` +
          `(${EXTENSION_NOT_APPROVED_CODE})`
      );
      return { ok: false, error: describeExtensionLoadRefusal(id) };
    }

    // Proxy-only (dataProxy without server.ts) — no compilation needed
    if (record.hasDataProxy && !record.hasServerEntry) {
      const sourceKey = buildSourceKey(record, null);
      if (active?.sourceKey === sourceKey) {
        logger.debug(`[Extensions] Proxy router for ${id} is already running, unchanged`);
        return { ok: true };
      }

      await this.stop(id);
      const proxyRouter = createProxyRouter(id, record.manifest.dataProxy!, this.dorkHome);
      this.serverExtensions.set(id, {
        extensionId: id,
        router: proxyRouter,
        cleanup: null,
        scheduledCleanups: [],
        sourceKey,
      });
      logger.info(`[Extensions] Proxy router mounted for ${id}`);
      return { ok: true };
    }

    // Compile server bundle
    const compiled = await this.compiler.compileServer(record);
    if ('error' in compiled) {
      // The compile now happens before the teardown, so a broken `server.ts`
      // leaves the previous version answering requests. Say so on the record —
      // an extension quietly serving code that no longer matches its source must
      // not read as healthy in the cockpit (DOR-1336 review). Nothing is marked
      // when there was nothing running: that failure is the caller's to report,
      // and the client bundle it may still have is not in question.
      //
      // `serverError`, NOT `status`/`error`: `status` is one field for the whole
      // extension and it is what `ExtensionManager.readBundle` and the client
      // loader gate the CLIENT bundle on, so writing `compile_error` here would
      // pull a working UI off the screen in every new tab over a server-side
      // failure (DOR-1336 review round 2).
      if (active) {
        record.serverError = toRecordError(compiled.error);
        logger.warn(
          `[Extensions] ${id} failed to compile, so the version already running keeps serving ` +
            `until this is fixed: ${compiled.error.message}`
        );
      }
      return { ok: false, error: compiled.error.message };
    }

    // Compiling waited; a turn-off or revoke meanwhile wins.
    if (!this.stillWanted(record)) {
      return { ok: false, error: 'Extension was turned off while it was starting' };
    }

    const sourceKey = buildSourceKey(record, compiled.sourceHash);
    if (active?.sourceKey === sourceKey) {
      logger.debug(`[Extensions] Server for ${id} is already running, unchanged`);
      return { ok: true };
    }

    // An isolated extension that stopped on its own waits for its restart,
    // or, after too many, for a person: the client asks every page load to
    // start every server half, and that must not undo either. New code or a
    // new manifest is a fresh start; so is a reload, enable or approval
    // (`resetRestarts`).
    if (runsSeparately(record) && !active) {
      const name = record.manifest.name;
      if (this.restartTimers.has(id)) {
        return { ok: false, error: `Restarting ${name}…` };
      }
      if (this.gaveUp.get(id) === sourceKey) {
        return { ok: false, error: this.supervised.get(id)?.serverError?.message ?? 'Stopped' };
      }
    }

    // Shut down the stale instance before its replacement takes over
    await this.stop(id);

    // Write temp file for require()
    const tempDir = path.join(this.dorkHome, 'cache', 'extensions', 'server', '_run');
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${id}.js`);
    await fs.writeFile(tempFile, compiled.code, 'utf-8');

    if (runsSeparately(record)) return this.startIsolated(id, record, tempFile, sourceKey);

    try {
      delete require.cache[require.resolve(tempFile)];
    } catch {
      // Not in cache yet
    }

    if (!this.stillWanted(record))
      return { ok: false, error: 'Extension was turned off while it was starting' };
    const occurrence = this.registrationCustody.begin(id);
    let registrarEntered = false;
    let registrarSettled = false;
    let disposeContext: (() => void) | undefined;
    let originalCleanup: (() => void) | undefined;
    let published: ActiveServerExtension | undefined;
    let closeTools: (() => void) | undefined;
    try {
      const mod = require(tempFile);
      const registerFn = mod.default ?? mod;
      if (typeof registerFn !== 'function') {
        return { ok: false, error: 'Server entry does not export a register function' };
      }

      const router = Router();
      // Starting again lifts the stop on its messages (DOR-2683).
      getAgentSendService()?.extensionStarted(id);
      const toolChecks = checkDeclaredTools(record.manifest);
      const { ctx, getScheduledCleanups, releaseListeners, dispose, tools } =
        createDataProviderContext({
          extensionId: id,
          // A copy that runs by origin runs from its verified snapshot, so what
          // it reaches relative to itself at runtime is the snapshot's too.
          extensionDir: record.runPath ?? record.path,
          dorkHome: this.dorkHome,
          extensionName: record.manifest.name,
          toolChecks,
          registrationRecovery: 'restart-app',
          ownOriginal: (enter) => occurrence.runOriginal(enter),
          requireCurrent: () => {
            if (!this.stillWanted(record))
              throw new Error('Extension server registration was replaced.');
            occurrence.requireCurrent();
          },
        });
      // A register() that throws after adding an account listener or advisor
      // must not leave it behind: this instance never becomes active.
      disposeContext = dispose;
      closeTools = () => tools.close();

      registrarEntered = true;
      const outcome = await settleWithin(
        Promise.resolve(registerFn(router, ctx)),
        this.registerTimeoutMs
      );
      if (outcome.timedOut) {
        // It may still finish later. Whatever it hands back then is cleaned up
        // and never mounted: this instance is not active.
        occurrence.unknown();
        void outcome.late
          .then(
            (late) => {
              if (typeof late === 'function') return occurrence.late(late as () => void);
            },
            (value: unknown) => occurrence.fail(value)
          )
          .catch(() => undefined);
        // Cancel what it scheduled, release what it registered, and make
        // anything it still tries later a no-op. Missing registrar return remains
        // UNKNOWN: later reloads cannot start another copy beside this one.
        await occurrence.retire([dispose]);
        const seconds = Math.round(this.registerTimeoutMs / 1000);
        const message = `${record.manifest.name} took too long to start. Restart the DorkOS app before trying again.`;
        record.serverError = { code: REGISTER_TIMEOUT_ERROR, message };
        logger.warn(`[Extensions] Server init timed out for ${id} after ${seconds}s`);
        return { ok: false, error: message };
      }
      registrarSettled = true;
      const result = outcome.value;
      const cleanup = typeof result === 'function' ? result : null;
      originalCleanup = cleanup ?? undefined;

      // register() finished: no more handlers. Only an instance that started
      // has tools, and only the declared tools it handled (DOR-2685).
      const agentTools = sealAgentTools(id, record.manifest.name, toolChecks, tools);

      // Mount proxy routes alongside custom routes for hybrid extensions
      if (record.hasDataProxy && record.manifest.dataProxy) {
        const proxyRouter = createProxyRouter(id, record.manifest.dataProxy, this.dorkHome);
        router.use(proxyRouter);
      }

      // Asked again now that register() has run: a turn-off or revoke that
      // arrived meanwhile wins, and this instance is released, not stored.
      if (!this.stillWanted(record)) {
        await occurrence.retire([dispose, ...(cleanup ? [cleanup] : [])]);
        // Started (above) lifted the stop on its messages; nothing runs now.
        getAgentSendService()?.extensionStopped(id);
        logger.info(`[Extensions] ${id} was turned off or stopped while starting; left off`);
        return { ok: false, error: 'Extension was turned off while it was starting' };
      }
      // One instance per id, ever: anything still stored is stopped before
      // this one takes its place.
      await this.stop(id);

      const instance: ActiveServerExtension = {
        extensionId: id,
        router,
        cleanup,
        scheduledCleanups: getScheduledCleanups(),
        releaseListeners,
        sourceKey,
        agentTools,
        disposeCtx: dispose,
      };
      this.registrations.set(instance, occurrence);
      this.serverExtensions.set(id, instance);
      published = instance;

      // Only now, with the instance active, can agents reach its tools. A
      // refusal leaves the extension running without them and says why on
      // each tool, never on `status`/`serverError` (DOR-1336: a server-side
      // problem must not pull a working client UI).
      if (this.capabilityRegistry) agentTools.contribute(this.capabilityRegistry);

      // Its inbox decisions show again, escalate again, and a deadline that
      // passed while it was down fires now that it can answer (spec
      // `flow-multiproject` §7.1).
      getExtensionInbox()?.markRunning(id, record.manifest.name);

      // A fixed `server.ts` took over, so the failure mark this method wrote
      // above no longer describes anything.
      record.serverError = undefined;

      logger.info(`[Extensions] Server initialized for ${id}`);
      return { ok: true };
    } catch (err) {
      // Reserve the original failure before cleanup; falsy causes are not absence.
      occurrence.fail(err);
      if (registrarEntered && !registrarSettled) occurrence.unknown();
      if (published) {
        // A publication callback can throw; retire the exact instance, not a successor.
        try {
          await this.stop(id);
        } catch {
          /* The bank retains the original failure. */
        }
      } else {
        try {
          await occurrence.retire([
            ...(disposeContext ? [disposeContext] : closeTools ? [closeTools] : []),
            ...(originalCleanup ? [originalCleanup] : []),
          ]);
        } catch {
          /* The original registrar failure remains primary. */
        }
      }
      logger.error(`[Extensions] Server init failed for ${id}:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Shut down a server-side extension: take its agent tools away, cancel
   * tasks, call cleanup, remove its account listeners and advisor, remove
   * router.
   *
   * Someone asked for this stop (turned it off, removed, reloaded or moved
   * it to another copy), so an isolated extension's crash history goes with
   * it: what runs next under this id starts fresh, and a card is never left
   * saying it stopped 3 times.
   *
   * @param id - Extension identifier
   */
  shutdown(id: string): Promise<void> {
    return this.exclusive(id, async () => {
      await this.stop(id);
      this.resetRestarts(id);
    });
  }

  /** The body of {@link shutdown}, run inside the id's queue. */
  private async stop(id: string): Promise<void> {
    const active = this.serverExtensions.get(id);
    if (!active) {
      this.cancelRestart(id);
      this.registrationCustody.requireReleased(id);
      return;
    }

    const occurrence = this.registrations.get(active);
    if (occurrence) {
      // Unpublish exact authority before callbacks; the bank survives removal.
      if (this.serverExtensions.get(id) === active) this.serverExtensions.delete(id);
      this.cancelRestart(id);
      await occurrence.retire([
        () => active.agentTools?.stop(),
        () => getExtensionInbox()?.markStopped(id),
        () => getAgentSendService()?.extensionStopped(id),
        ...active.scheduledCleanups,
        ...(active.cleanup ? [() => active.cleanup?.()] : []),
        ...(active.releaseListeners ? [() => active.releaseListeners?.()] : []),
        ...(active.closeTools ? [() => active.closeTools?.()] : []),
        ...(active.disposeCtx ? [() => active.disposeCtx?.()] : []),
      ]);
      logger.info(`[Extensions] Server shutdown for ${id}`);
      return;
    }

    // Its tools go FIRST, before anything else of it is torn down: no agent
    // can start a new call, a call that found a tool a moment ago is refused
    // before its handler runs, and every call still running is aborted with
    // its result thrown away (DOR-2685).
    active.agentTools?.stop();

    // Nobody can answer its decisions while it is down: hide them and stop
    // their clocks before its handler goes away.
    getExtensionInbox()?.markStopped(id);
    // Nor can it be told what became of a message still waiting for room:
    // fail those now, so nothing it sent goes out after it is gone (DOR-2683).
    getAgentSendService()?.extensionStopped(id);

    for (const cancel of active.scheduledCleanups) {
      try {
        cancel();
      } catch {
        /* swallow cancellation errors */
      }
    }

    if (active.cleanup) {
      try {
        active.cleanup();
      } catch (err) {
        logger.warn(`[Extensions] Cleanup error for ${id}:`, err);
      }
    }

    // An isolated extension's cleanup runs in its own process: ask it to
    // stop and wait until it has (3 s, then it is killed), so an async
    // cleanup still reaches ctx before its listeners go. Only its own child
    // is ever signalled — never anything by name, never an agent's process.
    if (active.isolated) await active.isolated.stop();

    // After the extension's own cleanup, so it can still unregister gracefully;
    // whatever it left behind goes now.
    active.releaseListeners?.();
    active.closeTools?.();
    active.disposeCtx?.();

    // A pending restart is cancelled by any stop: turning it off, an
    // uninstall or a reload must not be undone a few seconds later.
    this.cancelRestart(id);

    if (this.serverExtensions.get(id) === active) this.serverExtensions.delete(id);
    logger.info(`[Extensions] Server shutdown for ${id}`);
  }

  /**
   * Start an isolated extension's server half in its own process (DOR-2686,
   * spec §9): the real ctx is built here exactly as in-process, the child
   * gets a proxy to it, and DorkOS mounts a router that forwards to the
   * child. The child's self-check runs first; an extension that cannot
   * confirm its limits does not run at all (no in-process fallback).
   *
   * @param id - The extension id.
   * @param record - Its discovery record.
   * @param bundlePath - The compiled server bundle.
   * @param sourceKey - What this instance is built from.
   */
  private async startIsolated(
    id: string,
    record: ExtensionRecord,
    bundlePath: string,
    sourceKey: string
  ): Promise<{ ok: boolean; error?: string }> {
    const name = record.manifest.name;
    const isolation = record.isolation;
    if (!isolation) {
      // Discovery always fills this for a subprocess manifest; a record
      // without it is refused, never run inside DorkOS instead.
      const message = extensionServerErrorCopy('isolation_unavailable', name)!;
      record.serverError = { code: 'isolation_unavailable', message };
      return { ok: false, error: message };
    }

    // New code or a new manifest is a fresh start, however it arrived (an
    // update, a rescan, a page load after an edit): its crash count is for
    // this source only.
    if (this.policySources.get(id) !== sourceKey) {
      this.restartPolicies.get(id)?.reset();
      this.policySources.set(id, sourceKey);
    }

    // Starting again lifts the stop on its messages (DOR-2683).
    getAgentSendService()?.extensionStarted(id);
    const toolChecks = checkDeclaredTools(record.manifest);
    const built = createDataProviderContext({
      extensionId: id,
      extensionDir: record.runPath ?? record.path,
      dorkHome: this.dorkHome,
      extensionName: name,
      toolChecks,
    });
    const release = (): void => {
      built.tools.close();
      built.dispose();
      getAgentSendService()?.extensionStopped(id);
    };

    let host: IsolatedExtensionHost;
    let result: Awaited<ReturnType<IsolatedExtensionHost['start']>>;
    try {
      const started = new IsolatedExtensionHost({
        extensionId: id,
        displayName: name,
        bundlePath,
        extensionDir: record.runPath ?? record.path,
        dorkHome: this.dorkHome,
        isolation,
        dorkosPort: this.options.dorkosPort ?? env.DORKOS_PORT,
        bootstrapPath: await resolveChildEntry(this.dorkHome),
        logger: {
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
        },
        ctx: built.ctx,
        projectRoots: async () => (await built.ctx.projects.list()).map((p) => p.root),
        timings: { loadTimeoutMs: this.registerTimeoutMs, ...this.options.isolatedTimings },
        tools: toolChecks,
        // Its tools leave the registry before anything else of the dead
        // child is released, so a call still running fails as stopped.
        onGone: () => {
          const active = this.serverExtensions.get(id);
          if (active?.isolated === started) active.agentTools?.stop();
        },
        onExit: (exit) => this.onIsolatedExit(id, started, sourceKey, exit),
      });
      host = started;
      result = await started.start();
    } catch (err) {
      release();
      const message = `${name} couldn't start: ${err instanceof Error ? err.message : String(err)}`;
      record.serverError = { code: 'server_start_failed', message };
      logger.error(`[Extensions] Isolated start failed for ${id}:`, err);
      return { ok: false, error: message };
    }

    if (!result.ok) {
      release();
      // The host's load timer is the register timer here, so a slow start
      // carries the same code and words as in-process.
      record.serverError = { code: result.code, message: result.message };
      logger.warn(
        `[Extensions] Isolated start refused for ${id}: ${result.code}: ${result.message}`
      );
      return { ok: false, error: record.serverError.message };
    }

    // Starting waited; a turn-off or revoke meanwhile wins.
    if (!this.stillWanted(record)) {
      await host.stop();
      release();
      logger.info(`[Extensions] ${id} was turned off or stopped while starting; left off`);
      return { ok: false, error: 'Extension was turned off while it was starting' };
    }
    // One instance per id, ever.
    await this.stop(id);

    // register() finished in the child (`registered`), and every tool it
    // bound was bound through the real ctx.tools.handle on the way: seal the
    // host's binding exactly as after an in-process register() (spec §8).
    const agentTools = sealAgentTools(id, name, toolChecks, built.tools);
    const proxyRouter =
      record.hasDataProxy && record.manifest.dataProxy
        ? createProxyRouter(id, record.manifest.dataProxy, this.dorkHome)
        : null;
    this.serverExtensions.set(id, {
      extensionId: id,
      router: createIsolatedRouter({ displayName: name, host, proxyRouter }),
      cleanup: null,
      scheduledCleanups: [],
      releaseListeners: built.releaseListeners,
      closeTools: () => built.tools.close(),
      disposeCtx: built.dispose,
      sourceKey,
      agentTools,
      isolated: host,
    });
    // It may have died in the moment between starting and being stored, when
    // nothing could hear it: treat that exactly like any other crash.
    if (!host.running) {
      this.onIsolatedExit(id, host, sourceKey, {
        reason: 'server_crashed',
        code: null,
        signal: null,
      });
      return { ok: false, error: `${name} stopped while starting.` };
    }

    // Only now, with the instance active, can agents reach its tools, as
    // in-process. Every call goes through the registry's gate here, in
    // DorkOS, before anything reaches the child.
    if (this.capabilityRegistry) agentTools.contribute(this.capabilityRegistry);

    getExtensionInbox()?.markRunning(id, name);
    record.serverError = undefined;
    this.supervised.delete(id);
    this.gaveUp.delete(id);
    logger.info(`[Extensions] Isolated server started for ${id} (pid ${host.pid ?? '?'})`);
    return { ok: true };
  }

  /**
   * An isolated extension's process ended. A stop DorkOS asked for is
   * handled by {@link stop}; anything else runs the same bookkeeping here,
   * at once, then restarts it on the backoff or, after too many, leaves it
   * stopped with the reason on its card.
   *
   * The bookkeeping matters most for what the dead child had already asked
   * for: an `agent.send` waiting for room is still running in the real ctx,
   * and only `extensionStopped` keeps it from going out (DOR-2683).
   *
   * Only the extension's own child ended; nothing here touches any other
   * process, an agent's least of all.
   *
   * @param id - The extension id.
   * @param host - The host whose child ended.
   * @param sourceKey - What that instance was built from.
   * @param exit - How it ended.
   */
  private onIsolatedExit(
    id: string,
    host: IsolatedExtensionHost,
    sourceKey: string,
    exit: IsolatedExit
  ): void {
    if (exit.reason === 'stopped') return;
    const active = this.serverExtensions.get(id);
    if (!active || active.isolated !== host) return;

    active.agentTools?.stop();
    getExtensionInbox()?.markStopped(id);
    getAgentSendService()?.extensionStopped(id);
    active.releaseListeners?.();
    active.closeTools?.();
    // Whatever the dead child still had running in the real ctx acts no more.
    active.disposeCtx?.();
    this.serverExtensions.delete(id);

    const record = this.options.recordOf?.(id);
    const name = record?.manifest.name ?? id;
    logger.warn(
      `[Extensions] ${id} stopped on its own (${exit.reason}, code ${exit.code}, signal ${exit.signal})`
    );

    let policy = this.restartPolicies.get(id);
    if (!policy) {
      policy = new RestartPolicy(this.options.restartPolicy);
      this.restartPolicies.set(id, policy);
    }
    const decision = policy.onUnexpectedExit();
    if ('giveUp' in decision) {
      const message = extensionServerErrorCopy(exit.reason, name)!;
      this.supervised.set(id, { serverError: { code: exit.reason, message } });
      this.gaveUp.set(id, sourceKey);
      logger.warn(`[Extensions] ${id} stopped too often; left off until it is reloaded`);
    } else {
      this.supervised.set(id, {
        restartingAt: new Date(Date.now() + decision.restartIn).toISOString(),
      });
      const timer = setTimeout(() => {
        this.restartTimers.delete(id);
        void this.restartAfterExit(id);
      }, decision.restartIn);
      timer.unref();
      this.restartTimers.set(id, timer);
    }
    this.options.onStatusChange?.(id);
  }

  /** The restart a backoff timer fires: a fresh process, `register()` again. */
  private async restartAfterExit(id: string): Promise<void> {
    const record = this.options.recordOf?.(id);
    this.supervised.delete(id);
    if (record) {
      const result = await this.initialize(id, record);
      if (!result.ok) logger.warn(`[Extensions] Restart of ${id} failed: ${result.error}`);
    }
    this.options.onStatusChange?.(id);
  }

  /** Cancel a pending restart, if any. */
  private cancelRestart(id: string): void {
    const timer = this.restartTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.restartTimers.delete(id);
    if (this.supervised.get(id)?.restartingAt) this.supervised.delete(id);
  }

  /**
   * Forget an isolated extension's crashes: a person reloaded, enabled or
   * approved it (a dev-link save reloads it too), so it gets a fresh crash
   * budget and the stop after too many crashes is lifted (spec §9).
   *
   * @param id - The extension id.
   */
  resetRestarts(id: string): void {
    this.restartPolicies.get(id)?.reset();
    this.cancelRestart(id);
    this.gaveUp.delete(id);
    this.supervised.delete(id);
  }

  /**
   * What an isolated extension's card says between starts (a pending
   * restart, or the stop after too many crashes), laid over its record by
   * `ExtensionManager`. Empty for everything else.
   *
   * @param id - The extension id.
   */
  supervisedStatus(id: string): SupervisedServerStatus {
    return this.supervised.get(id) ?? {};
  }

  /**
   * The running isolated extension's process id, for diagnostics and tests.
   * Never used to signal anything.
   *
   * @param id - The extension id.
   */
  isolatedPid(id: string): number | undefined {
    return this.serverExtensions.get(id)?.isolated?.pid;
  }

  /**
   * Get the Express router for a server-side extension.
   *
   * @param id - Extension identifier
   * @returns The extension's router, or null if no server extension is active
   */
  getRouter(id: string): Router | null {
    return this.serverExtensions.get(id)?.router ?? null;
  }
}

/**
 * Wait for `promise`, but no longer than `ms`.
 *
 * @param promise - What to wait for.
 * @param ms - The longest to wait.
 * @returns Its value, or that it did not settle in time (with the promise, so
 *   the caller can clean up whatever it resolves to later).
 */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ timedOut: false; value: T } | { timedOut: true; late: Promise<T> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    const first = await Promise.race([promise.then((value) => ({ value })), timeout]);
    if (first === 'timeout') return { timedOut: true, late: promise };
    return { timedOut: false, value: first.value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether an extension's server half runs in its own process: its manifest
 * asks for it, or discovery says so. Either one is enough, so a record
 * missing its isolation view is refused rather than run inside DorkOS.
 *
 * @param record - The extension's discovery record.
 */
function runsSeparately(record: ExtensionRecord): boolean {
  return record.manifest.serverCapabilities?.runtime === 'subprocess' || !!record.isolation;
}

/**
 * Close an instance's tool binding once its `register()` finished, and hold
 * what it handled for contribution: only the declared tools it handled
 * (DOR-2685). A declared tool with no handler is reported, not offered. The
 * same for both runtimes: an isolated extension's tools were bound through
 * the same real `ctx.tools.handle` by the host's dispatcher.
 *
 * @param id - The extension id.
 * @param name - Its manifest name.
 * @param toolChecks - Discovery's verdict on each declared tool.
 * @param tools - The instance's binding, from `createDataProviderContext`.
 */
function sealAgentTools(
  id: string,
  name: string,
  toolChecks: ReturnType<typeof checkDeclaredTools>,
  tools: ToolBinding
): RunningExtensionTools {
  const { handled, unhandled } = tools.seal();
  const agentTools = new RunningExtensionTools(id, name, handled, [
    ...toolChecks.flatMap((check) =>
      check.ok ? [] : [{ name: check.name, reason: check.reason }]
    ),
    ...unhandled.map((tool) => ({
      name: tool.name,
      reason: `${name} declares ${tool.name} but never handles it`,
    })),
  ]);
  if (unhandled.length > 0) {
    logger.warn(
      `[Extensions] ${id} declares tools it never handles, so agents won't get them: ` +
        unhandled.map((tool) => tool.name).join(', ')
    );
  }
  return agentTools;
}
