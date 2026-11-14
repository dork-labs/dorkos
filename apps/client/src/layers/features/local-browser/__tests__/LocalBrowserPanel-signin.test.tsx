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
afterEach(() => {
  vi.restoreAllMocks();
});
const held = { ...connected, signInElsewhere: { handoffId: 'held-atlas' } };

it('1.11 shows one primary action and announces Paused without claiming other chats’ tabs', async () => {
  transport.getLocalBrowserState.mockResolvedValue(held);
  mount();
  await screen.findByRole('button', { name: 'Show the sign-in' });
  const panel = screen.getByRole('region', { name: 'Agent browser' });
  const status = within(panel).getByText(/^Paused$/);
  expect(status).toHaveAttribute('role', 'status');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(
    within(panel).getByText(
      'Paused while you sign in for another chat. Kai can still read this tab.'
    )
  ).toBeInTheDocument();
  const savedSignIns = within(panel).getByRole('region', { name: 'Saved sign-ins' });
  const show = within(panel).getByRole('button', { name: 'Show the sign-in' });
  const forget = within(savedSignIns).getByRole('button', { name: 'Forget…' });
  const buttons = within(panel).getAllByRole('button');
  expect(buttons).toEqual([show, forget]);
  expect(show).toHaveClass('h-auto', 'min-h-11', 'w-full', 'py-2', 'whitespace-normal');
  expect([...show.classList].filter((name) => /(?:^|:)h-(?!auto$)/.test(name))).toEqual([]);
  expect(
    show.compareDocumentPosition(savedSignIns) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(within(panel).queryByRole('combobox')).toBeNull();
  expect(within(panel).queryByLabelText('Web address')).toBeNull();
});

it('focuses only the held sign-in on an explicit click, without caching its answer in this chat', async () => {
  transport.getLocalBrowserState.mockResolvedValue(held);
  const other = { ...connected, sessionId: 'atlas', selectedTabId: 'private-atlas' };
  transport.signInLocalBrowser.mockResolvedValue(other);
  const view = mount();
  const show = await screen.findByRole('button', { name: 'Show the sign-in' });
  expect(transport.signInLocalBrowser).not.toHaveBeenCalled();
  fireEvent.click(show);
  await waitFor(() =>
    expect(transport.signInLocalBrowser).toHaveBeenCalledExactlyOnceWith({
      handoffId: 'held-atlas',
    })
  );
  await waitFor(() => expect(show).toBeEnabled());
  expect(view.client.getQueryData(['local-browser', 'state', 'chat-one'])).toEqual(held);
  expect(view.client.getQueryData(['local-browser', 'state', 'atlas'])).toBeUndefined();
  expect(transport.openLocalBrowser).not.toHaveBeenCalled();
  expect(transport.resumeLocalBrowser).not.toHaveBeenCalled();
  expect(transport.selectLocalBrowserTab).not.toHaveBeenCalled();
});

it('arrives and clears without taking focus, adding a receipt or restarting the agent', async () => {
  transport.getLocalBrowserState.mockResolvedValue(connected);
  const outside = document.createElement('input');
  outside.setAttribute('aria-label', 'Composer');
  document.body.append(outside);
  const view = mount();
  try {
    await screen.findByRole('button', { name: 'Pause agent' });
    const savedSignIns = screen.getByRole('region', { name: 'Saved sign-ins' });
    outside.focus();
    transport.getLocalBrowserState.mockResolvedValue(held);
    act(() => view.client.setQueryData(['local-browser', 'state', 'chat-one'], held));
    await screen.findByRole('button', { name: 'Show the sign-in' });
    expect(screen.getByRole('region', { name: 'Saved sign-ins' })).toBe(savedSignIns);
    expect(outside).toHaveFocus();
    transport.getLocalBrowserState.mockResolvedValue(connected);
    act(() =>
      view.client.setQueryData(['local-browser', 'state', 'chat-one'], {
        ...connected,
        signInElsewhere: null,
      })
    );
    await screen.findByRole('button', { name: 'Pause agent' });
    expect(screen.getByRole('region', { name: 'Saved sign-ins' })).toBe(savedSignIns);
    expect(outside).toHaveFocus();
    expect(screen.queryByText(/Handed back/)).toBeNull();
    expect(transport.resumeLocalBrowser).not.toHaveBeenCalled();
  } finally {
    outside.remove();
  }
});

it('keeps the paused state and saved sign-ins when showing the sign-in fails', async () => {
  transport.getLocalBrowserState.mockResolvedValue(held);
  transport.signInLocalBrowser.mockRejectedValue(new Error('private process details'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Show the sign-in' }));
  expect(await screen.findByRole('alert')).not.toHaveTextContent('private process details');
  expect(screen.getByText(/^Paused$/)).toHaveAttribute('role', 'status');
  expect(screen.getAllByRole('button')).toHaveLength(2);
  expect(screen.getByRole('region', { name: 'Saved sign-ins' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show the sign-in' })).toBeEnabled();
});

it('keeps a newly arrived sign-in hold when an older pause response finishes', async () => {
  transport.getLocalBrowserState.mockResolvedValue(connected);
  let finish!: (state: typeof connected) => void;
  transport.pauseLocalBrowser.mockReturnValue(
    new Promise<typeof connected>((resolve) => {
      finish = resolve;
    })
  );
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Pause agent' }));
  await waitFor(() => expect(transport.pauseLocalBrowser).toHaveBeenCalledOnce());
  transport.getLocalBrowserState.mockResolvedValue(held);
  act(() => view.client.setQueryData(['local-browser', 'state', 'chat-one'], held));
  await screen.findByRole('button', { name: 'Show the sign-in' });
  await act(async () => finish({ ...connected, paused: true }));
  expect(screen.getByText(/^Paused$/)).toHaveAttribute('role', 'status');
  expect(screen.getAllByRole('button')).toHaveLength(2);
  expect(screen.getByRole('region', { name: 'Saved sign-ins' })).toBeInTheDocument();
  expect(view.client.getQueryData(['local-browser', 'state', 'chat-one'])).toMatchObject({
    signInElsewhere: { handoffId: 'held-atlas' },
    paused: true,
  });
});
