/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { DEFAULT_TEMPLATES } from '@dorkos/shared/template-catalog';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { TemplatePicker } from '../ui/TemplatePicker';

// ---------------------------------------------------------------------------
// Mock the marketplace entity so each test can control the Dork Hub tab state
// independently of the Transport. Existing built-in tab tests default to an
// empty marketplace response (no error, no agents), which preserves prior
// behavior.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
}));

type MarketplaceHookState = {
  data?: AggregatedPackage[];
  error?: Error | null;
  isLoading?: boolean;
};

function setMarketplaceState(state: MarketplaceHookState) {
  vi.mocked(useMarketplacePackages).mockReturnValue({
    data: state.data,
    error: state.error ?? null,
    isLoading: state.isLoading ?? false,
    // The component only reads `data` and `error`, but TanStack Query's
    // UseQueryResult has many fields; cast keeps the type surface small.
  } as unknown as ReturnType<typeof useMarketplacePackages>);
}

// ---------------------------------------------------------------------------
// Browser API mocks
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
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPicker(props: { selectedTemplate?: string | null; onSelect?: () => void } = {}) {
  const transport = createMockTransport();
  vi.mocked(transport.getTemplates).mockResolvedValue(DEFAULT_TEMPLATES);

  const onSelect = props.onSelect ?? vi.fn();
  const queryClient = createTestQueryClient();

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TemplatePicker selectedTemplate={props.selectedTemplate ?? null} onSelect={onSelect} />
      </TransportProvider>
    </QueryClientProvider>
  );

  return { ...result, onSelect, transport, queryClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TemplatePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: marketplace hook returns an empty agent list with no error.
    // Individual tests override via setMarketplaceState().
    setMarketplaceState({ data: [] });
  });

  afterEach(cleanup);

  it('renders all default templates in the grid', async () => {
    renderPicker();

    for (const template of DEFAULT_TEMPLATES) {
      expect(await screen.findByText(template.name)).toBeInTheDocument();
    }
  });

  it('renders template descriptions', async () => {
    renderPicker();

    // Wait for templates to load, then check a description
    await screen.findByText('Blank');
    expect(
      screen.getByText('Empty agent workspace — just agent.json and convention files')
    ).toBeInTheDocument();
  });

  it('category tabs filter templates to matching category', async () => {
    const user = userEvent.setup();
    renderPicker();

    // Wait for all templates
    await screen.findByText('Blank');

    // Click "Frontend" tab
    await user.click(screen.getByRole('tab', { name: 'Frontend' }));

    const grid = screen.getByTestId('template-grid');
    // Frontend templates should be visible
    expect(within(grid).getByText('Next.js')).toBeInTheDocument();
    expect(within(grid).getByText('Vite + React')).toBeInTheDocument();

    // Non-frontend templates should be gone
    expect(within(grid).queryByText('Blank')).not.toBeInTheDocument();
    expect(within(grid).queryByText('Express')).not.toBeInTheDocument();
    expect(within(grid).queryByText('FastAPI')).not.toBeInTheDocument();
    expect(within(grid).queryByText('TypeScript Library')).not.toBeInTheDocument();
    expect(within(grid).queryByText('CLI Tool')).not.toBeInTheDocument();
  });

  it('clicking "All" tab shows all templates after filtering', async () => {
    const user = userEvent.setup();
    renderPicker();

    await screen.findByText('Blank');

    // Filter to backend
    await user.click(screen.getByRole('tab', { name: 'Backend' }));
    const grid = screen.getByTestId('template-grid');
    expect(within(grid).queryByText('Blank')).not.toBeInTheDocument();

    // Return to All
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(within(grid).getByText('Blank')).toBeInTheDocument();
    expect(within(grid).getByText('Express')).toBeInTheDocument();
  });

  it('clicking a template calls onSelect with template ID', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await screen.findByText('Blank');
    await user.click(screen.getByTestId('template-card-nextjs'));

    expect(onSelect).toHaveBeenCalledWith('nextjs');
  });

  it('clicking the selected template deselects it (calls onSelect with null)', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker({ selectedTemplate: 'nextjs' });

    await screen.findByText('Next.js');
    await user.click(screen.getByTestId('template-card-nextjs'));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('custom URL input calls onSelect with URL value', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await screen.findByText('Blank');

    const urlInput = screen.getByTestId('custom-url-input');
    await user.type(urlInput, 'github.com/my/repo');

    // onSelect should have been called with the accumulating URL
    expect(onSelect).toHaveBeenLastCalledWith('github.com/my/repo');
  });

  it('clearing custom URL input calls onSelect with null', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await screen.findByText('Blank');

    const urlInput = screen.getByTestId('custom-url-input');
    await user.type(urlInput, 'x');
    await user.clear(urlInput);

    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('selecting a template clears the custom URL input', async () => {
    const user = userEvent.setup();
    renderPicker();

    await screen.findByText('Blank');

    // Type a URL first
    const urlInput = screen.getByTestId('custom-url-input');
    await user.type(urlInput, 'github.com/my/repo');

    // Select a template
    await user.click(screen.getByTestId('template-card-blank'));

    // URL input should be cleared
    expect(urlInput).toHaveValue('');
  });

  it('shows checkmark on selected template card', async () => {
    renderPicker({ selectedTemplate: 'express' });

    await screen.findByText('Express');

    const card = screen.getByTestId('template-card-express');
    // The card should contain an SVG (Check icon)
    expect(card.querySelector('svg')).toBeInTheDocument();

    // Other cards should not have SVG
    const blankCard = screen.getByTestId('template-card-blank');
    expect(blankCard.querySelector('svg')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Dork Hub tab regression tests (task 9.3)
  //
  // These tests verify the marketplace tab added by task 9.1 without breaking
  // the built-in tab behavior covered by the tests above.
  // -------------------------------------------------------------------------

  describe('Dork Hub tab', () => {
    const codeReviewer: AggregatedPackage = {
      name: '@dorkos/code-reviewer',
      source: 'github.com/dorkos/code-reviewer',
      description: 'Reviews pull requests',
      type: 'agent',
      marketplace: 'dork-hub',
    };

    const docWriter: AggregatedPackage = {
      name: '@dorkos/doc-writer',
      source: 'github.com/dorkos/doc-writer',
      description: 'Writes documentation',
      type: 'agent',
      marketplace: 'dork-hub',
    };

    it('built-in tab still renders template grid with default state', async () => {
      renderPicker();

      // template-grid test ID stability + default templates still render.
      // findByTestId waits for useTemplateCatalog to resolve.
      expect(await screen.findByTestId('template-grid')).toBeInTheDocument();
      expect(await screen.findByTestId('template-card-blank')).toBeInTheDocument();
      expect(await screen.findByTestId('template-card-nextjs')).toBeInTheDocument();
    });

    it('custom URL input is present regardless of active tab', async () => {
      renderPicker();

      // custom-url-input is outside the Tabs component, so it is always
      // visible even before templates finish loading.
      expect(screen.getByTestId('custom-url-input')).toBeInTheDocument();
    });

    it('renders marketplace agent cards when the hook returns data', async () => {
      const user = userEvent.setup();
      setMarketplaceState({ data: [codeReviewer, docWriter] });
      renderPicker();

      await screen.findByText('Blank');
      await user.click(screen.getByRole('tab', { name: /from dork hub/i }));

      const grid = await screen.findByTestId('marketplace-template-grid');
      expect(
        within(grid).getByTestId('marketplace-template-@dorkos/code-reviewer')
      ).toBeInTheDocument();
      expect(
        within(grid).getByTestId('marketplace-template-@dorkos/doc-writer')
      ).toBeInTheDocument();
      expect(within(grid).getByText('Reviews pull requests')).toBeInTheDocument();
    });

    it('shows empty state when marketplace returns no agents', async () => {
      const user = userEvent.setup();
      setMarketplaceState({ data: [] });
      renderPicker();

      await screen.findByText('Blank');
      await user.click(screen.getByRole('tab', { name: /from dork hub/i }));

      expect(screen.getByText(/No marketplace agents available/i)).toBeInTheDocument();
      expect(screen.queryByTestId('marketplace-template-grid')).not.toBeInTheDocument();
    });

    it('shows error state when marketplace hook returns an error', async () => {
      const user = userEvent.setup();
      setMarketplaceState({ data: undefined, error: new Error('network down') });
      renderPicker();

      await screen.findByText('Blank');
      await user.click(screen.getByRole('tab', { name: /from dork hub/i }));

      expect(screen.getByText(/Could not load marketplace agents/i)).toBeInTheDocument();
      expect(screen.queryByTestId('marketplace-template-grid')).not.toBeInTheDocument();
    });

    it('built-in tab still renders when marketplace hook returns an error', async () => {
      // Critical regression: a marketplace API failure must not break the
      // Built-in tab, because that is the primary template source.
      setMarketplaceState({ data: undefined, error: new Error('API down') });
      renderPicker();

      // template-grid + default templates still resolve via the built-in tab.
      expect(await screen.findByTestId('template-grid')).toBeInTheDocument();
      expect(await screen.findByTestId('template-card-blank')).toBeInTheDocument();
      expect(await screen.findByTestId('template-card-nextjs')).toBeInTheDocument();
      // Custom URL input remains functional.
      expect(screen.getByTestId('custom-url-input')).toBeInTheDocument();
    });

    it('clicking a marketplace agent calls onSelect with agent.source', async () => {
      const user = userEvent.setup();
      setMarketplaceState({ data: [codeReviewer] });
      const { onSelect } = renderPicker();

      await screen.findByText('Blank');
      await user.click(screen.getByRole('tab', { name: /from dork hub/i }));

      const card = await screen.findByTestId('marketplace-template-@dorkos/code-reviewer');
      await user.click(card);

      // Must pass the git source URL, not the package name — downstream
      // template downloader treats source URLs uniformly.
      expect(onSelect).toHaveBeenCalledWith('github.com/dorkos/code-reviewer');
      expect(onSelect).not.toHaveBeenCalledWith('@dorkos/code-reviewer');
    });

    it('clicking the selected marketplace agent deselects it', async () => {
      const user = userEvent.setup();
      setMarketplaceState({ data: [codeReviewer] });
      const { onSelect } = renderPicker({
        selectedTemplate: 'github.com/dorkos/code-reviewer',
      });

      await screen.findByText('Blank');
      await user.click(screen.getByRole('tab', { name: /from dork hub/i }));

      const card = await screen.findByTestId('marketplace-template-@dorkos/code-reviewer');
      await user.click(card);

      expect(onSelect).toHaveBeenCalledWith(null);
    });

    it('selecting a marketplace agent clears the custom URL input', async () => {
      const user = userEvent.setup();
      setMarketplaceState({ data: [codeReviewer] });
      renderPicker();

      await screen.findByText('Blank');

      // Populate the custom URL input first.
      const urlInput = screen.getByTestId('custom-url-input');
      await user.type(urlInput, 'github.com/other/repo');
      expect(urlInput).toHaveValue('github.com/other/repo');

      // Switch to Dork Hub and select an agent.
      await user.click(screen.getByRole('tab', { name: /from dork hub/i }));
      await user.click(await screen.findByTestId('marketplace-template-@dorkos/code-reviewer'));

      // Custom URL should be cleared by the marketplace selection handler.
      expect(urlInput).toHaveValue('');
    });
  });
});
