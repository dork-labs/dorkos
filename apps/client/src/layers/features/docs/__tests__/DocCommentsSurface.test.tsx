/**
 * @vitest-environment jsdom
 *
 * The comments panel beside a doc (DOR-2983): threads listed with their
 * place in the text (ambiguous and orphaned said so), resolved ones behind a
 * switch, a comment opened on the selection, replies, resolve and reopen,
 * mentions picked from the roster, moved anchors saved, and a mention that
 * woke nobody reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type {
  DocComment,
  DocCommentMentionable,
  DocCommentThread,
} from '@dorkos/shared/doc-comments';
import type { UseBlintzCommentsOptions } from '@blintz/comments';
import { TransportProvider } from '@/layers/shared/model';
import { DocCommentsSurface } from '../ui/DocCommentsSurface';

const blintz = vi.hoisted(() => ({
  options: undefined as UseBlintzCommentsOptions | undefined,
  anchor: null as Record<string, unknown> | null,
  matches: new Map<string, 'exact' | 'moved' | 'ambiguous'>(),
  reveal: vi.fn(),
  plugin: Object.assign(() => undefined, { preservesSourceMapping: true }),
}));

// jsdom cannot run the editor; the hook is the seam the panel drives it through.
vi.mock('@blintz/comments', () => ({
  useBlintzComments: (options: UseBlintzCommentsOptions) => {
    blintz.options = options;
    return {
      plugin: blintz.plugin,
      anchorSelection: () => blintz.anchor,
      rangeOf: (id: string) => {
        const match = blintz.matches.get(id);
        return match ? { from: 1, to: 2, match } : null;
      },
      threadsAtSelection: () => [],
      reveal: blintz.reveal,
    };
  },
}));

const DOC = { cwd: '/work', path: 'notes/plan.md' };
const OWNER = {
  id: 'author-you',
  kind: 'human' as const,
  displayName: 'You',
  handle: 'dorian',
  emoji: null,
  color: null,
  isOwner: true,
};
const SCOUT = {
  ...OWNER,
  id: 'author-scout',
  kind: 'agent' as const,
  displayName: 'Scout',
  handle: 'scout',
  isOwner: false,
};

function comment(id: string, body: string, author = OWNER): DocComment {
  return {
    id,
    threadId: 't1',
    author,
    body,
    mentions: [],
    createdAt: new Date().toISOString(),
    editedAt: null,
  };
}

function thread(id: string, overrides: Partial<DocCommentThread> = {}): DocCommentThread {
  return {
    id,
    path: DOC.path,
    anchor: { v: 1, quote: `words of ${id}`, prefix: '', suffix: '', start: 0, end: 4 },
    resolved: false,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comments: [comment(`${id}-c1`, `First on ${id}`)],
    ...overrides,
  };
}

function mount(threads: DocCommentThread[], people: DocCommentMentionable[] = [SCOUT, OWNER]) {
  const transport = createMockTransport({
    listDocCommentThreads: vi.fn().mockResolvedValue({ threads }),
    listDocCommentMentionable: vi.fn().mockResolvedValue({ people }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>
        <DocCommentsSurface doc={DOC}>
          {(plugins) => <div data-testid="editor" data-plugins={plugins.length} />}
        </DocCommentsSurface>
      </QueryClientProvider>
    </TransportProvider>
  );
  return transport;
}

beforeEach(() => {
  blintz.options = undefined;
  blintz.anchor = null;
  blintz.matches = new Map();
  blintz.reveal.mockClear();
});

afterEach(cleanup);

describe('DocCommentsSurface', () => {
  it('hands the editor the comment plugin and the threads it highlights', async () => {
    mount([thread('t1')]);
    expect(screen.getByTestId('editor')).toHaveAttribute('data-plugins', '1');
    await screen.findByText('First on t1');
    expect(blintz.options?.threads).toEqual([
      expect.objectContaining({ id: 't1', resolved: false }),
    ]);
  });

  it('says when a thread may be on the wrong words, or lost its words', async () => {
    blintz.matches.set('t1', 'ambiguous');
    mount([thread('t1'), thread('t2')]);
    await screen.findByText('First on t2');
    await waitFor(() =>
      expect(
        screen.getByText('These words appear more than once. Check the highlight.')
      ).toBeInTheDocument()
    );
    act(() => blintz.options?.onOrphanedChange?.(['t2']));
    expect(await screen.findByText('The words this was on were removed.')).toBeInTheDocument();
  });

  it('keeps resolved threads behind a switch', async () => {
    mount([thread('t1'), thread('t2', { resolved: true })]);
    await screen.findByText('First on t1');
    expect(screen.queryByText('First on t2')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('First on t2')).toBeInTheDocument();
    expect(blintz.options?.showResolved).toBe(true);
  });

  it('asks for a selection, then opens a thread on it', async () => {
    const transport = mount([]);
    await screen.findByText('No comments yet');
    fireEvent.click(screen.getByRole('button', { name: 'Comment on the selected text' }));
    expect(screen.getByRole('status')).toHaveTextContent('Select some text in the doc first.');

    blintz.anchor = { v: 1, quote: 'Friday', prefix: '', suffix: '', start: 3, end: 9 };
    vi.mocked(transport.createDocCommentThread).mockResolvedValue({
      thread: thread('t9'),
      unreached: [{ authorId: SCOUT.id, name: 'Scout', reason: 'depth' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment on the selected text' }));
    const field = screen.getByRole('textbox', {
      name: 'Add a comment. Type @ to mention an agent.',
    });
    fireEvent.change(field, { target: { value: 'Is this firm?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() =>
      expect(transport.createDocCommentThread).toHaveBeenCalledWith({
        ...DOC,
        anchor: blintz.anchor,
        body: 'Is this firm?',
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Scout wasn’t woken. The reply limit was reached.'
    );
  });

  it('keeps the words and says so when a comment does not save', async () => {
    const transport = mount([]);
    await screen.findByText('No comments yet');
    blintz.anchor = { v: 1, quote: 'Friday', prefix: '', suffix: '', start: 3, end: 9 };
    vi.mocked(transport.createDocCommentThread).mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on the selected text' }));
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Couldn’t save the comment. Try again.'
    );
    expect(field).toHaveValue('Keep me');
  });

  it('reopens a resolved thread', async () => {
    const transport = mount([thread('t1', { resolved: true })]);
    vi.mocked(transport.setDocCommentThreadResolved).mockResolvedValue({ thread: thread('t1') });
    fireEvent.click(await screen.findByRole('switch'));
    fireEvent.click(await screen.findByRole('button', { name: /Reopen/ }));
    await waitFor(() =>
      expect(transport.setDocCommentThreadResolved).toHaveBeenCalledWith('t1', {
        ...DOC,
        resolved: false,
      })
    );
  });

  it('replies and resolves', async () => {
    const transport = mount([thread('t1')]);
    await screen.findByText('First on t1');
    vi.mocked(transport.replyDocComment).mockResolvedValue({ thread: thread('t1'), unreached: [] });
    vi.mocked(transport.setDocCommentThreadResolved).mockResolvedValue({
      thread: thread('t1', { resolved: true }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply…' }), {
      target: { value: 'Yes, Friday.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() =>
      expect(transport.replyDocComment).toHaveBeenCalledWith('t1', { ...DOC, body: 'Yes, Friday.' })
    );

    fireEvent.click(screen.getByRole('button', { name: /Resolve/ }));
    await waitFor(() =>
      expect(transport.setDocCommentThreadResolved).toHaveBeenCalledWith('t1', {
        ...DOC,
        resolved: true,
      })
    );
  });

  it('offers agents to mention and writes the handle the server resolves', async () => {
    mount([]);
    await screen.findByText('No comments yet');
    blintz.anchor = { v: 1, quote: 'Friday', prefix: '', suffix: '', start: 3, end: 9 };
    fireEvent.click(screen.getByRole('button', { name: 'Comment on the selected text' }));
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    // The roster arrives after the composer opens.
    await waitFor(() => {
      fireEvent.change(field, { target: { value: 'Ask @sc', selectionStart: 7 } });
      expect(screen.getByRole('listbox', { name: 'Mentions' })).toBeInTheDocument();
    });
    const palette = screen.getByRole('listbox', { name: 'Mentions' });
    expect(within(palette).getByText('Scout')).toBeInTheDocument();
    // You do not mention yourself.
    expect(within(palette).queryByText('@dorian')).not.toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).toHaveValue('Ask @scout ');
  });

  it('saves anchors the editor moved, and brings a clicked thread forward', async () => {
    const transport = mount([thread('t1')]);
    await screen.findByText('First on t1');
    const moved = { v: 1, quote: 'words of t1', prefix: '', suffix: '', start: 9, end: 13 };
    act(() => blintz.options?.onAnchorsChange?.([{ id: 't1', anchor: moved as never }]));
    await waitFor(() =>
      expect(transport.updateDocCommentAnchors).toHaveBeenCalledWith({
        ...DOC,
        updates: [{ id: 't1', anchor: moved }],
      })
    );

    act(() => blintz.options?.onThreadClick?.(['t1']));
    expect(blintz.options?.activeThreadId).toBe('t1');
    fireEvent.click(screen.getByRole('button', { name: 'words of t1' }));
    expect(blintz.reveal).toHaveBeenCalledWith('t1');
  });
});
