/**
 * Wire the home resolver's registry for a test (spec `agent-home-desk` §3.1).
 *
 * The resolver fails closed with nothing wired — no folder is anybody's home —
 * so a test that exercises identity must say which folders are registered,
 * exactly as boot does against the live mesh registry.
 */
import path from 'node:path';
import { setAgentHomeRegistry, type AgentHome, type AgentHomeRegistry } from '../agent-home.js';

/**
 * Register `homes` as the only agent homes, and return a mutable handle.
 *
 * @param homes - Absolute paths that count as registered homes.
 * @param extra - Managed-workspace owners and the rooms directory, when a test needs them.
 */
export function registerTestHomes(
  homes: Iterable<string>,
  extra: { managed?: Record<string, string>; roomsDir?: string } = {}
): { homes: Set<string>; managed: Map<string, string>; port: AgentHomeRegistry } {
  const registered = new Set([...homes].map((h) => path.resolve(h)));
  const managed = new Map(
    Object.entries(extra.managed ?? {}).map(([dir, owner]) => [path.resolve(dir), owner])
  );
  const port: AgentHomeRegistry = {
    isRegisteredHome: (dir) => registered.has(dir),
    listRegisteredHomes: () => [...registered],
    managedWorkspaceOwner: (dir) => managed.get(dir) ?? null,
    roomsDir: extra.roomsDir ?? null,
  };
  setAgentHomeRegistry(port);
  return { homes: registered, managed, port };
}

/**
 * Treat every folder as a registered home, exactly.
 *
 * For suites about something OTHER than which folder is whose — manifest I/O,
 * tool gating, token minting — that stand an agent at a scratch folder and
 * decide "is it an agent" through their own mocked mesh. Each folder still
 * resolves only to itself: no prefix, no worktree mapping. Suites about
 * resolution itself use {@link registerTestHomes}.
 */
export function registerEveryFolderAsHome(): void {
  setAgentHomeRegistry({
    isRegisteredHome: () => true,
    listRegisteredHomes: () => [],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
}

/** Clear the registry again, back to the fail-closed default. */
export function clearTestHomes(): void {
  setAgentHomeRegistry(undefined);
}

/**
 * Treat `dir` as a registered home for an identity reader under test — the
 * one place a test mints the brand without the resolver.
 *
 * @param dir - A folder the test stands an agent at.
 */
export function testHome(dir: string): AgentHome {
  return dir as AgentHome;
}
