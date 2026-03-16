// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueuePanel } from '../ui/QueuePanel';
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
  createdAt: Date.now() + index,
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
    render(
      <QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />
    );
    expect(screen.getByText('First message')).toBeDefined();
    expect(screen.getByText('Second message')).toBeDefined();
    expect(screen.getByText('Third message')).toBeDefined();
  });

  it('renders "Queued (N)" header with correct count', () => {
    const queue = [makeItem('A', 0), makeItem('B', 1)];
    render(
      <QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />
    );
    expect(screen.getByText('Queued (2)')).toBeDefined();
  });

  it('clicking card calls onEdit with correct index', () => {
    const onEdit = vi.fn();
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(
      <QueuePanel queue={queue} editingIndex={null} onEdit={onEdit} onRemove={vi.fn()} />
    );
    fireEvent.click(screen.getByText('Second'));
    expect(onEdit).toHaveBeenCalledWith(1);
  });

  it('clicking x button calls onRemove with correct index and NOT onEdit', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(
      <QueuePanel queue={queue} editingIndex={null} onEdit={onEdit} onRemove={onRemove} />
    );
    fireEvent.click(screen.getByLabelText('Remove queued message 1'));
    expect(onRemove).toHaveBeenCalledWith(0);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('editing item shows selected state with border-l-2', () => {
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(
      <QueuePanel queue={queue} editingIndex={1} onEdit={vi.fn()} onRemove={vi.fn()} />
    );
    // The second card button should have border-l-2 class
    screen.getAllByRole('button', { name: /\d+\./ });
    // Find the second card button (index 1)
    const allButtons = document.querySelectorAll('button[type="button"]');
    const cardButtons = Array.from(allButtons).filter((b) =>
      b.className.includes('rounded-md')
    );
    expect(cardButtons[1].className).toContain('border-l-2');
  });

  it('non-editing items do not have selected state', () => {
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    render(
      <QueuePanel queue={queue} editingIndex={0} onEdit={vi.fn()} onRemove={vi.fn()} />
    );
    const allButtons = document.querySelectorAll('button[type="button"]');
    const cardButtons = Array.from(allButtons).filter((b) =>
      b.className.includes('rounded-md')
    );
    expect(cardButtons[1].className).not.toContain('border-l-2');
  });

  it('remove button is always visible (opacity-100 base class, not standalone opacity-0)', () => {
    const queue = [makeItem('Test', 0)];
    render(
      <QueuePanel queue={queue} editingIndex={null} onEdit={vi.fn()} onRemove={vi.fn()} />
    );
    const removeBtn = screen.getByLabelText('Remove queued message 1');
    // Base class is opacity-100 (always visible on mobile); md:opacity-0 is desktop hover-gated
    const classes = removeBtn.className.split(' ');
    expect(classes).toContain('opacity-100');
    // Should NOT have a bare opacity-0 class (only md:opacity-0 is acceptable)
    expect(classes).not.toContain('opacity-0');
  });
});
