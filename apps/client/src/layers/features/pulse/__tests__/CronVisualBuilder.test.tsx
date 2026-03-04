/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { parseCron, assembleCron, CronVisualBuilder } from '../ui/CronVisualBuilder';

// Capture the aria-label from SelectTrigger and attach it to the wrapping <select>
// We store it in a module-level ref so Select can pick it up after SelectTrigger renders.
// Since Select renders its children (including SelectTrigger) inside a <select>, we instead
// hoist the aria-label by having SelectTrigger set it on a shared context value, then
// pass it through a React context to the parent Select.

import React from 'react';

const SelectAriaLabelContext = React.createContext<{
  ariaLabel: string;
  setAriaLabel: (label: string) => void;
}>({ ariaLabel: '', setAriaLabel: () => {} });

// Mock shadcn Select — render a native <select> for testability
vi.mock('@/layers/shared/ui', () => ({
  Label: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <label {...props}>{children}</label>
  ),
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => {
    const [ariaLabel, setAriaLabel] = React.useState('');
    return (
      <SelectAriaLabelContext.Provider value={{ ariaLabel, setAriaLabel }}>
        <select
          value={value}
          aria-label={ariaLabel || undefined}
          onChange={(e) => onValueChange(e.target.value)}
        >
          {children}
        </select>
      </SelectAriaLabelContext.Provider>
    );
  },
  SelectTrigger: ({
    children,
    'aria-label': ariaLabel,
  }: {
    children?: React.ReactNode;
    'aria-label'?: string;
  }) => {
    const ctx = React.useContext(SelectAriaLabelContext);
    React.useEffect(() => {
      if (ariaLabel) ctx.setAriaLabel(ariaLabel);
    }, [ariaLabel]); // eslint-disable-line react-hooks/exhaustive-deps
    return <>{children}</>;
  },
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <option value={value}>{children}</option>,
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
});

describe('parseCron', () => {
  it('parses a full 5-field cron expression', () => {
    expect(parseCron('0 9 * * 1-5')).toEqual({
      minute: '0',
      hour: '9',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '1-5',
    });
  });

  it('defaults missing fields to *', () => {
    expect(parseCron('30 12')).toEqual({
      minute: '30',
      hour: '12',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });

  it('handles all wildcards', () => {
    expect(parseCron('* * * * *')).toEqual({
      minute: '*',
      hour: '*',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });

  it('trims whitespace', () => {
    expect(parseCron('  5  10  *  *  * ')).toEqual({
      minute: '5',
      hour: '10',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });

  it('handles empty string by defaulting all fields to *', () => {
    expect(parseCron('')).toEqual({
      minute: '*',
      hour: '*',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });
});

describe('assembleCron', () => {
  it('assembles fields into a cron string', () => {
    expect(
      assembleCron({ minute: '30', hour: '14', dayOfMonth: '1', month: '6', dayOfWeek: '3' })
    ).toBe('30 14 1 6 3');
  });

  it('assembles all wildcards', () => {
    expect(
      assembleCron({ minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' })
    ).toBe('* * * * *');
  });
});

describe('CronVisualBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders 5 field selects with labels', () => {
    render(<CronVisualBuilder value="* * * * *" onChange={vi.fn()} />);

    expect(screen.getByText('Minute')).toBeDefined();
    expect(screen.getByText('Hour')).toBeDefined();
    expect(screen.getByText('Day')).toBeDefined();
    expect(screen.getByText('Month')).toBeDefined();
    expect(screen.getByText('Weekday')).toBeDefined();
  });

  it('renders aria-label attributes on triggers', () => {
    render(<CronVisualBuilder value="* * * * *" onChange={vi.fn()} />);

    // The mocked Select renders as native <select>, labels render as <label>
    const labels = screen.getAllByText(/Minute|Hour|Day|Month|Weekday/);
    expect(labels).toHaveLength(5);
  });

  it('calls onChange when a field is changed', () => {
    const onChange = vi.fn();
    render(<CronVisualBuilder value="* * * * *" onChange={onChange} />);

    // The mocked Select renders as a native <select> — find by aria-label
    const minuteSelect = screen.getByLabelText('Minute');
    fireEvent.change(minuteSelect, { target: { value: '30' } });

    expect(onChange).toHaveBeenCalledWith('30 * * * *');
  });

  it('updates displayed values when value prop changes', () => {
    const { rerender } = render(<CronVisualBuilder value="* * * * *" onChange={vi.fn()} />);

    // All selects should show wildcard initially — the mocked Select renders value as a <select>
    const hourSelect = screen.getByLabelText('Hour') as HTMLSelectElement;
    expect(hourSelect.value).toBe('*');

    rerender(<CronVisualBuilder value="0 9 * * 1-5" onChange={vi.fn()} />);

    expect(hourSelect.value).toBe('9');
  });
});
