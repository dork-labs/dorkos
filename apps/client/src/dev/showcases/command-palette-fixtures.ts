/**
 * Mock agents and conversations shared by the command-palette showcases.
 *
 * Their own module because two showcase files draw from them now — the page
 * itself and the ranked-results section — and a second copy is how two demos of
 * the same list start disagreeing.
 *
 * @module dev/showcases/command-palette-fixtures
 */
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { PaletteSessionItem } from '@/layers/features/command-palette';

/** How long ago, as the ISO-8601 string a palette row carries. */
export const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** A small fleet, with and without custom faces. */
export const MOCK_AGENTS: AgentPathEntry[] = [
  {
    id: 'agent-frontend',
    name: 'Frontend App',
    projectPath: '/Users/kai/projects/dork-os/apps/client',
    icon: '🎨',
    color: 'hsl(210, 80%, 55%)',
  },
  {
    id: 'agent-backend',
    name: 'API Server',
    projectPath: '/Users/kai/projects/dork-os/apps/server',
    icon: '⚡',
    color: 'hsl(150, 70%, 45%)',
  },
  {
    id: 'agent-docs',
    name: 'Documentation',
    projectPath: '/Users/kai/projects/dork-os/docs',
    icon: '📚',
  },
  { id: 'agent-cli', name: 'CLI Tool', projectPath: '/Users/kai/projects/dork-os/packages/cli' },
  {
    id: 'agent-infra',
    name: 'Infrastructure',
    projectPath: '/Users/kai/projects/dork-os/infra',
    icon: '🏗️',
    color: 'hsl(30, 85%, 55%)',
  },
];

/** Three conversations: live, recent, and an automated run. */
export const SESSION_ROWS: PaletteSessionItem[] = [
  {
    id: 'sess-live',
    who: 'Frontend App',
    title: 'Sidebar zones rewrite',
    cwd: '/Users/kai/projects/dork-os/apps/client',
    agent: MOCK_AGENTS[0],
    lastActivityAt: minutesAgo(1),
  },
  {
    id: 'sess-recent',
    who: 'API Server',
    title: 'Rate limiting for the relay',
    cwd: '/Users/kai/projects/dork-os/apps/server',
    agent: MOCK_AGENTS[1],
    lastActivityAt: minutesAgo(35),
  },
  {
    id: 'sess-automated',
    who: 'Documentation',
    title: 'Nightly link check',
    cwd: '/Users/kai/projects/dork-os/docs',
    agent: MOCK_AGENTS[2],
    origin: 'task',
    originLabel: 'Scheduled task · nightly-links',
    lastActivityAt: minutesAgo(600),
  },
];
