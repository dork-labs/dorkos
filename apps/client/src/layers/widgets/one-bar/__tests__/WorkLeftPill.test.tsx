// @vitest-environment jsdom
/**
 * The session header's pill for commands a Stop left running (DOR-3285): it
 * counts the ones still running, hides once none are, and scrolls to the line.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { HistoryMessage, WorkLeftRunningPart } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { DEFAULT_SESSION_STREAM_STATE, useSessionStreamStore } from '@/layers/entities/session';
import { WorkLeftPill } from '../ui/WorkLeftPill';

const SESSION_ID = 'session-1';

function seed(messages: HistoryMessage[], inProgressTurn: SessionEvent[] = []) {
  act(() => {
    useSessionStreamStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [SESSION_ID]: { ...DEFAULT_SESSION_STREAM_STATE, messages, inProgressTurn },
      },
    }));
  });
}

function line(tasks: WorkLeftRunningPart['tasks'], id = 'work-left-running-5'): HistoryMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    parts: [{ type: 'work_left_running', tasks }],
  } as HistoryMessage;
}

afterEach(() => {
  cleanup();
  act(() => useSessionStreamStore.setState((state) => ({ ...state, sessions: {} })));
});

describe('WorkLeftPill', () => {
  it('draws nothing when no Stop left work running', () => {
    seed([]);
    render(<WorkLeftPill sessionId={SESSION_ID} />);
    expect(screen.queryByTestId('work-left-pill')).not.toBeInTheDocument();
  });

  it('says one command is running', () => {
    seed([line([{ taskId: 'tail', command: 'tail -f log' }])]);
    render(<WorkLeftPill sessionId={SESSION_ID} />);
    expect(screen.getByTestId('work-left-pill')).toHaveTextContent('1 command running');
  });

  it('counts only the commands that have not ended, live ends included', () => {
    seed(
      [
        line([
          { taskId: 'tail', command: 'tail -f log' },
          { taskId: 'deploy', command: 'npm run deploy' },
          { taskId: 'sleep', command: 'sleep 600', ended: 'completed' },
        ]),
      ],
      [
        {
          type: 'work_left_running',
          seq: 9,
          tasks: [{ taskId: 'watch', command: 'npm run watch' }],
        } as SessionEvent,
      ]
    );
    render(<WorkLeftPill sessionId={SESSION_ID} />);
    expect(screen.getByTestId('work-left-pill')).toHaveTextContent('3 commands running');

    seed(useSessionStreamStore.getState().sessions[SESSION_ID]!.messages, [
      ...useSessionStreamStore.getState().sessions[SESSION_ID]!.inProgressTurn,
      { type: 'work_left_ended', seq: 10, taskId: 'deploy', status: 'stopped' } as SessionEvent,
    ]);
    expect(screen.getByTestId('work-left-pill')).toHaveTextContent('2 commands running');
  });

  it('hides once every command has ended', () => {
    seed([line([{ taskId: 'tail', command: 'tail -f log', ended: 'failed' }])]);
    render(<WorkLeftPill sessionId={SESSION_ID} />);
    expect(screen.queryByTestId('work-left-pill')).not.toBeInTheDocument();
  });

  it('scrolls to the line that names the commands', async () => {
    seed([line([{ taskId: 'tail', command: 'tail -f log' }])]);
    const target = document.createElement('div');
    target.id = 'work-left-tail';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    render(<WorkLeftPill sessionId={SESSION_ID} />);

    await userEvent.click(screen.getByTestId('work-left-pill'));

    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    target.remove();
  });
});
