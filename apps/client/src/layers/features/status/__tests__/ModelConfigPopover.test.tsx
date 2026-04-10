// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
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
const mockUseModels = vi.fn(() => mockUseModelsReturn);

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useModels: () => mockUseModels(),
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

// Mock Popover to render inline (avoids portal/floating-ui complexity)
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Popover: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="popover-root">{children}</div>
    ),
    PopoverTrigger: ({
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
    PopoverContent: ({
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
    autoMode: false,
    onChangeFastMode: vi.fn(),
    onChangeAutoMode: vi.fn(),
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
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
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
    it('renders Fast and Auto toggle buttons for Opus', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      expect(screen.getByText('Fast')).toBeInTheDocument();
      expect(screen.getByText('Auto')).toBeInTheDocument();
    });

    it('renders only Fast toggle for Haiku (no auto mode)', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-haiku-3-5' })} />);
      expect(screen.getByText('Fast')).toBeInTheDocument();
      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    });

    it('does not render mode section when model has no mode support', () => {
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

    it('calls onChangeAutoMode when Auto toggle is clicked', async () => {
      const user = userEvent.setup();
      const onChangeAutoMode = vi.fn();
      render(<ModelConfigPopover {...defaultProps({ onChangeAutoMode })} />);
      await user.click(screen.getByText('Auto'));
      expect(onChangeAutoMode).toHaveBeenCalledWith(true);
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

    it('mode toggles use switch role', () => {
      render(<ModelConfigPopover {...defaultProps({ model: 'claude-opus-4-6' })} />);
      const switches = screen.getAllByRole('switch');
      expect(switches.length).toBe(2);
    });

    it('marks active mode toggle with aria-checked=true', () => {
      render(<ModelConfigPopover {...defaultProps({ fastMode: true, autoMode: false })} />);
      const switches = screen.getAllByRole('switch');
      const fastSwitch = switches.find((s) => s.textContent?.includes('Fast'));
      const autoSwitch = switches.find((s) => s.textContent?.includes('Auto'));
      expect(fastSwitch).toHaveAttribute('aria-checked', 'true');
      expect(autoSwitch).toHaveAttribute('aria-checked', 'false');
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
