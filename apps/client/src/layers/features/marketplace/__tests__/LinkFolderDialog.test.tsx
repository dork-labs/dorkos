/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DevLinkPreviewResponse } from '@dorkos/shared/marketplace-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { LinkFolderDialog } from '../ui/LinkFolderDialog';

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: vi.fn().mockReturnValue({ data: { agents: [] } }),
}));

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
});

/** A preview answer for `/work/flow`. */
function card(overrides: Partial<DevLinkPreviewResponse> = {}): DevLinkPreviewResponse {
  return {
    name: 'flow',
    type: 'plugin',
    version: '1.0.0',
    path: '/work/flow',
    scope: 'global',
    slot: '/home/me/.dork/plugins/flow',
    replaces: null,
    effects: null,
    extensions: ['flow-dashboard'],
    change: 'CARD-A',
    ...overrides,
  };
}

/** A refusal shaped the way the HTTP transport raises one. */
function refusal(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

let transport: Transport;
const onOpenChange = vi.fn();

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<LinkFolderDialog open onOpenChange={onOpenChange} />, { wrapper });
}

/** Type a path and leave the field, which is what asks for the preview. */
async function enterPath(user: ReturnType<typeof userEvent.setup>, path: string) {
  await user.type(screen.getByLabelText('Folder'), path);
  await user.tab();
}

beforeEach(() => {
  transport = createMockTransport();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LinkFolderDialog', () => {
  it('keeps what was typed and says why when the folder cannot be linked', async () => {
    // Purpose: a refusal shows inline under the field and never clears the input.
    vi.mocked(transport.previewDevLink).mockRejectedValue(
      refusal('No package found in this folder.', 'dev_link_not_a_package')
    );
    const user = userEvent.setup();
    renderDialog();

    await enterPath(user, '/work/empty');

    expect(await screen.findByRole('alert')).toHaveTextContent('No package found in this folder.');
    expect(screen.getByLabelText('Folder')).toHaveValue('/work/empty');
    expect(screen.getByRole('button', { name: 'Link folder' })).toBeDisabled();
  });

  it('shows the card for the folder and links it with the card text it showed', async () => {
    // Purpose: the person's yes is bound to the preview they read (expectedChange).
    vi.mocked(transport.previewDevLink).mockResolvedValue(card());
    vi.mocked(transport.linkDevLink).mockResolvedValue({
      status: 'linked',
      link: {
        name: 'flow',
        type: 'plugin',
        scope: 'global',
        path: '/work/flow',
        state: 'active',
        parked: null,
        linkedAt: '2026-10-03T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderDialog();

    await enterPath(user, '/work/flow');

    expect(await screen.findByText('Run Flow from this folder?')).toBeInTheDocument();
    expect(screen.getByText('Edits here run in DorkOS right away, without asking.')).toBeVisible();
    expect(screen.getByText('Extension flow-dashboard')).toBeVisible();
    expect(transport.previewDevLink).toHaveBeenCalledWith({ path: '/work/flow', scope: 'global' });

    await user.click(screen.getByRole('button', { name: 'Link folder' }));

    await waitFor(() =>
      expect(transport.linkDevLink).toHaveBeenCalledWith({
        path: '/work/flow',
        scope: 'global',
        via: 'app',
        expectedChange: 'CARD-A',
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith('Flow runs from your folder.');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('needs the explicit tick before linking over an installed copy, and sends the same switch', async () => {
    // Purpose: design decision D2 — the installed copy is set aside only on an
    // explicit "Use my folder instead" tick, and preview and link agree on it.
    vi.mocked(transport.previewDevLink).mockImplementation(async (input) =>
      card({
        replaces: { version: '0.9.2' },
        change: input.replaceInstalled ? 'CARD-REPLACE' : 'CARD-PLAIN',
      })
    );
    vi.mocked(transport.linkDevLink).mockResolvedValue({
      status: 'linked',
      link: {
        name: 'flow',
        type: 'plugin',
        scope: 'global',
        path: '/work/flow',
        state: 'active',
        parked: { version: '0.9.2' },
        linkedAt: '2026-10-03T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderDialog();

    await enterPath(user, '/work/flow');

    expect(
      await screen.findByText('Your installed copy (v0.9.2) is set aside, not deleted.')
    ).toBeVisible();
    const linkButton = screen.getByRole('button', { name: 'Link folder' });
    expect(linkButton).toBeDisabled();

    await user.click(screen.getByLabelText('Use my folder instead of the installed copy'));

    await waitFor(() => expect(linkButton).toBeEnabled());
    expect(transport.previewDevLink).toHaveBeenLastCalledWith({
      path: '/work/flow',
      scope: 'global',
      replaceInstalled: true,
    });

    await user.click(linkButton);

    await waitFor(() =>
      expect(transport.linkDevLink).toHaveBeenCalledWith({
        path: '/work/flow',
        scope: 'global',
        replaceInstalled: true,
        via: 'app',
        expectedChange: 'CARD-REPLACE',
      })
    );
  });

  it('says the folder changed and shows its new card when the link is refused for it', async () => {
    // Purpose: dev_link_changed is never linked unread — the dialog checks again.
    vi.mocked(transport.previewDevLink)
      .mockResolvedValueOnce(card({ change: 'CARD-A' }))
      .mockResolvedValueOnce(card({ change: 'CARD-B', extensions: ['flow-dashboard', 'new'] }));
    vi.mocked(transport.linkDevLink).mockRejectedValue(
      refusal('The folder changed after you approved it. Ask again.', 'dev_link_changed')
    );
    const user = userEvent.setup();
    renderDialog();

    await enterPath(user, '/work/flow');
    await screen.findByText('Run Flow from this folder?');
    await user.click(screen.getByRole('button', { name: 'Link folder' }));

    expect(await screen.findByText('The folder changed. Check it again.')).toBeVisible();
    expect(await screen.findByText('Extension new')).toBeVisible();
    expect(transport.previewDevLink).toHaveBeenCalledTimes(2);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('waits for approval rather than claiming a link when the server asks for one', async () => {
    // Purpose: a 202 is impossible for the app, but if it comes it is not a success.
    vi.mocked(transport.previewDevLink).mockResolvedValue(card());
    vi.mocked(transport.linkDevLink).mockResolvedValue({
      status: 'approval_required',
      approval: {
        status: 'approval_required',
        capabilityId: 'marketplace.link',
        capabilityTitle: 'Run a package from a folder',
        tier: 'destructive',
        approvalId: 'a1',
        approvalToken: 't1',
        expiresAt: '2026-10-03T01:00:00.000Z',
        reason: 'tier',
        message: 'A person must approve this.',
        retry: { channel: 'http', field: 'X-DorkOS-Approval', instructions: '' },
      },
    });
    const user = userEvent.setup();
    renderDialog();

    await enterPath(user, '/work/flow');
    await screen.findByText('Run Flow from this folder?');
    await user.click(screen.getByRole('button', { name: 'Link folder' }));

    expect(
      await screen.findByText('Waiting for approval. Approve it, then link again.')
    ).toBeVisible();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Link folder' })).toBeDisabled();
  });
});
