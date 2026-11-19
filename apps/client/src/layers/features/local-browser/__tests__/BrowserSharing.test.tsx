// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { BrowserSharing } from '../ui/BrowserSharing';

const state: LocalBrowserState = {
  preparation: null,
  connectionId: 'example',
  sessionId: 'example-chat',
  mode: 'new-window',
  status: 'connected',
  paused: false,
  tabs: [],
  selectedTabId: null,
  revision: 0,
  profile: { id: 'agent-atlas', label: 'Atlas · browser', agentId: 'atlas', agentName: 'Atlas' },
};

it.each([
  {
    agentName: 'Atlas',
    title: 'Atlas',
    body: 'Atlas will use your own Chrome window and every site you’re signed in to there.',
  },
  {
    agentName: null,
    title: 'your agent',
    body: 'This agent will use your Chrome window and every site you’re signed in to there.',
  },
])(
  'opens a card for $title only after a person clicks and shares exactly once',
  async ({ agentName, title, body }) => {
    const transport = createMockTransport();
    vi.mocked(transport.bindLocalBrowserProfile).mockResolvedValue({
      id: 'default',
      label: 'Your browser',
      agentIds: ['atlas'],
      createdAt: 'now',
    });
    const action = vi.fn(async (run: () => Promise<LocalBrowserState>) => {
      await run();
      return true;
    });
    render(
      <TransportProvider transport={transport}>
        <BrowserSharing
          state={{ ...state, profile: { ...state.profile!, agentName } }}
          action={action}
        />
      </TransportProvider>
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(transport.bindLocalBrowserProfile).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Share yours' }));
    const card = await screen.findByRole('alertdialog', {
      name: `Share your browser with ${title}?`,
    });
    expect(screen.getByText('This agent has its own browser.')).toBeTruthy();
    expect(within(card).getByText(body)).toBeTruthy();
    expect(card.textContent).not.toMatch(/profile/i);
    fireEvent.click(within(card).getByRole('button', { name: 'Share browser' }));
    await waitFor(() =>
      expect(transport.bindLocalBrowserProfile).toHaveBeenCalledExactlyOnceWith('default', 'atlas')
    );
    expect(transport.openLocalBrowser).toHaveBeenCalledWith({
      mode: 'new-window',
      sessionId: 'example-chat',
      profileId: 'default',
    });
  }
);

it('stops sharing before reopening the agent’s own browser', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.listLocalBrowserProfiles).mockResolvedValue({
    profiles: [{ id: 'default', label: 'Your browser', agentIds: ['atlas'], createdAt: 'now' }],
  });
  const action = vi.fn(async (run: () => Promise<LocalBrowserState>) => {
    await run();
    return true;
  });
  render(
    <TransportProvider transport={transport}>
      <BrowserSharing
        state={{ ...state, profile: { ...state.profile!, id: 'default' } }}
        action={action}
      />
    </TransportProvider>
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }));
  await waitFor(() =>
    expect(transport.unbindLocalBrowserProfile).toHaveBeenCalledExactlyOnceWith('default', 'atlas')
  );
  expect(transport.openLocalBrowser).toHaveBeenCalledWith({
    mode: 'new-window',
    sessionId: 'example-chat',
  });
});

it('keeps Stop sharing available after reopening the agent’s own profile', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.listLocalBrowserProfiles).mockResolvedValue({
    profiles: [{ id: 'default', label: 'Your browser', agentIds: ['atlas'], createdAt: 'now' }],
  });
  const action = vi.fn(async (run: () => Promise<LocalBrowserState>) => {
    await run();
    return true;
  });
  render(
    <TransportProvider transport={transport}>
      <BrowserSharing state={state} action={action} />
    </TransportProvider>
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }));
  expect(screen.queryByRole('button', { name: 'Share yours' })).toBeNull();
  await waitFor(() =>
    expect(transport.unbindLocalBrowserProfile).toHaveBeenCalledExactlyOnceWith('default', 'atlas')
  );
});

it('keeps a marked-turn refusal as a status above the share buttons', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.bindLocalBrowserProfile).mockRejectedValue(
    Object.assign(new Error('Sharing waits.'), { code: 'outside_turn' })
  );
  const action = vi.fn();
  render(
    <TransportProvider transport={transport}>
      <BrowserSharing state={state} action={action} />
    </TransportProvider>
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Share yours' }));
  const card = await screen.findByRole('alertdialog');
  const share = within(card).getByRole('button', { name: 'Share browser' });
  fireEvent.click(share);
  const status = await within(card).findByRole('status');
  expect(status.textContent).toBe('Wait until this agent’s turn ends, then share.');
  expect(status.classList.contains('text-muted-foreground')).toBe(true);
  expect(status.classList.contains('text-xs')).toBe(true);
  expect(status.classList.contains('text-destructive')).toBe(false);
  expect(status.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).queryByRole('alert')).toBeNull();
  expect(within(card).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
  expect(transport.openLocalBrowser).not.toHaveBeenCalled();
});

it('shows a share that did not save as an error alert, not a muted status', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.bindLocalBrowserProfile).mockRejectedValue(new Error('Could not save.'));
  const action = vi.fn();
  render(
    <TransportProvider transport={transport}>
      <BrowserSharing state={state} action={action} />
    </TransportProvider>
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Share yours' }));
  const card = await screen.findByRole('alertdialog');
  fireEvent.click(within(card).getByRole('button', { name: 'Share browser' }));
  const alert = await within(card).findByRole('alert');
  expect(alert.textContent).toBe('Couldn’t change sharing. Try again.');
  expect(alert.classList.contains('text-destructive')).toBe(true);
  expect(alert.classList.contains('text-sm')).toBe(true);
  expect(alert.classList.contains('text-muted-foreground')).toBe(false);
  expect(alert.classList.contains('text-xs')).toBe(false);
  expect(within(card).queryByRole('status')).toBeNull();
  expect(action).not.toHaveBeenCalled();
  expect(transport.openLocalBrowser).not.toHaveBeenCalled();
});
