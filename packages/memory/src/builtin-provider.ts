/**
 * The builtin `MemoryProvider`: this machine's own `MEMORY.md` files.
 *
 * @module memory/builtin-provider
 */
import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MemoryUnsupportedError,
  type AgentMemoryRef,
  type MemoryHits,
  type MemoryProvider,
  type MemoryQuery,
  type MemorySelector,
  type MemorySnapshot,
  type MemoryWriteOp,
  type MemoryWriteResult,
} from '@dorkos/shared/memory-provider';

import { forgetMemory, readMemorySnapshot, writeMemory } from './store.js';

/**
 * The id the `memory.provider` config key names for this provider.
 *
 * Re-exported from the port rather than declared here: the config default and
 * the server's registry fallback need the same string and neither may import
 * this engine, so the one declaration lives in `@dorkos/shared/memory-provider`
 * and this line keeps `@dorkos/memory`'s published surface unchanged.
 */
export { BUILTIN_MEMORY_PROVIDER_ID };

/**
 * Build the provider that keeps each agent's memory in a markdown file the
 * operator can open, beside the agent's other files.
 *
 * It is stateless — every call resolves its own path from the ref it is handed —
 * so one instance serves every agent on this machine, and there is nothing to
 * dispose.
 *
 * **Both capabilities are off, and each is off for a reason worth stating.**
 * `search` is off because the whole of this backend's memory is already in the
 * prompt, capped: searching it would answer a question the reader can answer by
 * looking, and the refusal is what keeps "this backend cannot search" from
 * arriving as "I searched and found nothing". `consolidate` is off because
 * tidying up here is the agent's own job — the cap refusal tells it so in
 * words — and a background rewrite of a file a person may have edited by hand is
 * a bigger promise than v1 makes.
 */
export function createBuiltinMemoryProvider(): MemoryProvider {
  return {
    info: {
      id: BUILTIN_MEMORY_PROVIDER_ID,
      capabilities: { search: false, consolidate: false },
    },

    getSnapshot(ref: AgentMemoryRef): Promise<MemorySnapshot> {
      return readMemorySnapshot(ref);
    },

    write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult> {
      return writeMemory(ref, op);
    },

    query(_ref: AgentMemoryRef, _query: MemoryQuery): Promise<MemoryHits> {
      return Promise.reject(
        new MemoryUnsupportedError(
          BUILTIN_MEMORY_PROVIDER_ID,
          'search',
          'query',
          'this agent keeps its memory in one small file, and all of it is already in view'
        )
      );
    },

    forget(ref: AgentMemoryRef, selector: MemorySelector): Promise<void> {
      return forgetMemory(ref, selector);
    },

    consolidate(_ref: AgentMemoryRef): Promise<void> {
      return Promise.reject(
        new MemoryUnsupportedError(
          BUILTIN_MEMORY_PROVIDER_ID,
          'consolidate',
          'consolidate',
          'tidying up this file is something the agent does itself, not a background rewrite'
        )
      );
    },
  };
}
