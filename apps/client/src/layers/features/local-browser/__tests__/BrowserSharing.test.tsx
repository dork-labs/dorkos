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
  profile: { id: 'agent-atlas', label: 'Atlas’s browser', agentId: 'atlas', agentName: 'Atlas' },
};

it('opens a named-agent card only after a person clicks and shares exactly once', async () => {
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
      <BrowserSharing state={state} action={action} />
    </TransportProvider>
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(transport.bindLocalBrowserProfile).not.toHaveBeenCalled();
  fireEvent.click(
    await screen.findByRole('button', { name: 'This agent has its own browser. Share yours?' })
  );
  const card = await screen.findByRole('alertdialog', { name: 'Share your browser with Atlas?' });
  expect(
    within(card).getByText('Shares the sign-ins in your Chrome window (not the in-app browser).')
  ).toBeTruthy();
  expect(
    within(card).getByText('It can use everything you’re signed in to in this profile.')
  ).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: 'Share browser' }));
  await waitFor(() =>
    expect(transport.bindLocalBrowserProfile).toHaveBeenCalledExactlyOnceWith('default', 'atlas')
  );
  expect(transport.openLocalBrowser).toHaveBeenCalledWith({
    mode: 'new-window',
    sessionId: 'example-chat',
    profileId: 'default',
  });
});

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
  expect(
    screen.queryByRole('button', { name: 'This agent has its own browser. Share yours?' })
  ).toBeNull();
  await waitFor(() =>
    expect(transport.unbindLocalBrowserProfile).toHaveBeenCalledExactlyOnceWith('default', 'atlas')
  );
});
