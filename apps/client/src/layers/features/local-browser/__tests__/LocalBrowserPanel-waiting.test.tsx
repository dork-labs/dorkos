// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  transport,
  connected,
  mount,
  resetBrowserPanelFixture,
} from './local-browser-panel-fixture';

beforeEach(resetBrowserPanelFixture);
afterEach(() => vi.restoreAllMocks());
const waiting = {
  ...connected,
  status: 'disconnected' as const,
  tabs: [],
  selectedTabId: null,
  waitingForTab: true,
  idleTabToClose: { sessionId: 'chat-nova', title: 'Northwind quarterly research' },
  openChatTabs: [
    {
      sessionId: 'chat-nova',
      title: 'Northwind quarterly research',
      origin: 'https://northwind.example',
      state: 'Agent' as const,
      idle: true,
    },
  ],
};

it('1.12 announces Waiting and offers the person an idle close before See open tabs', async () => {
  transport.getLocalBrowserState.mockResolvedValue(waiting);
  mount();
  const close = await screen.findByRole('button', {
    name: 'Close the tab in Northwind quarterly research',
  });
  const panel = screen.getByRole('region', { name: 'Agent browser' });
  expect(within(panel).getByText(/^Waiting$/)).toHaveAttribute('role', 'status');
  expect(within(panel).getByText('All 6 tabs are in use by other chats.')).toBeInTheDocument();
  expect(within(panel).getByText('Kai will wait until one is free.')).toBeInTheDocument();
  expect(close).toHaveClass('w-full', 'min-h-11', 'whitespace-normal');
  expect(
    within(panel)
      .getAllByRole('button')
      .map((b) => b.textContent)
  ).toEqual(['Close the tab in Northwind quarterly research', 'See open tabs', 'Forget…']);
  expect(within(panel).queryByRole('combobox')).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'See open tabs' }));
  const dialog = await screen.findByRole('dialog', { name: 'Open chat tabs' });
  expect(
    within(dialog).getByRole('link', { name: /Northwind quarterly research/ })
  ).toHaveAttribute('href', '/session?session=chat-nova');
});

it('offers only See open tabs when every tab is busy', async () => {
  transport.getLocalBrowserState.mockResolvedValue({ ...waiting, idleTabToClose: null });
  mount();
  await screen.findByRole('button', { name: 'See open tabs' });
  expect(screen.queryByRole('button', { name: /^Close the tab in/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
});

it('clears silently without moving focus or restarting the agent when a slot is assigned', async () => {
  transport.getLocalBrowserState.mockResolvedValue(waiting);
  const input = document.createElement('input');
  document.body.append(input);
  const view = mount();
  try {
    await screen.findByRole('button', { name: 'See open tabs' });
    input.focus();
    transport.getLocalBrowserState.mockResolvedValue(connected);
    act(() => view.client.setQueryData(['local-browser', 'state', 'chat-one'], connected));
    await screen.findByRole('button', { name: 'Pause agent' });
    expect(input).toHaveFocus();
    expect(screen.queryByText(/^Waiting$/)).toBeNull();
    expect(transport.resumeLocalBrowser).not.toHaveBeenCalled();
    await waitFor(() => expect(transport.openLocalBrowser).not.toHaveBeenCalled());
  } finally {
    input.remove();
  }
});

it('sends the named idle close through the person transport with this chat as requester', async () => {
  transport.getLocalBrowserState.mockResolvedValue(waiting);
  transport.closeIdleLocalBrowserTab.mockResolvedValue({ ...connected, waitingForTab: false });
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Close the tab in Northwind quarterly research' })
  );
  await waitFor(() =>
    expect(transport.closeIdleLocalBrowserTab).toHaveBeenCalledExactlyOnceWith(
      'chat-nova',
      'chat-one'
    )
  );
  expect(transport.disconnectLocalBrowser).not.toHaveBeenCalled();
});

it('keeps an attached sign-in in 1.4 and raises it only on this chat’s Show window action', async () => {
  transport.getLocalBrowserState.mockResolvedValue({
    ...connected,
    paused: true,
    handoffAttached: true,
    handoff: {
      id: 'made-up-handoff',
      sessionId: 'chat-one',
      site: 'northwind.example',
      outcome: null,
    },
  });
  transport.selectLocalBrowserTab.mockResolvedValue(connected);
  mount();
  const show = await screen.findByRole('button', { name: 'Show window' });
  expect(screen.getByText('Waiting for you')).toHaveAttribute('role', 'status');
  expect(screen.queryByText(/Handed back/)).toBeNull();
  expect(transport.selectLocalBrowserTab).not.toHaveBeenCalled();
  fireEvent.click(show);
  await waitFor(() =>
    expect(transport.selectLocalBrowserTab).toHaveBeenCalledExactlyOnceWith('one', 'chat-one')
  );
  expect(transport.resumeLocalBrowser).not.toHaveBeenCalled();
  expect(transport.signInLocalBrowser).not.toHaveBeenCalled();
});

it.each(['room', 'embedded', 'other-chat'] as const)(
  'keeps the chat tab inventory out of %s panels',
  async (scope) => {
    transport.getLocalBrowserState.mockResolvedValue({
      ...connected,
      mode: scope === 'embedded' ? 'embedded' : 'new-window',
      sessionId: scope === 'other-chat' ? 'another-chat' : connected.sessionId,
      openChatTabs: waiting.openChatTabs,
    });
    mount(true, scope === 'room' ? null : 'chat-one');
    await screen.findByRole('button', { name: 'Pause agent' });
    expect(screen.queryByRole('button', { name: /Also open in/ })).toBeNull();
  }
);
