/**
 * @vitest-environment jsdom
 */
/**
 * One to-do row's second line (DOR-3088, design review of #3461): the assignee only when it isn't
 * the person, the parts apart by a middle dot, and today's date in stronger ink.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockTodo } from '@dorkos/test-utils';
import { TooltipProvider } from '@/layers/shared/ui';
import { TodoRow } from '../index';

const phone = vi.hoisted(() => ({ value: false }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsMobile: () => phone.value,
}));

afterEach(() => {
  cleanup();
  phone.value = false;
});

function renderRow(props: Parameters<typeof TodoRow>[0]) {
  render(
    <TooltipProvider>
      <ul>
        <TodoRow {...props} />
      </ul>
    </TooltipProvider>
  );
  return screen.getByRole('listitem');
}

describe('TodoRow', () => {
  it("says nothing about who has the person's own to-do, and keeps the parts apart", () => {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 0, 0);
    const row = renderRow({
      todo: createMockTodo({ dueAt: endOfToday.toISOString() }),
      from: 'you',
    });
    expect(row).toHaveTextContent('Due today·from you');
    expect(row).not.toHaveTextContent('You');
    expect(screen.getByText('Due today')).toHaveClass('font-medium');
  });

  it("names the agent that has an agent's to-do", () => {
    const row = renderRow({
      todo: createMockTodo({ assignee: { kind: 'agent', agentId: 'agent-1' } }),
      agent: { id: 'agent-1', name: 'DorkBot', projectPath: '/a' } as never,
      from: 'you',
    });
    expect(row).toHaveTextContent('DorkBot·from you');
  });

  it('shows the one line an agent left when it finished', () => {
    const row = renderRow({
      todo: createMockTodo({ state: 'kept', note: 'Sent it to Ana' }),
      from: 'you',
    });
    expect(row).toHaveTextContent('Done·Sent it to Ana·from you');
  });

  it('finishes with a swipe right on a phone, and only while it can be finished', () => {
    phone.value = true;
    const row = renderRow({ todo: createMockTodo(), from: 'you', onComplete: () => {} });
    expect(row.querySelector('[data-swipe-to-finish]')).not.toBeNull();
    cleanup();
    renderRow({ todo: createMockTodo(), from: 'you' });
    expect(screen.getByRole('listitem').querySelector('[data-swipe-to-finish]')).toBeNull();
  });

  it('says whose words and where: "DorkBot in #team" (DOR-3715)', () => {
    const row = renderRow({
      todo: createMockTodo({ titleFromSource: true, sourceAuthor: 'DorkBot' }),
      from: 'you',
      roomTitle: '#team',
    });
    expect(row).toHaveTextContent('from you·DorkBot in #team');
  });

  it('wraps a long title whole on a phone and stops it at three lines wider up', () => {
    renderRow({ todo: createMockTodo({ what: 'A'.repeat(139) }), from: 'you' });
    const title = screen.getByText('A'.repeat(139));
    expect(title).toHaveClass('break-words', 'md:line-clamp-3');
    expect(title).not.toHaveClass('line-clamp-3');
    expect(title).not.toHaveClass('truncate');
  });

  it('tints a Reorder row under the pointer or holding focus, and no other row', () => {
    const plain = renderRow({ todo: createMockTodo(), from: 'you' });
    expect(plain).not.toHaveClass('hover:bg-muted/50');
    cleanup();
    const reorder = renderRow({ todo: createMockTodo(), from: 'you', trailing: <span /> });
    expect(reorder).toHaveClass('hover:bg-muted/50', 'focus-within:bg-muted/50');
  });
});
