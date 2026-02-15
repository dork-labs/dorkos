// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useInteractiveShortcuts } from '../use-interactive-shortcuts';

function fireKey(key: string, options: Partial<KeyboardEvent> = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
}

function fireKeyOnElement(el: HTMLElement, key: string, options: Partial<KeyboardEvent> = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
}

describe('useInteractiveShortcuts', () => {
  const onApprove = vi.fn();
  const onDeny = vi.fn();
  const onToggleOption = vi.fn();
  const onNavigateOption = vi.fn();
  const onNavigateQuestion = vi.fn();
  const onSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Unmount all rendered hooks to remove their event listeners
    cleanup();
    // Clean up any DOM elements created during tests
    document.body.innerHTML = '';
  });

  describe('when activeInteraction is null', () => {
    it('does not fire any shortcuts', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: null,
          onApprove,
          onDeny,
          onToggleOption,
          onNavigateOption,
          onNavigateQuestion,
          onSubmit,
        }),
      );

      fireKey('Enter');
      fireKey('Escape');
      fireKey('1');
      fireKey('ArrowUp');
      fireKey(' ');

      expect(onApprove).not.toHaveBeenCalled();
      expect(onDeny).not.toHaveBeenCalled();
      expect(onToggleOption).not.toHaveBeenCalled();
      expect(onNavigateOption).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('approval mode', () => {
    const approvalInteraction = { type: 'approval' as const, toolCallId: 'tc-1' };

    it('fires onApprove on Enter', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: approvalInteraction,
          onApprove,
          onDeny,
        }),
      );

      fireKey('Enter');
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('fires onDeny on Escape', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: approvalInteraction,
          onApprove,
          onDeny,
        }),
      );

      fireKey('Escape');
      expect(onDeny).toHaveBeenCalledTimes(1);
    });

    it('does not fire question shortcuts in approval mode', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: approvalInteraction,
          onApprove,
          onDeny,
          onToggleOption,
          onNavigateOption,
          onSubmit,
        }),
      );

      fireKey('1');
      fireKey('ArrowUp');
      fireKey(' ');

      expect(onToggleOption).not.toHaveBeenCalled();
      expect(onNavigateOption).not.toHaveBeenCalled();
    });

    it('prevents double-fire via respondingRef', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: approvalInteraction,
          onApprove,
          onDeny,
        }),
      );

      fireKey('Enter');
      fireKey('Enter');

      // Only first fires because respondingRef is set to true
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('resets respondingRef when toolCallId changes', () => {
      const { rerender } = renderHook(
        ({ interaction }) =>
          useInteractiveShortcuts({
            activeInteraction: interaction,
            onApprove,
            onDeny,
          }),
        { initialProps: { interaction: approvalInteraction } },
      );

      fireKey('Enter');
      expect(onApprove).toHaveBeenCalledTimes(1);

      // Change toolCallId to reset respondingRef
      rerender({ interaction: { type: 'approval' as const, toolCallId: 'tc-2' } });

      fireKey('Enter');
      expect(onApprove).toHaveBeenCalledTimes(2);
    });
  });

  describe('question mode', () => {
    const questionInteraction = { type: 'question' as const, toolCallId: 'tc-q1' };

    it('fires onToggleOption with correct index for digit keys 1-9', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onToggleOption,
          optionCount: 5,
        }),
      );

      fireKey('1');
      expect(onToggleOption).toHaveBeenCalledWith(0);

      fireKey('3');
      expect(onToggleOption).toHaveBeenCalledWith(2);

      fireKey('5');
      expect(onToggleOption).toHaveBeenCalledWith(4);
    });

    it('ignores digit keys beyond optionCount', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onToggleOption,
          optionCount: 2,
        }),
      );

      fireKey('3'); // Index 2, but optionCount is 2 so max index is 1
      expect(onToggleOption).not.toHaveBeenCalled();

      fireKey('2'); // Index 1, within bounds
      expect(onToggleOption).toHaveBeenCalledWith(1);
    });

    it('fires onNavigateOption with "up" on ArrowUp', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onNavigateOption,
        }),
      );

      fireKey('ArrowUp');
      expect(onNavigateOption).toHaveBeenCalledWith('up');
    });

    it('fires onNavigateOption with "down" on ArrowDown', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onNavigateOption,
        }),
      );

      fireKey('ArrowDown');
      expect(onNavigateOption).toHaveBeenCalledWith('down');
    });

    it('fires onToggleOption with focusedIndex on Space', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onToggleOption,
          focusedIndex: 2,
        }),
      );

      fireKey(' ');
      expect(onToggleOption).toHaveBeenCalledWith(2);
    });

    it('fires onNavigateQuestion with "prev" on ArrowLeft', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onNavigateQuestion,
        }),
      );

      fireKey('ArrowLeft');
      expect(onNavigateQuestion).toHaveBeenCalledWith('prev');
    });

    it('fires onNavigateQuestion with "next" on ArrowRight', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onNavigateQuestion,
        }),
      );

      fireKey('ArrowRight');
      expect(onNavigateQuestion).toHaveBeenCalledWith('next');
    });

    it('fires onNavigateQuestion with "prev" on [ key', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onNavigateQuestion,
        }),
      );

      fireKey('[');
      expect(onNavigateQuestion).toHaveBeenCalledWith('prev');
    });

    it('fires onNavigateQuestion with "next" on ] key', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onNavigateQuestion,
        }),
      );

      fireKey(']');
      expect(onNavigateQuestion).toHaveBeenCalledWith('next');
    });

    it('fires onSubmit on Enter', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onSubmit,
        }),
      );

      fireKey('Enter');
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('text input filtering in question mode', () => {
    const questionInteraction = { type: 'question' as const, toolCallId: 'tc-q1' };

    it('disables digit, arrow, and space shortcuts when typing in a textarea', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onToggleOption,
          onNavigateOption,
          onNavigateQuestion,
          onSubmit,
          optionCount: 5,
          focusedIndex: 0,
        }),
      );

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);

      fireKeyOnElement(textarea, '1');
      fireKeyOnElement(textarea, 'ArrowUp');
      fireKeyOnElement(textarea, ' ');
      fireKeyOnElement(textarea, 'ArrowLeft');

      expect(onToggleOption).not.toHaveBeenCalled();
      expect(onNavigateOption).not.toHaveBeenCalled();
      expect(onNavigateQuestion).not.toHaveBeenCalled();
    });

    it('allows Enter for submit when typing in a textarea', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onSubmit,
        }),
      );

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);

      fireKeyOnElement(textarea, 'Enter');
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('does not fire submit on Shift+Enter in textarea (allows newline)', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onSubmit,
        }),
      );

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);

      fireKeyOnElement(textarea, 'Enter', { shiftKey: true });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('disables shortcuts when typing in an input', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onToggleOption,
          optionCount: 5,
        }),
      );

      const input = document.createElement('input');
      document.body.appendChild(input);

      fireKeyOnElement(input, '1');
      expect(onToggleOption).not.toHaveBeenCalled();
    });

    it('does not filter shortcuts for disabled inputs', () => {
      renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: questionInteraction,
          onToggleOption,
          optionCount: 5,
        }),
      );

      const input = document.createElement('input');
      input.disabled = true;
      document.body.appendChild(input);

      fireKeyOnElement(input, '1');
      expect(onToggleOption).toHaveBeenCalledWith(0);
    });
  });

  describe('cleanup', () => {
    it('removes event listener on unmount', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener');

      const { unmount } = renderHook(() =>
        useInteractiveShortcuts({
          activeInteraction: { type: 'approval', toolCallId: 'tc-1' },
          onApprove,
        }),
      );

      unmount();
      expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
      removeSpy.mockRestore();
    });
  });
});
