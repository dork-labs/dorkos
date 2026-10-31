/**
 * @vitest-environment jsdom
 */
/**
 * A page DorkOS could not add its scripts to says why, in one line above the
 * frame, and a page it could says nothing (DOR-3131).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type {
  FrameBridgeRefusal,
  WorkbenchBridgeStatusRequest,
  WorkbenchBridgeStatusResponse,
} from '@dorkos/shared/schemas';

const mockState = {
  openDocuments: [],
  selectedCwd: '/work' as string | null,
  roomCanvasLiveRoomId: null as string | null,
  roomCanvasEditing: {} as Record<string, string | null>,
  browserHistories: {},
  writeBrowserHistory: vi.fn(),
};
const getFrameBridgeStatus = vi.fn(
  async (_target: WorkbenchBridgeStatusRequest): Promise<WorkbenchBridgeStatusResponse> => ({
    bridge: 'unknown',
  })
);

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  return {
    useAppStore,
    useTransport: () => ({
      createServeUrl: async () => '/api/workbench/serve/tok/page.html',
      createProxyUrl: async () => ({ url: 'http://localhost:4390/?__dorkos_preview=tok' }),
      probeLoopbackPort: async () => ({ listening: true }),
      openRoomCanvasDocument: async () => ({}),
      getFrameBridgeStatus,
    }),
    useSafeSearch: () => ({}),
  };
});
vi.mock('../lib/probe-direct', () => ({ probeDirect: async () => true }));
// The transport above is rebuilt on every render, and the page's document
// channel keys on transport identity, so it is inert here, as in the other
// browser suites. Its real composition is covered in CanvasBrowserContentFrame.
vi.mock('../model/use-doc-frame-channel', () => ({
  useDocFrameChannel: (params: { resolvedSource: string | null }) => ({
    frameSource: params.resolvedSource,
    requiresReload: false,
    noteFrameLoaded: () => {},
  }),
}));

import { CanvasBrowserContent } from '../ui/CanvasBrowserContent';

const COPY: Record<FrameBridgeRefusal, string> = {
  csp: 'This page’s security policy blocks added scripts, so it can’t talk to its agent.',
  encoding: 'This page isn’t saved as UTF-8, so it can’t talk to its agent.',
  oversize: 'This page is over 5 MB, so it can’t talk to its agent.',
  'no-head': 'This page has no <head> tag, so it can’t talk to its agent.',
  markup: 'DorkOS can’t safely read this page’s <head>, so it can’t talk to its agent.',
  'fixed-source': 'DorkOS couldn’t connect this page to its agent.',
};

async function loadedFrame(url: string): Promise<HTMLIFrameElement> {
  render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url }} />);
  const frame = await waitFor(() => {
    const element = document.querySelector('iframe');
    expect(element).not.toBeNull();
    return element as HTMLIFrameElement;
  });
  await act(async () => {
    fireEvent.load(frame);
  });
  return frame;
}

beforeEach(() => {
  mockState.selectedCwd = '/work';
  getFrameBridgeStatus.mockReset();
  getFrameBridgeStatus.mockResolvedValue({ bridge: 'unknown' });
});
afterEach(() => cleanup());

describe('CanvasBrowserContent — why a page cannot talk to its agent', () => {
  it.each(Object.entries(COPY) as [FrameBridgeRefusal, string][])(
    'shows one line for %s',
    async (reason, line) => {
      getFrameBridgeStatus.mockResolvedValue({ bridge: 'refused', reason });
      await loadedFrame('page.html');
      expect(await screen.findByText(line)).toBeInTheDocument();
      expect(document.querySelectorAll('[data-bridge-refusal]')).toHaveLength(1);
      // The page is named the way it was opened: a file under the session's folder.
      expect(getFrameBridgeStatus).toHaveBeenCalledWith({
        kind: 'serve',
        cwd: '/work',
        path: 'page.html',
      });
    }
  );

  it('says nothing when the scripts went in', async () => {
    getFrameBridgeStatus.mockResolvedValue({ bridge: 'added' });
    await loadedFrame('page.html');
    await act(async () => {});
    expect(getFrameBridgeStatus).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-bridge-refusal]')).toBeNull();
  });

  it('forgets the reason once the page navigates itself, and asks nothing about it', async () => {
    getFrameBridgeStatus.mockResolvedValue({ bridge: 'refused', reason: 'csp' });
    const frame = await loadedFrame('page.html');
    expect(await screen.findByText(COPY.csp)).toBeInTheDocument();
    // A link clicked inside the frame: a second load the host did not issue.
    await act(async () => {
      fireEvent.load(frame);
    });
    await act(async () => {});
    expect(document.querySelector('[data-bridge-refusal]')).toBeNull();
    expect(getFrameBridgeStatus).toHaveBeenCalledTimes(1);
  });

  it('asks again when the host reloads the page', async () => {
    getFrameBridgeStatus.mockResolvedValue({ bridge: 'refused', reason: 'markup' });
    const frame = await loadedFrame('page.html');
    expect(await screen.findByText(COPY.markup)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Reload'));
    const reloaded = await waitFor(() => {
      const element = document.querySelector('iframe');
      expect(element).not.toBeNull();
      expect(element).not.toBe(frame);
      return element as HTMLIFrameElement;
    });
    expect(document.querySelector('[data-bridge-refusal]')).toBeNull();
    await act(async () => {
      fireEvent.load(reloaded);
    });
    expect(await screen.findByText(COPY.markup)).toBeInTheDocument();
    expect(getFrameBridgeStatus).toHaveBeenCalledTimes(2);
  });

  it('says nothing before the frame has loaded', async () => {
    getFrameBridgeStatus.mockResolvedValue({ bridge: 'refused', reason: 'csp' });
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'page.html' }} />
    );
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(getFrameBridgeStatus).not.toHaveBeenCalled();
    expect(document.querySelector('[data-bridge-refusal]')).toBeNull();
  });

  it('asks about a dev server page by its own port and path', async () => {
    getFrameBridgeStatus.mockResolvedValue({ bridge: 'refused', reason: 'markup' });
    await loadedFrame('http://localhost:5173/app?tab=1');
    expect(await screen.findByText(COPY.markup)).toBeInTheDocument();
    expect(getFrameBridgeStatus).toHaveBeenCalledWith({
      kind: 'proxy',
      port: 5173,
      path: '/app?tab=1',
    });
  });

  it('never asks about an external site, which DorkOS adds nothing to', async () => {
    await loadedFrame('https://example.com/');
    expect(getFrameBridgeStatus).not.toHaveBeenCalled();
  });
});
