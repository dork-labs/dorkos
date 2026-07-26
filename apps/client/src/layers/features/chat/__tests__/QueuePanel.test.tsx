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

/** Renders the panel with send-now enabled unless a case says otherwise. */
function renderPanel(props: Partial<React.ComponentProps<typeof QueuePanel>> = {}) {
  return render(
    <QueuePanel
      queue={[]}
      editingId={null}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onSend={vi.fn()}
      sendBlockedReason={null}
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

  it('exposes an edit, a send-now and a remove button per item', () => {
    // Was 4 (edit + remove per row). The count grew because every row gained a
    // send-now control — the only escape from a queue the auto-flush cannot drain.
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)] });
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
        sendBlockedReason={null}
      />
    );
    expect(rowClasses()).toContain('border-l-2');
    expect(container.querySelectorAll('.border-l-2')).toHaveLength(queue.length);
  });

  it('says when the queued messages will go out, not just how many', () => {
    // "Queued (2)" answered the one question nobody was asking. The blocked
    // reason is the answer to the real one, already written for a person.
    renderPanel({
      queue: [makeItem('A', 0), makeItem('B', 1)],
      sendBlockedReason: 'Waiting for the reply to finish',
    });
    expect(screen.getByText('Queued (2)')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the reply to finish/)).toBeInTheDocument();
  });

  it('reads "ready to send" when nothing is holding the queue back', () => {
    renderPanel({ queue: [makeItem('A', 0)], sendBlockedReason: null });
    expect(screen.getByText(/ready to send/)).toBeInTheDocument();
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

describe('QueuePanel — send now (a queued message is never trapped)', () => {
  it('offers a send-now control per row, addressed by the item id', () => {
    const onSend = vi.fn();
    renderPanel({ queue: [makeItem('First', 0), makeItem('Second', 1)], onSend });

    fireEvent.click(screen.getByLabelText('Send queued message 2 now'));

    expect(onSend).toHaveBeenCalledWith('id-1');
  });

  it('send-now is enabled and free of any hover gate when a send can happen', () => {
    // Discoverability is the whole point: a person recovering a stranded queue
    // must not have to hover to find the way out. (jsdom reports every element as
    // 0×0, so this checks the classes that decide visibility, not geometry.)
    renderPanel({ queue: [makeItem('Test', 0)], sendBlockedReason: null });
    const sendBtn = screen.getByLabelText('Send queued message 1 now');

    expect(sendBtn.getAttribute('aria-disabled')).toBe('false');
    expect(sendBtn.className).not.toContain('opacity-0');
  });

  it('states the reason in the accessible name when a send cannot happen', () => {
    // `title` alone was announced to nobody: an aria-label wins the accessible
    // name outright. And blocked is the COMMON state here — a queue mostly
    // exists while a reply streams — so this is the reading most people get.
    const onSend = vi.fn();
    renderPanel({
      queue: [makeItem('Test', 0)],
      onSend,
      sendBlockedReason: 'Waiting for the reply to finish',
    });

    const sendBtn = screen.getByLabelText(
      'Send queued message 1 now — unavailable: Waiting for the reply to finish'
    );
    expect(sendBtn.getAttribute('title')).toBe('Waiting for the reply to finish');

    // Refuses the click, but visibly and by its own guard.
    fireEvent.click(sendBtn);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps a blocked send-now reachable by keyboard, so the reason can be heard', () => {
    // A real `disabled` drops the button out of the tab order — hiding the
    // explanation from exactly the person who most needs it, in exactly the
    // state where it applies.
    renderPanel({ queue: [makeItem('Test', 0)], sendBlockedReason: 'This session is busy' });
    const sendBtn = screen.getByRole('button', { name: /Send queued message 1 now/ });

    expect(sendBtn).not.toBeDisabled();
    expect(sendBtn.getAttribute('aria-disabled')).toBe('true');
    sendBtn.focus();
    expect(document.activeElement).toBe(sendBtn);
  });

  it('gives every row button a keyboard focus ring', () => {
    renderPanel({ queue: [makeItem('Test', 0)] });

    for (const name of [/Test/, /Send queued message 1 now/, /Remove queued message 1/]) {
      expect(screen.getByRole('button', { name }).className).toContain('focus-ring');
    }
  });
});
