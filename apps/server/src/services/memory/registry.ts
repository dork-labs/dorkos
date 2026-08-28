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
 * ## What the AGENT is told, and how far that goes today
 *
 * `agent-context.ts` (`buildMemoryBlock`) adds one DorkOS-authored line to the
 * fenced memory block when the configured backend is benched AND that block
 * already renders — i.e. when `builtin`'s own file for this agent happens to
 * have content, via {@link memoryProviderStatus}. That is deliberately narrow:
 * the `'error'` snapshot's message is still never rendered into a prompt (a raw
 * I/O message is neither useful to a model nor safe to hand it), and the block
 * set an agent's append carries is pinned by the D9 prompt-content tests.
 *
 * **The common case is still silent.** The first bench of a run almost always
 * lands on a `builtin` file that has never been written — `'absent'`, not
 * `'present'` — because the fallback starts from its own empty scaffold rather
 * than the faulted backend's notes. `buildMemoryBlock` renders nothing for
 * `'absent'` today, same as an agent that never saved anything, so THAT is the
 * amnesia case this docblock used to describe as entirely unfixed. Making the
 * block appear on an absent-but-benched read is not one line: it means deciding
 * whether `<agent_memory>` may ever carry a notice with no underlying file, and
 * moving the D9 pin to match — an injection-path decision with its own spec
 * question ("what does an agent do differently when told its memory is
 * unavailable?"). Filed as follow-up work rather than smuggled in here.
 *
 * The operator-visible half is not narrow: `memoryProviderStatus()` answers
 * `GET /api/system/memory` in full (configured id, active id, benched, reason)
 * regardless of which snapshot state the last read happened to hit.
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
  MemoryQuerySchema,
  MemorySelectorSchema,
  MemorySnapshotSchema,
  MemoryUnsupportedError,
  MemoryWriteOpSchema,
  type AgentMemoryRef,
  type MemoryHits,
  type MemoryProvider,
  type MemoryProviderInfo,
  type MemoryProviderStatus,
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

/**
 * What benched a provider, keyed by id — a short, safe SUMMARY, never the raw
 * thrown value. Populated alongside `benched`, read by
 * {@link memoryProviderStatus} for `GET /api/system/memory` and by
 * `buildMemoryBlock`'s in-band notice. Never contains `builtin` — its faults
 * degrade to no memory rather than to a bench, so there is nothing to explain.
 */
const benchReasons = new Map<string, string>();

/** How much of a bench reason `GET /api/system/memory` answers with. */
const BENCH_REASON_MAX_CHARS = 120;

/**
 * A short, safe description of what benched a provider — never the error a
 * backend actually threw.
 *
 * `GET /api/system/memory` is loopback-only by default but reachable over the
 * built-in tunnel, and it answers with no auth check of its own. A raw
 * `String(err)` can carry whatever a backend's message happened to
 * interpolate — a connection string, a file path, a credential — so this
 * keeps only the error's own name (its class, e.g. `TypeError`, or a custom
 * refusal-shaped name) plus the first line of its message, capped. Enough for
 * an operator to recognize the SHAPE of a failure; not enough to leak one. The
 * server log (`warnOnce` in {@link bench}) still gets the full `String(err)` —
 * this cap applies only to what crosses the wire.
 *
 * @param err - Whatever the provider threw.
 */
function summarizeBenchReason(err: unknown): string {
  const firstLine =
    err instanceof Error
      ? err.message.split('\n')[0]
        ? `${err.name}: ${err.message.split('\n')[0]}`
        : err.name
      : (String(err).split('\n')[0] ?? String(err));
  return firstLine.length > BENCH_REASON_MAX_CHARS
    ? `${firstLine.slice(0, BENCH_REASON_MAX_CHARS)}…`
    : firstLine;
}

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
 * The six refusals this port and its engine declare, by the `name` every one of
 * them sets on itself.
 *
 * The names exist for a case `instanceof` cannot answer: a third-party backend
 * that ships with its OWN copy of `@dorkos/shared` throws errors from a
 * different module instance, so `instanceof` says `false` for a class that is
 * the same class by every meaning a person would use. Benching a backend for
 * refusing an ambiguous edit — because its `node_modules` are laid out
 * differently from ours — is exactly the false positive quarantine must not
 * have.
 */
const REFUSAL_NAMES: ReadonlySet<string> = new Set([
  'MemoryUnsupportedError',
  'MemoryMatchError',
  'MemoryCapExceededError',
  'MemoryNoteShapeError',
  'MemoryIOError',
  'MemoryPathError',
]);

/**
 * Whether an error is the provider working correctly rather than failing.
 *
 * `instanceof` first, because it is exact for everything that shares this
 * process's module instances (the builtin engine, anything registered from
 * inside this repo). The name check is the fallback for a duplicated module
 * graph, and it is deliberately generous in the direction that keeps a healthy
 * backend serving: the cost of believing a foreign `MemoryIOError` is one
 * unbenched provider that will fail again and be reported by whoever called it,
 * while the cost of disbelieving it is a working backend taken out for the rest
 * of the run.
 *
 * @param err - Whatever a provider threw.
 */
function isContractRefusal(err: unknown): boolean {
  if (
    err instanceof MemoryUnsupportedError ||
    err instanceof MemoryMatchError ||
    err instanceof MemoryCapExceededError ||
    err instanceof MemoryNoteShapeError ||
    err instanceof MemoryIOError ||
    err instanceof MemoryPathError
  ) {
    return true;
  }
  return err instanceof Error && REFUSAL_NAMES.has(err.name);
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
  benchReasons.set(id, summarizeBenchReason(err));
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
 * The id this machine is configured to use, read once — **once it can be read
 * at all**.
 *
 * Defensive about the config manager itself: this is reached from the injection
 * path, and a server booted without config (or a test that never initialised it)
 * must get `builtin` rather than an exception on the way into a turn.
 *
 * **The failure is deliberately not cached, and that distinction is the whole
 * point of the branch.** `configManager` is a `let` assigned at boot, so
 * anything that reaches memory before `initConfigManager` runs sees `undefined`.
 * Caching the `builtin` answer from that moment would disable the operator's
 * configured backend for the rest of the process, silently, with no warning to
 * find — a bug whose only symptom is an agent that remembers nothing. A read
 * that could not happen is not an answer, so it is not remembered; the next
 * caller asks again, and the first one that succeeds fixes the choice.
 */
function configuredId(): string {
  if (chosenId !== null) return chosenId;
  const manager = configManager as ConfigManager | undefined;
  if (!manager) return BUILTIN_MEMORY_PROVIDER_ID;
  let id: unknown;
  try {
    id = manager.getDot('memory.provider');
  } catch {
    return BUILTIN_MEMORY_PROVIDER_ID;
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

/**
 * The read's own dispatch, because reading is the one call that may not reject.
 *
 * `getSnapshot` is called on the way INTO a turn and the port says outright that
 * it never throws: absence and failure are both states the injection path
 * renders (as nothing), not states that abort a conversation. So this variant
 * differs from {@link dispatch} in exactly one way — **a refusal is reported
 * rather than raised** — and is identical in every other: a fault still benches,
 * a refusal still benches nobody.
 *
 * Without the difference, a backend that carefully wrapped its disk failure in
 * `MemoryIOError` would get a WORSE outcome than one that threw a bare `Error`:
 * the bare throw becomes an empty memory and a turn that runs, the typed one
 * becomes an exception in the caller. That inverts the incentive the author
 * guide states ("throw the typed errors"), and it is the sort of inversion
 * nobody discovers until a turn dies in front of an operator.
 *
 * A refusal is answered on the spot rather than retried on `builtin`, and the
 * asymmetry with a fault is deliberate. A fault says this backend is broken, so
 * the fallback is the mitigation. A refusal says this READ did not work, on a
 * backend that is otherwise fine — and quietly answering it with a different
 * store's notes would inject the wrong agent's memory rather than none.
 *
 * @param call - The read, applied to whichever provider is serving.
 */
async function dispatchRead(
  call: (provider: MemoryProvider) => Promise<MemorySnapshot>
): Promise<MemorySnapshot> {
  const chosen = primary();
  if (chosen) {
    try {
      return await call(chosen);
    } catch (err) {
      if (isContractRefusal(err)) return errorSnapshot(err);
      bench(configuredId(), err);
    }
  }

  const builtin = fallback();
  if (!builtin) {
    return errorSnapshot(new Error('no memory provider could be built'));
  }
  try {
    return await call(builtin);
  } catch (err) {
    if (!isContractRefusal(err)) bench(BUILTIN_MEMORY_PROVIDER_ID, err);
    return errorSnapshot(err);
  }
}

/**
 * What an `'error'` snapshot says when the failure itself said nothing.
 *
 * `MemorySnapshotSchema` requires a non-empty `error`, and a thrown `new
 * Error()` or a thrown `''` produces exactly the empty string it refuses — so
 * without a floor here the SHAPING of the failure would throw, out of the one
 * branch whose whole job is that the turn still runs.
 */
const UNEXPLAINED_FAILURE = 'the memory backend failed without saying why';

/**
 * Shape a failure the injection path can render as nothing at all.
 *
 * **This function may not throw**, which is why it neither trusts the error to
 * carry a message nor trusts the schema to accept what it built. Both belts are
 * cheap and each covers a case the other does not: the message floor handles the
 * empty-message error, and the `safeParse` handles whatever future invariant the
 * snapshot schema grows that this call site has not been taught about.
 *
 * @param err - Whatever went wrong.
 */
function errorSnapshot(err: unknown): MemorySnapshot {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  const message = raw.trim() === '' ? UNEXPLAINED_FAILURE : raw;
  const shaped = {
    status: 'error' as const,
    content: '',
    bytes: 0,
    truncated: false,
    error: message,
  };
  const parsed = MemorySnapshotSchema.safeParse(shaped);
  return parsed.success ? parsed.data : { ...shaped, error: UNEXPLAINED_FAILURE };
}

/** Re-raise, for the methods whose caller needs to know nothing happened. */
function rethrow(err: unknown): never {
  throw err;
}

/**
 * The single facade every caller in this server addresses.
 *
 * It IS a `MemoryProvider`, so nothing at a call site knows a registry exists —
 * which is the point of a seam. It is also the object `memoryConformance` runs
 * against in `__tests__/conformance.test.ts`, which is what keeps "the facade is
 * a provider" a checked claim rather than a comment.
 *
 * **Every argument is validated here rather than in each branch**, and for one
 * reason: a malformed ref, op, query or selector is the CALLER's bug. It is
 * refused identically whichever backend is installed, so passing it down would
 * bench a perfectly healthy provider for somebody else's mistake — the same
 * false positive quarantine exists to avoid. The parsed value is what reaches
 * the provider, so a backend is handed the port's canonical shape.
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
    return dispatchRead((provider) => provider.getSnapshot(parsed.data));
  },

  write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.reject(parsed.error);
    const parsedOp = MemoryWriteOpSchema.safeParse(op);
    if (!parsedOp.success) return Promise.reject(parsedOp.error);
    return dispatch((provider) => provider.write(parsed.data, parsedOp.data), rethrow);
  },

  query(ref: AgentMemoryRef, query: MemoryQuery): Promise<MemoryHits> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.reject(parsed.error);
    const parsedQuery = MemoryQuerySchema.safeParse(query);
    if (!parsedQuery.success) return Promise.reject(parsedQuery.error);
    return dispatch((provider) => provider.query(parsed.data, parsedQuery.data), rethrow);
  },

  forget(ref: AgentMemoryRef, selector: MemorySelector): Promise<void> {
    const parsed = AgentMemoryRefSchema.safeParse(ref);
    if (!parsed.success) return Promise.reject(parsed.error);
    const parsedSelector = MemorySelectorSchema.safeParse(selector);
    if (!parsedSelector.success) return Promise.reject(parsedSelector.error);
    return dispatch((provider) => provider.forget(parsed.data, parsedSelector.data), rethrow);
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
  benchReasons.clear();
  warned.clear();
  factories.clear();
  registerMemoryProvider(BUILTIN_MEMORY_PROVIDER_ID, createBuiltinMemoryProvider);
}

/**
 * Whether a provider is currently benched.
 *
 * Exported for tests and for {@link memoryProviderStatus}, which is what
 * `GET /api/system/memory` and the standing client banner actually read — this
 * is the primitive underneath both, not a settings surface itself.
 *
 * @param id - The provider id to ask about.
 */
export function isMemoryProviderBenched(id: string): boolean {
  return benched.has(id);
}

/**
 * A live snapshot of which memory backend `memory.provider` names, which one is
 * actually serving calls right now, and why they differ.
 *
 * This is the one exported read behind `GET /api/system/memory` and the
 * one-line in-band notice {@link buildMemoryBlock} adds when the configured
 * backend is benched — both want the same three facts (configured, active,
 * reason), so there is one place that knows how to compute them rather than
 * two call sites re-deriving the fallback rule.
 *
 * `activeId` also accounts for a configured id nothing registered (a
 * misconfiguration, not a fault): `builtin` is what actually answers a call
 * either way, so an honest "active" says so even though `benched` — which
 * names the quarantine state specifically — stays `false` for that case.
 */
export function memoryProviderStatus(): MemoryProviderStatus {
  const id = configuredId();
  const isBenched = isMemoryProviderBenched(id);
  const isRegistered = id === BUILTIN_MEMORY_PROVIDER_ID || factories.has(id);
  const activeId = isRegistered && !isBenched ? id : BUILTIN_MEMORY_PROVIDER_ID;
  return {
    configuredId: id,
    activeId,
    benched: isBenched,
    benchReason: isBenched ? (benchReasons.get(id) ?? null) : null,
  };
}
