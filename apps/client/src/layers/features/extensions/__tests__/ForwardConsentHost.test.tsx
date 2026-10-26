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
      answer = requestForwardConsent({ appName: 'Dorian Desk', agentName: 'DorkOS PM' });
    });
    expect(screen.getByText('Send Dorian Desk comments to DorkOS PM?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await expect(answer).resolves.toBe(true);
  });

  it('Not now answers no, and only once', async () => {
    render(<ForwardConsentHost />);
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    act(() => {
      first = requestForwardConsent({ appName: 'A', agentName: 'One' });
      second = requestForwardConsent({ appName: 'A', agentName: 'Two' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await expect(first).resolves.toBe(false);
    // The second question is still waiting, not answered by the dialog closing.
    expect(await screen.findByText('Send A comments to Two?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await expect(second).resolves.toBe(true);
  });
});
