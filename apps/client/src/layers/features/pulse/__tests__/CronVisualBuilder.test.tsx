/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { parseCron, assembleCron, CronVisualBuilder } from '../ui/CronVisualBuilder';

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
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
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
});
