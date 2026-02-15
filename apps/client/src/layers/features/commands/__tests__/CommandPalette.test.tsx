// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CommandPalette } from '../ui/CommandPalette';

beforeAll(() => {
  // jsdom does not implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

const mockCommands = [
  { namespace: 'daily', command: 'plan', fullCommand: '/daily:plan', description: 'Morning planning', filePath: '' },
  { namespace: 'daily', command: 'eod', fullCommand: '/daily:eod', description: 'End of day review', filePath: '' },
  { namespace: 'meeting', command: 'prep', fullCommand: '/meeting:prep', description: 'Prepare for meeting', argumentHint: '[name]', filePath: '' },
];

describe('CommandPalette', () => {
  it('renders command items', () => {
    render(
      <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(screen.getByText('/daily:plan')).toBeDefined();
    expect(screen.getByText('/daily:eod')).toBeDefined();
    expect(screen.getByText('/meeting:prep')).toBeDefined();
  });

  it('shows descriptions', () => {
    render(
      <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(screen.getByText('Morning planning')).toBeDefined();
    expect(screen.getByText('End of day review')).toBeDefined();
  });

  it('shows argument hints', () => {
    render(
      <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(screen.getByText('[name]')).toBeDefined();
  });

  it('groups commands by namespace', () => {
    render(
      <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(screen.getByText('daily')).toBeDefined();
    expect(screen.getByText('meeting')).toBeDefined();
  });

  describe('selection highlighting', () => {
    it('highlights first item when selectedIndex=0', () => {
      render(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
      );
      const items = screen.getAllByRole('option');
      expect(items[0].getAttribute('data-selected')).toBe('true');
      expect(items[1].getAttribute('data-selected')).toBe('false');
      expect(items[2].getAttribute('data-selected')).toBe('false');
    });

    it('highlights third item when selectedIndex=2', () => {
      render(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={2} onSelect={vi.fn()} />
      );
      const items = screen.getAllByRole('option');
      expect(items[0].getAttribute('data-selected')).toBe('false');
      expect(items[1].getAttribute('data-selected')).toBe('false');
      expect(items[2].getAttribute('data-selected')).toBe('true');
    });

    it('updates highlight when selectedIndex changes', () => {
      const { rerender } = render(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
      );
      let items = screen.getAllByRole('option');
      expect(items[0].getAttribute('data-selected')).toBe('true');

      rerender(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={1} onSelect={vi.fn()} />
      );
      items = screen.getAllByRole('option');
      expect(items[0].getAttribute('data-selected')).toBe('false');
      expect(items[1].getAttribute('data-selected')).toBe('true');
    });
  });

  it('renders empty state when no commands match', () => {
    render(
      <CommandPalette filteredCommands={[]} selectedIndex={0} onSelect={vi.fn()} />
    );
    expect(screen.getByText('No commands found.')).toBeDefined();
  });

  describe('ARIA attributes', () => {
    it('listbox container has listbox role and correct id', () => {
      render(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
      );
      const listbox = screen.getByRole('listbox');
      expect(listbox).toBeDefined();
      expect(listbox.getAttribute('id')).toBe('command-palette-listbox');
    });

    it('items have option role and unique sequential ids', () => {
      render(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
      );
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(3);
      expect(options[0].getAttribute('id')).toBe('command-item-0');
      expect(options[1].getAttribute('id')).toBe('command-item-1');
      expect(options[2].getAttribute('id')).toBe('command-item-2');
    });

    it('only active item has aria-selected true', () => {
      render(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={1} onSelect={vi.fn()} />
      );
      const options = screen.getAllByRole('option');
      expect(options[0].getAttribute('aria-selected')).toBe('false');
      expect(options[1].getAttribute('aria-selected')).toBe('true');
      expect(options[2].getAttribute('aria-selected')).toBe('false');
    });
  });

  it('prevents default on mousedown to preserve textarea focus', () => {
    const { container } = render(
      <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
    );
    const paletteContainer = container.firstElementChild!;
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const prevented = !paletteContainer.dispatchEvent(event);
    expect(prevented).toBe(true);
  });

  describe('scroll behavior', () => {
    it('scrolls active item into view when selectedIndex changes', () => {
      const { rerender } = render(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={0} onSelect={vi.fn()} />
      );

      // Clear any initial scrollIntoView calls
      vi.mocked(Element.prototype.scrollIntoView).mockClear();

      rerender(
        <CommandPalette filteredCommands={mockCommands} selectedIndex={2} onSelect={vi.fn()} />
      );

      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });
  });
});
