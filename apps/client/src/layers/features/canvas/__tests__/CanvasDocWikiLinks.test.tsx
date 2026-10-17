/**
 * @vitest-environment jsdom
 *
 * Wiki links in the canvas's file-backed markdown docs (DOR-2982), against the
 * REAL Blintz editor and the real Docs hook: with the Docs experiment on, a
 * `[[link]]` resolves against the space's docs and a click in a read-only doc
 * opens the target through `open_file`; with it off, or for markdown with no
 * file behind it, the editor gets no `wikiLinks` and links stay plain text.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import '@testing-library/jest-dom/vitest';

const { executeUiCommand } = vi.hoisted(() => ({ executeUiCommand: vi.fn() }));
// Observe the seam a link opens through, without running the canvas dispatch.
vi.mock('@/layers/shared/lib', async (importActual) => ({
  ...(await importActual<typeof import('@/layers/shared/lib')>()),
  executeUiCommand,
}));

// The save hook is tested on its own; these docs are only read.
vi.mock('../model/use-canvas-file-save', () => ({
  useCanvasFileSave: () => ({
    recovery: {
      identity: {},
      supported: false,
      current: () => false,
      discover: async () => ({ status: 'idle' }),
      recover: async () => ({ status: 'idle' }),
      inspectCurrent: async () => ({ status: 'idle' }),
    },
    status: 'idle',
    conflict: null,
    canSave: true,
    save: vi.fn(),
    prepareFinalSave: () => ({ cancel: vi.fn(), flush: vi.fn() }),
    overwrite: vi.fn(),
    adoptDisk: vi.fn(),
    getConfirmedBase: vi.fn(),
  }),
}));

import { configKeys, TransportProvider, useAppStore } from '@/layers/shared/model';
import { CanvasFileContent } from '../ui/CanvasFileContent';
import { CanvasMarkdownContent } from '../ui/CanvasMarkdownContent';

const CWD = '/work';
const DOC_ID = 'doc-plan';
const BODY = '# Plan\n\nSee [[Welcome]] and [[Nowhere]].\n';

let transport: Transport;
let getDocIndex: Mock<Transport['getDocIndex']>;

function renderWith(ui: React.ReactElement, docsOn: boolean) {
  const config = {
    experiments: [
      { key: 'docs.enabled', title: 'Docs', description: '', enabled: docsOn, lockedByEnv: false },
    ],
  };
  getDocIndex = vi.fn<Transport['getDocIndex']>().mockResolvedValue({
    root: CWD,
    docs: [
      { path: 'README.md', title: 'Welcome', slug: 'readme' },
      { path: 'notes/plan.md', title: 'Plan', slug: 'plan' },
    ],
    truncated: false,
  });
  transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    getDocIndex,
    readFileContent: vi.fn().mockResolvedValue({ content: BODY, hash: 'h1', encoding: 'utf-8' }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

/** How long the first lazy load of the editor chunk may take. */
const EDITOR_LOAD = { timeout: 15_000 };

/** The anchor Blintz draws for a wiki link with this text. */
async function wikiLink(text: string): Promise<HTMLAnchorElement> {
  let anchor: HTMLAnchorElement | undefined;
  await waitFor(() => {
    anchor = [...document.querySelectorAll<HTMLAnchorElement>('a.blintz-wiki-link')].find(
      (a) => a.textContent === text
    );
    expect(anchor).toBeDefined();
  }, EDITOR_LOAD);
  return anchor!;
}

const fileDoc: Extract<UiCanvasContent, { type: 'file' }> = {
  type: 'file',
  sourcePath: 'notes/plan.md',
  language: 'markdown',
};

beforeEach(() => {
  useAppStore.setState({
    selectedCwd: CWD,
    canvasSessionId: null,
    roomCanvasLiveRoomId: null,
    openDocuments: [],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('wiki links in a file-backed markdown doc', () => {
  it(
    'resolve against the space with Docs on, and a click opens the linked doc',
    { timeout: 20_000 },
    async () => {
      renderWith(<CanvasFileContent documentId={DOC_ID} content={fileDoc} />, true);
      const welcome = await wikiLink('Welcome');
      await waitFor(() => expect(welcome).toHaveAttribute('data-state', 'resolved'));
      expect(welcome).toHaveAttribute('href', '../README.md');
      expect(await wikiLink('Nowhere')).toHaveAttribute('data-state', 'missing');
      expect(getDocIndex).toHaveBeenCalledWith(CWD);

      fireEvent.click(welcome);
      expect(executeUiCommand).toHaveBeenCalledWith(
        expect.anything(),
        { action: 'open_file', sourcePath: 'README.md' },
        'user'
      );
    }
  );

  it('stay plain text with Docs off, and nothing asks for the space’s docs', async () => {
    renderWith(<CanvasFileContent documentId={DOC_ID} content={fileDoc} />, false);
    const welcome = await wikiLink('Welcome');
    expect(welcome).toHaveAttribute('data-state', 'unresolved');
    expect(welcome).not.toHaveAttribute('href');
    expect(getDocIndex).not.toHaveBeenCalled();
  });

  it('resolve in a markdown canvas doc that has a source file', async () => {
    renderWith(
      <CanvasMarkdownContent
        documentId={DOC_ID}
        content={{ type: 'markdown', content: BODY, sourcePath: 'notes/plan.md' }}
        onContentChange={vi.fn()}
      />,
      true
    );
    const welcome = await wikiLink('Welcome');
    await waitFor(() => expect(welcome).toHaveAttribute('data-state', 'resolved'));
  });

  it('stay plain text in generated markdown with no file behind it', async () => {
    renderWith(
      <CanvasMarkdownContent
        documentId={DOC_ID}
        content={{ type: 'markdown', content: BODY }}
        onContentChange={vi.fn()}
      />,
      true
    );
    expect(await wikiLink('Welcome')).toHaveAttribute('data-state', 'unresolved');
    expect(getDocIndex).not.toHaveBeenCalled();
  });
});
