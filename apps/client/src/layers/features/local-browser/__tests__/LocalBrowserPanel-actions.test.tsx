// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import {
  connected,
  mount,
  resetBrowserPanelFixture,
  transport,
} from './local-browser-panel-fixture';

beforeEach(resetBrowserPanelFixture);

const browsing: LocalBrowserPersonState = { ...connected, handoff: null, signIn: null };
const held: LocalBrowserPersonState = {
  ...browsing,
  paused: true,
  handoffAttached: true,
  handoffTaken: true,
  handoff: {
    id: 'made-up-handoff',
    sessionId: 'chat-one',
    agentName: 'Kai',
    agentId: null,
    agentFolder: null,
    profileId: null,
    reason: 'password',
    askedAt: '2026-11-14T00:00:00.000Z',
    site: 'northwind.example',
    outcome: null,
  },
};

const examples: {
  state: string;
  browser: LocalBrowserPersonState;
  primary: string;
  secondaries: string[];
}[] = [
  { state: '1.2', browser: browsing, primary: 'Pause agent', secondaries: ['Disconnect'] },
  {
    state: '1.3',
    browser: { ...browsing, paused: true },
    primary: 'Resume agent',
    secondaries: ['Disconnect'],
  },
  {
    state: '1.5',
    browser: held,
    primary: 'Hand back to Kai',
    secondaries: ['Show window', 'Close tab'],
  },
  {
    state: '1.7',
    browser: { ...held, handoffTaken: false, handoff: { ...held.handoff!, outcome: 'stopped' } },
    primary: 'Hand back to Kai',
    secondaries: ['Close tab'],
  },
  {
    state: '1.12',
    browser: {
      ...browsing,
      waitingForTab: true,
      idleTabToClose: {
        sessionId: 'chat-idle',
        title: 'Northwind quarterly research and planning',
      },
    },
    primary: 'Close the tab in Northwind quarterly research and planning',
    secondaries: ['See open tabs'],
  },
];

it.each(examples)(
  '$state groups its secondaries beside a primary that fills the phone row',
  async (example) => {
    transport.getLocalBrowserState.mockResolvedValue(example.browser);
    mount();
    const primary = await screen.findByRole('button', { name: example.primary });
    const actions = primary.closest('[data-slot="browser-panel-actions"]');
    expect(actions).not.toBeNull();
    expect(primary.parentElement).toBe(actions);
    expect(primary).toHaveClass('w-full', 'min-[480px]:w-auto');
    expect(actions).toHaveClass('flex', 'flex-wrap', 'items-center');
    const secondaries = actions!.querySelector('[data-slot="browser-panel-secondary-actions"]');
    expect(secondaries?.parentElement).toBe(actions);
    expect(secondaries).toHaveClass('flex', 'flex-wrap', 'items-center', 'min-w-0');
    const buttons = within(secondaries as HTMLElement).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(example.secondaries);
    for (const button of buttons) {
      expect(button).not.toHaveClass('w-full');
      expect(button).toHaveAttribute('data-variant', 'ghost');
    }
  }
);

it('1.4 keeps Show window as its primary without an empty secondary row', async () => {
  transport.getLocalBrowserState.mockResolvedValue({ ...held, handoffTaken: false });
  mount();
  const show = await screen.findByRole('button', { name: 'Show window' });
  const actions = show.closest('[data-slot="browser-panel-actions"]');
  expect(show.parentElement).toBe(actions);
  expect(actions?.querySelector('[data-slot="browser-panel-secondary-actions"]')).toBeNull();
});
