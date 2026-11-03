/**
 * @vitest-environment jsdom
 */
/**
 * Moving a to-do in "My order" (DOR-3715). Chosen by pointer, not width: with a mouse the grip
 * waits for a hover or focus, at any width; on a touch screen there is no grip, and a long press
 * on the row's words picks it up instead. In Reorder mode the row moves by its ↑ and ↓, and
 * nothing on it can finish or lift it by accident.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { createMockTodo } from '@dorkos/test-utils';
import { TooltipProvider } from '@/layers/shared/ui';
import { SortableTodoRow, type SortableTodoRowProps } from '../ui/SortableTodoRow';

const media = vi.hoisted(() => ({ coarse: false, narrow: false }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMediaQuery: (query: string) => (query === '(pointer: coarse)' ? media.coarse : false),
  useIsMobile: () => media.narrow,
}));

afterEach(() => {
  cleanup();
  media.coarse = false;
  media.narrow = false;
});

function renderRow(props: Partial<SortableTodoRowProps> = {}) {
  const todo = createMockTodo({ what: 'Renew the domain' });
  render(
    <TooltipProvider>
      <DndContext>
        <SortableContext items={[todo.id]}>
          <ul>
            <SortableTodoRow todo={todo} from="you" sortable onMove={() => {}} {...props} />
          </ul>
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  );
}

describe('SortableTodoRow', () => {
  it('keeps the grip out of sight with a mouse until the row is hovered or the grip focused', () => {
    renderRow();
    const grip = screen.getByRole('button', { name: 'Move Renew the domain' });
    expect(grip).toHaveClass(
      'opacity-0',
      'group-hover/row:opacity-100',
      'focus-visible:opacity-100'
    );
  });

  it('keeps the grip in a narrow window that still has a mouse', () => {
    media.narrow = true;
    renderRow();
    expect(screen.getByRole('button', { name: 'Move Renew the domain' })).toBeInTheDocument();
  });

  it('has no grip on a touch screen, at any width, and the words lift instead of selecting', () => {
    media.coarse = true;
    renderRow();
    expect(screen.queryByRole('button', { name: 'Move Renew the domain' })).toBeNull();
    expect(screen.getByText('Renew the domain').closest('[class*="select-none"]')).toHaveClass(
      'select-none',
      '[-webkit-touch-callout:none]'
    );
  });

  it('moves by ↑ and ↓ in Reorder mode, each off at its end', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderRow({ onMove, reorder: { first: true, last: false }, onComplete: vi.fn() });
    expect(screen.getByRole('button', { name: 'Move Renew the domain up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Renew the domain down' }));
    expect(onMove).toHaveBeenCalledWith(1);
  });

  it('pauses the check, the swipe and the long press in Reorder mode', () => {
    media.coarse = true;
    media.narrow = true;
    renderRow({ reorder: { first: false, last: false }, onComplete: vi.fn() });
    expect(screen.getByRole('checkbox', { name: 'Renew the domain' })).toBeDisabled();
    expect(screen.getByText('Renew the domain').closest('[class*="select-none"]')).toBeNull();
    expect(document.querySelector('[data-swipe-to-finish]')).toBeNull();
  });

  it('offers no grip in Reorder mode, which moves by its buttons alone', () => {
    renderRow({ reorder: { first: false, last: false } });
    expect(screen.queryByRole('button', { name: 'Move Renew the domain' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move Renew the domain up' })).toBeInTheDocument();
  });

  it('swipes to finish on a phone outside Reorder mode', () => {
    media.narrow = true;
    renderRow({ onComplete: vi.fn() });
    expect(document.querySelector('[data-swipe-to-finish]')).not.toBeNull();
  });
});
