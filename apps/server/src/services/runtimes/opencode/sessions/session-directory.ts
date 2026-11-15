/**
 * Where OpenCode stores a session, read once and kept.
 *
 * @module services/runtimes/opencode/sessions/session-directory
 */
import type { OpencodeClient } from '@opencode-ai/sdk';
import { unwrap } from './session-mapper.js';

/**
 * The directory AS STORED BY OPENCODE for a session — the demux key half
 * that must never be substituted with the DorkOS cwd (strict string
 * equality; trailing-slash or symlink drift would silently drop every
 * event). Read once via `session.get` and cached; failure is loud — a turn
 * without a trustworthy demux key must not run.
 *
 * @param cache - The runtime's directory per OpenCode session id.
 * @param client - The sidecar client.
 * @param ocSessionId - The OpenCode session.
 */
export async function sessionDirectoryOf(
  cache: Map<string, string>,
  client: OpencodeClient,
  ocSessionId: string
): Promise<string> {
  const cached = cache.get(ocSessionId);
  if (cached !== undefined) return cached;
  const session = unwrap(await client.session.get({ path: { id: ocSessionId } }), 'session.get');
  cache.set(ocSessionId, session.directory);
  return session.directory;
}
