/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  parseCronToSimple,
  buildCron,
  formatHour,
  getSimplePreview,
  ScheduleBuilder,
} from '../ui/ScheduleBuilder';

// --- Mock cronstrue for cron mode preview ---
vi.mock('cronstrue', () => ({
  default: {
    toString: (cron: string) => `Cron: ${cron}`,
  },
}));

// --- Mock Shadcn Select as native <select> for testability ---
const SelectAriaLabelContext = React.createContext<{
  ariaLabel: string;
  setAriaLabel: (label: string) => void;
}>({ ariaLabel: '', setAriaLabel: () => {} });

vi.mock('@/layers/shared/ui', () => ({
  Label: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <label {...props}>{children}</label>
  ),
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => <input ref={ref} {...props} />
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
    responsive?: boolean;
    className?: string;
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
    className?: string;
  }) => <option value={value}>{children}</option>,
}));

// --- Mock motion/react to skip animations ---
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>, ref) => (
        <div ref={ref} {...props}>
          {children}
        </div>
      )
    ),
  },
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

// ─── Helper function tests ───────────────────────────────────────────

describe('parseCronToSimple', () => {
  it('parses every-15-minutes cron', () => {
    expect(parseCronToSimple('*/15 * * * *')).toEqual({
      frequency: '15m',
      hour: 9,
      days: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
    });
  });

  it('parses hourly cron', () => {
    expect(parseCronToSimple('0 * * * *')).toEqual({
      frequency: 'hourly',
      hour: 9,
      days: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
    });
  });

  it('parses daily cron at specific hour', () => {
    expect(parseCronToSimple('0 14 * * *')).toEqual({
      frequency: 'daily',
      hour: 14,
      days: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
    });
  });

  it('parses weekly cron with comma-separated days', () => {
    expect(parseCronToSimple('0 9 * * 1,3,5')).toEqual({
      frequency: 'weekly',
      hour: 9,
      days: [1, 3, 5],
      dayOfMonth: 1,
    });
  });

  it('parses weekly cron with day range', () => {
    expect(parseCronToSimple('0 9 * * 1-5')).toEqual({
      frequency: 'weekly',
      hour: 9,
      days: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
    });
  });

  it('parses monthly cron', () => {
    expect(parseCronToSimple('0 9 15 * *')).toEqual({
      frequency: 'monthly',
      hour: 9,
      days: [1, 2, 3, 4, 5],
      dayOfMonth: 15,
    });
  });

  it('returns null for non-simple frequencies', () => {
    expect(parseCronToSimple('0 */6 * * *')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCronToSimple('')).toBeNull();
  });

  it('returns null for expressions with too many fields', () => {
    expect(parseCronToSimple('0 9 * * 1-5 extra')).toBeNull();
  });

  it('returns null for step values in minute field', () => {
    expect(parseCronToSimple('*/5 * * * *')).toBeNull();
  });

  it('returns null when month field is not wildcard', () => {
    expect(parseCronToSimple('0 9 * 6 *')).toBeNull();
  });
});

describe('buildCron', () => {
  it('builds 15m cron', () => {
    expect(buildCron({ frequency: '15m', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })).toBe(
      '*/15 * * * *'
    );
  });

  it('builds hourly cron', () => {
    expect(buildCron({ frequency: 'hourly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })).toBe(
      '0 * * * *'
    );
  });

  it('builds daily cron at specific hour', () => {
    expect(buildCron({ frequency: 'daily', hour: 14, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })).toBe(
      '0 14 * * *'
    );
  });

  it('builds weekly cron with specific days', () => {
    expect(buildCron({ frequency: 'weekly', hour: 9, days: [1, 3, 5], dayOfMonth: 1 })).toBe(
      '0 9 * * 1,3,5'
    );
  });

  it('builds monthly cron', () => {
    expect(
      buildCron({ frequency: 'monthly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 15 })
    ).toBe('0 9 15 * *');
  });
});

describe('formatHour', () => {
  it('formats midnight as 12:00 AM', () => {
    expect(formatHour(0)).toBe('12:00 AM');
  });

  it('formats morning hour', () => {
    expect(formatHour(9)).toBe('9:00 AM');
  });

  it('formats noon as 12:00 PM', () => {
    expect(formatHour(12)).toBe('12:00 PM');
  });

  it('formats afternoon hour', () => {
    expect(formatHour(13)).toBe('1:00 PM');
  });

  it('formats late night hour', () => {
    expect(formatHour(23)).toBe('11:00 PM');
  });
});

describe('getSimplePreview', () => {
  it('previews 15m frequency', () => {
    expect(
      getSimplePreview({ frequency: '15m', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })
    ).toBe('Runs every 15 minutes');
  });

  it('previews hourly frequency', () => {
    expect(
      getSimplePreview({ frequency: 'hourly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })
    ).toBe('Runs every hour, on the hour');
  });

  it('previews daily frequency', () => {
    expect(
      getSimplePreview({ frequency: 'daily', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })
    ).toBe('Runs every day at 9:00 AM');
  });

  it('previews weekly Mon-Fri as weekday', () => {
    expect(
      getSimplePreview({ frequency: 'weekly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })
    ).toBe('Runs every weekday at 9:00 AM');
  });

  it('previews weekly Sat-Sun as weekend', () => {
    expect(getSimplePreview({ frequency: 'weekly', hour: 10, days: [0, 6], dayOfMonth: 1 })).toBe(
      'Runs every Saturday and Sunday at 10:00 AM'
    );
  });

  it('previews weekly with specific days', () => {
    expect(getSimplePreview({ frequency: 'weekly', hour: 9, days: [1, 3, 5], dayOfMonth: 1 })).toBe(
      'Runs every Monday, Wednesday, and Friday at 9:00 AM'
    );
  });

  it('previews monthly with ordinal suffix st', () => {
    expect(
      getSimplePreview({ frequency: 'monthly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 1 })
    ).toBe('Runs on the 1st of every month at 9:00 AM');
  });

  it('previews monthly with ordinal suffix nd', () => {
    expect(
      getSimplePreview({ frequency: 'monthly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 2 })
    ).toBe('Runs on the 2nd of every month at 9:00 AM');
  });

  it('previews monthly with ordinal suffix rd', () => {
    expect(
      getSimplePreview({ frequency: 'monthly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 3 })
    ).toBe('Runs on the 3rd of every month at 9:00 AM');
  });

  it('previews monthly with ordinal suffix th for teens', () => {
    expect(
      getSimplePreview({ frequency: 'monthly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 11 })
    ).toBe('Runs on the 11th of every month at 9:00 AM');
  });

  it('previews monthly 21st with ordinal suffix st', () => {
    expect(
      getSimplePreview({ frequency: 'monthly', hour: 9, days: [1, 2, 3, 4, 5], dayOfMonth: 21 })
    ).toBe('Runs on the 21st of every month at 9:00 AM');
  });
});

// ─── Component tests ─────────────────────────────────────────────────

describe('ScheduleBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders frequency select with default "daily" and time select', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * *" onChange={onChange} />);

    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;
    expect(frequencySelect.value).toBe('daily');

    const timeSelect = screen.getByLabelText('Time') as HTMLSelectElement;
    expect(timeSelect.value).toBe('9');
  });

  it('hides time select for 15m frequency', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="*/15 * * * *" onChange={onChange} />);

    expect(screen.queryByLabelText('Time')).toBeNull();
  });

  it('hides time select for hourly frequency', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 * * * *" onChange={onChange} />);

    expect(screen.queryByLabelText('Time')).toBeNull();
  });

  it('calls onChange with updated cron when time changes', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * *" onChange={onChange} />);

    const timeSelect = screen.getByLabelText('Time') as HTMLSelectElement;
    fireEvent.change(timeSelect, { target: { value: '14' } });

    expect(onChange).toHaveBeenCalledWith('0 14 * * *');
  });

  it('shows day pills for weekly frequency with Mon-Fri active', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * 1-5" onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'Mon' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sun' })).toBeTruthy();
  });

  it('toggles day pill and calls onChange', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * 1-5" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sat' }));

    expect(onChange).toHaveBeenCalledWith('0 9 * * 1,2,3,4,5,6');
  });

  it('prevents deselecting last day', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * 1" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows day-of-month select for monthly frequency', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 1 * *" onChange={onChange} />);

    const domSelect = screen.getByLabelText('Day of month') as HTMLSelectElement;
    expect(domSelect.value).toBe('1');
  });

  it('switches to cron mode when escape hatch is clicked', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * *" onChange={onChange} />);

    fireEvent.click(screen.getByText('Use a cron expression'));

    expect(screen.getByPlaceholderText('0 9 * * 1-5')).toBeTruthy();
    expect(screen.getByText(/Back to simple schedule/)).toBeTruthy();
  });

  it('switches back to simple mode from cron mode', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * *" onChange={onChange} />);

    fireEvent.click(screen.getByText('Use a cron expression'));
    fireEvent.click(screen.getByText(/Back to simple schedule/));

    expect(screen.getByLabelText('Frequency')).toBeTruthy();
    expect(screen.queryByPlaceholderText('0 9 * * 1-5')).toBeNull();
  });

  it('parses existing weekly cron in edit mode', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 14 * * 1,3,5" onChange={onChange} />);

    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;
    expect(frequencySelect.value).toBe('weekly');

    const timeSelect = screen.getByLabelText('Time') as HTMLSelectElement;
    expect(timeSelect.value).toBe('14');
  });

  it('opens in cron mode for non-parseable cron', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="*/5 * * * *" onChange={onChange} />);

    expect(screen.getByDisplayValue('*/5 * * * *')).toBeTruthy();
    expect(screen.getByText(/Back to simple schedule/)).toBeTruthy();
  });

  it('shows preview text for simple mode', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * *" onChange={onChange} />);

    expect(screen.getByText('Runs every day at 9:00 AM')).toBeTruthy();
  });

  it('calls onChange when frequency changes', () => {
    const onChange = vi.fn();
    render(<ScheduleBuilder value="0 9 * * *" onChange={onChange} />);

    const frequencySelect = screen.getByLabelText('Frequency');
    fireEvent.change(frequencySelect, { target: { value: 'weekly' } });

    expect(onChange).toHaveBeenCalledWith('0 9 * * 1,2,3,4,5');
  });
});
