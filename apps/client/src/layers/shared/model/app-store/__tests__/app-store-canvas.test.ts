/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../app-store';

describe('CanvasSlice — canvasEditing (transient edit flag)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      canvasOpen: false,
      canvasContent: null,
      canvasSessionId: null,
      canvasEditing: false,
    });
  });

  it('setCanvasEditing flips the flag', () => {
    expect(useAppStore.getState().canvasEditing).toBe(false);
    useAppStore.getState().setCanvasEditing(true);
    expect(useAppStore.getState().canvasEditing).toBe(true);
    useAppStore.getState().setCanvasEditing(false);
    expect(useAppStore.getState().canvasEditing).toBe(false);
  });

  it('is transient — setCanvasEditing never writes to the per-session canvas store', () => {
    useAppStore.getState().loadCanvasForSession('sess-1');
    useAppStore.getState().setCanvasContent({ type: 'markdown', content: '# Hi' });
    const before = JSON.stringify(localStorage);
    useAppStore.getState().setCanvasEditing(true);
    expect(JSON.stringify(localStorage)).toBe(before);
    expect(useAppStore.getState().canvasEditing).toBe(true);
  });

  it('loadCanvasForSession clears canvasEditing so a new session never inherits edit mode', () => {
    useAppStore.getState().setCanvasEditing(true);
    useAppStore.getState().loadCanvasForSession('sess-2');
    expect(useAppStore.getState().canvasEditing).toBe(false);
  });
});
