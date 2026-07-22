/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockState = {
  selectedCwd: '/work' as string | null,
  sessionId: 'sess-1' as string | null,
};
// The resolved theme handed to the diff viewer. `useResolvedTheme` (system→OS
// resolution) is unit-tested in shared/model/__tests__/use-theme.test.ts; here
// we prove the diff surface forwards it instead of the old `=== 'dark'` collapse.
const mockResolvedTheme = { value: 'light' as 'light' | 'dark' };

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  return {
    useAppStore,
    useIsMobile: () => false,
    useResolvedTheme: () => mockResolvedTheme.value,
  };
});

// Ready diff data so the surface reaches the CodeMirror merge view.
const review = {
  isLoading: false,
  error: null as unknown,
  data: {
    baseline: 'const x = 1;\n',
    current: 'const x = 2;\n',
    capturedFrom: 'session',
    baselineHash: 'h1',
    currentHash: 'h2',
  },
  mode: 'session' as const,
  setMode: vi.fn(),
  conflict: false,
  writeFailed: false,
  writing: false,
  rejectHunk: vi.fn(),
  rejectAll: vi.fn(),
  markReviewed: vi.fn(),
  refresh: vi.fn(),
  revalidate: vi.fn(),
};
vi.mock('../model/use-diff-review', () => ({ useDiffReview: () => review }));
vi.mock('../model/use-agent-edit-refresh', () => ({ useAgentEditRefresh: () => {} }));

// Stub the heavy @codemirror/merge surface; surface the theme it receives.
vi.mock('../ui/CodeMirrorDiff', () => ({
  CodeMirrorDiff: ({ theme }: { theme: string }) => (
    <div data-testid="cm-diff" data-theme={theme} />
  ),
}));
// Image diff is a sibling import that never renders for a text file — stub it so
// its import chain stays out of jsdom.
vi.mock('../ui/CanvasImageDiffContent', () => ({
  CanvasImageDiffContent: () => <div data-testid="image-diff" />,
}));

import type { UiCanvasContent } from '@dorkos/shared/types';
import { CanvasDiffContent } from '../ui/CanvasDiffContent';

const textDiff: Extract<UiCanvasContent, { type: 'diff' }> = {
  type: 'diff',
  sourcePath: 'src/index.ts',
  mediaKind: 'text',
};

beforeEach(() => {
  mockResolvedTheme.value = 'light';
});
afterEach(cleanup);

describe('CanvasDiffContent theme forwarding', () => {
  it('forwards a resolved dark theme to the diff viewer (system + OS-dark → dark)', async () => {
    mockResolvedTheme.value = 'dark';
    render(<CanvasDiffContent content={textDiff} documentId="d1" />);
    const diff = await screen.findByTestId('cm-diff');
    expect(diff).toHaveAttribute('data-theme', 'dark');
  });

  it('forwards a resolved light theme to the diff viewer', async () => {
    mockResolvedTheme.value = 'light';
    render(<CanvasDiffContent content={textDiff} documentId="d1" />);
    const diff = await screen.findByTestId('cm-diff');
    expect(diff).toHaveAttribute('data-theme', 'light');
  });
});
