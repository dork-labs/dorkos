/**
 * @vitest-environment jsdom
 */
/**
 * The Handle field on an agent you manage (DOR-3156): it renames the agent by
 * its author id, not its roster id, says the server's own sentence for a
 * look-alike or a Wi-Fi refusal, and waits for a room when the agent has no
 * author row yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ProfileHandleField } from '../ui/fields/ProfileFields';

const WARDEN = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden')!;

let transport: ReturnType<typeof createMockTransport>;

function mount(member: TeamMember) {
  transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ProfileHandleField member={member} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Type a new handle and press Save. */
function submit(value: string) {
  fireEvent.change(screen.getByLabelText('Handle'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('the Handle field on an agent you manage', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('renames the agent by its author id, never its roster id', async () => {
    mount(WARDEN);
    expect(screen.getByText('What others type after @ to reach this agent.')).toBeTruthy();

    submit('warden-ops');

    await vi.waitFor(() =>
      expect(transport.setAuthorHandle).toHaveBeenCalledWith('author-warden', 'warden-ops')
    );
  });

  it.each([
    ['HANDLE_LOOKALIKE', '@d0rian looks too much like @dorian. Pick a different one.'],
    ['NOT_FROM_WIFI', "Change an agent's handle at this computer."],
  ])('draws the server’s own sentence for %s', async (code, sentence) => {
    mount(WARDEN);
    vi.mocked(transport.setAuthorHandle).mockRejectedValueOnce(
      Object.assign(new Error(sentence), { code })
    );

    submit('d0rian');

    expect(await screen.findByText(sentence)).toBeTruthy();
  });

  it('waits for a room when the agent has no author row yet', () => {
    const { authorId: _none, ...agent } = WARDEN.agent!;
    mount({ ...WARDEN, handle: null, agent });

    expect(screen.getByText('It gets a handle when it first joins a room.')).toBeTruthy();
    expect((screen.getByLabelText('Handle') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
