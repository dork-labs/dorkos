import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { AgentFleetTable, type AgentTableRow } from '@/layers/features/agents-list';

/** Minutes ago as an ISO string, so the relative times read sensibly. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function row(overrides: Partial<AgentTableRow> & { id: string; name: string }): AgentTableRow {
  return {
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: minutesAgo(60 * 24 * 30),
    registeredBy: 'user',
    personaEnabled: true,
    enabledToolGroups: {},
    projectPath: `/Users/kai/code/${overrides.name}`,
    healthStatus: 'active',
    relayAdapters: [],
    relaySubject: null,
    taskCount: 0,
    lastSeenAt: minutesAgo(4),
    lastSeenEvent: 'response_complete',
    sessionCount: 0,
    isDefault: false,
    ...overrides,
  };
}

/** One agent in each attention state, plus the edge cases that trip up copy. */
const FLEET: AgentTableRow[] = [
  row({
    id: '1',
    name: 'scout',
    displayName: 'Scout',
    icon: '🧭',
    runtime: 'opencode',
    projectPath: '/Users/kai/research/scout',
    healthStatus: 'unreachable',
    lastSeenAt: minutesAgo(60 * 72),
    lastSeenEvent: 'tool_error',
    taskCount: 4,
  }),
  row({
    id: '2',
    name: 'nightly',
    displayName: 'Nightly',
    icon: '🌙',
    runtime: 'codex',
    healthStatus: 'stale',
    lastSeenAt: minutesAgo(60 * 40),
    lastSeenEvent: 'heartbeat',
    taskCount: 2,
  }),
  row({
    id: '3',
    name: 'dorkbot',
    displayName: 'DorkBot',
    icon: '🤖',
    projectPath: '/Users/kai/code/dork-os/dorkos',
    sessionCount: 2,
    taskCount: 7,
    isDefault: true,
    isSystem: true,
  }),
  row({
    id: '4',
    name: 'blintz',
    displayName: 'Blintz',
    icon: '🦞',
    runtime: 'codex',
    healthStatus: 'inactive',
    lastSeenAt: minutesAgo(140),
    lastSeenEvent: 'message_sent',
  }),
  row({
    id: '5',
    name: 'fresh',
    displayName: 'Fresh Agent',
    icon: '🥚',
    healthStatus: 'stale',
    lastSeenAt: null,
    lastSeenEvent: null,
  }),
];

const NOOP_CALLBACKS = {
  onNavigate: () => {},
  onManage: () => {},
  onStartSession: () => {},
};

/** The agent fleet table, in attention order and flattened. */
export function AgentFleetShowcases() {
  return (
    <PlaygroundSection
      title="AgentFleetTable"
      description="The /agents fleet table. Rows group by whether an agent needs you, is working, or is quiet; picking a field sort flattens the groups."
    >
      <ShowcaseLabel>Attention order (the default)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <AgentFleetTable rows={FLEET} grouped callbacks={NOOP_CALLBACKS} />
      </ShowcaseDemo>

      <ShowcaseLabel>Flattened by a field sort</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <AgentFleetTable
          rows={[...FLEET].sort((a, b) => a.name.localeCompare(b.name))}
          grouped={false}
          callbacks={NOOP_CALLBACKS}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Nothing needs you</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <AgentFleetTable
          rows={FLEET.filter((r) => r.healthStatus === 'active' || r.healthStatus === 'inactive')}
          grouped
          callbacks={NOOP_CALLBACKS}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Empty fleet</ShowcaseLabel>
      <ShowcaseDemo>
        <AgentFleetTable rows={[]} grouped callbacks={NOOP_CALLBACKS} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
