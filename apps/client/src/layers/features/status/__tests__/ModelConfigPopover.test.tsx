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
        // React 19 hands `ref` over as an ordinary prop, so it rides through in `rest`.
        const Component = (props: Record<string, unknown>) => {
          const {
            initial: _initial,
            animate: _animate,
            exit: _exit,
            transition: _transition,
            ...rest
          } = props;
          return React.createElement(tag, rest);
        };
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
  });

  describe('disabled state', () => {
    it('renders a disabled trigger when disabled', () => {
      render(<ModelConfigPopover {...defaultProps({ disabled: true })} />);
      const trigger = screen.getByTestId('model-config-trigger');
      expect(trigger).toBeDisabled();
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

  describe('on DorkOS credits', () => {
    it('says the menu is the models credits cover, whenever the rows are the credits menu', () => {
      mockUseModels.mockImplementation(() => ({
        ...mockUseModelsReturn,
        data: mockModels.map((m) => ({ ...m, paidFromCredits: true })) as unknown[],
      }));
      const { unmount } = render(<ModelConfigPopover {...defaultProps({ onCredits: true })} />);
      expect(screen.getByTestId('model-credits-note')).toHaveTextContent(
        'Models your DorkOS credits cover'
      );
      unmount();
      // A Codex or OpenCode session on credits: the rows alone say it.
      render(<ModelConfigPopover {...defaultProps()} />);
      expect(screen.getByTestId('model-credits-note')).toBeInTheDocument();
    });

    it('fails honest when the credits list cannot be read: no cards, the model kept', () => {
      mockUseModels.mockImplementation(() => ({
        data: undefined as unknown as unknown[],
        isLoading: false,
        isError: true,
        refetch: mockRefetch,
      }));
      render(<ModelConfigPopover {...defaultProps({ onCredits: true })} />);
      expect(screen.getByTestId('model-load-error')).toHaveTextContent(
        'Couldn’t load the models DorkOS credits cover. Your model stays as it is.'
      );
      expect(screen.queryByTestId('model-card-list')).not.toBeInTheDocument();
    });

    it('says credits cover no model here, rather than blaming the runtime', () => {
      mockUseModels.mockImplementation(() => ({
        data: [] as unknown[],
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
      }));
      render(<ModelConfigPopover {...defaultProps({ onCredits: true })} />);
      expect(screen.getByTestId('model-catalog-unavailable')).toHaveTextContent(
        'DorkOS credits don’t cover a model for this runtime yet.'
      );
    });
  });

  describe('model cards', () => {
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
  });

  describe('effort section', () => {
    it('renders effort pills when selected model supports effort', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      const effortGroup = screen.getByRole('radiogroup', { name: 'Effort level' });
      expect(effortGroup).toHaveTextContent('Low');
      expect(effortGroup).toHaveTextContent('Medium');
      expect(effortGroup).toHaveTextContent('High');
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
  });

  describe('mode section', () => {
    it('renders only the Fast toggle for Opus (no Auto toggle)', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      expect(screen.getByText('Mode')).toBeInTheDocument();
      expect(screen.getByText('Fast')).toBeInTheDocument();
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
  });

  describe('context window formatting', () => {
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
        expect(group).toHaveTextContent('Can’t do agent work');
        // And it is NOT sitting in Frontier alongside the models that work.
        const text = screen.getByTestId('model-card-list').textContent ?? '';
        expect(text.indexOf('Nova')).toBeLessThan(text.indexOf('Can’t do agent work'));
        expect(text.indexOf('Can’t do agent work')).toBeLessThan(text.indexOf('Lyria'));
      });

      it('says on the card why a tool-less model will not work', () => {
        render(<ModelConfigPopover {...defaultProps({ model: 'model-frontier-a' })} />);

        expect(screen.getByTestId('model-limitation-model-chat-only')).toHaveTextContent(
          'Can’t use tools, so it can’t read files or run commands.'
        );
      });

      it('does not warn that OpenRouter’s router "makes images"', () => {
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
          'A partial list DorkOS can’t confirm. Connect a provider to see yours.'
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
          'No match in this short list. Connect a provider to see more.'
        );
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
    });
  });

  // ---------------------------------------------------------------------------
  // Vanished saved model (spec §11): a saved value absent from the options is
  // shown marked "(not available)" with a plain hint, and never auto-switched.
  // ---------------------------------------------------------------------------
  describe('vanished saved model', () => {
    it('treats an empty catalog as a discovery failure instead of a vanished model', () => {
      mockUseModels.mockImplementation(() => ({
        data: [],
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
      }));

      render(<ModelConfigPopover {...defaultProps({ model: 'gpt-6-astra' })} />);

      expect(screen.getByTestId('model-catalog-unavailable')).toHaveTextContent(
        'Couldn’t load models. Check Settings, then try again.'
      );
      expect(screen.queryByTestId('model-unavailable-saved')).not.toBeInTheDocument();
      expect(screen.queryByRole('radiogroup', { name: 'Model selection' })).not.toBeInTheDocument();
    });

    it('marks a vanished saved model unavailable with a plain hint (small list)', () => {
      const onChangeModel = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ model: 'ollama/gone:7b', onChangeModel })} />);
      const banner = screen.getByTestId('model-unavailable-saved');
      expect(banner).toHaveTextContent('ollama/gone:7b');
      expect(banner).toHaveTextContent('(not available)');
      expect(
        screen.getByText('This model isn’t available anymore. Pick another.')
      ).toBeInTheDocument();
      // Never auto-switch: the component only reflects the prop.
      expect(onChangeModel).not.toHaveBeenCalled();
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

    beforeEach(mockOpenRouterModels);

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

    it('never truncates or clamps the line that says what a model cannot do', () => {
      render(
        <ModelConfigPopover {...defaultProps({ model: 'openrouter/google/gemini-3-pro-image' })} />
      );
      const warning = screen.getByTestId('model-limitation-openrouter/google/gemini-3-pro-image');
      expect(warning).toHaveTextContent('Makes images DorkOS can’t show yet.');
      // Half a warning is worse than none, so it wraps and keeps every word.
      for (const clipped of ['truncate', 'line-clamp-2', 'whitespace-nowrap']) {
        expect(warning).not.toHaveClass(clipped);
      }
    });
  });
});
