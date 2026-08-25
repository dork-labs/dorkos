/**
 * The memory registry: which backend serves this machine's agents, and the
 * guard that keeps a broken one from ever costing a turn.
 *
 * `MemoryProvider` is the fifth swappable seam (beside `AgentRuntime`,
 * `Transport`, `ConnectorProvider` and `CommunityAdapter`), and this module is
 * the only place that knows more than one implementation could exist. The engine
 * (`@dorkos/memory`) owns the file; the port
 * (`@dorkos/shared/memory-provider`) owns the contract; the `memory.provider`
 * config key owns the choice; this owns what happens when the choice turns out
 * badly.
 *
 * ## Quarantine and fallback, in one paragraph
 *
 * A provider that FAULTS — throws something that is not one of the port's own
 * refusals — is **benched for the rest of the process**, `builtin` takes over
 * the call that faulted and every call after it, and **exactly one** warning is
 * logged for that provider. One, not one per turn: a backend that throws on
 * every read would otherwise write the same line into the log a thousand times
 * and bury whatever else happened that day. The benched provider is never called
 * again, which is the difference between quarantine and a retry loop that
 * swallows its errors.
 *
 * ## What is a fault, and what is not
 *
 * The port declares five refusals — {@link MemoryUnsupportedError},
 * {@link MemoryMatchError}, {@link MemoryCapExceededError},
 * {@link MemoryNoteShapeError} and {@link MemoryIOError} — plus the engine's own
 * {@link MemoryPathError}. **None of them benches anybody.** They are the
 * provider working correctly: refusing a `replace` that names two notes, refusing
 * a write past the cap, saying it cannot search. A registry that benched a
 * provider for refusing a bad edit would bench every healthy backend within a
 * day of shipping, and `MemoryIOError` is on the list for a sharper version of
 * the same reason — a full disk is a fact about the machine, not evidence that
 * this backend is broken, and swapping backends would not fix it.
 *
 * Everything else is a fault: a `TypeError`, a rejected fetch, a provider that
 * throws from `getSnapshot` (which the port says must never throw), a factory
 * that cannot construct. Those say the implementation is not holding its end.
 *
 * ## `builtin` is never benched
 *
 * It is the fallback, so benching it would leave nothing to fall back TO. When
 * the fallback itself fails, memory degrades to **nothing injected** and the turn
 * runs: `getSnapshot` answers with an `'error'` snapshot the injection path
 * already renders as silence, and every other method's refusal reaches the
 * caller that asked for it, which turns it into a plain "nothing was saved".
 * A conversation is never lost over a notes file — that is the whole invariant,
 * and every branch here exists to keep it.
 *
 * @module server/services/memory/registry
 */
import { MemoryPathError, createBuiltinMemoryProvider } from '@dorkos/memory';
import {
  AgentMemoryRefSchema,
  BUILTIN_MEMORY_PROVIDER_ID,
  MemoryCapExceededError,
  MemoryIOError,
  MemoryMatchError,
  MemoryNoteShapeError,
  MemorySnapshotSchema,
  MemoryUnsupportedError,
  type AgentMemoryRef,
  type MemoryHits,
  type MemoryProvider,
  type MemoryProviderInfo,
  type MemoryQuery,
  type MemorySelector,
  type MemorySnapshot,
  type MemoryWriteOp,
  type MemoryWriteResult,
} from '@dorkos/shared/memory-provider';
import { logger } from '../../lib/logger.js';
import { configManager, type ConfigManager } from '../core/config-manager.js';

/** Builds a memory backend. Called at most once per process, on first use. */
export type MemoryProviderFactory = () => MemoryProvider;

/**
 * What `info` reports when nothing usable resolved at all — a benched provider
 * and a `builtin` that could not be built.
 *
 * Both capabilities are off because nothing is there to serve them, which is the
 * honest reading rather than a hopeful one. It is not a registered provider and
 * nothing dispatches to it; it exists so `info` has something true to say
 * instead of throwing on a property read.
 */
export const MEMORY_PROVIDER_UNAVAILABLE_INFO: MemoryProviderInfo = {
  id: 'unavailable',
  capabilities: { search: false, consolidate: false },
};

/** Every registered backend, by the id `memory.provider` names. */
const factories = new Map<string, MemoryProviderFactory>();

/** Instances built so far, so one provider serves every agent on this machine. */
const instances = new Map<string, MemoryProvider>();

/** Providers benched for the rest of this process. Never contains `builtin`. */
const benched = new Set<string>();

/** Warnings already logged, so a repeat failure is silent rather than a flood. */
const warned = new Set<string>();

/** The chosen id, resolved once. The choice is made at boot, not per turn. */
let chosenId: string | null = null;

/**
 * Register a memory backend under the id `memory.provider` names.
 *
 * Registering the same id twice replaces the factory and drops any instance
 * built from the old one — which is what a test swapping a backend between cases
 * needs, and what nothing in production does (registration happens at module
 * load).
 *
 * @param id - The id the config key names, e.g. `'builtin'`.
 * @param factory - Builds the backend. Called at most once per process.
 */
export function registerMemoryProvider(id: string, factory: MemoryProviderFactory): void {
  factories.set(id, factory);
  instances.delete(id);
}

/** Every registered backend id, for a log line or a settings surface. */
export function registeredMemoryProviderIds(): string[] {
  return [...factories.keys()];
}

registerMemoryProvider(BUILTIN_MEMORY_PROVIDER_ID, createBuiltinMemoryProvider);

/**
 * Log one line about one provider, ever.
 *
 * @param key - What is being warned about, e.g. the provider id.
 * @param message - A printf-style line for the server log.
 * @param args - Its arguments.
 */
function warnOnce(key: string, message: string, ...args: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message, ...args);
}

/**
 * Whether an error is the provider working correctly rather than failing.
 *
 * @param err - Whatever a provider threw.
 */
function isContractRefusal(err: unknown): boolean {
  return (
    err instanceof MemoryUnsupportedError ||
    err instanceof MemoryMatchError ||
    err instanceof MemoryCapExceededError ||
    err instanceof MemoryNoteShapeError ||
    err instanceof MemoryIOError ||
    err instanceof MemoryPathError
  );
}

/**
 * Bench a provider for the rest of the process and say so once.
 *
 * @param id - The provider that faulted.
 * @param err - What it threw, for the log.
 */
function bench(id: string, err: unknown): void {
  if (id === BUILTIN_MEMORY_PROVIDER_ID) {
    // The fallback is never benched — there is nothing behind it. Its failures
    // degrade to no memory rather than to another backend, and they are still
    // said once.
    warnOnce(
      `builtin-fault`,
      '[Memory] The builtin memory backend failed (%s). Agents will run without memory until ' +
        'this is fixed; nothing else is affected.',
      String(err)
    );
    return;
  }
  benched.add(id);
  warnOnce(
    id,
    "[Memory] Memory provider '%s' failed (%s). It is benched for the rest of this run and " +
      "'%s' is serving memory instead. Turns are unaffected. This is logged once.",
    id,
    String(err),
    BUILTIN_MEMORY_PROVIDER_ID
  );
}

/**
 * The id this machine is configured to use, read once.
 *
 * Defensive about the config manager itself: this is reached from the injection
 * path, and a server booted without config (or a test that never initialised it)
 * must get `builtin` rather than an exception on the way into a turn.
 */
function configuredId(): string {
  if (chosenId !== null) return chosenId;
  let id: unknown;
  try {
    // `configManager` is a `let` populated at boot, so despite its non-optional
    // type it really is `undefined` for anything that reaches memory before the
    // server has configured itself — including a unit test that never
    // initialised it. Reading through it without the cast throws there.
    id = (configManager as ConfigManager | undefined)?.getDot('memory.provider');
  } catch {
    id = undefined;
  }
  chosenId = typeof id === 'string' && id.length > 0 ? id : BUILTIN_MEMORY_PROVIDER_ID;
  return chosenId;
}

/**
 * Build (or fetch) one provider, or `null` when it cannot be had.
 *
 * A factory that THROWS is a fault like any other — the bench-check itself must
 * not be a way to take a turn down — so it benches and returns `null` rather
 * than propagating.
 *
 * @param id - Which backend to build.
 */
function instanceOf(id: string): MemoryProvider | null {
  const existing = instances.get(id);
  if (existing) return existing;
  const factory = factories.get(id);
  if (!factory) return null;
  try {
    const built = factory();
    instances.set(id, built);
    return built;
  } catch (err) {
    bench(id, err);
    return null;
  }
}

/** The backend to try first: the configured one, unless it is benched or unknown. */
function primary(): MemoryProvider | null {
  const id = configuredId();
  if (id === BUILTIN_MEMORY_PROVIDER_ID) return null;
  if (benched.has(id)) return null;
  if (!factories.has(id)) {
    warnOnce(
      `unknown:${id}`,
      "[Memory] No memory provider is registered as '%s' (registered: %s). Falling back to '%s'. " +
        'This is logged once.',
      id,
      registeredMemoryProviderIds().join(', '),
      BUILTIN_MEMORY_PROVIDER_ID
    );
    return null;
  }
  return instanceOf(id);
}

/** The fallback, or `null` when even it cannot be built. */
function fallback(): MemoryProvider | null {
  return instanceOf(BUILTIN_MEMORY_PROVIDER_ID);
}

/**
 * Run one port call through the configured provider, then the fallback.
 *
 * The shape every method here shares: try the primary, pass its REFUSALS
 * straight through, bench it on a FAULT and retry once on `builtin`. The retry
 * is deliberate rather than a fire-and-forget — a read that faults still has to
 * answer the turn that asked for it, and a write that faults still has to tell
 * the agent whether anything was saved.
 *
 * @param call - The port method, applied to whichever provider is serving.
 * @param whenNothingWorks - What to answer when neither provider can serve.
 */
async function dispatch<T>(
  call: (provider: MemoryProvider) => Promise<T>,
  whenNothingWorks: (err: unknown) => T
): Promise<T> {
  const chosen = primary();
  if (chosen) {
    try {
      return await call(chosen);
    } catch (err) {
      if (isContractRefusal(err)) throw err;
      bench(configuredId(), err);
    }
  }

  const builtin = fallback();
  if (!builtin) {
    return whenNothingWorks(new Error('no memory provider could be built'));
  }
  try {
    return await call(builtin);
  } catch (err) {
    if (isContractRefusal(err)) throw err;
    bench(BUILTIN_MEMORY_PROVIDER_ID, err);
    return whenNothingWorks(err);
  }
}

/** Shape a failure the injection path can render as nothing at all. */
function errorSnapshot(err: unknown): MemorySnapshot {
  return MemorySnapshotSchema.parse({
    status: 'error',
    content: '',
    bytes: 0,
    truncated: false,
    error: err instanceof Error ? err.message : String(err),
  });
}

/** Re-raise, for the methods whose caller needs to know nothing happened. */
function rethrow(err: unknown): never {
  throw err;
}

/**
 * The single facade every caller in this server addresses.
 *
 * It IS a `MemoryProvider`, so nothing at a call site knows a registry exists —
 * which is the point of a seam. Refs are validated here rather than in each
 * branch: a malformed ref is the CALLER's bug, refused identically whichever
 * backend is installed, and benching a provider for it would take a healthy
 * backend out over somebody else's mistake.
 */
const facade: MemoryProvider = {
  get info(): MemoryProviderInfo {
    const chosen = primary();
    if (chosen) {
      try {
        return chosen.info;
      } catch (err) {
        bench(configuredId(), err);
      }
    }
    const builtin = fallback();
    if (!builtin) return MEMORY_PROVIDER_UNAVAILABLE_INFO;
    try {
      return builtin.info;
    } catch (err) {
      bench(BUILTIN_MEMORY_PROVIDER_ID, err);
      return MEMORY_PROVIDER_UNAVAILABLE_INFO;
    }
  },

  getSnapshot(ref: AgentMemoryRef): Promise<MemorySnapshot> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.resolve(errorSnapshot(parsed.error));
    // The one method that never rejects, because it is called on the way INTO a
    // turn. Everything that could go wrong arrives as an `'error'` snapshot,
    // which the injection path already renders as silence.
    return dispatch((provider) => provider.getSnapshot(parsed.data), errorSnapshot);
  },

  write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.reject(parsed.error);
    return dispatch((provider) => provider.write(parsed.data, op), rethrow);
  },

  query(ref: AgentMemoryRef, query: MemoryQuery): Promise<MemoryHits> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.reject(parsed.error);
    return dispatch((provider) => provider.query(parsed.data, query), rethrow);
  },

  forget(ref: AgentMemoryRef, selector: MemorySelector): Promise<void> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.reject(parsed.error);
    return dispatch((provider) => provider.forget(parsed.data, selector), rethrow);
  },

  consolidate(ref: AgentMemoryRef): Promise<void> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.reject(parsed.error);
    return dispatch((provider) => provider.consolidate(parsed.data), rethrow);
  },
};

/**
 * The memory backend this server reads and writes agent memory through.
 *
 * Every caller goes through here rather than importing an engine: the injection
 * path, the `memory_write` handler, and whatever comes next all address the same
 * instance, so the in-process write mutex a backend keeps is actually shared
 * between them. Two instances would each hold their own lock and serialize
 * nothing.
 *
 * The configured id is read once, at the first call. Changing `memory.provider`
 * takes effect on the next restart — a swap mid-run would mean two backends
 * holding half an agent's notes each.
 */
export function getMemoryProvider(): MemoryProvider {
  return facade;
}

/**
 * Forget everything this module has decided: the chosen id, the built
 * instances, the bench, the warnings, and any backend a test registered.
 *
 * For tests. Production never calls it — a bench is meant to last the process,
 * which is exactly what makes "one warning" true.
 */
export function resetMemoryProvider(): void {
  chosenId = null;
  instances.clear();
  benched.clear();
  warned.clear();
  factories.clear();
  registerMemoryProvider(BUILTIN_MEMORY_PROVIDER_ID, createBuiltinMemoryProvider);
}

/**
 * Whether a provider is currently benched.
 *
 * Exported for tests and for a future settings surface that wants to say
 * "this backend stopped answering, so DorkOS is using the builtin one".
 *
 * @param id - The provider id to ask about.
 */
export function isMemoryProviderBenched(id: string): boolean {
  return benched.has(id);
}
