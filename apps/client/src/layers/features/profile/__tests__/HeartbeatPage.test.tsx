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
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  vi.useRealTimers();
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
// The install owner's row, reading the page themselves (`isViewer`).
const OWNER: TeamMember = {
  ...MOCK_TEAM_ROSTER[0]!,
  person: { ...MOCK_TEAM_ROSTER[0]!.person!, accountId: 'acct-owner', isViewer: true },
};
const ROSTER = [OWNER, ...MOCK_TEAM_ROSTER.slice(1), PRIYA, OTHERS_AGENT];

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
  report: { cadence: 'daily', to: 'owner', nextReportAt: null, items: 0 },
};

function renderPage(
  member: TeamMember,
  status: Partial<HeartbeatStatus> = {},
  heartbeatContent: string | null = HEARTBEAT_FILE,
  getAgentHeartbeat = vi.fn().mockResolvedValue({ ...STATUS, ...status })
) {
  const transport = createMockTransport({
    getAgentHeartbeat,
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
  return Object.assign(transport, { client });
}

/** A beat whose chat the server names. */
const BEAT = {
  id: 'b1',
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  endedAt: null,
  kind: 'pulse' as const,
  wake: 'timer' as const,
  outcome: 'worked' as const,
  summary: 'Sent Acme’s second reminder.',
  raises: 0,
  sessionId: 'chat-1',
};

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
    expect(await screen.findByText('Wakes every 30 minutes in working hours.')).toBeInTheDocument();
    expect(screen.getByText('Next check in 12 min')).toBeInTheDocument();
  });

  it('counts the next check down with the clock, with no new data', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'Date'] });
    renderPage(MANAGED, {
      wake: 'timed',
      nextBeatAt: new Date(Date.now() + 12 * 60_000 - 1_000).toISOString(),
    });
    expect(await screen.findByText('Next check in 12 min')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    // The page's poll re-reads the same status, and structural sharing keeps
    // that from re-rendering anything: only the page's own clock moves this.
    expect(screen.getByText('Next check in 7 min')).toBeInTheDocument();
  });

  it('says heartbeats are off for everyone, with no controls, not even to open a chat', async () => {
    renderPage(MANAGED, {
      enabled: false,
      skippedReason: 'Heartbeats are off.',
      lastBeats: [BEAT],
    });
    expect(await screen.findByText('Heartbeats are off for everyone.')).toBeInTheDocument();
    expect(screen.getByText('Sent Acme’s second reminder.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the next report', () => {
  it('says who reads it, how often, and how much it covers so far', async () => {
    renderPage(MANAGED, {
      report: { cadence: 'daily', to: 'owner', nextReportAt: null, items: 3 },
    });
    expect(
      await screen.findByText('Reports to you each workday. 3 items so far.')
    ).toBeInTheDocument();
    cleanup();

    const lead = byId('agent-cartographer');
    renderPage(MANAGED, {
      report: { cadence: 'weekly', to: lead.agent!.manifestId!, nextReportAt: null, items: 0 },
    });
    expect(
      await screen.findByText(`Reports to ${lead.displayName} each week. Nothing to report yet.`)
    ).toBeInTheDocument();
  });

  it('says nothing about reports when the agent does not beat here', async () => {
    renderPage(MANAGED, { wake: 'off', skippedReason: 'Heartbeat off.' });
    await screen.findByText('Heartbeat off.');
    expect(screen.queryByText(/^Reports to/)).not.toBeInTheDocument();
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

  it('offers to write one when there is no file, and to change your mind', async () => {
    renderPage(MANAGED, {}, null);
    await userEvent.click(await screen.findByRole('button', { name: 'Write one' }));
    expect(await screen.findByRole('textbox')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write one' })).toBeInTheDocument();
  });

  it('keeps the editor and the draft when a refetch fails or the switch goes off', async () => {
    const getAgentHeartbeat = vi.fn().mockResolvedValueOnce(STATUS);
    const page = renderPage(MANAGED, {}, HEARTBEAT_FILE, getAgentHeartbeat);
    const editor = await screen.findByRole('textbox');
    await userEvent.type(editor, '\n- Unsaved.');

    getAgentHeartbeat.mockRejectedValueOnce(new Error('offline'));
    await act(() => page.client.refetchQueries());
    await waitFor(() => expect(getAgentHeartbeat).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox')).toHaveValue(`${HEARTBEAT_FILE}\n- Unsaved.`);
    expect(screen.queryByText('Couldn’t read this heartbeat.')).not.toBeInTheDocument();

    getAgentHeartbeat.mockResolvedValueOnce({ ...STATUS, enabled: false });
    await act(() => page.client.refetchQueries());
    expect(await screen.findByText('Heartbeats are off for everyone.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(`${HEARTBEAT_FILE}\n- Unsaved.`);
  });

  it('says it could not read the heartbeat when the first read fails', async () => {
    renderPage(MANAGED, {}, HEARTBEAT_FILE, vi.fn().mockRejectedValue(new Error('offline')));
    expect(await screen.findByText('Couldn’t read this heartbeat.')).toBeInTheDocument();
  });
});

describe('last checks', () => {
  it('lists each check with its line and how it ended, and links its chat when named', async () => {
    renderPage(MANAGED, {
      lastBeats: [
        BEAT,
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
    const links = within(list).getAllByRole('button', { name: /^Open chat from the check at / });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('Open chat');
    await userEvent.click(links[0]!);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ session: 'chat-1' }) })
    );
  });

  it('says so when there are none', async () => {
    renderPage(MANAGED);
    expect(await screen.findByText('No checks yet.')).toBeInTheDocument();
  });

  it('moves "5m ago" along with the clock, with no new data', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'Date'] });
    renderPage(MANAGED, { lastBeats: [BEAT] });
    const list = await screen.findByRole('list', { name: 'Last checks' });
    expect(within(list).getByText(/^\d+m ago$/)).toBeInTheDocument();
    const before = within(list).getByText(/^\d+m ago$/).textContent;
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(within(list).getByText(/^\d+m ago$/).textContent).not.toBe(before);
  });
});

describe('held until working hours', () => {
  const held = (id: string, text: string | null = null) => ({
    id,
    to: 'owner',
    rung: 'dm' as const,
    deliverAfter: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    text,
  });

  it('counts the held messages and lists their texts', async () => {
    renderPage(MANAGED, {
      held: [held('o1', 'Acme paid.'), held('o2', 'The build is red.')],
    });
    expect(await screen.findByText('Held until working hours: 2.')).toBeInTheDocument();
    expect(screen.getByText('Acme paid.')).toBeInTheDocument();
    expect(screen.getAllByText(/^To you · Arrives /)).toHaveLength(2);
  });

  it('lists who each message is for and when, without texts that are not yours', async () => {
    renderPage(OTHERS_AGENT, { held: [held('o1')] });
    expect(await screen.findByText('Held until working hours: 1.')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Held messages' });
    expect(within(list).getByText(/^To you · Arrives /)).toBeInTheDocument();
    expect(within(list).getAllByText(/./)).toHaveLength(1);
  });

  it('draws nothing when nothing is held', async () => {
    renderPage(MANAGED);
    await screen.findByText('No checks yet.');
    expect(screen.queryByText(/Held until working hours/)).not.toBeInTheDocument();
  });
});

describe('someone else’s agent', () => {
  it('shows the facts with no editor and no controls', async () => {
    renderPage(OTHERS_AGENT, { wake: 'timed' });
    expect(await screen.findByText('Wakes every 30 minutes in working hours.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
