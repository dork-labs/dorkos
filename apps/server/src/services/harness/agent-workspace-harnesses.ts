/** The original harness set shared by workspace projection and retirement checks. */
import type { HarnessId } from '@dorkos/harness';

/**
 * The harness set DorkOS scaffolds into an agent workspace it owns.
 *
 * Only Claude Code, because only Claude Code needs anything projected: the other
 * harnesses read `.agents/skills/` natively. Enabling more would add no skill
 * coverage and would make this unattended pass generate hook files. See the
 * module docs.
 *
 * Exported because it decides more than the scaffold: it is the harness set
 * whose projection TARGETS a caller has to account for. `room-worktree-manager`
 * reads it to recognise the harness manifest it once scaffolded into a room
 * worktree, so the two can never disagree about which file DorkOS wrote.
 */
export const AGENT_WORKSPACE_HARNESSES: readonly HarnessId[] = ['claude-code'];
