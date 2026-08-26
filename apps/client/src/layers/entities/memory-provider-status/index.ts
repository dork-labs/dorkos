/**
 * Memory-provider-status entity — the one cheap read of which memory backend
 * is configured, which one is actually serving agent calls right now, and why
 * they differ.
 *
 * Its own entity rather than a corner of `settings` because nothing today owns
 * a "memory" domain on the client at all — `memory.provider` has no settings UI
 * yet, only a config key and a server-side registry — so this is the seam a
 * future memory settings surface grows into, not a borrowed corner of one.
 *
 * @module entities/memory-provider-status
 */
export { useMemoryProviderStatus } from './model/use-memory-provider-status';
