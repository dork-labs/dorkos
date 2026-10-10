/**
 * @vitest-environment jsdom
 */
/**
 * The Heartbeat page (spec `heartbeats` §7.6): how an agent wakes, its
 * HEARTBEAT.md in the convention editor, its last checks, and what is held for
 * people's hours. The editor is drawn on your own agents only; someone else's
 * agent is facts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { TransportProvider } from '@/layers/shared/model';
import { HeartbeatPage } from '../ui/pages/HeartbeatPage';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => navigate,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;
const MANAGED = byId('agent-warden');
const PRIYA = {
  id: 'person-priya',
  kind: 'human',
  displayName: 'Priya',
  handle: 'priya',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  person: { role: null, lastSeenAt: null, accountId: 'acct-priya' },
} as TeamMember;
const OTHERS_AGENT: TeamMember = { ...byId('agent-cartographer'), ownerId: PRIYA.id };
const ROSTER = [...MOCK_TEAM_ROSTER, PRIYA, OTHERS_AGENT];

const HEARTBEAT_FILE = '---\nwake: timed\n---\n- Watch the build.';

/** Warden's manifest, with or without a HEARTBEAT.md. */
function manifest(heartbeatContent: string | null) {
  return {
    id: 'agent-warden',
    name: 'warden',
    displayName: 'Warden',
    runtime: 'claude-code',
    conventions: { soul: true, nope: true, memory: true, dorkosKnowledge: true },
    heartbeatContent,
  } as unknown as AgentManifest;
}

const STATUS: HeartbeatStatus = {
  enabled: true,
  wake: 'events',
  nextBeatAt: null,
  skippedReason: null,
  fileError: null,
  lastBeats: [],
  held: [],
};

function renderPage(
  member: TeamMember,
  status: Partial<HeartbeatStatus> = {},
  heartbeatContent: string | null = HEARTBEAT_FILE
) {
  const transport = createMockTransport({
    getAgentHeartbeat: vi.fn().mockResolvedValue({ ...STATUS, ...status }),
    getAgentByPath: vi.fn().mockResolvedValue(manifest(heartbeatContent)),
    updateAgentByPath: vi.fn().mockResolvedValue(manifest(heartbeatContent)),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <HeartbeatPage member={member} roster={ROSTER} onPush={() => undefined} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('how it wakes', () => {
  it('says each wake mode in plain words', async () => {
    renderPage(MANAGED, { wake: 'events' });
    expect(await screen.findByText('Wakes when something happens.')).toBeInTheDocument();
    cleanup();

    renderPage(MANAGED, { wake: 'off', skippedReason: 'Heartbeat off.' });
    expect(await screen.findByText('Heartbeat off.')).toBeInTheDocument();
    cleanup();

    renderPage(MANAGED, {
      wake: 'timed',
      nextBeatAt: new Date(Date.now() + 12 * 60_000 - 1_000).toISOString(),
    });
    expect(await screen.findByText('Wakes every 30 minutes in your hours.')).toBeInTheDocument();
    expect(screen.getByText('Next check in 12 min')).toBeInTheDocument();
  });

  it('says heartbeats are off for everyone, with no controls', async () => {
    renderPage(MANAGED, { enabled: false, skippedReason: 'Heartbeats are off.' });
    expect(await screen.findByText('Heartbeats are off for everyone.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('HEARTBEAT.md', () => {
  it('saves the file as heartbeatContent', async () => {
    const transport = renderPage(MANAGED);
    const editor = await screen.findByRole('textbox');
    expect(editor).toHaveValue(HEARTBEAT_FILE);
    await userEvent.type(editor, '\n- Ping me on red.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.updateAgentByPath).toHaveBeenCalledWith('/Users/dorian/agents/warden', {
        heartbeatContent: `${HEARTBEAT_FILE}\n- Ping me on red.`,
      })
    );
    // Saving re-reads the status, so a header that does not read shows at once.
    await waitFor(() => expect(transport.getAgentHeartbeat).toHaveBeenCalledTimes(2));
  });

  it('says in plain words when the settings at the top do not read', async () => {
    renderPage(MANAGED, {
      fileError: "wake: Invalid enum value. Expected 'timed' | 'events' | 'off'",
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/These settings don’t read/)).toBeInTheDocument();
    expect(within(alert).getByText('Set wake to timed, events or off.')).toBeInTheDocument();
  });

  it('offers to write one when there is no file', async () => {
    renderPage(MANAGED, {}, null);
    await userEvent.click(await screen.findByRole('button', { name: 'Write one' }));
    expect(await screen.findByRole('textbox')).toHaveValue('');
  });
});

describe('last checks', () => {
  it('lists each check with its line and how it ended, and links its chat when named', async () => {
    renderPage(MANAGED, {
      lastBeats: [
        {
          id: 'b1',
          startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          endedAt: null,
          kind: 'pulse',
          wake: 'timer',
          outcome: 'worked',
          summary: 'Sent Acme’s second reminder.',
          raises: 0,
          sessionId: 'chat-1',
        },
        {
          id: 'b2',
          startedAt: new Date(Date.now() - 65 * 60_000).toISOString(),
          endedAt: null,
          kind: 'pulse',
          wake: 'timer',
          outcome: 'quiet',
          summary: 'Checked 4 things. Nothing new.',
          raises: 0,
          sessionId: null,
        },
      ],
    });
    const list = await screen.findByRole('list', { name: 'Last checks' });
    expect(within(list).getByText('Sent Acme’s second reminder.')).toBeInTheDocument();
    expect(within(list).getByText('Worked')).toBeInTheDocument();
    expect(within(list).getByText('Quiet')).toBeInTheDocument();
    const links = within(list).getAllByRole('button', { name: 'Open chat' });
    expect(links).toHaveLength(1);
    await userEvent.click(links[0]!);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ session: 'chat-1' }) })
    );
  });

  it('says so when there are none', async () => {
    renderPage(MANAGED);
    expect(await screen.findByText('No checks yet.')).toBeInTheDocument();
  });
});

describe('held for your hours', () => {
  const held = (id: string, text?: string) => ({
    id,
    to: 'owner',
    rung: 'dm' as const,
    deliverAfter: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...(text === undefined ? {} : { text }),
  });

  it('counts the held messages and lists their texts', async () => {
    renderPage(MANAGED, {
      held: [held('o1', 'Acme paid.'), held('o2', 'The build is red.')] as HeartbeatStatus['held'],
    });
    expect(await screen.findByText('Held for your hours: 2.')).toBeInTheDocument();
    expect(screen.getByText('Acme paid.')).toBeInTheDocument();
    expect(screen.getAllByText(/^To you · Arrives /)).toHaveLength(2);
  });

  it('shows only the count when the texts are not yours to read', async () => {
    renderPage(OTHERS_AGENT, { held: [held('o1')] as unknown as HeartbeatStatus['held'] });
    expect(await screen.findByText('Held for your hours: 1.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Held messages' })).not.toBeInTheDocument();
  });

  it('draws nothing when nothing is held', async () => {
    renderPage(MANAGED);
    await screen.findByText('No checks yet.');
    expect(screen.queryByText(/Held for your hours/)).not.toBeInTheDocument();
  });
});

describe('someone else’s agent', () => {
  it('shows the facts with no editor and no controls', async () => {
    renderPage(OTHERS_AGENT, { wake: 'timed' });
    expect(await screen.findByText('Wakes every 30 minutes in your hours.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
