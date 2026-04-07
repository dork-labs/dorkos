/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MarketplaceSource } from '@dorkos/shared/marketplace-schemas';
import {
  useMarketplaceSources,
  useAddMarketplaceSource,
  useRemoveMarketplaceSource,
} from '@/layers/entities/marketplace';

import { MarketplaceSourcesView } from '../ui/MarketplaceSourcesView';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplaceSources: vi.fn(),
  useAddMarketplaceSource: vi.fn(),
  useRemoveMarketplaceSource: vi.fn(),
}));

const addMutate = vi.fn();
const removeMutate = vi.fn();

function setSourcesState(state: { data?: MarketplaceSource[]; isLoading?: boolean }) {
  vi.mocked(useMarketplaceSources).mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useMarketplaceSources>);
}

function setAddMutationState(state: { isPending?: boolean } = {}) {
  vi.mocked(useAddMarketplaceSource).mockReturnValue({
    mutate: addMutate,
    mutateAsync: vi.fn(),
    isPending: state.isPending ?? false,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useAddMarketplaceSource>);
}

function setRemoveMutationState(state: { isPending?: boolean } = {}) {
  vi.mocked(useRemoveMarketplaceSource).mockReturnValue({
    mutate: removeMutate,
    mutateAsync: vi.fn(),
    isPending: state.isPending ?? false,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useRemoveMarketplaceSource>);
}

// ---------------------------------------------------------------------------
// Polyfills (Radix Dialog pointer capture + matchMedia)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<MarketplaceSource> = {}): MarketplaceSource {
  return {
    name: 'dorkos-official',
    source: 'https://github.com/dorkos/marketplace',
    enabled: true,
    addedAt: '2026-02-20T10:30:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketplaceSourcesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAddMutationState();
    setRemoveMutationState();
  });

  afterEach(cleanup);

  describe('state rendering', () => {
    it('renders the heading and Add Source button on every state', () => {
      setSourcesState({ data: [] });

      render(<MarketplaceSourcesView />);

      expect(screen.getByRole('heading', { name: /marketplace sources/i })).toBeInTheDocument();
      // Empty state renders the Add button twice (header + CTA).
      expect(screen.getAllByRole('button', { name: /add source/i }).length).toBeGreaterThanOrEqual(
        1
      );
    });

    it('renders the empty state when no sources are configured', () => {
      setSourcesState({ data: [] });

      render(<MarketplaceSourcesView />);

      expect(screen.getByText(/no sources configured/i)).toBeInTheDocument();
      expect(screen.getByText(/add a git registry/i)).toBeInTheDocument();
    });

    it('renders one card per source with name, URL, and date', () => {
      setSourcesState({
        data: [
          makeSource({ name: 'dorkos-official' }),
          makeSource({
            name: 'community',
            source: 'https://github.com/community/marketplace',
            enabled: false,
          }),
        ],
      });

      render(<MarketplaceSourcesView />);

      expect(screen.getByText('dorkos-official')).toBeInTheDocument();
      expect(screen.getByText('community')).toBeInTheDocument();
      expect(screen.getByText('https://github.com/dorkos/marketplace')).toBeInTheDocument();
      expect(screen.getByText('https://github.com/community/marketplace')).toBeInTheDocument();
    });

    it('differentiates enabled vs disabled sources via aria-label', () => {
      setSourcesState({
        data: [
          makeSource({ name: 'enabled-src', enabled: true }),
          makeSource({ name: 'disabled-src', enabled: false }),
        ],
      });

      render(<MarketplaceSourcesView />);

      // The Circle indicator renders with an aria-label of "Enabled" / "Disabled".
      expect(screen.getByLabelText('Enabled')).toBeInTheDocument();
      expect(screen.getByLabelText('Disabled')).toBeInTheDocument();
    });
  });

  describe('add source flow', () => {
    it('opens the add dialog when the header button is clicked', async () => {
      const user = userEvent.setup();
      setSourcesState({ data: [makeSource()] });

      render(<MarketplaceSourcesView />);

      // Dialog is not mounted by default.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /add source/i }));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.getByLabelText(/git url/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    });

    it('keeps the submit button disabled until both fields have values', async () => {
      const user = userEvent.setup();
      setSourcesState({ data: [] });

      render(<MarketplaceSourcesView />);

      // Use the header button (first Add Source) to open the dialog.
      await user.click(screen.getAllByRole('button', { name: /add source/i })[0]);

      const submit = await screen.findByRole('button', { name: /^add source$/i });
      expect(submit).toBeDisabled();

      // Fill only the URL — still disabled.
      await user.type(screen.getByLabelText(/git url/i), 'https://github.com/org/marketplace');
      expect(submit).toBeDisabled();

      // Fill the name — now enabled.
      await user.type(screen.getByLabelText(/^name$/i), 'my-registry');
      expect(submit).not.toBeDisabled();
    });

    it('fires addSource.mutate with the form values and enabled: true', async () => {
      const user = userEvent.setup();
      setSourcesState({ data: [] });

      render(<MarketplaceSourcesView />);

      await user.click(screen.getAllByRole('button', { name: /add source/i })[0]);

      await user.type(screen.getByLabelText(/git url/i), 'https://github.com/org/marketplace');
      await user.type(screen.getByLabelText(/^name$/i), 'my-registry');

      await user.click(screen.getByRole('button', { name: /^add source$/i }));

      expect(addMutate).toHaveBeenCalledTimes(1);
      expect(addMutate.mock.calls[0][0]).toEqual({
        name: 'my-registry',
        source: 'https://github.com/org/marketplace',
        enabled: true,
      });
    });

    it('trims whitespace from form inputs before submitting', async () => {
      const user = userEvent.setup();
      setSourcesState({ data: [] });

      render(<MarketplaceSourcesView />);

      await user.click(screen.getAllByRole('button', { name: /add source/i })[0]);

      await user.type(screen.getByLabelText(/git url/i), '  https://github.com/org/marketplace  ');
      await user.type(screen.getByLabelText(/^name$/i), '  my-registry  ');

      await user.click(screen.getByRole('button', { name: /^add source$/i }));

      expect(addMutate.mock.calls[0][0]).toEqual({
        name: 'my-registry',
        source: 'https://github.com/org/marketplace',
        enabled: true,
      });
    });
  });

  describe('remove source flow', () => {
    it('fires removeSource.mutate with the bare source name', async () => {
      const user = userEvent.setup();
      setSourcesState({ data: [makeSource({ name: 'dorkos-official' })] });

      render(<MarketplaceSourcesView />);

      await user.click(screen.getByRole('button', { name: /^remove dorkos-official$/i }));

      expect(removeMutate).toHaveBeenCalledTimes(1);
      expect(removeMutate).toHaveBeenCalledWith('dorkos-official');
    });

    it('disables all remove buttons while a removal is in flight', () => {
      setSourcesState({
        data: [makeSource({ name: 'source-1' }), makeSource({ name: 'source-2' })],
      });
      setRemoveMutationState({ isPending: true });

      render(<MarketplaceSourcesView />);

      expect(screen.getByRole('button', { name: /^remove source-1$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^remove source-2$/i })).toBeDisabled();
    });
  });
});
