/**
 * Which runtime an agent's unattended turn should run on.
 *
 * One rule, one copy. Rooms asked it first (`room-turn-runner.ts`), the relay
 * now asks the same question when a chat platform's first message needs a
 * session created for an agent (DOR-1614), and the room binding repair sweep
 * asks it a third time. A second copy of the manifest-then-default ladder is a
 * second copy that can disagree about which program answers for an agent.
 *
 * @module services/runtimes/shared/resolve-agent-runtime-type
 */
import { readManifest } from '@dorkos/shared/manifest';
import { runtimeRegistry } from '../../core/runtime-registry.js';

/**
 * Which runtime an agent's turn should run on: its manifest's preference when
 * that runtime is registered in this process, otherwise the default.
 *
 * Mirrors `POST /api/sessions/:id/messages`, deliberately including the soft
 * fallback — a test-mode server registers only `test-mode` while every manifest
 * on disk says `claude-code`, and without the fallback no room and no chat
 * binding could ever trigger anything there.
 *
 * Swallows its own manifest read: an agent with no manifest, or an unreadable
 * one, is not a reason to refuse a turn — the default is the right answer.
 *
 * @param agentPath - The agent's project directory, the one holding `.dork/agent.json`.
 */
export async function resolveAgentRuntimeType(agentPath: string): Promise<string> {
  try {
    const manifest = await readManifest(agentPath);
    if (manifest?.runtime && runtimeRegistry.has(manifest.runtime)) return manifest.runtime;
  } catch {
    // No manifest, or an unreadable one. The default is the right answer.
  }
  return runtimeRegistry.getDefaultType();
}
