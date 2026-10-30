// @vitest-environment jsdom
/**
 * Settings → Server → Network (DOR-3361): the company certificates row says how
 * many certificates the desktop app actually trusts, from the server's
 * start-up record, and draws nothing where the setting does nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { NetworkSection } from '../ui/network/NetworkSection';

const BUNDLE = '/Users/kai/company-ca.pem';

/** Render the card against a config whose `network` block the test sets. */
function renderSection(network: ServerConfig['network']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const updateConfig = vi.fn().mockResolvedValue(undefined);
  const transport = createMockTransport({ updateConfig });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <NetworkSection config={{ network } as ServerConfig} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { updateConfig };
}

afterEach(cleanup);

describe('NetworkSection', () => {
  it('shows how many certificates the app loaded, and from where', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'added', added: 3, path: BUNDLE },
    });
    expect(screen.getByTestId('company-certificates-status')).toHaveTextContent(
      `Trusting 3 extra certificates from ${BUNDLE}`
    );
    expect(screen.getByLabelText('Company certificates file')).toHaveValue(BUNDLE);
  });

  it('says one certificate in the singular', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'added', added: 1, path: BUNDLE },
    });
    expect(screen.getByTestId('company-certificates-status')).toHaveTextContent(
      `Trusting 1 extra certificate from ${BUNDLE}`
    );
  });

  it('says when the file could not be read', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'unreadable', added: 0, path: BUNDLE },
    });
    expect(screen.getByTestId('company-certificates-status')).toHaveTextContent(
      'Couldn’t read this file'
    );
  });

  it('says a restart is due when the saved file is not the one loaded', () => {
    renderSection({
      extraCaCertsPath: '/Users/kai/new-ca.pem',
      companyCertificates: { outcome: 'added', added: 3, path: BUNDLE },
    });
    expect(screen.getByTestId('company-certificates-status')).toHaveTextContent(
      'Restart DorkOS to use this file.'
    );
  });

  it('shows no status line when nothing is set', async () => {
    const user = userEvent.setup();
    renderSection({
      extraCaCertsPath: null,
      companyCertificates: { outcome: 'not-set', added: 0, path: null },
    });
    await user.click(screen.getByRole('button', { name: /network/i }));
    expect(screen.getByLabelText('Company certificates file')).toHaveValue('');
    expect(screen.queryByTestId('company-certificates-status')).toBeNull();
  });

  it('draws nothing outside the desktop app', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <TransportProvider transport={createMockTransport()}>
          <NetworkSection
            config={
              { network: { extraCaCertsPath: null, companyCertificates: null } } as ServerConfig
            }
          />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('saves a full path, and refuses a partial one', async () => {
    const user = userEvent.setup();
    const { updateConfig } = renderSection({
      extraCaCertsPath: null,
      companyCertificates: { outcome: 'ignored-env', added: 0, path: null },
    });
    const field = screen.getByLabelText('Company certificates file');

    await user.type(field, 'company-ca.pem{Enter}');
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByText('Use the full path to the file.')).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, `${BUNDLE}{Enter}`);
    expect(updateConfig).toHaveBeenCalledWith({ network: { extraCaCertsPath: BUNDLE } });
  });
});
