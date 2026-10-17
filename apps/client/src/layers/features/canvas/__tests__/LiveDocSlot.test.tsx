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
import { FakeDocServer } from '@/layers/features/docs/__tests__/fake-doc-server';

// The canvas editor, as a stub that shows what it was handed.
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: (props: { plugins?: unknown[]; editable: boolean }) => (
    <div
      data-testid="live-editor"
      data-plugins={props.plugins?.length ?? 0}
      data-editable={String(props.editable)}
    />
  ),
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
  { on, onRestored }: { on: boolean; onRestored?: () => void }
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
        onRestored={onRestored}
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
    expect(editor).toHaveAttribute('data-editable', 'true');
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
      expect.any(Object)
    );
  });

  it('offers Restore previous version once a version exists, and reloads the file after', async () => {
    const onRestored = vi.fn();
    const transport = createMockTransport({
      listDocVersions: vi.fn().mockResolvedValue({ versions: [VERSION] }),
      restoreDocVersion: vi.fn().mockResolvedValue({ ok: true, live: false }),
    });
    renderSlot(transport, { on: true, onRestored });

    const restore = await screen.findByRole('button', { name: /restore previous version/i }, LAZY);
    expect(restore).toHaveAttribute('title', expect.stringContaining('Ada’s change'));
    fireEvent.click(restore);
    await waitFor(() =>
      expect(transport.restoreDocVersion).toHaveBeenCalledWith(
        { cwd: '/work', path: 'plan.md' },
        VERSION.id
      )
    );
    await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
  });
});
