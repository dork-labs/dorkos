/**
 * `@dorkos/memory` — the engine behind an agent's durable memory.
 *
 * One agent, one small markdown file (`<agentPath>/.dork/MEMORY.md`), capped so
 * the prompt cost of carrying it is knowable. This package owns the file: how it
 * is created, how it is read honestly, how the three edits work, and the jail
 * that keeps a write inside the agent it belongs to. The `MemoryProvider` port
 * it implements lives in `@dorkos/shared/memory-provider`; the wiring that
 * chooses a provider, exposes the tool and injects the block lives in the
 * server.
 *
 * **It resolves no roots of its own.** Every path arrives as an `AgentMemoryRef`
 * from the caller — the server always knows where an agent lives, and an engine
 * that guessed would be guessing differently in dev, in production and under
 * test.
 *
 * @module memory
 */
export { BUILTIN_MEMORY_PROVIDER_ID, createBuiltinMemoryProvider } from './builtin-provider.js';
export { MEMORY_DIR_NAME, MEMORY_FILE_NAME, MEMORY_MAX_CHARS } from './constants.js';
export { applyMemoryOp } from './ops.js';
export { MemoryPathError, resolveMemoryFile } from './paths.js';
export { renderProvenanceSuffix } from './provenance.js';
export { MEMORY_NOTES_HEADING, defaultMemoryTemplate } from './scaffold.js';
export { MEMORY_OVERSIZE_WARNING, forgetMemory, readMemorySnapshot, writeMemory } from './store.js';
