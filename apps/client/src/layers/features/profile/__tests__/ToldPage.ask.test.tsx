/**
 * @vitest-environment jsdom
 */
/**
 * "Ask {agent}" on What {agent} knows (DOR-4115): one press starts a NEW chat
 * in the agent's folder, on its own runtime, whose first message is the cold
 * check, sent at once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ToldPage } from '../ui/pages/ToldPage';
import { coldCheckPrompt } from '../lib/cold-check';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => navigate,
}));

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

const warden = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden')!;

/** A made-up agent on a made-up path. */
const ATLAS: TeamMember = {
  ...warden,
  id: 'agent-atlas',
  displayName: 'Atlas',
  handle: 'atlas',
  agent: {
    ...warden.agent!,
    manifestId: 'agent-atlas',
    projectPath: '/tmp/made-up/atlas',
    effectiveRuntimeId: 'codex',
  },
};

function renderPage(member: TeamMember) {
  const transport = createMockTransport({
    createSessionLocation: vi.fn().mockResolvedValue({ id: 'loc-atlas' }),
    getAgentPermissions: vi.fn().mockResolvedValue({
      agentId: member.id,
      agentName: member.displayName,
      overrides: {},
      filesAndCommands: {
        stop: null,
        source: 'runtime-own',
        inherited: { stop: null, source: 'runtime-own' },
      },
      areas: [],
    }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<ToldPage member={member} roster={[member]} onPush={vi.fn()} />, { wrapper });
  return transport;
}

describe('Ask {agent}', () => {
  it('starts a new chat in the agent’s folder that sends the cold check at once', async () => {
    const transport = renderPage(ATLAS);

    await userEvent.click(await screen.findByRole('button', { name: 'Ask Atlas' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(transport.createSessionLocation).toHaveBeenCalledWith('/tmp/made-up/atlas');
    const target = navigate.mock.calls[0]![0] as { search: Record<string, unknown> };
    expect(target.search).toMatchObject({
      launchRef: 'loc-atlas',
      draft: '1',
      runtime: 'codex',
      prompt: coldCheckPrompt('Atlas'),
      send: '1',
    });
    // A fresh session id, never the chat open now.
    expect(target.search.session).toEqual(expect.any(String));
  });

  it('asks before it looks, then checks its real levels', () => {
    const prompt = coldCheckPrompt('Atlas');
    expect(prompt).toMatch(/Without calling any tool/);
    expect(prompt).toMatch(/list_my_permissions/);
  });

  it('offers no button for an agent with no folder', async () => {
    renderPage({ ...ATLAS, agent: { ...ATLAS.agent!, projectPath: '' } });
    await screen.findByText('What Atlas can do');
    expect(screen.queryByRole('button', { name: 'Ask Atlas' })).not.toBeInTheDocument();
  });
});
