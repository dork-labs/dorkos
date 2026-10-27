/**
 * @vitest-environment jsdom
 */
/**
 * The core first-use prompt for `api.forward` (DOR-3325): it names the app and
 * the agent it was handed, Allow answers yes, Not now answers no, once.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ForwardConsentHost } from '../ui/ForwardConsentHost';
import { requestForwardConsent } from '../model/forward-consent';

afterEach(cleanup);

describe('ForwardConsentHost', () => {
  it('draws nothing while nobody asks', () => {
    render(<ForwardConsentHost />);
    expect(screen.queryByTestId('forward-consent')).toBeNull();
  });

  it('asks with the registered agent name, and Allow answers yes', async () => {
    render(<ForwardConsentHost />);
    let answer: Promise<boolean> | undefined;
    act(() => {
      answer = requestForwardConsent({
        appName: 'Dorian Desk',
        agentName: 'DorkOS PM',
        agentHandle: 'dorkos-pm',
      });
    });
    expect(screen.getByText('Send Dorian Desk comments to DorkOS PM?')).toBeInTheDocument();
    expect(
      screen.getByText('They arrive in your chat as your own words, so it can act without asking.')
    ).toBeInTheDocument();
    // The registered handle, which an agent cannot change, on its own line.
    expect(screen.getByText('Registered as @dorkos-pm')).toBeInTheDocument();
    // Not now is where focus starts.
    expect(screen.getByRole('button', { name: 'Not now' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await expect(answer).resolves.toBe(true);
  });

  it('Not now answers no, and only once', async () => {
    render(<ForwardConsentHost />);
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    act(() => {
      first = requestForwardConsent({ appName: 'A', agentName: 'One', agentHandle: 'one' });
      second = requestForwardConsent({ appName: 'A', agentName: 'Two', agentHandle: 'two' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await expect(first).resolves.toBe(false);
    // The second question is still waiting, not answered by the dialog closing.
    expect(await screen.findByText('Send A comments to Two?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await expect(second).resolves.toBe(true);
  });

  it('Esc answers no', async () => {
    render(<ForwardConsentHost />);
    let answer: Promise<boolean> | undefined;
    act(() => {
      answer = requestForwardConsent({ appName: 'A', agentName: 'One', agentHandle: 'one' });
    });
    fireEvent.keyDown(screen.getByTestId('forward-consent'), { key: 'Escape' });
    await expect(answer).resolves.toBe(false);
  });
});
