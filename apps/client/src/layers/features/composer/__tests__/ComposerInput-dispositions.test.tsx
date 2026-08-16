// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComposerInput } from '../ui/ComposerInput';

/**
 * The Queue / Steer / Add context affordances, and the keyboard chords behind
 * them.
 *
 * Two separate questions, tested separately because they fail for different
 * reasons. The BUTTON layer: whether the extra-dispositions caret appears at all
 * — only while a turn is running, and only when the host wired the verb (which
 * it does exactly when the runtime can honour it). The KEYBOARD layer: whether
 * ⌘/Ctrl+Enter reaches the steer, ⌘/Ctrl+Shift+Enter the stage, and an
 * unsupported chord falls through to the ordinary Queue rather than doing
 * nothing. Menu ROW rendering lives in `DispositionMenu.test.tsx`.
 */

// A plain desktop: fine pointer, no coarse primary, wide. Enter means send here,
// which is the only device the chords live on.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const matches = query.includes('(any-pointer: fine)');
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
});

afterEach(() => cleanup());

const base = {
  onChange: vi.fn(),
  onSubmit: vi.fn(),
};

/** The composer's caret that opens Steer / Add context, if the split is shown. */
function moreWaysCaret() {
  return screen.queryByRole('button', { name: 'More ways to send' });
}

describe('ComposerInput — the split action shows Queue plus the supported extras', () => {
  it('an idle session shows a plain Send, never the disposition caret', () => {
    render(
      <ComposerInput
        {...base}
        value="Refactor the auth module"
        isStreaming={false}
        onSteer={() => {}}
        onStage={() => {}}
      />
    );
    // Idle: every disposition would just run now, so there is one Send and no
    // split — even though the runtime CAN steer.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    expect(moreWaysCaret()).toBeNull();
  });

  it('a busy session on a steer-capable runtime shows Queue plus the caret', () => {
    render(
      <ComposerInput
        {...base}
        value="Also check the tests"
        isStreaming
        onQueue={() => {}}
        onSteer={() => {}}
        onStage={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy();
    expect(moreWaysCaret()).toBeTruthy();
  });

  it('a busy session on a queue-only runtime shows a plain Queue, no caret', () => {
    render(<ComposerInput {...base} value="Also check the tests" isStreaming onQueue={() => {}} />);
    // codex / opencode: the extras are ABSENT, not greyed.
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy();
    expect(moreWaysCaret()).toBeNull();
  });

  it('shows no caret while streaming with an empty box (nothing to send)', () => {
    render(<ComposerInput {...base} value="" isStreaming onSteer={() => {}} onStage={() => {}} />);
    expect(moreWaysCaret()).toBeNull();
  });
});

describe('ComposerInput — the steer / add-context keyboard chords', () => {
  function renderBusy(props: Partial<Parameters<typeof ComposerInput>[0]>) {
    render(<ComposerInput {...base} value="Also check the tests" isStreaming {...props} />);
    const field = screen.getByRole('combobox');
    field.focus();
    return field;
  }

  it('⌘+Enter steers, and does not also queue', () => {
    const onSteer = vi.fn();
    const onQueue = vi.fn();
    const field = renderBusy({ onSteer, onStage: () => {}, onQueue });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter steers too (the non-mac chord)', () => {
    const onSteer = vi.fn();
    const field = renderBusy({ onSteer, onQueue: vi.fn() });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(onSteer).toHaveBeenCalledTimes(1);
  });

  it('⌘+Shift+Enter adds context', () => {
    const onStage = vi.fn();
    const onSteer = vi.fn();
    const onQueue = vi.fn();
    const field = renderBusy({ onSteer, onStage, onQueue });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onSteer).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('an unsupported ⌘+Enter falls through to Queue rather than doing nothing', () => {
    const onQueue = vi.fn();
    // Steer-only host omitted: the runtime cannot steer, so ⌘+Enter must not be
    // a dead key — it queues, exactly what a plain Enter would do here.
    const field = renderBusy({ onQueue });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it('an unsupported ⌘+Shift+Enter also queues, never swallowed', () => {
    const onQueue = vi.fn();
    // No onStage: a stage-incapable runtime. The chord must not be a dead key
    // either — same fallback as the steer chord.
    const field = renderBusy({ onQueue });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it('the chords are inert on an idle session (they are a running-turn thing)', () => {
    const onSteer = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ComposerInput
        {...base}
        onSubmit={onSubmit}
        value="Refactor the auth module"
        isStreaming={false}
        onSteer={onSteer}
        onStage={() => {}}
      />
    );
    const field = screen.getByRole('combobox');
    field.focus();
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    // Idle: ⌘+Enter is not a steer — it falls to the ordinary send.
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
