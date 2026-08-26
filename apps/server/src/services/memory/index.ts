/**
 * The server's wiring for agent memory: which backend serves it, and the one
 * place the rest of the server asks.
 *
 * The engine (`@dorkos/memory`) owns the file. The port
 * (`@dorkos/shared/memory-provider`) owns the contract. The registry next door
 * ({@link ./registry.js}) owns the choice between implementations, the
 * `memory.provider` config key that makes it, and the quarantine that keeps a
 * broken backend from ever costing a turn.
 *
 * This file is the address the rest of the server imports, and it stays a
 * one-line re-export on purpose: every call site asks for a `MemoryProvider` and
 * learns nothing about how one is chosen, which is what makes the seam a seam.
 *
 * @module server/services/memory
 */
export { getMemoryProvider, registerMemoryProvider, resetMemoryProvider } from './registry.js';
