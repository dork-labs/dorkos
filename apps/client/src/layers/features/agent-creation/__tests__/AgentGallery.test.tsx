/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { AgentGallery } from '../ui/AgentGallery';

// ---------------------------------------------------------------------------
// Mocks
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
  } as unknown as ReturnType<typeof useMarketplacePackages>);
}

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
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const boardKeeper: AggregatedPackage = {
  name: '@dorkos/board-keeper',
  displayName: 'Board Keeper',
  source: 'github.com/dorkos/board-keeper',
  description: 'Keeps your board tidy',
  type: 'agent',
  icon: '🗂️',
  tags: ['linear', 'pm'],
  marketplace: 'marketplace',
};

// No displayName — the gallery must humanize the slug.
const codeReviewer: AggregatedPackage = {
  name: '@dorkos/code-reviewer',
  source: 'github.com/dorkos/code-reviewer',
  description: 'Reviews pull requests',
  type: 'agent',
  marketplace: 'marketplace',
};

const eslintPlugin: AggregatedPackage = {
  name: '@dorkos/eslint-plugin',
  source: 'github.com/dorkos/eslint-plugin',
  description: 'Linting rules',
  type: 'plugin',
  marketplace: 'marketplace',
};

function renderGallery(overrides: Partial<Parameters<typeof AgentGallery>[0]> = {}) {
  const onDesignYourOwn = overrides.onDesignYourOwn ?? vi.fn();
  const onSelectTemplate = overrides.onSelectTemplate ?? vi.fn();
  const onImport = overrides.onImport ?? vi.fn();
  const result = render(
    <AgentGallery
      onDesignYourOwn={onDesignYourOwn}
      onSelectTemplate={onSelectTemplate}
      onImport={onImport}
    />
  );
  return { ...result, onDesignYourOwn, onSelectTemplate, onImport };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMarketplaceState({ data: [] });
  });

  afterEach(cleanup);

  it('renders "Design your own" first, before any template', () => {
    setMarketplaceState({ data: [boardKeeper] });
    renderGallery();

    const grid = screen.getByTestId('agent-gallery');
    const cards = within(grid).getAllByRole('button');
    expect(cards[0]).toHaveAttribute('data-testid', 'gallery-design-your-own');
    expect(within(grid).getByTestId('gallery-template-@dorkos/board-keeper')).toBeInTheDocument();
  });

  it('shows the sidecar display name, and humanizes a slug when none is given', () => {
    setMarketplaceState({ data: [boardKeeper, codeReviewer] });
    renderGallery();

    expect(screen.getByText('Board Keeper')).toBeInTheDocument();
    // @dorkos/code-reviewer has no displayName → humanized, never the raw slug.
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
    expect(screen.queryByText('@dorkos/code-reviewer')).not.toBeInTheDocument();
  });

  it('renders cadence/connection chips derived from tags', () => {
    setMarketplaceState({ data: [boardKeeper] });
    renderGallery();
    const card = screen.getByTestId('gallery-template-@dorkos/board-keeper');
    expect(within(card).getByText('linear')).toBeInTheDocument();
  });

  it('filters out non-agent packages', () => {
    setMarketplaceState({ data: [boardKeeper, eslintPlugin] });
    renderGallery();
    expect(screen.getByTestId('gallery-template-@dorkos/board-keeper')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-template-@dorkos/eslint-plugin')).not.toBeInTheDocument();
  });

  it('calls onDesignYourOwn when the lead card is clicked', async () => {
    const user = userEvent.setup();
    const { onDesignYourOwn } = renderGallery();
    await user.click(screen.getByTestId('gallery-design-your-own'));
    expect(onDesignYourOwn).toHaveBeenCalledOnce();
  });

  it('calls onSelectTemplate with a distilled template on card click', async () => {
    const user = userEvent.setup();
    setMarketplaceState({ data: [boardKeeper] });
    const { onSelectTemplate } = renderGallery();

    await user.click(screen.getByTestId('gallery-template-@dorkos/board-keeper'));
    expect(onSelectTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'github.com/dorkos/board-keeper',
        name: '@dorkos/board-keeper',
        displayName: 'Board Keeper',
        icon: '🗂️',
      })
    );
  });

  it('calls onImport from the footer link', async () => {
    const user = userEvent.setup();
    const { onImport } = renderGallery();
    await user.click(screen.getByTestId('gallery-import-link'));
    expect(onImport).toHaveBeenCalledOnce();
  });

  it('accepts a custom template URL via the advanced disclosure', async () => {
    const user = userEvent.setup();
    const { onSelectTemplate } = renderGallery();

    await user.click(screen.getByTestId('advanced-toggle'));
    await user.type(screen.getByTestId('custom-url-input'), 'github.com/my/repo');
    await user.click(screen.getByTestId('custom-url-go'));

    expect(onSelectTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'github.com/my/repo', displayName: 'Repo' })
    );
  });

  it('shows an honest note when no ready-made agents are available', () => {
    setMarketplaceState({ data: [] });
    renderGallery();
    expect(screen.getByTestId('gallery-templates-note')).toBeInTheDocument();
    // Design-your-own still leads even with no templates.
    expect(screen.getByTestId('gallery-design-your-own')).toBeInTheDocument();
  });

  it('moves focus across cards with arrow keys (roving tabindex)', () => {
    setMarketplaceState({ data: [boardKeeper] });
    renderGallery();

    const design = screen.getByTestId('gallery-design-your-own');
    const template = screen.getByTestId('gallery-template-@dorkos/board-keeper');
    design.focus();
    expect(document.activeElement).toBe(design);

    fireEvent.keyDown(design, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(template);
    expect(template).toHaveAttribute('tabindex', '0');
    expect(design).toHaveAttribute('tabindex', '-1');
  });
});
