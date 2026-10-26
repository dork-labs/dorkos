// @vitest-environment jsdom
/**
 * The line a Stop leaves for background commands it could not end (DOR-3285).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { WorkLeftRunningPart } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { WorkLeftRunningRow, middleTruncate } from '../WorkLeftRunningRow';

const SESSION_ID = 'session-1';
const COULD_NOT_STOP = 'Couldn’t stop it, and it may keep running after DorkOS quits.';

afterEach(cleanup);

function renderRow(part: WorkLeftRunningPart, transport = createMockTransport()) {
  render(
    <TransportProvider transport={transport}>
      <WorkLeftRunningRow sessionId={SESSION_ID} part={part} />
    </TransportProvider>
  );
  return transport;
}

const acked = (taskId: string) => ({
  receipt: { outcome: 'acked' as const, runtime: 'claude-code' },
  taskId,
});

const ONE: WorkLeftRunningPart = {
  type: 'work_left_running',
  tasks: [{ taskId: 'tail', command: 'tail -f server.log' }],
};

const SEVERAL: WorkLeftRunningPart = {
  type: 'work_left_running',
  tasks: [
    { taskId: 'tail', command: 'tail -f server.log' },
    { taskId: 'deploy', command: 'npm run deploy' },
  ],
};

describe('WorkLeftRunningRow', () => {
  it('names the one command still running, with a Stop command button', () => {
    renderRow(ONE);
    const row = screen.getByTestId('work-left-running-row');
    expect(row).toHaveTextContent('Stopped. 1 command is still running:');
    expect(row).toHaveClass('text-status-warning-fg');
    expect(screen.getByText('tail -f server.log')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop command' })).toBeInTheDocument();
  });

  it('counts several, with one Stop per command', () => {
    renderRow(SEVERAL);
    expect(screen.getByTestId('work-left-running-row')).toHaveTextContent(
      'Stopped. 2 commands are still running.'
    );
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(2);
    expect(screen.getByText('npm run deploy')).toBeInTheDocument();
  });

  it('stops that one command by its task id', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.stopTask).mockResolvedValue(acked('deploy'));
    renderRow(SEVERAL, transport);

    await userEvent.click(screen.getAllByRole('button', { name: 'Stop' })[1]!);

    expect(transport.stopTask).toHaveBeenCalledWith(SESSION_ID, 'deploy');
    await waitFor(() =>
      expect(screen.getByTestId('work-left-running-row')).toHaveTextContent(
        'Stopped. 1 command is still running:'
      )
    );
  });

  it('says plainly when a command would not stop, in place of its button', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.stopTask).mockRejectedValue(new Error('nope'));
    renderRow(ONE, transport);

    await userEvent.click(screen.getByRole('button', { name: 'Stop command' }));

    expect(await screen.findByText(COULD_NOT_STOP)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop command' })).not.toBeInTheDocument();
  });

  it('treats a stop the runtime did not confirm as a failure too', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.stopTask).mockResolvedValue({
      receipt: { outcome: 'unconfirmed', runtime: 'claude-code' },
      taskId: 'tail',
    });
    renderRow(ONE, transport);

    await userEvent.click(screen.getByRole('button', { name: 'Stop command' }));

    expect(await screen.findByText(COULD_NOT_STOP)).toBeInTheDocument();
  });

  it('reads muted, with no buttons, once everything has ended', () => {
    renderRow({
      type: 'work_left_running',
      tasks: [
        { taskId: 'tail', command: 'tail -f server.log', ended: 'stopped' },
        { taskId: 'deploy', command: 'npm run deploy', ended: 'completed' },
      ],
    });
    const row = screen.getByTestId('work-left-running-row');
    expect(row).toHaveTextContent('Stopped. Everything has ended.');
    expect(row).toHaveClass('text-muted-foreground');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('counts only the commands that have not ended', () => {
    renderRow({
      type: 'work_left_running',
      tasks: [
        { taskId: 'tail', command: 'tail -f server.log', ended: 'failed' },
        { taskId: 'deploy', command: 'npm run deploy' },
      ],
    });
    expect(screen.getByTestId('work-left-running-row')).toHaveTextContent(
      'Stopped. 1 command is still running:'
    );
    expect(screen.queryByText('tail -f server.log')).not.toBeInTheDocument();
  });

  it('cuts a long command in the middle and keeps the whole of it in the title', () => {
    const command = `node scripts/migrate.js --from ${'a'.repeat(80)} --to production-db`;
    renderRow({ type: 'work_left_running', tasks: [{ taskId: 'm', command }] });
    const shown = screen.getByTitle(command);
    expect(shown.textContent).toBe(middleTruncate(command));
    expect(shown.textContent!.length).toBe(60);
    expect(shown.textContent!.startsWith('node scripts/')).toBe(true);
    expect(shown.textContent!.endsWith('production-db')).toBe(true);
    expect(shown.textContent).toContain('…');
  });

  it('draws a command as plain text, never as markdown or a link', () => {
    const command = 'echo "**bold**" [link](https://example.com) <b>x</b>';
    renderRow({ type: 'work_left_running', tasks: [{ taskId: 'e', command }] });
    expect(screen.getByTitle(command).textContent).toBe(command);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('strong, b')).toBeNull();
  });

  it('carries a stable id derived from the line, for the header pill', () => {
    renderRow(SEVERAL);
    expect(screen.getByTestId('work-left-running-row')).toHaveAttribute('id', 'work-left-tail');
  });
});
