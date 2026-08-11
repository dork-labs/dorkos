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

const makeItem = (content: string, index: number, over: Partial<QueueItem> = {}): QueueItem => ({
  id: `id-${index}`,
  content,
  mine: true,
  notice: null,
  ...over,
});

const STATUS_NOTE = 'Sending one at a time as the agent finishes';

/** Renders the panel with the props a plain waiting queue has. */
function renderPanel(props: Partial<React.ComponentProps<typeof QueuePanel>> = {}) {
  return render(
    <QueuePanel
      queue={[]}
      editingId={null}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onSend={vi.fn()}
      onMoveUp={vi.fn()}
      statusNote={STATUS_NOTE}
      {...props}
    />
  );
}

describe('QueuePanel', () => {
  it('renders nothing when queue is empty', () => {
    const { container } = renderPanel();
    expect(container.firstChild).toBeNull();
  });

  it('renders card for each queue item with content text', () => {
    const queue = [
      makeItem('First message', 0),
      makeItem('Second message', 1),
      makeItem('Third message', 2),
    ];
    renderPanel({ queue });
    expect(screen.getByText('First message')).toBeDefined();
    expect(screen.getByText('Second message')).toBeDefined();
    expect(screen.getByText('Third message')).toBeDefined();
  });

  it('renders "Queued (N)" header with correct count', () => {
    renderPanel({ queue: [makeItem('A', 0), makeItem('B', 1)] });
    expect(screen.getByText('Queued (2)')).toBeDefined();
  });

  it('clicking card calls onEdit with the item id, not its position', () => {
    const onEdit = vi.fn();
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)], onEdit });
    fireEvent.click(screen.getByText('Second'));
    expect(onEdit).toHaveBeenCalledWith('id-1');
  });

  it('clicking x button calls onRemove with the item id and NOT onEdit', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)], onEdit, onRemove });
    fireEvent.click(screen.getByLabelText('Remove queued message 1'));
    expect(onRemove).toHaveBeenCalledWith('id-0');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('nests no interactive element inside another', () => {
    // The row used to be a <button> wrapping a role="button" span — invalid HTML
    // that browsers resolve inconsistently and screen readers flatten to one control.
    const { container } = renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)] });
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(container.querySelectorAll('button [role="button"]')).toHaveLength(0);
    expect(container.querySelectorAll('button [tabindex]')).toHaveLength(0);
  });

  it('offers no reorder or send-next on the message that is already next', () => {
    // The head cannot go further forward. A control that can only no-op is
    // worse than no control, so it is not drawn: row 1 has edit + remove, row 2
    // has edit + move-up + send-next + remove.
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)] });
    expect(screen.queryByLabelText('Send queued message 1 next')).toBeNull();
    expect(screen.queryByLabelText('Move queued message 1 earlier')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('editing item shows selected state on its row', () => {
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)], editingId: 'id-1' });
    const editButton = screen.getByRole('button', { name: /Second/ });
    expect(editButton.getAttribute('aria-current')).toBe('true');
    expect(editButton.parentElement?.className).toContain('border-l-primary');
  });

  it('non-editing items do not have selected state', () => {
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)], editingId: 'id-0' });
    const editButton = screen.getByRole('button', { name: /Second/ });
    expect(editButton.getAttribute('aria-current')).toBeNull();
    expect(editButton.parentElement?.className).not.toContain('border-l-primary');
  });

  it('reserves the selected-row border at rest, so entering edit shifts nothing', () => {
    // The border used to appear only while editing, so the whole row jumped 2px
    // sideways the moment you clicked into it. jsdom reports every element as
    // 0×0, so this pins the classes that decide the box; the browser check for
    // the actual offset lives in the PR evidence.
    const queue = [makeItem('First', 0), makeItem('Second', 1)];
    const { container, rerender } = renderPanel({ queue, editingId: null });
    const rowClasses = () => screen.getByRole('button', { name: /First/ }).parentElement!.className;

    expect(rowClasses()).toContain('border-l-2');
    expect(rowClasses()).toContain('border-l-transparent');

    rerender(
      <QueuePanel
        queue={queue}
        editingId="id-0"
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSend={vi.fn()}
        onMoveUp={vi.fn()}
        statusNote={STATUS_NOTE}
      />
    );
    expect(rowClasses()).toContain('border-l-2');
    expect(container.querySelectorAll('.border-l-2')).toHaveLength(queue.length);
  });

  it('says when the queued messages will go out, not just how many', () => {
    // "Queued (2)" answered the one question nobody was asking.
    renderPanel({ queue: [makeItem('A', 0), makeItem('B', 1)] });
    expect(screen.getByText('Queued (2)')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(STATUS_NOTE))).toBeInTheDocument();
  });

  it('lets the caller say the queue is waiting on a person instead', () => {
    renderPanel({ queue: [makeItem('A', 0)], statusNote: 'Waiting for your answer above' });
    expect(screen.getByText(/Waiting for your answer above/)).toBeInTheDocument();
  });

  it('remove button is always visible (opacity-100 base class, not standalone opacity-0)', () => {
    renderPanel({ queue: [makeItem('Test', 0)] });
    const removeBtn = screen.getByLabelText('Remove queued message 1');
    // Base class is opacity-100 (always visible on mobile); md:opacity-0 is desktop hover-gated
    const classes = removeBtn.className.split(' ');
    expect(classes).toContain('opacity-100');
    // Should NOT have a bare opacity-0 class (only md:opacity-0 is acceptable)
    expect(classes).not.toContain('opacity-0');
  });
});

describe('QueuePanel — whose message it is, and what happened to it', () => {
  it('marks a chip another window queued, in words as well as an icon', () => {
    renderPanel({ queue: [makeItem('Mine', 0), makeItem('Theirs', 1, { mine: false })] });
    expect(screen.getAllByText('Queued from another window')).toHaveLength(1);
  });

  it('says nothing at all about this window\u2019s own chips', () => {
    renderPanel({ queue: [makeItem('Mine', 0), makeItem('Also mine', 1)] });
    expect(screen.queryByText('Queued from another window')).toBeNull();
  });

  it('shows a downgrade notice under the message it belongs to', () => {
    renderPanel({
      queue: [
        makeItem('Plain', 0),
        makeItem('Steered', 1, { notice: 'Queued — this agent cannot take a message mid-task' }),
      ],
    });
    expect(
      screen.getByText('Queued — this agent cannot take a message mid-task')
    ).toBeInTheDocument();
  });
});

describe('QueuePanel — send next and reorder', () => {
  it('offers a send-next control per row behind the head, addressed by the item id', () => {
    const onSend = vi.fn();
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)], onSend });

    fireEvent.click(screen.getByLabelText('Send queued message 2 next'));

    expect(onSend).toHaveBeenCalledWith('id-1');
  });

  it('offers a move-earlier control per row behind the head', () => {
    const onMoveUp = vi.fn();
    renderPanel({
      queue: [makeItem('First', 0), makeItem('Second', 1), makeItem('Third', 2)],
      onMoveUp,
    });

    fireEvent.click(screen.getByLabelText('Move queued message 3 earlier'));

    expect(onMoveUp).toHaveBeenCalledWith('id-2');
  });

  it('send-next is free of any hover gate — it is the row\u2019s primary action', () => {
    // Discoverability is the whole point. (jsdom reports every element as 0×0,
    // so this checks the classes that decide visibility, not geometry.)
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)] });
    const sendBtn = screen.getByLabelText('Send queued message 2 next');

    expect(sendBtn).not.toBeDisabled();
    expect(sendBtn.className).not.toContain('opacity-0');
  });

  it('gives every row button a keyboard focus ring', () => {
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)] });

    for (const name of [
      /Second/,
      /Send queued message 2 next/,
      /Move queued message 2 earlier/,
      /Remove queued message 2/,
    ]) {
      expect(screen.getByRole('button', { name }).className).toContain('focus-ring');
    }
  });
});
