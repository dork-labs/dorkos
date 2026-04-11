// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock shared/ui — render ResponsiveDropdownMenu components inline so we
// avoid portal/floating-ui complexity from Radix. Same strategy used by
// ModelConfigPopover.test.tsx.
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Dropdown primitives rendered inline
    ResponsiveDropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-root">{children}</div>
    ),
    ResponsiveDropdownMenuTrigger: ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children: React.ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) => (
      <div data-testid="dropdown-trigger" {...props}>
        {children}
      </div>
    ),
    ResponsiveDropdownMenuContent: ({
      children,
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => <div data-testid="dropdown-content">{children}</div>,
    ResponsiveDropdownMenuLabel: ({
      children,
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => <div data-testid="dropdown-label">{children}</div>,
    ResponsiveDropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
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
      >
        {children}
      </div>
    ),
    ResponsiveDropdownMenuRadioItem: ({
      children,
      value,
      description,
      className,
    }: {
      children: React.ReactNode;
      value: string;
      icon?: React.ComponentType;
      description?: string;
      className?: string;
    }) => (
      <div role="radio" aria-checked={false} data-radio-value={value} className={className}>
        <span>{children}</span>
        {description && <span data-testid={`desc-${value}`}>{description}</span>}
      </div>
    ),
    // Tooltip — render inline (used in disabled state)
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
});

// Import after mocks are set up
import { PermissionModeItem } from '../ui/PermissionModeItem';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionModeItem', () => {
  it('renders current mode label', () => {
    render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} />);
    const trigger = screen.getByTestId('dropdown-trigger');
    expect(trigger).toHaveTextContent('Default');
  });

  it('renders all 6 modes in dropdown', () => {
    render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} />);
    const group = screen.getByRole('radiogroup');
    expect(group).toBeInTheDocument();

    // Verify exactly 6 radio items
    const items = group.querySelectorAll('[role="radio"]');
    expect(items).toHaveLength(6);

    // All 6 mode labels should appear as radio items (scoped to the radiogroup
    // to avoid collisions with the trigger label)
    expect(group).toHaveTextContent('Default');
    expect(group).toHaveTextContent('Accept Edits');
    expect(group).toHaveTextContent('Plan Mode');
    expect(group).toHaveTextContent("Don't Ask");
    expect(group).toHaveTextContent('Bypass All');
    expect(group).toHaveTextContent('Auto');
  });

  it('filters modes by supportedModes', () => {
    render(
      <PermissionModeItem
        mode="default"
        onChangeMode={vi.fn()}
        supportedModes={['default', 'plan']}
      />
    );
    const group = screen.getByRole('radiogroup');
    const items = group.querySelectorAll('[role="radio"]');
    expect(items).toHaveLength(2);

    expect(group).toHaveTextContent('Default');
    expect(group).toHaveTextContent('Plan Mode');
    expect(screen.queryByText('Accept Edits')).not.toBeInTheDocument();
    expect(screen.queryByText('Bypass All')).not.toBeInTheDocument();
  });

  it('shows current mode in trigger even if not in supportedModes', () => {
    render(
      <PermissionModeItem mode="auto" onChangeMode={vi.fn()} supportedModes={['default', 'plan']} />
    );
    // The trigger button should still show "Auto" even though it's not in supportedModes
    const trigger = screen.getByTestId('dropdown-trigger');
    expect(trigger).toHaveTextContent('Auto');
  });

  it('calls onChangeMode when mode selected', async () => {
    const user = userEvent.setup();
    const onChangeMode = vi.fn();
    render(<PermissionModeItem mode="default" onChangeMode={onChangeMode} />);

    const planItem = screen.getByText('Plan Mode');
    await user.click(planItem);
    expect(onChangeMode).toHaveBeenCalledWith('plan');
  });

  it('shows disabled state', () => {
    render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} disabled />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    // When disabled, a tooltip with "Send a message first" is shown
    expect(screen.getByText('Send a message first')).toBeInTheDocument();
    // The dropdown root should not be present when disabled
    expect(screen.queryByTestId('dropdown-root')).not.toBeInTheDocument();
  });

  it('renders dontAsk correctly', () => {
    render(<PermissionModeItem mode="dontAsk" onChangeMode={vi.fn()} />);
    const trigger = screen.getByTestId('dropdown-trigger');
    expect(trigger).toHaveTextContent("Don't Ask");
  });

  it('renders auto correctly', () => {
    render(<PermissionModeItem mode="auto" onChangeMode={vi.fn()} />);
    const trigger = screen.getByTestId('dropdown-trigger');
    expect(trigger).toHaveTextContent('Auto');
  });
});
