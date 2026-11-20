/**
 * Restart on an extension's "is off" notice (DOR-4785): it asks the server to
 * restart exactly the extension the notice names, and says when it worked.
 *
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { RestartExtensionAction, extensionIdOfStoppedNotice } from '../ui/RestartExtensionAction';
import { InboxRow } from '../ui/InboxRow';

let transport: ReturnType<typeof createMockTransport>;

beforeEach(() => {
  transport = createMockTransport();
});

afterEach(() => {
  cleanup();
});

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={transport}>{node}</TransportProvider>
    </QueryClientProvider>
  );
}

/** The "is off" notice, as the server sends it. */
const OFF: NotificationDTO = {
  id: '01JZR0000000000000000009',
  kind: 'extension.stopped',
  tier: 'notable',
  subject: { type: 'system', id: 'extension:people' },
  title: 'The People app is off',
  body: 'It stopped 3 times in 10 minutes, so DorkOS left it off.',
  actions: [{ id: 'restart-extension', label: 'Restart', style: 'primary' }],
  createdAt: new Date().toISOString(),
};

describe('Restart on a stopped extension’s notice', () => {
  it('restarts exactly the named extension, then says so', async () => {
    wrap(<RestartExtensionAction extensionId="people" notificationId="n-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('Restarted')).toBeVisible();
    expect(transport.restartExtension).toHaveBeenCalledExactlyOnceWith('people');
  });

  it('says it could not, and keeps the button, when the server refuses', async () => {
    vi.mocked(transport.restartExtension).mockRejectedValueOnce(new Error('Not approved'));
    wrap(<RestartExtensionAction extensionId="people" notificationId="n-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t restart it.');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });

  it('is drawn on the notice row only when the notice offers it', () => {
    wrap(<InboxRow notification={OFF} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    cleanup();
    wrap(
      <InboxRow
        notification={{
          ...OFF,
          title: 'The People app stopped responding. DorkOS is restarting it.',
          actions: undefined,
        }}
        onOpen={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(transport.restartExtension).not.toHaveBeenCalled();
  });

  it('reads the extension id back from the notice subject', () => {
    expect(extensionIdOfStoppedNotice('extension:people')).toBe('people');
    expect(extensionIdOfStoppedNotice('shell-check')).toBeNull();
  });
});
