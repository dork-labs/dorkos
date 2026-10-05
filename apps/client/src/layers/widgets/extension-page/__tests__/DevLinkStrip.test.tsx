/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { DevLinkStrip } from '../ui/DevLinkStrip';

const openLink = vi.fn();
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openLink: (href: string) => openLink(href),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const EXTENSION = {
  id: 'flow-dashboard',
  sourcePlugin: 'flow',
  devLink: { path: '/work/flow' },
} as ExtensionRecordPublic;

let transport: Transport;

function renderStrip(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function listing(parked: { version?: string } | null) {
  vi.mocked(transport.listDevLinks).mockResolvedValue({
    links: [
      {
        name: 'flow',
        type: 'plugin',
        scope: 'global',
        path: '/work/flow',
        state: 'active',
        parked,
        linkedAt: '2026-10-03T00:00:00.000Z',
      },
    ],
  });
}

beforeEach(() => {
  transport = createMockTransport();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DevLinkStrip', () => {
  it('shows the folder and offers the installed copy when one is set aside', async () => {
    // Purpose: the /x/<id> strip names the folder and the switch back (DOR-2696).
    listing({ version: '0.9.2' });
    renderStrip(<DevLinkStrip extension={EXTENSION} />);

    expect(screen.getByText('/work/flow')).toBeInTheDocument();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Use installed copy' }));
    expect(await screen.findByText('Your installed copy comes back.')).toBeInTheDocument();
  });

  it('sends a link with no installed copy to the Installed list instead of unlinking here', async () => {
    // Purpose: unlinking would remove the page in view, so the strip links out.
    listing(null);
    renderStrip(<DevLinkStrip extension={EXTENSION} />);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Unlink or switch' }));
    expect(openLink).toHaveBeenCalledWith('/marketplace?view=installed');
  });

  it('draws nothing for an extension that is not a dev link', () => {
    listing(null);
    const { container } = renderStrip(
      <DevLinkStrip extension={{ ...EXTENSION, devLink: undefined }} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
