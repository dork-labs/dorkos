// @vitest-environment jsdom
/**
 * Settings → Server → Network (DOR-3361): the company certificates row says how
 * many certificates the desktop app actually trusts, from the server's
 * start-up record, and draws nothing where the setting does nothing. In the
 * desktop app the file comes from the native dialog (Choose…), and a change
 * says a restart is due, with Restart when the app can restart itself.
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
  const restartServer = vi.fn().mockResolvedValue({ message: 'ok' });
  const transport = createMockTransport({ updateConfig, restartServer });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <NetworkSection config={{ network } as ServerConfig} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { updateConfig, restartServer };
}

/** The desktop window's bridge: the file dialog and the server restart. */
function asDesktop(pick: string | null = BUNDLE) {
  const chooseCertificateFile = vi.fn().mockResolvedValue({ ok: true, path: pick });
  const restartServer = vi.fn().mockResolvedValue({ ok: true });
  window.electronAPI = {
    ...(window.electronAPI ?? {}),
    chooseCertificateFile,
    restartServer,
    resetAllData: vi.fn(),
  } as unknown as typeof window.electronAPI;
  return { chooseCertificateFile, restartServer };
}

afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
});

describe('NetworkSection', () => {
  it('shows how many certificates the app loaded, and from where', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'added', added: 3, path: BUNDLE },
    });
    const status = screen.getByTestId('company-certificates-status');
    expect(status).toHaveTextContent('Trusting 3 extra certificates from this file.');
    expect(screen.getByTitle(BUNDLE)).toHaveClass('font-mono');
    expect(screen.getByTestId('company-certificates-badge')).toHaveTextContent('3 certificates');
    expect(screen.getByLabelText('Company certificates file')).toHaveValue(BUNDLE);
  });

  it('says one certificate in the singular', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'added', added: 1, path: BUNDLE },
    });
    expect(screen.getByTestId('company-certificates-status')).toHaveTextContent(
      'Trusting 1 extra certificate from this file.'
    );
    expect(screen.getByTestId('company-certificates-badge')).toHaveTextContent('1 certificate');
  });

  it('says when the file could not be read', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'unreadable', added: 0, path: BUNDLE },
    });
    const status = screen.getByTestId('company-certificates-status');
    expect(status).toHaveTextContent('Couldn’t read this file');
    // Red lines carry the alert icon too, so colour is never the only signal.
    expect(status.querySelector('svg')).not.toBeNull();
  });

  it('says to choose another file when this one holds no certificate', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'empty', added: 0, path: BUNDLE },
    });
    const status = screen.getByTestId('company-certificates-status');
    expect(status).toHaveTextContent('No certificates found in this file. Choose a different one.');
    expect(status.querySelector('svg')).not.toBeNull();
  });

  it('says what is still in use, from where, until a restart', () => {
    renderSection({
      extraCaCertsPath: '/Users/kai/new-ca.pem',
      companyCertificates: { outcome: 'added', added: 3, path: BUNDLE },
    });
    const status = screen.getByTestId('company-certificates-status');
    expect(status).toHaveTextContent(
      `Still using 3 certificates from ${BUNDLE}. Restart DorkOS to use this file.`
    );
    // Not by colour alone: the line carries an icon too.
    expect(status.querySelector('svg')).not.toBeNull();
    // The file a restart will load, under the line, in mono.
    expect(screen.getByTitle('/Users/kai/new-ca.pem')).toHaveClass('font-mono');
    // No Restart in a browser: the page can't restart the app.
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('a first file says only that a restart is due', () => {
    renderSection({
      extraCaCertsPath: BUNDLE,
      companyCertificates: { outcome: 'not-set', added: 0, path: null },
    });
    expect(screen.getByTestId('company-certificates-status')).toHaveTextContent(
      /^Restart DorkOS to use this file\./
    );
    expect(screen.getByTitle(BUNDLE)).toHaveClass('font-mono');
  });

  it('shows NODE_EXTRA_CA_CERTS in mono', () => {
    renderSection({
      extraCaCertsPath: null,
      companyCertificates: { outcome: 'ignored-env', added: 0, path: null },
    });
    expect(screen.getByText('NODE_EXTRA_CA_CERTS')).toHaveClass('font-mono');
  });

  describe('in the desktop app', () => {
    it('Choose… saves the file picked in the native dialog, with no path field', async () => {
      const user = userEvent.setup();
      const { chooseCertificateFile } = asDesktop('/Users/kai/picked-ca.pem');
      const { updateConfig } = renderSection({
        extraCaCertsPath: null,
        companyCertificates: { outcome: 'ignored-env', added: 0, path: null },
      });
      expect(screen.queryByLabelText('Company certificates file')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Choose…' }));
      expect(chooseCertificateFile).toHaveBeenCalledTimes(1);
      expect(updateConfig).toHaveBeenCalledWith({
        network: { extraCaCertsPath: '/Users/kai/picked-ca.pem' },
      });
    });

    it('a cancelled dialog saves nothing', async () => {
      const user = userEvent.setup();
      asDesktop(null);
      const { updateConfig } = renderSection({
        extraCaCertsPath: null,
        companyCertificates: { outcome: 'not-set', added: 0, path: null },
      });
      await user.click(screen.getByRole('button', { name: /network/i }));
      await user.click(screen.getByRole('button', { name: 'Choose…' }));
      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('Stop using this file clears it with no confirm, and Restart restarts', async () => {
      const user = userEvent.setup();
      const { restartServer } = asDesktop();
      const { updateConfig } = renderSection({
        extraCaCertsPath: BUNDLE,
        companyCertificates: { outcome: 'added', added: 3, path: BUNDLE },
      });
      await user.click(screen.getByRole('button', { name: 'Stop using this file' }));
      expect(updateConfig).toHaveBeenCalledWith({ network: { extraCaCertsPath: null } });
      expect(screen.queryByRole('dialog')).toBeNull();
      cleanup();

      // The config after the stop: nothing chosen, three still in use.
      asDesktop();
      renderSection({
        extraCaCertsPath: null,
        companyCertificates: { outcome: 'added', added: 3, path: BUNDLE },
      });
      expect(screen.getByTestId('company-certificates-status')).toHaveTextContent(
        `Still using 3 certificates from ${BUNDLE}. Restart DorkOS to stop using it.`
      );
      // Nothing is chosen after a stop, so no path line.
      expect(screen.queryByTitle(BUNDLE)).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Restart' }));
      expect(window.electronAPI?.restartServer).toHaveBeenCalledTimes(1);
      expect(restartServer).not.toHaveBeenCalled();
    });
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
