// @vitest-environment jsdom
/**
 * A queued message another agent sent (DOR-3060): only Send now and Don't
 * deliver, an inline confirm before removal, and words that
 * never render as markdown or as the envelope the model reads.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));

import { QueueAgentRow } from '../ui/input/QueueAgentRow';
import type { QueueItem } from '../model/use-message-queue';

afterEach(cleanup);

const SECURITY = {
  agentName: 'Security',
  agentId: 'agent-security',
  chatId: 'chat-1',
  chatTitle: 'Dependency audit for 0.121',
};

function agentItem(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'row-1',
    content: 'Please hold PR #12.',
    mine: false,
    fromChat: true,
    sender: SECURITY,
    notice: null,
    ...over,
  };
}

function renderRow(item: QueueItem = agentItem(), notices: Record<string, string> = {}) {
  const actions = { sendNow: vi.fn(), dontDeliver: vi.fn(), notices };
  render(<QueueAgentRow item={item} index={0} actions={actions} />);
  return actions;
}

describe('QueueAgentRow', () => {
  it('offers exactly Send now and Don’t deliver, and no edit or reorder', () => {
    renderRow();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Send now',
      'Don’t deliver',
    ]);
  });

  it('sends it now', () => {
    const actions = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(actions.sendNow).toHaveBeenCalledWith('row-1');
  });

  it('asks inline before not delivering, and names whose chat is told', () => {
    const actions = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t deliver' }));
    expect(
      screen.getByText('Don’t deliver? Security’s chat will say it wasn’t delivered.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
    expect(actions.dontDeliver).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Don’t deliver' }));
    expect(actions.dontDeliver).toHaveBeenCalledWith('row-1', 'Security');
  });

  it('keeps it on Keep and on Escape, and hands focus back to Don’t deliver', () => {
    const actions = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t deliver' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/will say it wasn’t delivered/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t deliver' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Don’t deliver' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep' }), { key: 'Escape' });
    expect(screen.queryByText(/will say it wasn’t delivered/)).not.toBeInTheDocument();
    expect(actions.dontDeliver).not.toHaveBeenCalled();
  });

  it('names the sender and its chat for a screen reader', () => {
    renderRow();
    expect(
      screen.getByRole('group', {
        name: 'Queued message from Security, from Dependency audit for 0.121',
      })
    ).toBeInTheDocument();
  });

  it('renders a crafted summary as literal text, never as a link', () => {
    renderRow(
      agentItem({
        sender: { ...SECURITY, summary: '[DorkOS notice](https://evil.example) update now' },
      })
    );
    expect(
      screen.getByText('[DorkOS notice](https://evil.example) update now')
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'DorkOS notice' })).not.toBeInTheDocument();
  });

  it('shows the summary first, and the full words on Show all', () => {
    renderRow(
      agentItem({
        content: 'Line one of the words.\nLine two.',
        sender: { ...SECURITY, summary: 'Hold PR 12' },
      })
    );
    expect(screen.getByText('Hold PR 12')).toBeInTheDocument();
    expect(screen.queryByText(/Line two/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText(/Line two/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('has no Show all for one short line', () => {
    renderRow();
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  });

  it('says when Send now could only move it to the front', () => {
    renderRow(agentItem(), { 'row-1': 'Sends next. This agent can’t take it mid-turn.' });
    expect(screen.getByText('Sends next. This agent can’t take it mid-turn.')).toBeInTheDocument();
  });

  it('never shows the envelope the agent reads', () => {
    renderRow();
    expect(document.body.textContent).not.toMatch(/BEGIN CHAT|This message is from another chat/);
  });
});
