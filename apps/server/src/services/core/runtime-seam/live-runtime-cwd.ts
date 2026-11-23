/** The folder a chat's own runtime is running it in now (DOR-5035). */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import { runtimeRegistry } from '../runtime-registry.js';

/**
 * Ask only the runtime the chat is bound to, from its memory: never another
 * runtime, a transcript on disk or a caller. An unbound chat, an unregistered
 * runtime, or one that does not hold the chat answers `undefined`.
 *
 * @param db - The server's database, for the chat's bound runtime.
 * @param sessionId - The chat.
 */
export function liveRuntimeCwd(db: Db, sessionId: string): string | undefined {
  const runtime = db
    .select({ runtime: sessionMetadata.runtime })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get()?.runtime;
  if (!runtime || !runtimeRegistry.has(runtime)) return undefined;
  return runtimeRegistry.get(runtime).getSessionCwd?.(sessionId);
}
