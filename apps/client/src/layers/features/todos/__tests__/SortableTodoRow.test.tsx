/**
 * @vitest-environment jsdom
 */
/**
 * Moving a to-do in "My order" (DOR-3715): on a desktop the grip waits for a hover or focus, and a
 * phone has no grip column at all; a long press on the row's words picks it up instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { createMockTodo } from '@dorkos/test-utils';
import { TooltipProvider } from '@/layers/shared/ui';
import { SortableTodoRow } from '../ui/SortableTodoRow';

const phone = vi.hoisted(() => ({ value: false }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsMobile: () => phone.value,
}));

afterEach(() => {
  cleanup();
  phone.value = false;
});

function renderRow() {
  const todo = createMockTodo({ what: 'Renew the domain' });
  render(
    <TooltipProvider>
      <DndContext>
        <SortableContext items={[todo.id]}>
          <ul>
            <SortableTodoRow todo={todo} from="you" sortable onMove={() => {}} />
          </ul>
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  );
}

describe('SortableTodoRow', () => {
  it('keeps the grip out of sight on a desktop until the row is hovered or the grip focused', () => {
    renderRow();
    const grip = screen.getByRole('button', { name: 'Move Renew the domain' });
    expect(grip).toHaveClass(
      'opacity-0',
      'group-hover/row:opacity-100',
      'focus-visible:opacity-100'
    );
  });

  it('has no grip on a phone', () => {
    phone.value = true;
    renderRow();
    expect(screen.queryByRole('button', { name: 'Move Renew the domain' })).toBeNull();
  });
});
