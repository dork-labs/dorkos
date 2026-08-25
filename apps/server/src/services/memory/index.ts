/**
 * The server's wiring for agent memory: which backend serves it, and the one
 * place the rest of the server asks.
 *
 * The engine (`@dorkos/memory`) owns the file. The port
 * (`@dorkos/shared/memory-provider`) owns the contract. This directory owns the
 * choice between implementations — which in v1 is not much of a choice, and is
 * a module anyway so that the day a second backend exists, the callers do not
 * change.
 *
 * @module server/services/memory
 */
import { createBuiltinMemoryProvider } from '@dorkos/memory';
import type { MemoryProvider } from '@dorkos/shared/memory-provider';

/**
 * The single provider instance, built on first use.
 *
 * Memoized because the builtin provider is stateless — it resolves its path
 * from the ref on every call — so one instance serves every agent on this
 * machine and building a second would only cost allocations. A registry with
 * more than one entry, and the `memory.provider` config key that chooses
 * between them, is Phase 3 work; until then this function is the seam that
 * makes those a change here rather than a change at every call site.
 */
let provider: MemoryProvider | null = null;

/**
 * The memory backend this server reads and writes agent memory through.
 *
 * Every caller goes through here rather than importing the engine: the
 * injection path, the `memory_write` handler, and whatever comes next all
 * address the same instance, so the in-process write mutex the engine keeps is
 * actually shared between them. Two instances would each hold their own lock
 * and serialize nothing.
 */
export function getMemoryProvider(): MemoryProvider {
  provider ??= createBuiltinMemoryProvider();
  return provider;
}

/**
 * Drop the memoized provider.
 *
 * For tests that swap what `createBuiltinMemoryProvider` returns between cases.
 * Production never calls it — the provider is chosen once, at the first read.
 */
export function resetMemoryProvider(): void {
  provider = null;
}
