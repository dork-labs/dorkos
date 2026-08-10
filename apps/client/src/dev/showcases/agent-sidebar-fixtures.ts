/**
 * The agents and the clock the sidebar showcases share.
 *
 * A module of their own rather than exports from `AgentSidebarShowcases`,
 * because `SessionSwitcherShowcases` needs them too and that file is imported
 * BACK into the roster page — reaching across would make the pair circular, and
 * `SWITCHER_AGENT = MOCK_AGENTS[0]` runs at module init, which is exactly where
 * a circular import hands you `undefined`.
 *
 * @module dev/showcases/agent-sidebar-fixtures
 */

/** Three agents, enough to show disambiguation, grouping and a live chip. */
export const MOCK_AGENTS = [
  {
    path: '/home/user/.dork/agents/code-reviewer',
    agent: { id: 'code-reviewer', name: 'code-reviewer', color: '#6366f1', icon: '🔍' },
    displayName: 'code-reviewer',
  },
  {
    path: '/home/user/.dork/agents/deploy-bot',
    agent: { id: 'deploy-bot', name: 'deploy-bot', color: '#f59e0b', icon: '🚀' },
    displayName: 'deploy-bot',
  },
  {
    path: '/home/user/.dork/agents/test-runner',
    agent: { id: 'test-runner', name: 'test-runner', color: '#10b981', icon: '🧪' },
    displayName: 'test-runner',
  },
] as const;

/** Page-load time, so every fixture timestamp is relative to one instant. */
const now = new Date();

/**
 * An ISO timestamp `n` minutes before the page loaded.
 *
 * @param n - How many minutes ago.
 */
export function minutesAgo(n: number): string {
  return new Date(now.getTime() - n * 60_000).toISOString();
}
