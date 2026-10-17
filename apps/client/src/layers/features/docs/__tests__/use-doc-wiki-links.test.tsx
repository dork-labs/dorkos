/**
 * `useDocWikiLinks` (DOR-2982): the editor's `wikiLinks` for one file-backed
 * doc. Nothing while Docs is off or the doc has no file; sync resolution and
 * search over the space's index; an identity that changes only with the
 * index's data; opening a link through the `open_file` seam; and a fresh
 * index after a save.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WikiLink } from 'blintz';
import type { DocIndex } from '@dorkos/shared/doc-links';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';

const { executeUiCommand, toastInfo } = vi.hoisted(() => ({
  executeUiCommand: vi.fn(),
  toastInfo: vi.fn(),
}));
// Observe the `open_file` seam a link drives, without running the canvas dispatch.
vi.mock('@/layers/shared/lib', async (importActual) => ({
  ...(await importActual<typeof import('@/layers/shared/lib')>()),
  executeUiCommand,
}));
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: vi.fn(), success: vi.fn() } }));

import { docKeys } from '@/layers/entities/doc';
import { configKeys, TransportProvider } from '@/layers/shared/model';
import { useDocWikiLinks, type UseDocWikiLinksInput } from '../index';

const CWD = '/repo';

const INDEX: DocIndex = {
  docs: [
    { path: 'README.md', title: 'Welcome', slug: 'readme' },
    { path: 'notes/plan.md', title: 'Launch plan', slug: 'plan' },
    { path: 'notes/Meeting Notes.md', title: 'Meeting notes', slug: 'meeting-notes' },
  ],
  truncated: false,
};

/** The server config, with the Docs experiment on or off. */
function configWith(on: boolean) {
  return {
    experiments: [
      { key: 'docs.enabled', title: 'Docs', description: '', enabled: on, lockedByEnv: false },
    ],
  };
}

/** A wiki link as Blintz hands it over. */
function link(target: string, heading: string | null = null): WikiLink {
  return { target, heading, label: null, embed: false };
}

let queryClient: QueryClient;
let transport: Transport;
let getDocIndex: ReturnType<typeof vi.fn>;

function setup(options: { on?: boolean } = {}) {
  const config = configWith(options.on ?? true);
  getDocIndex = vi.fn().mockResolvedValue(INDEX);
  transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue(config), getDocIndex });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function renderLinks(input: UseDocWikiLinksInput) {
  return renderHook((props: UseDocWikiLinksInput) => useDocWikiLinks(props), {
    wrapper,
    initialProps: input,
  });
}

/** Render, and wait for the index to arrive. */
async function ready(input: UseDocWikiLinksInput = { cwd: CWD, sourcePath: 'notes/plan.md' }) {
  const hook = renderLinks(input);
  await waitFor(() => expect(hook.result.current).toBeDefined());
  return hook;
}

beforeEach(() => setup());
afterEach(() => vi.clearAllMocks());

describe('useDocWikiLinks', () => {
  it('gives nothing, and asks nothing, while Docs is off', async () => {
    setup({ on: false });
    const { result } = renderLinks({ cwd: CWD, sourcePath: 'notes/plan.md' });
    await act(async () => {});
    expect(result.current).toBeUndefined();
    expect(getDocIndex).not.toHaveBeenCalled();
  });

  it('gives nothing to a doc with no file in the space', async () => {
    for (const input of [
      { cwd: CWD, sourcePath: undefined },
      { cwd: CWD, sourcePath: null },
      { cwd: null, sourcePath: 'notes/plan.md' },
      { cwd: CWD, sourcePath: '/elsewhere/plan.md' },
    ]) {
      const { result, unmount } = renderLinks(input);
      await act(async () => {});
      expect(result.current).toBeUndefined();
      unmount();
    }
    expect(getDocIndex).not.toHaveBeenCalled();
  });

  it('resolves links at once, with hrefs relative to the open doc', async () => {
    const { result } = await ready();
    const { resolve } = result.current!;
    expect(resolve!(link('Welcome'))).toEqual({
      exists: true,
      href: '../README.md',
      title: 'Welcome',
    });
    expect(resolve!(link('meeting-notes', 'Next steps'))).toEqual({
      exists: true,
      href: 'Meeting%20Notes.md#next-steps',
      title: 'Meeting notes',
    });
    expect(resolve!(link('', 'Goals'))).toEqual({ exists: true, href: '#goals' });
    expect(resolve!(link('No such doc'))).toEqual({ exists: false });
    expect(getDocIndex).toHaveBeenCalledWith(CWD);
  });

  it('reads an absolute sourcePath inside the space as its relative path', async () => {
    const { result } = await ready({ cwd: CWD, sourcePath: '/repo/notes/plan.md' });
    expect(result.current!.resolve!(link('Welcome'))).toMatchObject({ href: '../README.md' });
  });

  it('suggests the space’s docs for the [[ menu, never the open doc', async () => {
    const { result } = await ready();
    const suggestions = await result.current!.search!('');
    expect(suggestions.map((s) => s.description)).toEqual(['notes/Meeting Notes.md', 'README.md']);
    expect(await result.current!.search!('wel')).toEqual([
      { target: 'Welcome', title: 'Welcome', description: 'README.md' },
    ]);
  });

  it('keeps its identity across renders and refetches that answer the same docs', async () => {
    const { result, rerender } = await ready();
    const first = result.current;
    rerender({ cwd: CWD, sourcePath: 'notes/plan.md' });
    expect(result.current).toBe(first);

    getDocIndex.mockResolvedValue(structuredClone(INDEX));
    await act(() => queryClient.refetchQueries({ queryKey: docKeys.index(CWD) }));
    expect(getDocIndex).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(first);
    expect(result.current!.resolve).toBe(first!.resolve);
  });

  it('gets a new resolve once the index changes, so a just-created doc resolves', async () => {
    const { result } = await ready();
    const before = result.current!.resolve;
    expect(before!(link('Brand new'))).toEqual({ exists: false });

    getDocIndex.mockResolvedValue({
      docs: [...INDEX.docs, { path: 'notes/new.md', title: 'Brand new', slug: 'new' }],
      truncated: false,
    });
    await act(() => queryClient.refetchQueries({ queryKey: docKeys.index(CWD) }));
    await waitFor(() => expect(result.current!.resolve).not.toBe(before));
    expect(result.current!.resolve!(link('Brand new'))).toMatchObject({
      exists: true,
      href: 'new.md',
    });
  });

  it('reads the index again each time a save lands', async () => {
    const { rerender } = await ready();
    expect(getDocIndex).toHaveBeenCalledTimes(1);
    rerender({ cwd: CWD, sourcePath: 'notes/plan.md', saved: true });
    await waitFor(() => expect(getDocIndex).toHaveBeenCalledTimes(2));
    rerender({ cwd: CWD, sourcePath: 'notes/plan.md', saved: false });
    rerender({ cwd: CWD, sourcePath: 'notes/plan.md', saved: true });
    await waitFor(() => expect(getDocIndex).toHaveBeenCalledTimes(3));
  });

  it('opens a linked doc through open_file, as the file tree does', async () => {
    const { result } = await ready();
    result.current!.onOpen!(link('Welcome'), undefined);
    expect(executeUiCommand).toHaveBeenCalledWith(
      expect.objectContaining({ supportsTerminal: transport.supportsTerminal }),
      { action: 'open_file', sourcePath: 'README.md' },
      'user'
    );
  });

  it('says so when a link names no doc, and opens nothing', async () => {
    const { result } = await ready();
    result.current!.onOpen!(link('  Someday  '), { exists: false });
    expect(toastInfo).toHaveBeenCalledWith('No doc called “Someday” here yet.');
    result.current!.onOpen!(link('', 'Goals'), undefined);
    expect(executeUiCommand).not.toHaveBeenCalled();
  });
});
