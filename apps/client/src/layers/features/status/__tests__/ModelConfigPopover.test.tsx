// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
  {
    // Claims effort but names no levels — the half-answer a runtime catalog can
    // legitimately give. There is nothing to offer and nothing to advertise, so
    // both the control and the badge must treat it as "no effort". Without this
    // row the length half of the capability check is untested.
    value: 'claude-halfclaim-1',
    displayName: 'Halfclaim',
    description: 'Declares effort, offers no levels',
    isDefault: false,
    contextWindow: 200_000,
    supportsEffort: true,
    supportedEffortLevels: [] as EffortLevel[],
    supportsFastMode: false,
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
        // `motion.create(Component)` wraps a component, unlike every other
        // property here which is a tag name — a shadow that did not
        // special-case this would treat "create" as the tag and hand back a
        // broken <create> element instead of the caller's component (DOR-1416).
        if (tag === 'create') return (Component: React.ElementType) => Component;
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

    it('drops the effort badge when the active model has no effort to give (DOR-1445)', () => {
      // Haiku in the mock catalog declares `supportsEffort: false`, so the
      // popover hides its Effort control. The status line used to keep
      // advertising the carried-over level anyway — "Haiku · High" for a
      // setting the person could no longer see or change.
      render(
        <ModelConfigPopover {...defaultProps({ model: 'claude-haiku-3-5', effort: 'high' })} />
      );
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toHaveTextContent('Haiku');
      expect(trigger).not.toHaveTextContent('High');
    });

    it('badge and Effort control agree: both absent for an effortless model (DOR-1445)', () => {
      // The point of the fix is that these two cannot disagree — one capability
      // source drives both — so assert them together rather than apart.
      render(
        <ModelConfigPopover {...defaultProps({ model: 'claude-haiku-3-5', effort: 'high' })} />
      );
      expect(screen.getByTestId('model-config-trigger')).not.toHaveTextContent('High');
      expect(screen.queryByRole('radiogroup', { name: 'Effort level' })).not.toBeInTheDocument();
    });

    it('drops the effort badge for a model that claims effort but offers no levels (DOR-1445)', () => {
      // Both halves of the capability check matter: a model with no levels to
      // pick has no Effort control either, so advertising one is the same lie.
      render(
        <ModelConfigPopover {...defaultProps({ model: 'claude-halfclaim-1', effort: 'high' })} />
      );
      expect(screen.getByTestId('model-config-trigger')).not.toHaveTextContent('High');
      expect(screen.queryByRole('radiogroup', { name: 'Effort level' })).not.toBeInTheDocument();
    });

    it('keeps the effort badge for a model that does take effort', () => {
      // The guard must not swallow the honest case: Opus declares effort levels.
      render(
        <ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6', effort: 'high' })} />
      );
      expect(screen.getByTestId('model-config-trigger')).toHaveTextContent('High');
      expect(screen.getByRole('radiogroup', { name: 'Effort level' })).toBeInTheDocument();
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

    it('drops the picker parenthetical — a status line names the model, it does not recommend one', () => {
      // "Default (recommended)" measured ~160px in Chromium and, paired with the
      // runtime item, overflowed a 375px status line by 46px (DOR-452). The
      // parenthetical is advice for someone choosing; it says nothing once chosen.
      mockUseModels.mockImplementation(() => ({
        data: [
          {
            value: 'default',
            displayName: 'Default (recommended)',
            description: 'Opus with 1M context',
          },
        ],
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
      }));
      render(<ModelConfigPopover {...defaultProps({ model: 'default' })} />);
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toHaveTextContent('Default');
      expect(trigger).not.toHaveTextContent('recommended');
    });
  });

  describe('compact (below the status line’s widest tier)', () => {
    it('keeps the model name and drops the effort badge', () => {
      // The name is what the line is for; effort is a setting this popover and the
      // Session panel both still report.
      render(<ModelConfigPopover {...defaultProps({ effort: 'high', compact: true })} />);
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toHaveTextContent('Opus');
      expect(trigger).not.toHaveTextContent('High');
    });

    it('drops the Fast badge', () => {
      render(<ModelConfigPopover {...defaultProps({ fastMode: true, compact: true })} />);
      expect(screen.getByTestId('model-config-trigger')).not.toHaveTextContent('Fast');
    });

    it('still shows both badges at the widest tier', () => {
      render(<ModelConfigPopover {...defaultProps({ effort: 'high', fastMode: true })} />);
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toHaveTextContent('High');
      expect(trigger).toHaveTextContent('Fast');
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
      expect(screen.getByText(/Couldn’t load the model list/)).toBeInTheDocument();
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
      // One per model in the catalog — all four fixtures declare a 200K window.
      expect(badges.length).toBe(mockModels.length);
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

    // ---- Honesty about what a model can do (DOR-1660) ----
    //
    // The complaint this answers: "I select a model, use it, and I'm told it
    // isn't available. I should know BEFORE I select it." So the picker keeps
    // every model but says, on the card, what will go wrong.
    describe('capability honesty', () => {
      const limitedModels = [
        buildModel({ value: 'model-frontier-a', displayName: 'Nova', tier: 'frontier' }),
        // Cannot call a tool: grouped apart, whatever its tier claims.
        buildModel({
          value: 'model-chat-only',
          displayName: 'Lyria',
          tier: 'frontier',
          supportsToolUse: false,
        }),
        // The operator's real case: tool-capable and picked on purpose, but it
        // answers with pictures the app cannot show yet.
        buildModel({
          value: 'model-image',
          displayName: 'Banana',
          tier: 'solid-coder',
          supportsToolUse: true,
          supportsImageOutput: true,
        }),
      ];

      beforeEach(() => mockTieredModels(limitedModels));

      it('still offers a model that cannot do agent work, under its own heading', () => {
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);

        // Offered, not hidden — someone looking for it can still find it.
        expect(screen.getByTestId('model-card-list')).toHaveTextContent('Lyria');
        const group = screen.getByTestId('model-group-no-tools');
        expect(group).toHaveTextContent("Can't do agent work");
        // And it is NOT sitting in Frontier alongside the models that work.
        const text = screen.getByTestId('model-card-list').textContent ?? '';
        expect(text.indexOf('Nova')).toBeLessThan(text.indexOf("Can't do agent work"));
        expect(text.indexOf("Can't do agent work")).toBeLessThan(text.indexOf('Lyria'));
      });

      it('says on the card why a tool-less model will not work', () => {
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);

        expect(screen.getByTestId('model-limitation-model-chat-only')).toHaveTextContent(
          "Can't use tools, so it can't read files or run commands."
        );
      });

      it('warns that an image model produces nothing the app can show yet', () => {
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);

        expect(screen.getByTestId('model-limitation-model-image')).toHaveTextContent(
          'Makes images, and DorkOS cannot show them yet.'
        );
        // It CAN call tools, so it keeps its real tier rather than being demoted.
        expect(screen.getByTestId('model-group-solid-coders')).toBeInTheDocument();
      });

      it('does not warn that OpenRouter\'s router "makes images"', () => {
        // `openrouter/auto` declares image among its outputs because that is the
        // union of everything it might route to. On a coding prompt it returns
        // text every time, so an amber warning at the moment of choice would be
        // misinformation about the most sensible OpenRouter default.
        mockTieredModels([
          buildModel({
            value: 'openrouter/openrouter/auto',
            displayName: 'Auto Router',
            tier: 'frontier',
            supportsToolUse: true,
            supportsImageOutput: true,
          }),
        ]);
        render(<ModelConfigPopover {...defaultProps({ model: 'openrouter/openrouter/auto' })} />);

        expect(
          screen.queryByTestId('model-limitation-openrouter/openrouter/auto')
        ).not.toBeInTheDocument();
      });

      it('still groups a router apart when it genuinely cannot use tools', () => {
        // The image waiver is not a blanket exemption.
        mockTieredModels([
          buildModel({
            value: 'openrouter/auto',
            displayName: 'Auto Router',
            supportsToolUse: false,
            supportsImageOutput: true,
          }),
        ]);
        render(<ModelConfigPopover {...defaultProps({ model: 'openrouter/auto' })} />);

        expect(screen.getByTestId('model-limitation-openrouter/auto')).toHaveTextContent(
          "Can't use tools"
        );
      });

      it('says nothing about a model with nothing to warn about', () => {
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);

        expect(screen.queryByTestId('model-limitation-model-frontier-a')).not.toBeInTheDocument();
        expect(screen.queryByTestId('model-group-no-tools')).toBeInTheDocument();
      });

      it('renders no warnings and no extra group for a catalog that reports nothing', () => {
        // Absent capability metadata must never read as "cannot" — the common
        // case for claude-code and codex, whose catalogs report neither field.
        mockTieredModels(tieredModels);
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);

        expect(screen.queryByTestId('model-group-no-tools')).not.toBeInTheDocument();
        expect(
          screen
            .getByTestId('model-card-list')
            .querySelectorAll('[data-testid^="model-limitation-"]')
        ).toHaveLength(0);
      });
    });

    // ---- The shortened, unconfirmed menu (DOR-1660) ----
    //
    // When the runtime finds no connected provider it offers a bounded slice of
    // every model it has heard of. Presenting that as the real list is the same
    // bug this PR fixes, pointed backwards — and the search box turns it into an
    // active falsehood.
    describe('an unverified catalog', () => {
      const unverifiedModels = [
        buildModel({ value: 'a/one', displayName: 'Alpha', tier: 'frontier', unverified: true }),
        buildModel({ value: 'b/two', displayName: 'Beta', tier: 'frontier', unverified: true }),
      ];

      it('says the list is short and unconfirmed, and names the fix', () => {
        mockTieredModels(unverifiedModels);
        render(<ModelConfigPopover {...defaultProps({ model: 'a/one' })} />);

        expect(screen.getByTestId('model-catalog-unverified')).toHaveTextContent(
          'This is a short list of models nobody has confirmed you can run. Connect a provider to see the ones you actually have.'
        );
      });

      it('does not claim a model is missing when the list was only shortened', () => {
        mockTieredModels(unverifiedModels);
        render(<ModelConfigPopover {...defaultProps({ model: 'a/one' })} />);

        // Before this, searching a shortened list for a model that genuinely IS
        // in the catalog answered with a confident "No models match".
        fireEvent.change(screen.getByTestId('model-search'), {
          target: { value: 'a-model-that-was-cut' },
        });
        expect(screen.getByTestId('model-search-empty')).toHaveTextContent(
          'No match in this shortened list. Connect a provider to search everything you can run.'
        );
      });

      it('stays quiet, and keeps the plain empty copy, for a confirmed catalog', () => {
        mockTieredModels(tieredModels);
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);

        expect(screen.queryByTestId('model-catalog-unverified')).not.toBeInTheDocument();
        fireEvent.change(screen.getByTestId('model-search'), { target: { value: 'zzzzz' } });
        expect(screen.getByTestId('model-search-empty')).toHaveTextContent('No models match');
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
        screen.getByText("This model isn't available anymore. Pick another.")
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

  // ---------------------------------------------------------------------------
  // Text too wide for the panel (DOR-1673). Two problems, and widening only
  // solves the first: an OpenRouter row carries a namespaced id and a sentence
  // about what the model cannot do, and BOTH ran past 320px.
  //
  // jsdom measures nothing, so these assertions pin the *treatment* each line
  // was given — which one may clip, which one may not, and from which end — and
  // the layout itself was verified in a browser.
  //
  // One of them is load-bearing beyond styling. The id line must hold its text
  // in ONE unbroken run, because a line split across two boxes is blockified by
  // its parent, and a blockified box breaks text continuity: find-in-page stops
  // matching the whole id and a copy comes back with a newline through the
  // middle of it. That was measured in Chromium, not deduced. jsdom cannot see
  // the consequence, but it CAN see the cause, and the shape below is what a
  // split line fails.
  // ---------------------------------------------------------------------------
  describe('text too wide for the panel', () => {
    const LONG_DESCRIPTION = 'OpenRouter · google/gemini-3-pro-image';
    const PROSE_DESCRIPTION = 'Small, fast, and cost-efficient model for simpler tasks.';

    /** An OpenRouter-shaped catalog: namespaced ids, and one model that warns. */
    function mockOpenRouterModels() {
      mockUseModels.mockImplementation(() => ({
        data: [
          {
            value: 'openrouter/google/gemini-3-pro-image',
            displayName: 'Google: Gemini 3 Pro Image Preview',
            description: LONG_DESCRIPTION,
            contextWindow: 1_000_000,
            supportsEffort: false,
            supportedEffortLevels: [] as EffortLevel[],
            supportsFastMode: false,
            supportsAutoMode: false,
            supportsToolUse: true,
            supportsImageOutput: true,
          },
          {
            // A sentence, the way claude-code and codex describe a model.
            value: 'gpt-oss-120b',
            displayName: 'GPT OSS 120B',
            description: PROSE_DESCRIPTION,
            contextWindow: 128_000,
            supportsEffort: false,
            supportedEffortLevels: [] as EffortLevel[],
            supportsFastMode: false,
            supportsAutoMode: false,
          },
          {
            // An Ollama id: the discriminating part is a `:` tag, with no slash
            // anywhere in it.
            value: 'deepseek-r1:70b-llama-distill-q4_K_M',
            displayName: 'DeepSeek R1 70B',
            description: 'ollama · deepseek-r1:70b-llama-distill-q4_K_M',
            contextWindow: 131_000,
            supportsEffort: false,
            supportedEffortLevels: [] as EffortLevel[],
            supportsFastMode: false,
            supportsAutoMode: false,
          },
        ] as unknown[],
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
      }));
    }

    /**
     * The whole line as one unbroken run of text, or `null` if it is split.
     *
     * "Unbroken" means: at most one element between the line and its characters,
     * and that element holding a single text node. Two side-by-side spans — the
     * shape this replaced — return `null`, which is the point of the helper.
     */
    function unbrokenText(line: HTMLElement): string | null {
      const inner = line.childNodes.length === 1 ? line.childNodes[0] : null;
      if (!inner) return null;
      if (inner.nodeType === Node.TEXT_NODE) return inner.textContent;
      const nested = (inner as HTMLElement).childNodes;
      if (nested.length !== 1 || nested[0].nodeType !== Node.TEXT_NODE) return null;
      return nested[0].textContent;
    }

    beforeEach(mockOpenRouterModels);

    it('gives the panel more room than the shared 320px default', () => {
      render(
        <ModelConfigPopover {...defaultProps({ model: 'openrouter/google/gemini-3-pro-image' })} />
      );
      const panel = screen.getByTestId('model-config-popover');
      // 480px — enough for the longest capability note on one line.
      expect(panel).toHaveClass('w-120');
      // The default this replaces. Leaving both on would let tailwind-merge's
      // ordering decide the width, which is not a decision anyone made.
      expect(panel).not.toHaveClass('w-80');
    });

    it('eats the START of a model id, never its tail', () => {
      render(
        <ModelConfigPopover {...defaultProps({ model: 'openrouter/google/gemini-3-pro-image' })} />
      );
      // `title` carries the whole string, so it is also how the line is found.
      const line = screen.getByTitle(LONG_DESCRIPTION);

      // `dir="rtl"` is the entire mechanism: it moves the browser's own ellipsis
      // to the other end of the line, so what gets dropped is the provider
      // prefix every row shares rather than the id that says which model this is.
      expect(line).toHaveAttribute('dir', 'rtl');
      expect(line).toHaveClass('truncate');
      // A right-to-left box would otherwise align a line that FITS to the right.
      expect(line).toHaveClass('text-left');
    });

    it('keeps the id in one unbroken run of text, not two boxes', () => {
      render(
        <ModelConfigPopover {...defaultProps({ model: 'openrouter/google/gemini-3-pro-image' })} />
      );
      const line = screen.getByTitle(LONG_DESCRIPTION);

      // The property that makes a copied id paste as one string and
      // find-in-page match across the whole of it. Two boxes fail this.
      expect(unbrokenText(line)).toBe(LONG_DESCRIPTION);
      // And the run is put back in reading order, so an id ending in a bracket
      // or a period is not reordered by the bidi algorithm.
      const [inner] = Array.from(line.children) as HTMLElement[];
      expect(inner.tagName).toBe('BDI');
      expect(inner).toHaveAttribute('dir', 'ltr');
    });

    it('reads an Ollama `name:tag` id as an id, not as prose', () => {
      const ollama = 'ollama · deepseek-r1:70b-llama-distill-q4_K_M';
      render(
        <ModelConfigPopover {...defaultProps({ model: 'deepseek-r1:70b-llama-distill-q4_K_M' })} />
      );
      // No slash anywhere in it: the tag after the colon is the discriminating
      // half, and an end ellipsis would eat exactly that.
      const line = screen.getByTitle(ollama);
      expect(line).toHaveAttribute('dir', 'rtl');
      expect(unbrokenText(line)).toBe(ollama);
    });

    it('leaves a prose description ellipsized at its end', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'gpt-oss-120b' })} />);
      const line = screen.getByTitle(PROSE_DESCRIPTION);
      // A sentence loses nothing that identifies it when its tail goes, and
      // starting one with an ellipsis reads as a mistake.
      expect(line).toHaveClass('truncate');
      expect(line).not.toHaveAttribute('dir');
      expect(unbrokenText(line)).toBe(PROSE_DESCRIPTION);
    });

    it('wraps a model name to a second line rather than clipping its suffix', () => {
      render(
        <ModelConfigPopover {...defaultProps({ model: 'openrouter/google/gemini-3-pro-image' })} />
      );
      const name = screen.getByText('Google: Gemini 3 Pro Image Preview');
      // `Preview`, `(free)` and `Thinking` all live at the END of a model name.
      expect(name).not.toHaveClass('truncate');
      expect(name).toHaveClass('line-clamp-2');
    });

    it('never truncates or clamps the line that says what a model cannot do', () => {
      render(
        <ModelConfigPopover {...defaultProps({ model: 'openrouter/google/gemini-3-pro-image' })} />
      );
      const warning = screen.getByTestId('model-limitation-openrouter/google/gemini-3-pro-image');
      expect(warning).toHaveTextContent('Makes images, and DorkOS cannot show them yet.');
      // Half a warning is worse than none, so it wraps and keeps every word.
      for (const clipped of ['truncate', 'line-clamp-2', 'whitespace-nowrap']) {
        expect(warning).not.toHaveClass(clipped);
      }
    });

    it('gives the vanished saved id the same treatment, beside its own label', () => {
      const vanished = 'openrouter/meta-llama/llama-3.1-nemotron-ultra-253b-v1';
      render(<ModelConfigPopover {...defaultProps({ model: vanished })} />);
      const banner = screen.getByTestId('model-unavailable-saved');
      const line = screen.getByTitle(vanished);

      expect(banner).toContainElement(line);
      expect(line).toHaveAttribute('dir', 'rtl');
      expect(unbrokenText(line)).toBe(vanished);
      expect(banner).toHaveTextContent('(not available)');
    });

    it('keeps every part of this line shrinkable, beside a sibling that is not', () => {
      // The failure this replaces (DOR-1673 review): the banner draws the id at
      // `text-sm` next to a `shrink-0` label, and the old treatment protected a
      // fixed 24-character tail. At 390px that tail took the row and left the
      // head EIGHT pixels — too few to draw an ellipsis in — so the line began
      // mid-word and never admitted it. Measured in a browser; jsdom counts
      // characters and cannot see 8 pixels. What it CAN check is the cause: that
      // nothing on this line refuses to shrink, so there is no per-line budget
      // to get wrong in the first place.
      const vanished = 'openrouter/meta-llama/llama-3.1-nemotron-ultra-253b-v1';
      render(<ModelConfigPopover {...defaultProps({ model: vanished })} />);
      const line = screen.getByTitle(vanished);

      expect(line).toHaveClass('min-w-0');
      expect(line).not.toHaveClass('shrink-0');
      for (const child of Array.from(line.querySelectorAll('*'))) {
        expect(child).not.toHaveClass('shrink-0');
        expect(child).not.toHaveClass('whitespace-nowrap');
      }
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
