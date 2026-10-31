// @vitest-environment jsdom
/**
 * The Team view's states: running, waiting, idle, over cap and nothing running,
 * and that a row opens its chat. The data hook is stubbed; its rules have their
 * own test in `team-board.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TeamBoard as TeamBoardData } from '../model/use-team-board';
import type { TeamBoardChat, TeamBoardRow } from '../model/team-board';

const mocks = vi.hoisted(() => ({
  board: null as unknown,
  navigate: vi.fn(),
}));

vi.mock('../model/use-team-board', () => ({ useTeamBoard: () => mocks.board }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => mocks.navigate,
}));

import { TeamBoard } from '../ui/TeamBoard';

const chat = (overrides: Partial<TeamBoardChat> = {}): TeamBoardChat => ({
  id: 'c1',
  cwd: '/work/a',
  title: 'Fix the login',
  activity: 'Running tests…',
  waiting: false,
  startedAt: null,
  ...overrides,
});

const row = (chats: TeamBoardChat[]): TeamBoardRow => ({
  agent: { id: 'a', name: 'Builder', color: '#000', emoji: '🤖', projectPath: '/work/a' },
  running: chats.filter((c) => !c.waiting).length,
  waiting: chats.filter((c) => c.waiting).length,
  chats,
});

const board = (overrides: Partial<TeamBoardData> = {}): TeamBoardData => ({
  figures: [{ key: 'chats', text: '1 of 14 chats running', over: false }],
  atCap: false,
  rows: [],
  otherChats: [],
  isEmpty: false,
  ...overrides,
});

afterEach(() => {
  cleanup();
  mocks.navigate.mockClear();
});

describe('TeamBoard', () => {
  it('shows a running chat under its agent and opens it on click', () => {
    mocks.board = board({ rows: [row([chat()])] });
    render(<TeamBoard />);
    const agentRow = screen.getByTestId('team-agent-row');
    expect(agentRow).toHaveTextContent('Builder');
    expect(agentRow).toHaveTextContent('1 running');
    expect(agentRow).toHaveTextContent('Running tests…');

    fireEvent.click(within(agentRow).getByTestId('team-chat-row'));
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });

  it('says Waiting in words, not colour alone', () => {
    mocks.board = board({ rows: [row([chat({ waiting: true })])] });
    render(<TeamBoard />);
    expect(screen.getByTestId('team-chat-row')).toHaveTextContent('Waiting');
    expect(screen.getByTestId('team-agent-row')).toHaveTextContent('1 waiting on you');
  });

  it('shows an idle agent as Idle with no chat rows', () => {
    mocks.board = board({ rows: [row([])] });
    render(<TeamBoard />);
    expect(screen.getByTestId('team-agent-row')).toHaveTextContent('Idle');
    expect(screen.queryByTestId('team-chat-row')).not.toBeInTheDocument();
  });

  it('draws a figure past its limit in amber and adds the cap line', () => {
    mocks.board = board({
      atCap: true,
      figures: [{ key: 'chats', text: '14 of 14 chats running, at the limit', over: true }],
    });
    render(<TeamBoard />);
    expect(screen.getByText('14 of 14 chats running, at the limit')).toHaveClass(
      'text-status-warning-fg'
    );
    expect(screen.getByTestId('team-cap')).toBeInTheDocument();
  });

  it('shows one quiet line when nothing is running', () => {
    mocks.board = board({ isEmpty: true, rows: [row([])] });
    render(<TeamBoard />);
    expect(screen.getByTestId('team-empty')).toHaveTextContent(
      'Nothing running. Agents start their next item when a slot frees.'
    );
    expect(screen.queryByTestId('team-agent-row')).not.toBeInTheDocument();
  });

  it('keeps chats no agent claims, so the total matches the rows', () => {
    mocks.board = board({ otherChats: [chat({ cwd: '/tmp/wt' })] });
    render(<TeamBoard />);
    expect(screen.getByTestId('team-other-chats')).toHaveTextContent('Fix the login');
  });

  it('shows how long a chat has run when the data says', () => {
    mocks.board = board({ rows: [row([chat({ startedAt: Date.now() - 12 * 60_000 })])] });
    render(<TeamBoard />);
    expect(screen.getByTestId('team-chat-row')).toHaveTextContent('12m');
  });
});
