/**
 * @vitest-environment jsdom
 *
 * The comments frame hands the editor through untouched while the Docs
 * experiment is off or the markdown is not a file, and asks nothing of the
 * server then; on, for a file, it brings the comments in (DOR-2983).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { DocCommentsFrame } from '../ui/DocCommentsFrame';

const experiment = vi.hoisted(() => ({ enabled: false, isLoading: false }));
vi.mock('@/layers/entities/config', () => ({
  useExperimentEnabledState: (path: string) => ({
    enabled: path === 'docs.enabled' && experiment.enabled,
    isLoading: experiment.isLoading,
  }),
}));
vi.mock('@blintz/comments', () => ({
  useBlintzComments: () => ({
    plugin: () => undefined,
    anchorSelection: () => null,
    rangeOf: () => null,
    threadsAtSelection: () => [],
    reveal: () => false,
  }),
}));

const DOC = { cwd: '/work', path: 'plan.md' };

function mount(doc: typeof DOC | null) {
  const transport = createMockTransport();
  render(
    <TransportProvider transport={transport}>
      <QueryClientProvider client={new QueryClient()}>
        <Suspense fallback={<div>Loading editor…</div>}>
          <DocCommentsFrame doc={doc} value="# Plan" saved="# Plan">
            {(plugins) => (
              <div data-testid="editor" data-plugins={plugins ? plugins.length : 'none'} />
            )}
          </DocCommentsFrame>
        </Suspense>
      </QueryClientProvider>
    </TransportProvider>
  );
  return transport;
}

afterEach(() => {
  cleanup();
  experiment.enabled = false;
  experiment.isLoading = false;
});

describe('DocCommentsFrame', () => {
  it('mounts no editor until the config says whether the experiment is on', () => {
    experiment.isLoading = true;
    mount(DOC);
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument();
  });

  it('hands the editor no Docs additions while the experiment is off', async () => {
    const transport = mount(DOC);
    expect(await screen.findByTestId('editor', {}, { timeout: 10_000 })).toHaveAttribute(
      'data-plugins',
      'none'
    );
    expect(screen.queryByRole('complementary', { name: 'Comments' })).not.toBeInTheDocument();
    expect(transport.listDocCommentThreads).not.toHaveBeenCalled();
  });

  it('hands the editor no Docs additions for markdown that is not a file', () => {
    experiment.enabled = true;
    const transport = mount(null);
    expect(screen.getByTestId('editor')).toHaveAttribute('data-plugins', 'none');
    expect(transport.listDocCommentThreads).not.toHaveBeenCalled();
  });

  it('brings comments in for a file while the experiment is on', async () => {
    experiment.enabled = true;
    const transport = mount(DOC);
    // The comments chunk loads lazily, the first time a doc with comments renders.
    expect(
      await screen.findByRole('complementary', { name: 'Comments' }, { timeout: 10_000 })
    ).toBeInTheDocument();
    expect(screen.getByTestId('editor')).toHaveAttribute('data-plugins', '1');
    expect(transport.listDocCommentThreads).toHaveBeenCalledWith(DOC);
  });
});
