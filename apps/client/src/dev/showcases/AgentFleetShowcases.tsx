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
    workspace: { mode: 'home' },
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: minutesAgo(60 * 24 * 30),
    registeredBy: 'user',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    projectPath: `/Users/kai/code/${overrides.name}`,
    healthStatus: 'active',
    relayAdapters: [],
    relaySubject: null,
    taskCount: 0,
    lastSeenAt: minutesAgo(4),
    lastSeenEvent: 'response_complete',
    // No chats running under this folder. Real rows read this from
    // `useAgentAttentionMap`; every mock here is registered a month ago, so
    // silence means something.
    chatState: 'inactive',
    isPastOnboardingGrace: true,
    isDefault: false,
    // Every mock agent here belongs to the one operator, which is what a
    // single-user install looks like. `null` is the system-agent case, shown
    // by the DorkBot row below.
    managedBy: '@kai',
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
    name: 'refactor',
    displayName: 'Refactor',
    icon: '🧹',
    runtime: 'codex',
    healthStatus: 'inactive',
    lastSeenAt: minutesAgo(70),
    lastSeenEvent: 'MCP_tool_call',
    // A chat under this folder is waiting on an approval, or stopped on an error.
    chatState: 'needs-attention',
  }),
  row({
    id: '4',
    name: 'dorkbot',
    displayName: 'DorkBot',
    icon: '🤖',
    projectPath: '/Users/kai/code/dork-os/dorkos',
    chatState: 'active',
    taskCount: 7,
    isDefault: true,
    isSystem: true,
    // The system agent belongs to the install, not to a person — the one row
    // whose Managed by cell is a dash.
    managedBy: null,
  }),
  row({
    id: '5',
    name: 'blintz',
    displayName: 'Blintz',
    icon: '🦞',
    runtime: 'codex',
    healthStatus: 'inactive',
    lastSeenAt: minutesAgo(140),
    lastSeenEvent: 'message_sent',
  }),
  row({
    id: '6',
    name: 'fresh',
    displayName: 'Fresh Agent',
    icon: '🥚',
    healthStatus: 'stale',
    lastSeenAt: null,
    lastSeenEvent: null,
    chatState: 'fresh',
    // Registered seconds ago in onboarding, with schedules whose first run has
    // not come due. Stays Quiet, so a fresh install never looks broken.
    registeredAt: minutesAgo(1),
    isPastOnboardingGrace: false,
    taskCount: 2,
  }),
];

const NOOP_CALLBACKS = {
  onNavigate: () => {},
  onViewProfile: () => {},
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
          rows={FLEET.filter(
            (r) =>
              (r.healthStatus === 'active' || r.healthStatus === 'inactive') &&
              r.chatState !== 'needs-attention'
          )}
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
