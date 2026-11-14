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
function expectWrappingButton(button: HTMLElement) {
  expect(button).toHaveClass('h-auto', 'min-h-11', 'py-2', 'whitespace-normal');
  expect([...button.classList].filter((name) => /(?:^|:)h-(?!auto$)/.test(name))).toEqual([]);
}

const waiting = {
  ...connected,
  status: 'disconnected' as const,
  tabs: [],
  selectedTabId: null,
  waitingForTab: true,
  idleTabToClose: { sessionId: 'chat-nova', title: 'Northwind quarterly research and planning' },
  openChatTabs: [
    {
      sessionId: 'chat-nova',
      title: 'Northwind quarterly research and planning',
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
    name: 'Close the tab in Northwind quarterly research and planning',
  });
  const panel = screen.getByRole('region', { name: 'Agent browser' });
  expect(within(panel).getByText(/^Waiting$/)).toHaveAttribute('role', 'status');
  expect(within(panel).getByText('All 6 tabs are in use by other chats.')).toBeInTheDocument();
  expect(within(panel).getByText('Kai will wait until one is free.')).toBeInTheDocument();
  expect(close).toHaveClass('w-full');
  expectWrappingButton(close);
  expect(
    within(panel)
      .getAllByRole('button')
      .map((b) => b.textContent)
  ).toEqual([
    'Close the tab in Northwind quarterly research and planning',
    'See open tabs',
    'Forget…',
  ]);
  expect(within(panel).queryByRole('combobox')).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'See open tabs' }));
  const dialog = await screen.findByRole('dialog', { name: 'Open chat tabs' });
  expect(
    within(dialog).getByRole('link', { name: /Northwind quarterly research and planning/ })
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
    await screen.findByRole('button', {
      name: 'Close the tab in Northwind quarterly research and planning',
    })
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
  expectWrappingButton(show);
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

it('moves from 1.4 to 1.5 only after the person shows the held tab, with a hand-back action', async () => {
  const held = {
    ...connected,
    paused: true,
    handoffAttached: true,
    handoffTaken: false,
    handoff: {
      id: 'made-up-handoff',
      sessionId: 'chat-one',
      site: 'northwind.example',
      outcome: null,
    },
  };
  transport.getLocalBrowserState.mockResolvedValue(held);
  transport.selectLocalBrowserTab.mockImplementation(async () => {
    transport.getLocalBrowserState.mockResolvedValue({ ...held, handoffTaken: true });
    return held;
  });
  transport.handBackLocalBrowser.mockResolvedValue(connected);
  mount();
  const show = await screen.findByRole('button', { name: 'Show window' });
  expectWrappingButton(show);
  expect(screen.getByText('Waiting for you')).toHaveAttribute('role', 'status');
  expect(screen.queryByRole('button', { name: 'Hand back to Kai' })).toBeNull();
  fireEvent.click(show);
  expect(await screen.findByText('You have it')).toHaveAttribute('role', 'status');
  expect(
    screen.getByText('Kai can’t see or use this tab until you hand it back.')
  ).toBeInTheDocument();
  expect(screen.queryByText(/Handed back/)).toBeNull();
  const handBack = screen.getByRole('button', { name: 'Hand back to Kai' });
  expectWrappingButton(handBack);
  expectWrappingButton(screen.getByRole('button', { name: 'Show window' }));
  fireEvent.click(handBack);
  await waitFor(() =>
    expect(transport.handBackLocalBrowser).toHaveBeenCalledExactlyOnceWith('made-up-handoff')
  );
  expect(transport.resumeLocalBrowser).not.toHaveBeenCalled();
});

it.each([390, 1280])(
  'focuses the first chat link when opening the 1.10 inventory at %ipx',
  async (width) => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: /max-width:\s*767px/.test(query) && width < 768,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    transport.getLocalBrowserState.mockResolvedValue(waiting);
    mount();
    const trigger = await screen.findByRole('button', { name: 'See open tabs' });
    expectWrappingButton(trigger);
    expect(trigger).toHaveClass('-ms-3', 'px-3');
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Open chat tabs' });
    const first = within(dialog).getByRole('link', {
      name: /Northwind quarterly research and planning/,
    });
    expect(within(first).getByText('northwind.example · Agent')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('https://');
    if (width >= 768) {
      expect(dialog).toHaveAttribute('data-side', 'bottom');
      expect(dialog).toHaveAttribute('data-align', 'start');
      expect(dialog).toHaveClass('max-w-(--radix-popover-content-available-width)');
    }
    await waitFor(() => expect(first).toHaveFocus());
  }
);

it('1.7 keeps focus, announces a stopped agent and lets the person hand back the fallen tab', async () => {
  const fallen = {
    ...connected,
    paused: true,
    handoffAttached: true,
    handoffTaken: false,
    handoff: {
      id: 'fallen-handoff',
      sessionId: 'chat-one',
      site: 'northwind.example',
      outcome: 'stopped',
    },
  };
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  transport.getLocalBrowserState.mockResolvedValue(fallen);
  transport.handBackLocalBrowser.mockResolvedValue(connected);
  try {
    mount();
    const back = await screen.findByRole('button', { name: 'Hand back to Kai' });
    expect(back).toBeEnabled();
    expectWrappingButton(back);
    expect(screen.getByText('You have it')).toHaveAttribute('role', 'status');
    expect(screen.getByText('Kai stopped, so this tab is yours now.')).toBeInTheDocument();
    expect(screen.getByText('It stays yours until you hand it back.')).toBeInTheDocument();
    expect(screen.getByText('Kai stopped. The tab is yours now.')).toHaveAttribute(
      'aria-live',
      'polite'
    );
    expect(screen.queryByText('Agent paused')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close tab' })).toBeEnabled();
    expect(input).toHaveFocus();
    fireEvent.click(back);
    await waitFor(() =>
      expect(transport.handBackLocalBrowser).toHaveBeenCalledExactlyOnceWith('fallen-handoff')
    );
    expect(transport.resumeLocalBrowser).not.toHaveBeenCalled();
  } finally {
    input.remove();
  }
});
