/**
 * Boot-timeout constants shared by the desktop shell's parent process and the
 * server child it spawns.
 *
 * The child polls its own health endpoint; the parent waits for the child's
 * `ready` message. These two windows are coupled — the parent must always
 * outwait the child — so they live here as one source of truth instead of two
 * hardcoded numbers that could silently drift apart.
 *
 * This module is dependency-free on purpose: `server-entry.ts` is bundled as a
 * separate child-process entry (esbuild, see `scripts/build-server.ts`), so
 * anything it imports must inline cleanly with no external dependency.
 *
 * @module shared/boot-timeouts
 */

/**
 * Child health-poll window.
 *
 * The window must exceed the slowest legitimate boot, not the typical one: a
 * first run on a slow disk pays DB setup plus a mesh disk scan that is itself
 * capped at 30s. Polling returns the moment the server is up, so a generous
 * ceiling costs a healthy boot nothing.
 */
export const SERVER_READY_TIMEOUT_MS = 60_000;

/**
 * Parent's wait for the child's `ready` message.
 *
 * Set past the child's own window so the child's clearer failure — stderr
 * "Server did not become ready in time" followed by exit 1 — always fires
 * first, instead of the parent tripping its generic "Server start timeout".
 */
export const SERVER_READY_PARENT_TIMEOUT_MS = SERVER_READY_TIMEOUT_MS + 10_000;
