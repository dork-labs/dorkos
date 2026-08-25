import type { Session } from '@dorkos/shared/types';
import { isWithinDirectory } from '@dorkos/shared/paths';

/**
 * THE canonical per-agent session membership rule (DOR-203): a session belongs
 * to an agent iff its `cwd` is the agent's project directory or a folder inside
 * it, newest-first. A session without a cwd belongs to no agent — fanning such
 * sessions into every agent is how ghost sessions appeared under every agent
 * (DOR-202).
 *
 * The subtree half is DOR-674: a session started in `<project>/packages/api` is
 * still that project's session, and an exact `cwd` match hid it from the
 * sidebar switcher, the profile Sessions page, the embed sidebar and the
 * command palette — including sessions the server had just gone to some trouble
 * to include. `isWithinDirectory` is shared with the server's OpenCode listing
 * and its per-agent fan-out precisely so this layer cannot disagree with them;
 * the cases all three answer live in `DIRECTORY_MEMBERSHIP_VECTORS`.
 *
 * Prefer the `useAgentSessions` hook; reach for this pure selector only where
 * a hook cannot go (per-agent aggregation loops, non-React code).
 *
 * @param sessions - The full session list for the active query scope
 * @param projectPath - The agent's project directory, or null when none is active
 */
export function selectAgentSessions(sessions: Session[], projectPath: string | null): Session[] {
  return sessions
    .filter((s) => projectPath !== null && isWithinDirectory(s.cwd, projectPath))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
