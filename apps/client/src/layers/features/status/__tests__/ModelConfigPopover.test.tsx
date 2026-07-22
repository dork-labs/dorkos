// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import type { EffortLevel } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Mock data — plain objects matching the shape ModelConfigPopover reads at
// runtime. We intentionally avoid the ModelOption type annotation because the
// shared schema has not yet been expanded with all the fields the component
// uses (pre-existing type drift in ModelConfigPopover.tsx).
// ---------------------------------------------------------------------------

const mockModels = [
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus',
    description: 'Most capable model',
    isDefault: true,
    contextWindow: 200_000,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'] as EffortLevel[],
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: 'claude-sonnet-4-6',
    displayName: 'Sonnet',
    description: 'Balanced performance',
    isDefault: false,
    contextWindow: 200_000,
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsFastMode: false,
    supportsAutoMode: false,
  },
  {
    value: 'claude-haiku-3-5',
    displayName: 'Haiku',
    description: 'Fastest responses',
    isDefault: false,
    contextWindow: 200_000,
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsFastMode: true,
    supportsAutoMode: false,
  },
];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRefetch = vi.fn();
const mockUseModelsReturn = {
  data: mockModels as unknown[],
  isLoading: false,
  isError: false,
  refetch: mockRefetch,
};
// The module mock forwards the hook options into this spy, so tests can both
// assert on the runtime/sessionId scope and vary the returned catalog by it.
const mockUseModels = vi.fn((_opts?: { sessionId?: string; runtime?: string | null }) => {
  return mockUseModelsReturn;
});

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useModels: (opts?: { sessionId?: string; runtime?: string | null }) => mockUseModels(opts),
}));

// Mock motion to avoid animation complexity in tests
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const Component = React.forwardRef(
          (props: Record<string, unknown>, ref: React.Ref<HTMLElement>) => {
            const {
              initial: _initial,
              animate: _animate,
              exit: _exit,
              transition: _transition,
              ...rest
            } = props;
            return React.createElement(tag, { ...rest, ref });
          }
        );
        Component.displayName = `motion.${tag}`;
        return Component;
      },
    }
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock ResponsivePopover to render inline (avoids portal/floating-ui complexity)
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsivePopover: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="popover-root">{children}</div>
    ),
    ResponsivePopoverTrigger: ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children: React.ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) => (
      <div data-testid="popover-trigger" {...props}>
        {children}
      </div>
    ),
    ResponsivePopoverContent: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => (
      <div data-testid="popover-content" {...props}>
        {children}
      </div>
    ),
    ResponsivePopoverTitle: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="popover-title">{children}</div>
    ),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({
      children,
      asChild: _asChild,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
    }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tooltip-content">{children}</div>
    ),
    Skeleton: ({ className }: { className?: string }) => (
      <div data-testid="skeleton" className={className} />
    ),
    Badge: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
      variant?: string;
    }) => (
      <span data-testid="badge" className={className}>
        {children}
      </span>
    ),
    RadioGroup: ({
      children,
      value,
      onValueChange,
      ...props
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
      [key: string]: unknown;
    }) => (
      <div
        role="radiogroup"
        data-value={value}
        onClick={(e) => {
          const target = (e.target as HTMLElement).closest('[data-radio-value]');
          if (target && onValueChange) onValueChange(target.getAttribute('data-radio-value')!);
        }}
        {...props}
      >
        {children}
      </div>
    ),
    RadioGroupItem: ({ value, className }: { value: string; className?: string }) => (
      <span role="radio" aria-checked={false} data-radio-value={value} className={className} />
    ),
    Separator: ({ className }: { className?: string }) => (
      <hr data-testid="separator" className={className} />
    ),
  };
});

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset to default return value after each test
  mockUseModels.mockImplementation(() => mockUseModelsReturn);
});

// Import after mocks are set up
import { ModelConfigPopover } from '../ui/ModelConfigPopover';

// ---------------------------------------------------------------------------
// Default props factory
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<React.ComponentProps<typeof ModelConfigPopover>> = {}) {
  return {
    model: 'claude-opus-4-6',
    onChangeModel: vi.fn(),
    effort: null as EffortLevel | null,
    onChangeEffort: vi.fn(),
    fastMode: false,
    onChangeFastMode: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelConfigPopover', () => {
  describe('trigger', () => {
    it('renders the trigger with the selected model display name', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      // "Opus" appears in both the trigger <span> and the model card — verify the trigger has it
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toHaveTextContent('Opus');
    });

    it('shows effort badge on the trigger when effort is set', () => {
      render(<ModelConfigPopover {...defaultProps({ effort: 'high' })} />);
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toHaveTextContent('High');
    });

    it('does not show effort badge when effort is null', () => {
      render(<ModelConfigPopover {...defaultProps({ effort: null })} />);
      // The trigger should not contain an effort badge
      const trigger = screen.getByTestId('model-config-trigger');
      const badgesInTrigger = trigger.querySelectorAll('[data-testid="badge"]');
      expect(badgesInTrigger.length).toBe(0);
    });

    it('falls back to extracting label from model id when model is not in list', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-unknown-1' })} />);
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });

    it('uses raw model id when no pattern match is found', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'gpt-4o' })} />);
      // The id shows on the trigger (it also appears in the unavailable banner
      // since gpt-4o is not in the mock catalog — scope to the trigger).
      expect(screen.getByTestId('model-config-trigger')).toHaveTextContent('gpt-4o');
    });
  });

  describe('disabled state', () => {
    it('renders a disabled trigger when disabled', () => {
      render(<ModelConfigPopover {...defaultProps({ disabled: true })} />);
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toBeDisabled();
    });

    it('shows "Send a message first" tooltip content when disabled', () => {
      render(<ModelConfigPopover {...defaultProps({ disabled: true })} />);
      expect(screen.getByText('Send a message first')).toBeInTheDocument();
    });

    it('does not render popover when disabled', () => {
      render(<ModelConfigPopover {...defaultProps({ disabled: true })} />);
      expect(screen.queryByTestId('model-config-popover')).not.toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('renders skeleton cards while models are loading', () => {
      mockUseModels.mockImplementation(() => ({
        data: undefined as unknown as unknown[],
        isLoading: true,
        isError: false,
        refetch: mockRefetch,
      }));
      render(<ModelConfigPopover {...defaultProps()} />);
      expect(screen.getByTestId('model-cards-skeleton')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('renders error message with retry button when models fail to load', () => {
      mockUseModels.mockImplementation(() => ({
        data: undefined as unknown as unknown[],
        isLoading: false,
        isError: true,
        refetch: mockRefetch,
      }));
      render(<ModelConfigPopover {...defaultProps()} />);
      expect(screen.getByTestId('model-load-error')).toBeInTheDocument();
      expect(screen.getByText('Failed to load models')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('calls refetch when retry button is clicked', async () => {
      const user = userEvent.setup();
      mockUseModels.mockImplementation(() => ({
        data: undefined as unknown as unknown[],
        isLoading: false,
        isError: true,
        refetch: mockRefetch,
      }));
      render(<ModelConfigPopover {...defaultProps()} />);
      await user.click(screen.getByText('Retry'));
      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('model cards', () => {
    it('renders a card for each model', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      const cardList = screen.getByTestId('model-card-list');
      expect(cardList).toHaveTextContent('Opus');
      expect(cardList).toHaveTextContent('Sonnet');
      expect(cardList).toHaveTextContent('Haiku');
    });

    it('renders model descriptions', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      const cardList = screen.getByTestId('model-card-list');
      expect(cardList).toHaveTextContent('Most capable model');
      expect(cardList).toHaveTextContent('Balanced performance');
      expect(cardList).toHaveTextContent('Fastest responses');
    });

    it('renders a radio item for the selected model', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      const radioGroup = screen.getByRole('radiogroup', { name: 'Model selection' });
      expect(radioGroup.querySelector('[data-radio-value="claude-opus-4-6"]')).toBeInTheDocument();
    });

    it('renders radio items for non-selected models', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      const radioGroup = screen.getByRole('radiogroup', { name: 'Model selection' });
      expect(
        radioGroup.querySelector('[data-radio-value="claude-sonnet-4-6"]')
      ).toBeInTheDocument();
    });

    it('calls onChangeModel when a model card is clicked', async () => {
      const user = userEvent.setup();
      const onChangeModel = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ onChangeModel })} />);
      // Click the radio item directly (data-radio-value propagates via mock RadioGroup onClick)
      const radioGroup = screen.getByRole('radiogroup', { name: 'Model selection' });
      const sonnetRadio = radioGroup.querySelector('[data-radio-value="claude-sonnet-4-6"]')!;
      await user.click(sonnetRadio);
      expect(onChangeModel).toHaveBeenCalledWith('claude-sonnet-4-6');
    });

    it('renders context window badges', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      const badges = screen.getAllByText('200K');
      expect(badges.length).toBe(3);
    });

    it('renders model card list with radiogroup role', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      const radiogroup = screen.getByRole('radiogroup', { name: 'Model selection' });
      expect(radiogroup).toBeInTheDocument();
    });
  });

  describe('effort section', () => {
    it('renders effort pills when selected model supports effort', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      const effortGroup = screen.getByRole('radiogroup', { name: 'Effort level' });
      expect(effortGroup).toHaveTextContent('Low');
      expect(effortGroup).toHaveTextContent('Medium');
      expect(effortGroup).toHaveTextContent('High');
    });

    it('renders Default pill in effort section', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      expect(screen.getByRole('radiogroup', { name: 'Effort level' })).toBeInTheDocument();
    });

    it('does not render effort section when model lacks effort support', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-sonnet-4-6' })} />);
      expect(screen.queryByText('Effort')).not.toBeInTheDocument();
    });

    it('calls onChangeEffort when an effort pill is clicked', async () => {
      const user = userEvent.setup();
      const onChangeEffort = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ onChangeEffort })} />);
      await user.click(screen.getByText('Medium'));
      expect(onChangeEffort).toHaveBeenCalledWith('medium');
    });

    it('calls onChangeEffort with null when Default pill is clicked', async () => {
      const user = userEvent.setup();
      const onChangeEffort = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ effort: 'high', onChangeEffort })} />);
      await user.click(screen.getByText('Default'));
      expect(onChangeEffort).toHaveBeenCalledWith(null);
    });

    it('marks the active effort pill with aria-checked=true', () => {
      render(<ModelConfigPopover {...defaultProps({ effort: 'medium' })} />);
      const effortGroup = screen.getByRole('radiogroup', { name: 'Effort level' });
      const pills = effortGroup.querySelectorAll('[role="radio"]');
      const mediumPill = Array.from(pills).find((p) => p.textContent === 'Medium');
      expect(mediumPill).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('mode section', () => {
    it('renders only the Fast toggle for Opus (no Auto toggle)', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      expect(screen.getByText('Mode')).toBeInTheDocument();
      expect(screen.getByText('Fast')).toBeInTheDocument();
      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    });

    it('renders only Fast toggle for Haiku', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-haiku-3-5' })} />);
      expect(screen.getByText('Fast')).toBeInTheDocument();
      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    });

    it('does not render mode section when model has no fast mode support', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-sonnet-4-6' })} />);
      expect(screen.queryByText('Mode')).not.toBeInTheDocument();
      expect(screen.queryByText('Fast')).not.toBeInTheDocument();
      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    });

    it('calls onChangeFastMode when Fast toggle is clicked', async () => {
      const user = userEvent.setup();
      const onChangeFastMode = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ onChangeFastMode })} />);
      await user.click(screen.getByText('Fast'));
      expect(onChangeFastMode).toHaveBeenCalledWith(true);
    });

    it('toggles Fast mode off when already active', async () => {
      const user = userEvent.setup();
      const onChangeFastMode = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ fastMode: true, onChangeFastMode })} />);
      // "Fast" appears in both trigger badge and mode toggle — target the switch role
      const fastSwitch = screen.getAllByRole('switch').find((s) => s.textContent?.includes('Fast'));
      expect(fastSwitch).toBeDefined();
      await user.click(fastSwitch!);
      expect(onChangeFastMode).toHaveBeenCalledWith(false);
    });

    it('mode toggle uses switch role', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      const switches = screen.getAllByRole('switch');
      expect(switches.length).toBe(1);
    });

    it('marks active mode toggle with aria-checked=true', () => {
      render(<ModelConfigPopover {...defaultProps({ fastMode: true })} />);
      const switches = screen.getAllByRole('switch');
      const fastSwitch = switches.find((s) => s.textContent?.includes('Fast'));
      expect(fastSwitch).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('context window formatting', () => {
    it('formats 200000 as 200K', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      expect(screen.getAllByText('200K').length).toBeGreaterThan(0);
    });

    it('formats 1000000 as 1M', () => {
      mockUseModels.mockImplementation(() => ({
        data: [{ ...mockModels[0], contextWindow: 1_000_000 }] as unknown[],
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
      }));
      render(<ModelConfigPopover {...defaultProps()} />);
      expect(screen.getByText('1M')).toBeInTheDocument();
    });
  });

  describe('runtime scoping', () => {
    const codexModels = [
      {
        value: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        description: 'OpenAI Codex model',
        isDefault: true,
        contextWindow: 400_000,
        supportsEffort: false,
        supportedEffortLevels: [] as EffortLevel[],
        supportsFastMode: false,
        supportsAutoMode: false,
      },
    ];

    it('threads the runtime prop into the useModels query', () => {
      render(<ModelConfigPopover {...defaultProps({ sessionId: 's1', runtime: 'codex' })} />);
      expect(mockUseModels).toHaveBeenCalledWith({ sessionId: 's1', runtime: 'codex' });
    });

    it('renders the runtime-scoped model list (Codex models for runtime="codex")', () => {
      // The mock returns Codex models only when queried for the codex runtime,
      // mirroring a transport that resolves the catalog by runtime.
      mockUseModels.mockImplementation((opts) =>
        opts?.runtime === 'codex'
          ? {
              data: codexModels as unknown[],
              isLoading: false,
              isError: false,
              refetch: mockRefetch,
            }
          : mockUseModelsReturn
      );
      render(
        <ModelConfigPopover
          {...defaultProps({ model: 'gpt-5-codex', sessionId: 's1', runtime: 'codex' })}
        />
      );
      const cardList = screen.getByTestId('model-card-list');
      expect(cardList).toHaveTextContent('GPT-5 Codex');
      // Anthropic models must NOT leak into a Codex session's picker.
      expect(cardList).not.toHaveTextContent('Opus');
      expect(cardList).not.toHaveTextContent('Sonnet');
    });
  });

  // ---------------------------------------------------------------------------
  // Tiered, searchable menu (spec §8): grouping, filtering, the local-model
  // annotation, and the guarantee that small untiered lists render unchanged.
  // ---------------------------------------------------------------------------
  describe('tiered menu', () => {
    /** Builds a minimal model option, filling in the fields the component reads. */
    function buildModel(
      overrides: Record<string, unknown> & { value: string; displayName: string }
    ) {
      return {
        description: 'A model',
        contextWindow: 128_000,
        supportsEffort: false,
        supportedEffortLevels: [] as EffortLevel[],
        supportsFastMode: false,
        supportsAutoMode: false,
        ...overrides,
      };
    }

    // Distinct display names so substring assertions never collide.
    const tieredModels = [
      buildModel({ value: 'model-frontier-a', displayName: 'Nova', tier: 'frontier' }),
      buildModel({ value: 'model-frontier-b', displayName: 'Atlas', tier: 'frontier' }),
      buildModel({ value: 'model-solid-a', displayName: 'Cobalt', tier: 'solid-coder' }),
      buildModel({ value: 'model-quick-a', displayName: 'Ember', tier: 'quick-helper' }),
      buildModel({
        value: 'model-quick-local',
        displayName: 'Pebble',
        tier: 'quick-helper',
        local: true,
      }),
      // Legacy/unknown tier vocabulary — must land in "More models", not a named group.
      buildModel({ value: 'model-legacy', displayName: 'Relic', tier: 'legacy' }),
      // No tier at all — also "More models".
      buildModel({ value: 'model-untiered', displayName: 'Drifter' }),
    ];

    function mockTieredModels(models: unknown[]) {
      mockUseModels.mockImplementation(() => ({
        data: models,
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
      }));
    }

    describe('grouping', () => {
      beforeEach(() => mockTieredModels(tieredModels));

      it('renders the four group headers in fixed order when any option carries a tier', () => {
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        const headers = screen.getAllByText(/^(Frontier|Solid coders|Quick helpers|More models)$/);
        expect(headers.map((h) => h.textContent)).toEqual([
          'Frontier',
          'Solid coders',
          'Quick helpers',
          'More models',
        ]);
      });

      it('places each model under the correct group header, preserving incoming order', () => {
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        const text = screen.getByTestId('model-card-list').textContent ?? '';
        const at = (needle: string) => text.indexOf(needle);

        expect(at('Frontier')).toBeGreaterThanOrEqual(0);
        expect(at('Frontier')).toBeLessThan(at('Nova'));
        expect(at('Nova')).toBeLessThan(at('Atlas'));
        expect(at('Atlas')).toBeLessThan(at('Solid coders'));
        expect(at('Solid coders')).toBeLessThan(at('Cobalt'));
        expect(at('Cobalt')).toBeLessThan(at('Quick helpers'));
        expect(at('Quick helpers')).toBeLessThan(at('Ember'));
        expect(at('Ember')).toBeLessThan(at('Pebble'));
        expect(at('Pebble')).toBeLessThan(at('More models'));
        expect(at('More models')).toBeLessThan(at('Relic'));
        expect(at('Relic')).toBeLessThan(at('Drifter'));
      });

      it('omits a group header entirely when it has no matching options', () => {
        // Only frontier + more-models tiers present — solid-coders/quick-helpers must not render.
        mockTieredModels([
          buildModel({ value: 'model-frontier-a', displayName: 'Nova', tier: 'frontier' }),
          buildModel({ value: 'model-untiered', displayName: 'Drifter' }),
        ]);
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        expect(screen.getByTestId('model-group-frontier')).toBeInTheDocument();
        expect(screen.getByTestId('model-group-more-models')).toBeInTheDocument();
        expect(screen.queryByTestId('model-group-solid-coders')).not.toBeInTheDocument();
        expect(screen.queryByTestId('model-group-quick-helpers')).not.toBeInTheDocument();
      });

      it('switches to the tiered layout past the searchable threshold even without tier metadata', () => {
        const manyUntiered = Array.from({ length: 11 }, (_, i) =>
          buildModel({ value: `model-${i}`, displayName: `Model ${i}` })
        );
        mockTieredModels(manyUntiered);
        render(<ModelConfigPopover {...defaultProps({ model: 'model-0' })} />);
        expect(screen.getByTestId('model-search')).toBeInTheDocument();
        // Untiered options all land in "More models" — the only group rendered.
        expect(screen.getByTestId('model-group-more-models')).toBeInTheDocument();
        expect(screen.queryByTestId('model-group-frontier')).not.toBeInTheDocument();
      });

      it('stays flat at exactly the searchable threshold with no tier metadata', () => {
        const tenUntiered = Array.from({ length: 10 }, (_, i) =>
          buildModel({ value: `model-${i}`, displayName: `Model ${i}` })
        );
        mockTieredModels(tenUntiered);
        render(<ModelConfigPopover {...defaultProps({ model: 'model-0' })} />);
        expect(screen.queryByTestId('model-search')).not.toBeInTheDocument();
      });
    });

    describe('search filtering', () => {
      beforeEach(() => mockTieredModels(tieredModels));

      it('filters options case-insensitively on display name as the user types', async () => {
        const user = userEvent.setup();
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        await user.type(screen.getByTestId('model-search'), 'nova');

        const cardList = screen.getByTestId('model-card-list');
        expect(cardList).toHaveTextContent('Nova');
        expect(cardList).not.toHaveTextContent('Atlas');
        expect(cardList).not.toHaveTextContent('Cobalt');
        // A group with no surviving matches is not rendered.
        expect(screen.queryByTestId('model-group-solid-coders')).not.toBeInTheDocument();
      });

      it('filters case-insensitively on the model id/value', async () => {
        const user = userEvent.setup();
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        await user.type(screen.getByTestId('model-search'), 'MODEL-LEGACY');

        const cardList = screen.getByTestId('model-card-list');
        expect(cardList).toHaveTextContent('Relic');
        expect(cardList).not.toHaveTextContent('Nova');
      });

      it('shows the empty state when no option matches the query', async () => {
        const user = userEvent.setup();
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        await user.type(screen.getByTestId('model-search'), 'zzz-no-such-model');

        expect(screen.getByTestId('model-search-empty')).toHaveTextContent('No models match');
        expect(screen.queryByTestId('model-card-list')).not.toBeInTheDocument();
      });
    });

    describe('local model annotation', () => {
      it('shows the local-device suffix on a model with local: true', async () => {
        mockTieredModels(tieredModels);
        const { localDeviceNoun } = await import('@/layers/shared/lib');
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        const cardList = screen.getByTestId('model-card-list');
        expect(cardList).toHaveTextContent(`${localDeviceNoun()} · private`);
      });

      it('does not show the suffix on a non-local model', () => {
        mockTieredModels(tieredModels);
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);
        const cardList = screen.getByTestId('model-card-list');
        // "Ember" (quick-helper, not local) must not carry the private suffix.
        const emberText = Array.from(cardList.querySelectorAll('label')).find((label) =>
          label.textContent?.includes('Ember')
        )?.textContent;
        expect(emberText).not.toContain('private');
      });
    });

    describe('unchanged small untiered list', () => {
      it('renders no search input and no group headers', () => {
        render(<ModelConfigPopover {...defaultProps()} />);
        expect(screen.queryByTestId('model-search')).not.toBeInTheDocument();
        expect(screen.queryByTestId('model-group-frontier')).not.toBeInTheDocument();
        expect(screen.queryByTestId('model-group-solid-coders')).not.toBeInTheDocument();
        expect(screen.queryByTestId('model-group-quick-helpers')).not.toBeInTheDocument();
        expect(screen.queryByTestId('model-group-more-models')).not.toBeInTheDocument();
      });

      it('renders every model as a flat, unfiltered RadioGroup', () => {
        render(<ModelConfigPopover {...defaultProps()} />);
        const cardList = screen.getByTestId('model-card-list');
        expect(cardList).toHaveTextContent('Opus');
        expect(cardList).toHaveTextContent('Sonnet');
        expect(cardList).toHaveTextContent('Haiku');
      });

      it('still calls onChangeModel when a card is clicked', async () => {
        const user = userEvent.setup();
        const onChangeModel = vi.fn();
        render(<ModelConfigPopover {...defaultProps({ onChangeModel })} />);
        const radioGroup = screen.getByRole('radiogroup', { name: 'Model selection' });
        await user.click(radioGroup.querySelector('[data-radio-value="claude-haiku-3-5"]')!);
        expect(onChangeModel).toHaveBeenCalledWith('claude-haiku-3-5');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Vanished saved model (spec §11): a saved value absent from the options is
  // shown marked "(not available)" with a plain hint, and never auto-switched.
  // ---------------------------------------------------------------------------
  describe('vanished saved model', () => {
    it('marks a vanished saved model unavailable with a plain hint (small list)', () => {
      const onChangeModel = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ model: 'ollama/gone:7b', onChangeModel })} />);
      const banner = screen.getByTestId('model-unavailable-saved');
      expect(banner).toHaveTextContent('ollama/gone:7b');
      expect(banner).toHaveTextContent('(not available)');
      expect(
        screen.getByText("This model isn't available anymore — pick another.")
      ).toBeInTheDocument();
      // Never auto-switch: the component only reflects the prop.
      expect(onChangeModel).not.toHaveBeenCalled();
    });

    it('does not show the unavailable banner when the saved model is present', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      expect(screen.queryByTestId('model-unavailable-saved')).not.toBeInTheDocument();
    });

    it('shows the unavailable banner in the tiered menu while still rendering the groups', () => {
      mockUseModels.mockImplementation(() => ({
        data: [
          {
            value: 'model-frontier-a',
            displayName: 'Nova',
            description: 'A model',
            contextWindow: 128_000,
            supportsEffort: false,
            supportedEffortLevels: [] as EffortLevel[],
            supportsFastMode: false,
            supportsAutoMode: false,
            tier: 'frontier',
          },
        ] as unknown[],
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
      }));
      const onChangeModel = vi.fn();
      render(
        <ModelConfigPopover {...defaultProps({ model: 'openrouter/vanished', onChangeModel })} />
      );
      expect(screen.getByTestId('model-unavailable-saved')).toHaveTextContent(
        'openrouter/vanished'
      );
      // The available options still render for the user to pick from.
      expect(screen.getByTestId('model-group-frontier')).toBeInTheDocument();
      expect(screen.getByTestId('model-card-list')).toHaveTextContent('Nova');
      expect(onChangeModel).not.toHaveBeenCalled();
    });
  });

  describe('popover structure', () => {
    it('renders with data-testid model-config-popover', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      expect(screen.getByTestId('model-config-popover')).toBeInTheDocument();
    });

    it('renders trigger with data-testid model-config-trigger', () => {
      render(<ModelConfigPopover {...defaultProps()} />);
      expect(screen.getByTestId('model-config-trigger')).toBeInTheDocument();
    });
  });
});
