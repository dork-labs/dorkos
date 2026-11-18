/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '@/layers/shared/model';
import { RemoteStepUpAction } from '../ui/RemoteStepUpAction';

afterEach(cleanup);
function setup(signOutDevice = vi.fn().mockResolvedValue(undefined)) {
  const transport = createMockTransport({ signOutDevice });
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={transport}>
        <RemoteStepUpAction deviceId="phone-1" notificationId="notice-1" />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}
describe('remote confirmation notice', () => {
  it('signs out exactly the named device through its transport', async () => {
    const transport = setup();
    expect(transport.signOutDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign it out' }));
    expect(await screen.findByText('Device signed out')).toBeVisible();
    expect(transport.signOutDevice).toHaveBeenCalledWith('phone-1');
  });
  it('stays answerable after the step-up is cancelled', async () => {
    setup(
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Confirmation cancelled'), { code: 'step_up_required' })
        )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign it out' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign it out' })).toBeEnabled());
    expect(screen.queryByText('Device signed out')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
