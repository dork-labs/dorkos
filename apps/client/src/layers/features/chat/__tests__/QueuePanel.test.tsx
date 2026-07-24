// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueuePanel } from '../ui/input/QueuePanel';
import type { QueueItem } from '../model/use-message-queue';

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
});

const makeItem = (content: string, index: number): QueueItem => ({
  id: `id-${index}`,
  content,
});

describe('QueuePanel', () => {
  it('renders nothing when queue is empty', () => {
    const { container } = render(
      <QueuePanel queue={[]} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders card for each queue item with content text', () => {
    const queue = [
      makeItem('First message', 0),
      makeItem('Second message', 1),
      makeItem('Third message', 2),
    ];
    render(<QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('First message')).toBeDefined();
    expect(screen.getByText('Second message')).toBeDefined();
    expect(screen.getByText('Third message')).toBeDefined();
  });

  it('renders "Queued (N)" header with correct count', () => {
    const queue = [makeItem('A', 0), makeItem('B', 1)];
    render(<QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Queued (2)')).toBeDefined();
  });

  it('clicking card calls onEdit with the item id, not its position', () => {
    const onEdit = vi.fn();
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(<QueuePanel queue={queue} editingIndex={null} onEdit={onEdit} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByText('Second'));
    expect(onEdit).toHaveBeenCalledWith('id-1');
  });

  it('clicking x button calls onRemove with the item id and NOT onEdit', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(<QueuePanel queue={queue} editingIndex={null} onEdit={onEdit} onRemove={onRemove} />);
    fireEvent.click(screen.getByLabelText('Remove queued message 1'));
    expect(onRemove).toHaveBeenCalledWith('id-0');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('nests no interactive element inside another', () => {
    // The row used to be a <button> wrapping a role="button" span — invalid HTML
    // that browsers resolve inconsistently and screen readers flatten to one control.
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    const { container } = render(
      <QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />
    );
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(container.querySelectorAll('button [role="button"]')).toHaveLength(0);
    expect(container.querySelectorAll('button [tabindex]')).toHaveLength(0);
  });

  it('exposes an edit and a remove button per item', () => {
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(<QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('editing item shows selected state on its row', () => {
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(<QueuePanel queue={queue} editingIndex={1} onEdit={vi.fn()} onRemove={vi.fn()} />);
    const editButton = screen.getByRole('button', { name: /Second/ });
    expect(editButton.getAttribute('aria-current')).toBe('true');
    expect(editButton.parentElement?.className).toContain('border-l-2');
  });

  it('non-editing items do not have selected state', () => {
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(<QueuePanel queue={queue} editingIndex={0} onEdit={vi.fn()} onRemove={vi.fn()} />);
    const editButton = screen.getByRole('button', { name: /Second/ });
    expect(editButton.getAttribute('aria-current')).toBeNull();
    expect(editButton.parentElement?.className).not.toContain('border-l-2');
  });

  it('remove button is always visible (opacity-100 base class, not standalone opacity-0)', () => {
    const queue = [makeItem('Test', 0)];
    render(<QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />);
    const removeBtn = screen.getByLabelText('Remove queued message 1');
    // Base class is opacity-100 (always visible on mobile); md:opacity-0 is desktop hover-gated
    const classes = removeBtn.className.split(' ');
    expect(classes).toContain('opacity-100');
    // Should NOT have a bare opacity-0 class (only md:opacity-0 is acceptable)
    expect(classes).not.toContain('opacity-0');
  });
});
