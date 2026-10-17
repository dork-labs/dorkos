/**
 * @vitest-environment jsdom
 *
 * A session canvas's files save through the Doc Channel (DOR-2665), which
 * records each save as a document event. Live editing (DOR-2984) would bypass
 * that, so with live docs on, a session canvas file still opens in today's
 * editor and no live socket is opened for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

const mockState = {
  selectedCwd: '/work' as string | null,
  canvasSessionId: 'session-1' as string | null,
  roomCanvasLiveRoomId: null as string | null,
  openDocuments: [{ id: 'doc-1', editing: false }],
  setDocumentEditing: vi.fn(),
};
const transport = {
  readFileContent: vi.fn().mockResolvedValue({ content: '# Plan', hash: 'h', encoding: 'utf-8' }),
  connectDocCollab: vi.fn(),
};

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  return {
    useAppStore,
    useResolvedTheme: () => 'light' as const,
    useTransport: () => transport,
  };
});
vi.mock('../ui/file-save/SessionFileEditor', () => ({
  SessionFileEditor: () => <div data-testid="session-file-editor" />,
}));
vi.mock('../ui/file-save/FileEditor', () => ({
  FileEditor: () => <div data-testid="file-editor" />,
}));

import { LiveDocsContext } from '../model/live-docs-context';
import { CanvasFileContent } from '../ui/CanvasFileContent';

afterEach(cleanup);

describe('CanvasFileContent with live docs on', () => {
  it('keeps a session canvas file on the Doc Channel’s editor, with no live socket', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LiveDocsContext.Provider value>
          <CanvasFileContent
            content={{ type: 'file', sourcePath: 'plan.md', title: 'Plan' }}
            documentId="doc-1"
          />
        </LiveDocsContext.Provider>
      </QueryClientProvider>
    );
    expect(await screen.findByTestId('session-file-editor')).toBeInTheDocument();
    expect(transport.connectDocCollab).not.toHaveBeenCalled();
  });
});
