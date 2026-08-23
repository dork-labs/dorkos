// @vitest-environment jsdom
/**
 * What one room says about its own automatic-reply limits.
 *
 * The three things worth pinning are all about inheritance: a room that says
 * nothing must still say what bounds it, clearing an override must send the
 * explicit `null` that clears it server-side (an absent field is a no-op), and
 * the section must not be offered to a reader the server would refuse.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { ServerConfig } from '@dorkos/shared/types';
import { ROOM_TURN_LIMIT_DEFAULTS } from '@dorkos/shared/config-schema';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { RoomLimitsSection } from '../ui/RoomLimitsSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** One member, so the roster can say what kind of reader is looking. */
function member(authorId: string, kind: 'human' | 'agent') {
  return {
    authorId,
    responseMode: 'engaged',
    lastReadSeq: 0,
    origin: 'local',
    author: { id: authorId, kind, displayName: kind === 'human' ? 'Dorian' : 'Scout' },
  };
}

function room(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'backend',
    title: 'Backend',
    topic: null,
    archived: false,
    createdAt: '2026-08-22T10:00:00.000Z',
    lastActivityAt: '2026-08-22T10:00:00.000Z',
    turnLimitsEnabled: null,
    maxAgentDepth: null,
    maxTurnsPerAgentPerCascade: null,
    maxAutoTurnsPerHour: null,
    members: [member('author-me', 'human')],
    viewerAuthorId: 'author-me',
    ...overrides,
  } as unknown as RoomWithRoster;
}

function renderSection(
  subject: RoomWithRoster,
  installLimits: Partial<
    Record<keyof typeof ROOM_TURN_LIMIT_DEFAULTS, number | boolean>
  > | null = {}
): { transport: Transport } {
  const config = {
    rooms:
      installLimits === null
        ? { engagedWindowMinutes: 10, engagedWindowPosts: 5 }
        : {
            engagedWindowMinutes: 10,
            engagedWindowPosts: 5,
            ...ROOM_TURN_LIMIT_DEFAULTS,
            ...installLimits,
          },
  } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    updateRoom: vi.fn().mockResolvedValue(subject),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<RoomLimitsSection room={subject} />, { wrapper });
  return { transport };
}

/** Open the section — it is collapsed until asked for. */
async function openSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Automatic replies/ }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('RoomLimitsSection', () => {
  it('offers all three stances, on "Follow Settings" for an untouched room', async () => {
    const user = userEvent.setup();
    renderSection(room());
    await openSection(user);

    expect(screen.getByRole('radio', { name: 'Follow Settings' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Limited' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Not limited' })).not.toBeChecked();
  });

  it('reads back the stance this room stored', async () => {
    const user = userEvent.setup();
    renderSection(room({ turnLimitsEnabled: false }));
    await openSection(user);

    expect(screen.getByRole('radio', { name: 'Not limited' })).toBeChecked();
    // The collapsed section says so too, so a closed panel still reports a room
    // running without limits.
    expect(
      screen.getByRole('button', { name: 'Automatic replies Not limited' })
    ).toBeInTheDocument();
  });

  it('shows the number Settings holds as the default an untouched field would use', async () => {
    const user = userEvent.setup();
    renderSection(room(), { maxAgentDepth: 12 });
    await openSection(user);

    expect(screen.getByLabelText('Replies in a row')).toHaveAttribute(
      'placeholder',
      'Default (12)'
    );
    expect(screen.getByLabelText('Replies in a row')).toHaveValue(null);
  });

  it('says only "Default" while Settings has not been read', async () => {
    const user = userEvent.setup();
    renderSection(room(), null);
    await openSection(user);

    expect(screen.getByLabelText('Replies in a row')).toHaveAttribute('placeholder', 'Default');
  });

  it('writes an override the reader types', async () => {
    const user = userEvent.setup();
    const { transport } = renderSection(room());
    await openSection(user);

    await user.type(screen.getByLabelText('Replies in a row'), '5');
    await user.tab();

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { maxAgentDepth: 5 })
    );
  });

  it('sends an explicit null when an override is cleared', async () => {
    const user = userEvent.setup();
    const { transport } = renderSection(room({ maxAgentDepth: 5 }));
    await openSection(user);

    await user.click(screen.getByRole('button', { name: 'Use the default' }));

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { maxAgentDepth: null })
    );
  });

  it('clears the override when the field is emptied, not just by the button', async () => {
    const user = userEvent.setup();
    const { transport } = renderSection(room({ maxAgentDepth: 5 }));
    await openSection(user);

    await user.clear(screen.getByLabelText('Replies in a row'));
    await user.tab();

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { maxAgentDepth: null })
    );
  });

  it('sends null for the stance too, when the room is handed back to Settings', async () => {
    const user = userEvent.setup();
    const { transport } = renderSection(room({ turnLimitsEnabled: false }));
    await openSection(user);

    await user.click(screen.getByRole('radio', { name: 'Follow Settings' }));

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { turnLimitsEnabled: null })
    );
  });

  it('holds the numbers, disabled, while the room is unlimited', async () => {
    const user = userEvent.setup();
    renderSection(room({ turnLimitsEnabled: false, maxAgentDepth: 5 }));
    await openSection(user);

    const depth = screen.getByLabelText('Replies in a row');
    expect(depth).toBeDisabled();
    expect(depth).toHaveValue(5);
  });

  it('refuses a number outside the bounds rather than clamping it', async () => {
    const user = userEvent.setup();
    const { transport } = renderSection(room());
    await openSection(user);

    await user.type(screen.getByLabelText('Replies in a row'), '500');
    await user.tab();

    expect(
      await screen.findByText(
        'Enter a whole number from 0 to 100, or leave it empty for the default.'
      )
    ).toBeInTheDocument();
    expect(transport.updateRoom).not.toHaveBeenCalled();
  });

  it('is not offered at all to a reader the server would refuse', () => {
    renderSection(
      room({
        members: [member('author-bot', 'agent')],
        viewerAuthorId: 'author-bot',
      } as Partial<RoomWithRoster>)
    );

    expect(screen.queryByRole('button', { name: /Automatic replies/ })).not.toBeInTheDocument();
  });

  it('stays visible for a reader the roster does not place', () => {
    // Seeing a room and being in it are different things, and not being on the
    // roster is not evidence of being an agent.
    renderSection(room({ members: [], viewerAuthorId: 'author-me' } as Partial<RoomWithRoster>));

    expect(screen.getByRole('button', { name: /Automatic replies/ })).toBeInTheDocument();
  });
});
