/**
 * @vitest-environment jsdom
 */
/**
 * One to-do row's second line (DOR-3088, design review of #3461): the assignee only when it isn't
 * the person, the parts apart by a middle dot, and today's date in stronger ink.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockTodo } from '@dorkos/test-utils';
import { TooltipProvider } from '@/layers/shared/ui';
import { TodoRow } from '../index';

afterEach(cleanup);

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
    expect(row).toHaveTextContent('Done · Sent it to Ana·from you');
  });
});
