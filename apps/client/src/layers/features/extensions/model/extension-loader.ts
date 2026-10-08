import type { ExtensionRecordPublic, ExtensionModule } from '@dorkos/extension-api';
import {
  createOwnedRegistrationDeps,
  registerManifestConfigTab,
} from './extension-registration-owner';
import { createExtensionAPI } from './extension-api-factory';
import type { ExtensionAPIDeps, LoadedExtension } from './types';
import { extensionApiUrl } from './extension-api-url';
import { getExtensionLoadAdmission, type ExtensionLoadAdmission } from '@/layers/shared/lib';
import { runningCopiesOnly } from '@/layers/entities/extension';

/**
 * Fetch the extension list from the server, rejecting on an HTTP error status.
 *
 * Used by {@link ExtensionLoader.reloadAll}, whose fetch-then-swap contract
 * needs a failed fetch to be distinguishable from a genuinely empty extension
 * set — an empty array must mean "this cwd has no extensions", never "the
 * request failed".
 */
async function fetchExtensionsOrThrow(current: () => boolean): Promise<ExtensionRecordPublic[]> {
  const url = extensionApiUrl('/extensions');
  const method = globalThis.fetch;
  if (!current()) throw new Error('Extension load was superseded.');
  const res = await Reflect.apply(method, globalThis, [url]);
  if (!res.ok) {
    throw new Error(`Failed to fetch extension list: ${res.status}`);
  }
  return runningCopiesOnly((await res.json()) as ExtensionRecordPublic[]);
}

/**
 * Dynamically import a compiled extension bundle from the server.
 *
 * Returns `null` on import failure so the caller can skip and report the error.
 */
async function importBundle(
  rec: ExtensionRecordPublic,
  current: () => boolean
): Promise<ExtensionModule | null> {
  const id = rec.id;
  if (!rec.bundleGeneration || !/^[a-f0-9]{64}$/.test(rec.bundleGeneration)) return null;
  try {
    const url = extensionApiUrl(`/extensions/${id}/bundle?generation=${rec.bundleGeneration}`);
    if (!current()) return null;
    return (await import(/* @vite-ignore */ url)) as ExtensionModule;
  } catch (err) {
    console.error(`[extensions] Failed to import ${id}:`, err);
    return null;
  }
}

/**
 * Signal the server to initialize the server-side component of an extension.
 *
 * This is a fire-and-forget coordination signal for dynamic enable/reload
 * scenarios. Failures are logged but never block client-side activation.
 */
async function initServerExtension(
  rec: ExtensionRecordPublic,
  current: () => boolean
): Promise<void> {
  if (!rec.hasServerEntry && !rec.hasDataProxy) return;

  try {
    const url = extensionApiUrl(`/extensions/${rec.id}/init-server`);
    const request: RequestInit = { method: 'POST' };
    const method = globalThis.fetch;
    if (!current()) return;
    const res = await Reflect.apply(method, globalThis, [url, request]);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Unknown error' }));
      console.warn(
        `[extensions] Server init failed for ${rec.id}:`,
        (body as { error?: string }).error ?? res.statusText
      );
    }
  } catch (err) {
    console.error(`[extensions] Server init error for ${rec.id}:`, err);
  }
}

interface ActivationOwner {
  cleanups: Array<() => void>;
  attempted: Set<() => void>;
  retired: boolean;
  published: boolean;
  deactivate?: () => void;
  deactivateAttempted: boolean;
}
export interface ExtensionLoadOutcome {
  status: 'completed' | 'partial' | 'failed' | 'stale';
  failures: ReadonlyArray<{ id: string; stage: 'import' | 'activation' | 'load' }>;
  extensions: ExtensionRecordPublic[];
  loaded: Map<string, LoadedExtension>;
}
/** Exact loader + admission owner. It cannot resume a retired instance. */
export class ExtensionLoader {
  private loaded = new Map<string, LoadedExtension>();
  private owners = new Set<ActivationOwner>();
  private disposed = false;
  private retirementFailed = false;
  private generation = 0;
  private outcomes = new WeakMap<ExtensionLoadOutcome, { generation: number; current: boolean }>();
  private readonly admission: ExtensionLoadAdmission;
  constructor(
    private readonly deps: ExtensionAPIDeps,
    admission: ExtensionLoadAdmission = getExtensionLoadAdmission(),
    private readonly onRetirementFailure: () => void = () => {}
  ) {
    this.admission = admission;
  }
  /** Callback-free local fields follow the shared exact admission observation. */
  private current(gen: number): boolean {
    const snapshot = getExtensionLoadAdmission();
    return (
      snapshot === this.admission &&
      !snapshot.suspended &&
      !snapshot.retirementFailed &&
      !this.disposed &&
      !this.retirementFailed &&
      gen === this.generation
    );
  }
  private requireCurrent(gen: number): void {
    if (!this.current(gen)) throw new Error('Extension load was superseded.');
  }
  private result(
    gen: number,
    extensions: ExtensionRecordPublic[],
    detail: {
      completed?: boolean;
      failed?: boolean;
      failures?: ExtensionLoadOutcome['failures'];
    } = {}
  ): ExtensionLoadOutcome {
    const { completed = false, failed = false, failures = [] } = detail;
    const current = this.current(gen);
    const authentic = current && (completed || failed);
    let status: ExtensionLoadOutcome['status'] = 'stale';
    if (authentic) {
      status = 'completed';
      if (failures.length || failed) status = this.loaded.size ? 'partial' : 'failed';
    }
    const value: ExtensionLoadOutcome = Object.freeze({
      status,
      extensions: authentic ? extensions : [],
      loaded: authentic ? new Map(this.loaded) : new Map<string, LoadedExtension>(),
      failures: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
    });
    this.outcomes.set(value, { generation: gen, current: authentic });
    return value;
  }
  /** Only a genuine current completed, partial or failed result of this current load may reach provider state. */
  isOutcomeCurrent(value: ExtensionLoadOutcome): boolean {
    const record = this.outcomes.get(value);
    return !!record?.current && this.current(record.generation);
  }
  /** Permanently refuse initiation and drain all registered obligations, including late ones. */
  deactivateAll(): boolean {
    this.disposed = true;
    ++this.generation;
    this.teardownLoaded();
    return !this.retirementFailed;
  }
  private failRetirement(): void {
    if (this.retirementFailed) return;
    this.retirementFailed = true;
    try {
      this.onRetirementFailure();
    } catch {
      /* Remains permanently failed. */
    }
  }
  private attemptCleanup(callback: () => void): void {
    try {
      const result: unknown = callback();
      if (result && (typeof result === 'object' || typeof result === 'function')) {
        const then = Reflect.get(result, 'then');
        if (typeof then === 'function') {
          // The declared synchronous cleanup contract cannot certify this pending work.
          this.failRetirement();
          void Promise.resolve(result).catch(() => {});
        }
      }
    } catch {
      this.failRetirement();
    }
  }
  private drain(owner: ActivationOwner): void {
    owner.retired = true;
    if (owner.deactivate && !owner.deactivateAttempted) {
      owner.deactivateAttempted = true;
      this.attemptCleanup(owner.deactivate);
    }
    for (const cleanup of owner.cleanups) {
      if (owner.attempted.has(cleanup)) continue;
      owner.attempted.add(cleanup);
      this.attemptCleanup(cleanup);
    }
    this.owners.delete(owner);
  }
  private teardownLoaded(): void {
    for (const owner of this.owners) this.drain(owner);
    this.loaded.clear();
  }
  private track(owner: ActivationOwner, cleanup: () => void): () => void {
    owner.cleanups.push(cleanup);
    if (owner.retired) this.drain(owner);
    return cleanup;
  }
  private ownerCurrent(gen: number, owner: ActivationOwner): boolean {
    const snapshot = getExtensionLoadAdmission();
    return (
      snapshot === this.admission &&
      !snapshot.suspended &&
      !snapshot.retirementFailed &&
      !this.disposed &&
      !this.retirementFailed &&
      !owner.retired &&
      (owner.published || gen === this.generation)
    );
  }
  private guardedDeps(gen: number, owner: ActivationOwner): ExtensionAPIDeps {
    return createOwnedRegistrationDeps(this.deps, {
      requireCurrent: () => {
        if (!this.ownerCurrent(gen, owner)) {
          this.drain(owner);
          throw new Error('Extension owner retired.');
        }
      },
      isCurrent: () => this.ownerCurrent(gen, owner),
      track: (cleanup) => this.track(owner, cleanup),
    });
  }
  async initialize(): Promise<ExtensionLoadOutcome> {
    if (!this.current(this.generation)) return this.result(this.generation, []);
    const gen = ++this.generation;
    try {
      const extensions = await fetchExtensionsOrThrow(() => this.current(gen));
      if (!this.current(gen)) return this.result(gen, []);
      return await this.activateFrom(extensions, gen);
    } catch (error) {
      console.error('[extensions] Load failed:', error);
      return this.result(gen, [], {
        failed: this.current(gen),
        failures: [{ id: '', stage: 'load' }],
      });
    }
  }
  private async activateFrom(
    extensions: ExtensionRecordPublic[],
    gen: number
  ): Promise<ExtensionLoadOutcome> {
    if (!this.current(gen)) return this.result(gen, []);
    const failures: Array<{ id: string; stage: 'import' | 'activation' | 'load' }> = [];
    const ready = extensions.filter(
      (rec) =>
        ['compiled', 'active'].includes(rec.status) &&
        rec.bundleReady &&
        rec.approvedToRun &&
        typeof rec.bundleGeneration === 'string' &&
        /^[a-f0-9]{64}$/.test(rec.bundleGeneration)
    );
    // Each sibling checks immediately before initiating its own import.
    const bundles = await Promise.all(
      ready.map(async (rec) => {
        if (!this.current(gen)) return { rec, module: null };
        const module = await importBundle(rec, () => this.current(gen));
        return { rec, module: this.current(gen) ? module : null };
      })
    );
    if (!this.current(gen)) return this.result(gen, []);
    const published = await fetchExtensionsOrThrow(() => this.current(gen));
    if (!this.current(gen)) return this.result(gen, []);
    const byId = new Map(published.map((rec) => [rec.id, rec]));
    for (const { rec, module } of bundles) {
      if (!this.current(gen)) return this.result(gen, []);
      const latest = byId.get(rec.id);
      if (!module) {
        failures.push({ id: rec.id, stage: 'import' });
        continue;
      }
      if (
        !latest ||
        !latest.approvedToRun ||
        !latest.bundleReady ||
        !['compiled', 'active'].includes(latest.status) ||
        latest.bundleGeneration !== rec.bundleGeneration
      )
        continue;
      if (!(await this.activateCandidate({ rec, module, gen }, failures)))
        return this.result(gen, []);
    }
    return this.result(gen, extensions, { completed: this.current(gen), failures });
  }
  async reloadAll(): Promise<ExtensionLoadOutcome> {
    if (!this.current(this.generation)) return this.result(this.generation, []);
    const gen = ++this.generation;
    try {
      const extensions = await fetchExtensionsOrThrow(() => this.current(gen));
      if (!this.current(gen)) return this.result(gen, []);
      this.teardownLoaded();
      if (!this.current(gen)) return this.result(gen, []);
      return await this.activateFrom(extensions, gen);
    } catch (error) {
      console.error('[extensions] Load failed:', error);
      return this.result(gen, [], {
        failed: this.current(gen),
        failures: [{ id: '', stage: 'load' }],
      });
    }
  }
  async reloadExtensions(ids: string[]): Promise<ExtensionLoadOutcome> {
    if (!this.current(this.generation)) return this.result(this.generation, []);
    const gen = ++this.generation;
    try {
      // Preserve unaffected registrations. Targeted owners are retired and cannot register anew.
      for (const id of ids) {
        if (!this.current(gen)) return this.result(gen, []);
        const ext = this.loaded.get(id);
        if (!ext) continue;
        for (const owner of this.owners) if (owner.cleanups === ext.cleanups) this.drain(owner);
        this.loaded.delete(id);
      }
      if (!this.current(gen)) return this.result(gen, []);
      const extensions = await fetchExtensionsOrThrow(() => this.current(gen));
      if (!this.current(gen)) return this.result(gen, []);
      const selected = extensions.filter((rec) => ids.includes(rec.id));
      const outcome = await this.activateFrom(selected, gen);
      if (!this.isOutcomeCurrent(outcome)) return this.result(gen, []);
      return this.result(gen, extensions, {
        completed: true,
        failed: outcome.status !== 'completed',
        failures: outcome.failures,
      });
    } catch (error) {
      console.error('[extensions] Load failed:', error);
      return this.result(gen, [], {
        failed: this.current(gen),
        failures: [{ id: '', stage: 'load' }],
      });
    }
  }
  getLoaded(): Map<string, LoadedExtension> {
    return new Map(this.loaded);
  }

  private createOwnedAPI(rec: ExtensionRecordPublic, gen: number, owner: ActivationOwner) {
    const guardedDeps = this.guardedDeps(gen, owner);
    const created = createExtensionAPI(
      rec.id,
      guardedDeps,
      rec.manifest.capabilities?.events ?? [],
      () => {
        if (!this.ownerCurrent(gen, owner)) {
          this.drain(owner);
          throw new Error('Extension owner retired.');
        }
      }
    );
    // Keep factory cleanup list itself: a started API call may append after retirement.
    created.cleanups.push(...owner.cleanups);
    owner.cleanups = created.cleanups;
    const api = created.api;
    return { api, guardedDeps };
  }
  private recordDeactivate(owner: ActivationOwner, deactivate: unknown): void {
    if (typeof deactivate === 'function') owner.deactivate = deactivate as () => void;
    else if (deactivate !== undefined) {
      // The author API is synchronous. Do not await or adopt an unsupported
      // return as successful activation or promise observed cleanup.
      if (
        deactivate !== null &&
        (typeof deactivate === 'object' || typeof deactivate === 'function')
      ) {
        // Unsupported object returns have unknown custody even if then lookup throws.
        this.failRetirement();
        const then = Reflect.get(deactivate, 'then');
        if (typeof then === 'function') {
          this.failRetirement();
          try {
            void Promise.resolve(deactivate).catch(() => {});
          } catch {
            /* Unknown remains sticky. */
          }
        }
      }
      throw new Error('Extension activate must return void or a cleanup function.');
    }
  }
  private async activateCandidate(
    input: { rec: ExtensionRecordPublic; module: ExtensionModule; gen: number },
    failures: Array<{ id: string; stage: 'import' | 'activation' | 'load' }>
  ): Promise<boolean> {
    const { rec, module, gen } = input;
    const owner: ActivationOwner = {
      cleanups: [],
      attempted: new Set(),
      retired: false,
      published: false,
      deactivateAttempted: false,
    };
    this.owners.add(owner); // Before factory/activation callbacks.
    try {
      const { api, guardedDeps } = this.createOwnedAPI(rec, gen, owner);
      const activate = module.activate;
      this.requireCurrent(gen);
      const deactivate: unknown = Reflect.apply(activate, module, [api]);
      this.recordDeactivate(owner, deactivate);
      if (!this.current(gen) || owner.retired) {
        this.drain(owner);
        return false;
      }
      registerManifestConfigTab(rec, owner.cleanups, guardedDeps);
      this.requireCurrent(gen);
      owner.published = true;
      this.loaded.set(rec.id, {
        id: rec.id,
        manifest: rec.manifest,
        module,
        api,
        cleanups: owner.cleanups,
        deactivate: owner.deactivate,
      });
      // Initiate only while still current; the server independently rechecks authority.
      if (!this.current(gen)) return false;
      await initServerExtension(rec, () => this.current(gen));
      if (!this.current(gen)) return false;
    } catch (error) {
      failures.push({ id: rec.id, stage: 'activation' });
      console.error(`[extensions] Activation failed for ${rec.id}:`, error);
      this.loaded.delete(rec.id);
      this.drain(owner);
      if (this.retirementFailed) {
        this.deactivateAll();
        return false;
      }
      if (!this.current(gen)) return false;
    }
    return this.current(gen);
  }
}
