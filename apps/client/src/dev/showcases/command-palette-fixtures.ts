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

/**
 * One conversation fixture by id.
 *
 * Showcases address these rows BY NAME rather than by position. An index into
 * the array below is a reference that silently means something else the moment
 * somebody inserts a row — which happened, and put a row belonging to one agent
 * under another agent's heading.
 *
 * @param id - The fixture's own id.
 */
export function sessionRow(id: string): PaletteSessionItem {
  const row = SESSION_ROWS.find((session) => session.id === id);
  if (!row) throw new Error(`no session fixture "${id}"`);
  return row;
}

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

/**
 * Five conversations: live, recent, an automated run, one from yesterday, and a
 * second one belonging to the same agent as the first.
 *
 * The last exists so the scoped showcase can draw a list that is HONESTLY
 * scoped. Filling it with whatever conversations were to hand put a row under
 * "Conversations with Frontend App" that belonged to a different agent — a
 * picture of the chip not filtering, which is the one thing that showcase is
 * about.
 */
export const SESSION_ROWS: PaletteSessionItem[] = [
  {
    id: 'sess-live',
    who: 'Frontend App',
    title: 'Sidebar zones rewrite',
    cwd: '/Users/kai/projects/dork-os/apps/client',
    agent: MOCK_AGENTS[0],
    lastActivityAt: minutesAgo(1),
    archived: false,
  },
  {
    id: 'sess-recent',
    who: 'API Server',
    title: 'Rate limiting for the relay',
    cwd: '/Users/kai/projects/dork-os/apps/server',
    agent: MOCK_AGENTS[1],
    lastActivityAt: minutesAgo(35),
    archived: false,
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
    archived: false,
  },
  {
    // Yesterday's work: gone from Today, still in ⌘K, and saying so.
    id: 'sess-archived',
    who: 'Infrastructure',
    title: 'Design airtight box',
    cwd: '/Users/kai/projects/dork-os/infra',
    agent: MOCK_AGENTS[4],
    lastActivityAt: minutesAgo(26 * 60),
    archived: true,
  },
  {
    // Started by a message in `#shipping`, and it says so — the channel-scoped
    // showcase draws this row under "Conversations in #shipping", and a row
    // with no origin tying it to that channel would be a picture of a scope
    // admitting something it does not.
    id: 'sess-from-shipping',
    who: 'API Server',
    title: 'Late parcels in the EU lane',
    cwd: '/Users/kai/projects/dork-os/apps/server',
    agent: MOCK_AGENTS[1],
    origin: 'room',
    originLabel: '#shipping',
    lastActivityAt: minutesAgo(52),
    archived: false,
  },
  {
    id: 'sess-frontend-two',
    who: 'Frontend App',
    title: 'Palette scope chips',
    cwd: '/Users/kai/projects/dork-os/apps/client',
    agent: MOCK_AGENTS[0],
    lastActivityAt: minutesAgo(95),
    archived: false,
  },
];
