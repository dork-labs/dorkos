/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockSession, createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { ChatTree } from '@dorkos/shared/work-graph-reads';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { FoldedSpinOff } from '../model/build-chat-list';
import { ChatTreeFold } from '../ui/ChatTreeFold';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

/** A spin-off the list folded under `parentId`. */
function folded(id: string, title: string, parentId: string): FoldedSpinOff {
  return {
    session: createMockSession({
      id,
      title,
      startedBy: { kind: 'chat', sessionId: parentId, title: null, reason: null, permission: null },
    }),
    status: 'idle',
    lifecycle: null,
  };
}

/** The tree read's answer under `host`. */
const TREE: ChatTree = {
  chatId: 'host',
  state: { kind: 'chat' },
  ancestors: [],
  descendants: [
    { chatId: 'mid', parentId: 'host', depth: 1, via: 'started', state: { kind: 'chat' } },
    { chatId: null, parentId: 'mid', depth: 2, state: { kind: 'private' } },
    { chatId: 'deep', parentId: null, depth: 3, via: 'started', state: { kind: 'chat' } },
    {
      chatId: 'lost',
      parentId: 'host',
      depth: 1,
      via: 'started',
      state: { kind: 'never-started', runId: 'r1', reason: 'start_failed' },
    },
  ],
  truncated: false,
  nextCursor: null,
};

interface FoldOptions {
  tree?: ChatTree;
  spinOffs?: FoldedSpinOff[];
  activeSessionId?: string | null;
}

function renderFold({
  tree = TREE,
  spinOffs = [folded('mid', 'Plan the post', 'host')],
  activeSessionId = null,
}: FoldOptions = {}) {
  const transport = createMockTransport();
  transport.getChatTree = vi.fn().mockResolvedValue(tree);
  const onOpen = vi.fn();
  const onOpenOther = vi.fn();
  // Which chats a row hands the list for `⇧↵`.
  const registerRow = vi.fn((_sessionId: string) => () => {});
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <ul>
            <ChatTreeFold
              hostId="host"
              parentTitle="Launch"
              spinOffs={spinOffs}
              byId={new Map(spinOffs.map((s) => [s.session.id, s]))}
              activeSessionId={activeSessionId}
              search=""
              onOpen={onOpen}
              onOpenOther={onOpenOther}
              registerRow={registerRow}
            />
          </ul>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onOpen, onOpenOther, registerRow };
}

describe('ChatTreeFold', () => {
  it('reads the tree only when opened, then draws it at every depth behind its own toggles', async () => {
    const { transport, onOpen, onOpenOther, registerRow } = renderFold();
    expect(transport.getChatTree).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '1 spin-off from Launch' }));
    expect(transport.getChatTree).toHaveBeenCalledWith('host', {});
    // The read knows chats the list does not: one that never started, one
    // another agent holds; the toggle counts the whole tree, joints left out.
    expect(await screen.findByText('Didn’t start: it failed to start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 spin-offs from Launch' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Plan the post/ }));
    expect(onOpen).toHaveBeenCalledWith('mid');

    // A level down: a private chat, not a button, with a chat you may read below it.
    await userEvent.click(screen.getByRole('button', { name: '1 spin-off from Plan the post' }));
    expect(screen.getByText('A private chat').closest('button')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '1 spin-off from A private chat' }));
    await userEvent.click(screen.getByRole('button', { name: /^Another chat/ }));
    expect(onOpenOther).toHaveBeenCalledWith('deep');
    // Only the list's own chat answers `⇧↵`: forking another agent's chat
    // would copy it into this agent's folder.
    expect(registerRow).toHaveBeenCalledWith('mid');
    expect(registerRow).not.toHaveBeenCalledWith('deep');
  });

  it('stops stepping in past the fourth level, so a deep chain still fits', async () => {
    // c1 started c2, and so on down to c6, which is open: every fold opens for it.
    const chain = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const spinOffs = chain.map((id, i) =>
      folded(id, `Chat ${id}`, i === 0 ? 'host' : chain[i - 1]!)
    );
    renderFold({
      spinOffs,
      activeSessionId: 'c6',
      tree: {
        ...TREE,
        descendants: chain.map((chatId, i) => ({
          chatId,
          parentId: i === 0 ? 'host' : chain[i - 1]!,
          depth: i + 1,
          via: 'started' as const,
          state: { kind: 'chat' as const },
        })),
      },
    });
    expect(await screen.findByRole('button', { name: /^Chat c6/ })).toBeInTheDocument();
    const stepsIn = Array.from(document.querySelectorAll<HTMLElement>('ul[data-depth]')).map(
      (list) => [list.dataset.depth, list.classList.contains('pl-3')]
    );
    expect(stepsIn).toEqual([
      ['1', true],
      ['2', true],
      ['3', true],
      ['4', true],
      ['5', false],
      ['6', false],
    ]);
  });
});
