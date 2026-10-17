/**
 * @vitest-environment jsdom
 */
/**
 * Where a canvas doc becomes live (DOR-2984): nothing changes while live docs
 * are off; with them on, a doc the server serves live is edited through the
 * collaboration plugin with a quiet line about who else is here, a doc it will
 * not serve falls back to today's editor, and "Restore previous version"
 * appears once a version exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { DocCollabProvider } from '@/layers/features/docs';
import * as Y from 'yjs';
import { FakeDocServer } from '@/layers/features/docs/__tests__/fake-doc-server';

/** Type into the live copy, as the bound editor would. */
function typeLive(text: string): void {
  const plugin = editorChange.plugins[0] as { fragment: Y.XmlFragment };
  plugin.fragment.insert(0, [new Y.XmlText(text)]);
}

/** Reconnects back off for a second; give them room. */
const RECONNECT = { timeout: 5_000 };

// The canvas editor, as a stub that shows what it was handed.
const editorChange = vi.hoisted(() => ({
  current: null as ((markdown: string) => void) | null,
  plugins: [] as unknown[],
}));
// The real plugin needs a real editor; this one hands the test the shared
// fragment, so it can type into the live copy as the editor would.
vi.mock('blintz/collab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('blintz/collab')>()),
  collaboration: (options: { fragment: unknown }) => ({ fragment: options.fragment }),
}));
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: (props: {
    plugins?: unknown[];
    editable: boolean;
    onChange?: (markdown: string) => void;
  }) => {
    editorChange.current = props.onChange ?? null;
    editorChange.plugins = props.plugins ?? [];
    return (
      <div
        data-testid="live-editor"
        data-plugins={props.plugins?.length ?? 0}
        data-editable={String(props.editable)}
      />
    );
  },
}));

import { LiveDocsContext } from '../model/live-docs-context';
import { LiveDocSlot } from '../ui/LiveDocSlot';

afterEach(cleanup);

/** The first lazy load of the docs chunk transforms a lot in a test run. */
const LAZY = { timeout: 15_000 };

const VERSION = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  savedAt: new Date().toISOString(),
  changedBy: { kind: 'agent' as const, name: 'Ada' },
  bytes: 4,
};

function renderSlot(
  transport: Transport,
  { on, onFileChanged }: { on: boolean; onFileChanged?: () => void }
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <LiveDocsContext.Provider value={on}>{node}</LiveDocsContext.Provider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return render(
    wrap(
      <LiveDocSlot
        cwd="/work"
        sourcePath="plan.md"
        editable
        loaded="# Plan"
        onFileChanged={onFileChanged}
      >
        <div data-testid="file-editor">today’s editor</div>
      </LiveDocSlot>
    )
  );
}

describe('LiveDocSlot', () => {
  it('renders today’s editor and opens no socket while live docs are off', () => {
    const transport = createMockTransport();
    renderSlot(transport, { on: false });
    expect(screen.getByTestId('file-editor')).toBeInTheDocument();
    expect(transport.connectDocCollab).not.toHaveBeenCalled();
    expect(transport.listDocVersions).not.toHaveBeenCalled();
  });

  it('leaves generated markdown and other files to today’s editor', () => {
    const transport = createMockTransport();
    render(
      <LiveDocsContext.Provider value>
        <LiveDocSlot cwd="/work" sourcePath="notes.txt" editable loaded="x">
          <div data-testid="file-editor" />
        </LiveDocSlot>
      </LiveDocsContext.Provider>
    );
    expect(screen.getByTestId('file-editor')).toBeInTheDocument();
    expect(transport.connectDocCollab).not.toHaveBeenCalled();
  });

  it('edits a doc the server serves live, and says quietly who else is here', async () => {
    const server = new FakeDocServer('# Plan');
    const transport = createMockTransport({
      connectDocCollab: server.transport().connectDocCollab,
    });
    renderSlot(transport, { on: true });

    const editor = await screen.findByTestId('live-editor', {}, LAZY);
    expect(editor).toHaveAttribute('data-plugins', '1');
    // Read-only until the pencil, like every canvas doc; still live either way.
    expect(editor).toHaveAttribute('data-editable', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    expect(screen.getByTestId('live-editor')).toHaveAttribute('data-editable', 'true');
    expect(screen.queryByTestId('file-editor')).not.toBeInTheDocument();

    // Sam opens the same doc from another window.
    const sam = new DocCollabProvider({
      transport: server.transport(),
      doc: { cwd: '/work', path: 'plan.md' },
    });
    sam.awareness.setLocalStateField('user', { name: 'Sam', color: '#336699' });
    expect(await screen.findByText('Sam is here')).toBeInTheDocument();

    server.note({ type: 'changed', changedBy: { kind: 'agent', name: 'Ada' } });
    expect(await screen.findByText('Ada changed this doc')).toBeInTheDocument();
    sam.destroy();
  });

  it('falls back to today’s editor when the server will not serve the doc live', async () => {
    const transport = createMockTransport();
    renderSlot(transport, { on: true });
    expect(await screen.findByTestId('file-editor', {}, LAZY)).toBeInTheDocument();
    expect(transport.connectDocCollab).toHaveBeenCalledWith(
      { cwd: '/work', path: 'plan.md' },
      expect.any(Object),
      {}
    );
  });

  it('lists the doc’s versions to pick from, and reloads the file after a restore', async () => {
    const onFileChanged = vi.fn();
    const OLDER = {
      ...VERSION,
      id: '01JZZZZZZZZZZZZZZZZZZZZZZY',
      changedBy: { kind: 'disk' as const },
    };
    const transport = createMockTransport({
      listDocVersions: vi.fn().mockResolvedValue({ versions: [VERSION, OLDER] }),
      restoreDocVersion: vi.fn().mockResolvedValue({ ok: true, live: false }),
    });
    renderSlot(transport, { on: true, onFileChanged });

    const menu = await screen.findByRole('button', { name: /versions/i }, LAZY);
    fireEvent.pointerDown(menu, { button: 0, pointerType: 'mouse' });
    expect(await screen.findByText('Before Ada’s change')).toBeInTheDocument();
    expect(screen.getByText(/Restoring replaces the doc/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Before a change on disk'));
    await waitFor(() =>
      expect(transport.restoreDocVersion).toHaveBeenCalledWith(
        { cwd: '/work', path: 'plan.md' },
        OLDER.id
      )
    );
    await waitFor(() => expect(onFileChanged).toHaveBeenCalledOnce());
  });

  it('shows no editor until the doc has arrived', async () => {
    const transport = createMockTransport({
      // A socket that opens and never sends anything.
      connectDocCollab: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
    });
    renderSlot(transport, { on: true });
    expect(await screen.findByText('Loading editor…', {}, LAZY)).toBeInTheDocument();
    expect(screen.queryByTestId('live-editor')).not.toBeInTheDocument();
  });

  it('offers the last edits back when live editing stops after the person typed', async () => {
    const server = new FakeDocServer('# Plan');
    const onFileChanged = vi.fn();
    const transport = createMockTransport({
      connectDocCollab: server.transport().connectDocCollab,
      readFileContent: vi
        .fn()
        .mockResolvedValue({ content: '# Plan', hash: 'h1', encoding: 'utf-8' }),
      writeFile: vi.fn().mockResolvedValue({ ok: true, hash: 'h2', effect: 'changed' }),
    });
    renderSlot(transport, { on: true, onFileChanged });
    await screen.findByTestId('live-editor', {}, LAZY);
    typeLive('Typed before it stopped.');
    editorChange.current?.('# Plan\n\nTyped before it stopped.');

    // Docs turned off: the server refuses the reconnect.
    server.refuseWith = 404;
    server.dropAll();
    expect(
      await screen.findByText(/before your last edits reached the file/, {}, RECONNECT)
    ).toBeInTheDocument();
    expect(screen.getByTestId('file-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save them' }));
    await waitFor(() =>
      expect(transport.writeFile).toHaveBeenCalledWith(
        '/work',
        'plan.md',
        '# Plan\n\nTyped before it stopped.',
        { expectedHash: 'h1' }
      )
    );
    await waitFor(() => expect(onFileChanged).toHaveBeenCalledTimes(2));
  });

  it('offers the edits back, even while the fresh copy is still loading, when they could not be kept', async () => {
    const server = new FakeDocServer('# Old');
    const transport = createMockTransport({
      connectDocCollab: server.transport().connectDocCollab,
      keepDocDraft: vi.fn().mockRejectedValue(new Error('offline')),
      readFileContent: vi
        .fn()
        .mockResolvedValue({ content: '# Fresh', hash: 'h1', encoding: 'utf-8' }),
    });
    renderSlot(transport, { on: true });
    await screen.findByTestId('live-editor', {}, LAZY);
    typeLive('Typed on the old copy.');
    editorChange.current?.('# Old\n\nTyped on the old copy.');
    server.dropAll();
    server.reload('# Fresh');
    // The fresh copy never arrives: what the editor sends is lost on the way.
    server.muted = true;

    expect(await screen.findByText(/weren’t merged into it/, {}, RECONNECT)).toBeInTheDocument();
    expect(screen.getByText('Loading editor…')).toBeInTheDocument();
  });

  it('saves offered edits against the file they were based on, so a later change is not replaced silently', async () => {
    const server = new FakeDocServer('# Plan');
    const transport = createMockTransport({
      connectDocCollab: server.transport().connectDocCollab,
      // Somebody changed the file after the last save this editor heard of.
      readFileContent: vi
        .fn()
        .mockResolvedValue({ content: '# Changed', hash: 'h-later', encoding: 'utf-8' }),
      writeFile: vi.fn().mockResolvedValue({
        ok: false,
        conflict: { currentHash: 'h-later', currentContent: '# Changed' },
      }),
    });
    renderSlot(transport, { on: true });
    await screen.findByTestId('live-editor', {}, LAZY);
    server.save('h-saved');
    typeLive('Typed after the last save.');
    editorChange.current?.('# Plan\n\nTyped after the last save.');
    server.refuseWith = 404;
    server.dropAll();

    fireEvent.click(await screen.findByRole('button', { name: 'Save them' }, RECONNECT));
    await waitFor(() =>
      expect(transport.writeFile).toHaveBeenCalledWith(
        '/work',
        'plan.md',
        '# Plan\n\nTyped after the last save.',
        { expectedHash: 'h-saved' }
      )
    );
    expect(await screen.findByText(/Saving replaces those changes/)).toBeInTheDocument();
  });

  it('offers nothing when every edit already reached the file', async () => {
    const server = new FakeDocServer('# Plan');
    const transport = createMockTransport({
      connectDocCollab: server.transport().connectDocCollab,
      readFileContent: vi
        .fn()
        .mockResolvedValue({ content: '# Other', hash: 'h', encoding: 'utf-8' }),
    });
    renderSlot(transport, { on: true });
    await screen.findByTestId('live-editor', {}, LAZY);
    typeLive('Saved words.');
    editorChange.current?.('# Plan\n\nSaved words.');
    server.save('h-saved');
    server.refuseWith = 404;
    server.dropAll();
    expect(await screen.findByTestId('file-editor', {}, RECONNECT)).toBeInTheDocument();
    // An offer would read the file to compare; nothing is offered, so nothing is read.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transport.readFileContent).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save them' })).not.toBeInTheDocument();
  });

  it('keeps edits as a version when a fresh copy of the doc replaces this one', async () => {
    const server = new FakeDocServer('# Old');
    const transport = createMockTransport({
      connectDocCollab: server.transport().connectDocCollab,
    });
    renderSlot(transport, { on: true });
    await screen.findByTestId('live-editor', {}, LAZY);
    typeLive('Typed on the old copy.');
    editorChange.current?.('# Old\n\nTyped on the old copy.');
    server.dropAll();
    server.reload('# Fresh');

    await waitFor(
      () =>
        expect(transport.keepDocDraft).toHaveBeenCalledWith(
          { cwd: '/work', path: 'plan.md' },
          '# Old\n\nTyped on the old copy.'
        ),
      RECONNECT
    );
    expect(await screen.findByText(/kept as a version/, {}, RECONNECT)).toBeInTheDocument();
    // Nothing from the old copy reached the fresh one.
    expect(server.text()).not.toContain('Typed on the old copy.');
  });
});
