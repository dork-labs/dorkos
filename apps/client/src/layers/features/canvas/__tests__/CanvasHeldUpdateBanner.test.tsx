/**
 * Notify-and-reconcile: the half of ADR-0292 that was deferred for two years.
 *
 * Edit-protection held an agent's canvas push so the editor stayed the sole
 * writer, and then dropped it — the agent was told "success", the person was
 * told nothing, and the content was gone. These cases drive the real store and
 * the real editor through that exact moment: a person edits, an agent pushes,
 * and the choice appears.
 *
 * Deliberately NOT a mocked store. The hold lives in the store and the banner
 * reads it, so a mock here would let the two agree with each other while the
 * product did something else. The only mocks are the pieces jsdom cannot run:
 * the Blintz editor chunk and the transport-backed save hook.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';

// jsdom cannot load Milkdown/ProseMirror. The stub surfaces the value and the
// editable flag, which is how these cases read "is the person still editing".
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({ value, editable }: { value: string; editable: boolean }) => (
    <div data-testid="blintz-canvas" data-editable={String(editable)}>
      <span data-testid="blintz-value">{value}</span>
    </div>
  ),
}));

// The save hook owns the transport write; it is unit-tested on its own. Here it
// only has to say the document is file-backed, which is what offers the pencil.
vi.mock('../model/use-canvas-file-save', () => ({
  useCanvasFileSave: () => ({
    status: 'idle',
    conflict: null,
    canSave: true,
    save: vi.fn().mockResolvedValue('saved'),
    overwrite: vi.fn(),
    adoptDisk: vi.fn(),
    getConfirmedBase: () => ({ content: '', hash: null }),
  }),
}));

import { useAppStore } from '@/layers/shared/model';
import { CanvasContent } from '../ui/AgentCanvas';

const MINE: UiCanvasContent = { type: 'markdown', content: 'my draft', sourcePath: 'notes.md' };
const THEIRS: UiCanvasContent = {
  type: 'markdown',
  content: 'the agent version',
  sourcePath: 'notes.md',
};

/** The active document as the store currently holds it. */
function activeDoc() {
  const s = useAppStore.getState();
  return s.openDocuments.find((d) => d.id === s.activeDocumentId)!;
}

/** Open one file-backed markdown document and start editing it. */
async function openAndEdit(): Promise<void> {
  act(() => {
    useAppStore.getState().openCanvasDocument(MINE);
    useAppStore.setState({ canvasOpen: true, selectedCwd: '/work' });
  });
  render(<CanvasContent />);
  // The editor chunk is lazy, so every assertion about what the person sees
  // waits for it — without this the first case reads the Suspense fallback.
  await screen.findByTestId('blintz-canvas');
  fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
  expect(activeDoc().editing).toBe(true);
}

/** Push an agent update at the active document, the way `update_canvas` does. */
function agentPushes(): void {
  act(() => useAppStore.getState().updateActiveDocument(THEIRS));
}

describe('an agent update that arrives while a person is editing', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      canvasOpen: false,
      openDocuments: [],
      activeDocumentId: null,
      canvasSessionId: 'sess-1',
      selectedCwd: null,
    });
  });
  afterEach(cleanup);

  it('is held and offered, instead of vanishing', async () => {
    await openAndEdit();
    agentPushes();

    expect(screen.getByText(/Your agent changed this while you were editing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
    // The push did NOT land — that is still the edit-protection rule.
    expect(activeDoc().content).toEqual(MINE);
    expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-editable', 'true');
  });

  it('says nothing at all when nobody is editing — the push just lands', async () => {
    act(() => {
      useAppStore.getState().openCanvasDocument(MINE);
      useAppStore.setState({ canvasOpen: true, selectedCwd: '/work' });
    });
    render(<CanvasContent />);
    await screen.findByTestId('blintz-canvas');
    agentPushes();

    expect(activeDoc().content).toEqual(THEIRS);
    expect(screen.queryByRole('button', { name: 'Keep mine' })).not.toBeInTheDocument();
  });

  it('Reload takes the agent version, ends the edit, and clears the notice', async () => {
    await openAndEdit();
    agentPushes();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(activeDoc().content).toEqual(THEIRS);
    expect(activeDoc().heldUpdate).toBeNull();
    expect(activeDoc().editing).toBe(false);
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    // The editor followed the store out of edit mode, so the agent's version is
    // what the person is now looking at — not their draft with a stale notice.
    const editor = screen.getByTestId('blintz-canvas');
    expect(editor).toHaveAttribute('data-editable', 'false');
    expect(screen.getByTestId('blintz-value')).toHaveTextContent('the agent version');
  });

  it('Keep mine throws the agent version away and leaves the edit running', async () => {
    await openAndEdit();
    agentPushes();

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));

    expect(activeDoc().content).toEqual(MINE);
    expect(activeDoc().heldUpdate).toBeNull();
    expect(activeDoc().editing).toBe(true);
    expect(screen.queryByRole('button', { name: 'Keep mine' })).not.toBeInTheDocument();
    expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-editable', 'true');
  });

  it('offers the newest version when the agent pushes twice', async () => {
    await openAndEdit();
    agentPushes();
    const newest: UiCanvasContent = { ...THEIRS, content: 'the agent version, again' };
    act(() => useAppStore.getState().updateActiveDocument(newest));

    // One notice, not two, and Reload takes the current version rather than the
    // one the person was first offered.
    expect(screen.getAllByRole('button', { name: 'Reload' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(activeDoc().content).toEqual(newest);
  });
});
