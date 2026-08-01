// @vitest-environment jsdom
/**
 * The focus restore, driven frame by frame.
 *
 * Its mechanisms are a retry loop, a deadline and a stand-down rule, and none of
 * the three is observable from a page test: in jsdom the panel unmounts in the
 * same commit that closes it, so the room is always already there and the retry
 * never has anything to retry. Every one of these mechanisms went green with
 * the mechanism deleted until this file existed.
 *
 * So the timing is driven directly: fake timers make `requestAnimationFrame` a
 * 16ms tick this test advances by hand, and the DOM is moved between ticks the
 * way a real close moves it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useRestoreThreadFocus } from '../model/use-restore-thread-focus';
import { entryRowId, threadRowId } from '../lib/room-timeline';

/** One frame of the faked clock. */
const FRAME_MS = 16;

/** The hook's window, from its own module — kept in step by construction. */
const WINDOW_MS = 600;

/** The hook under test, mounted for the length of one test. */
let mounted: ReturnType<typeof renderHook<ReturnType<typeof useRestoreThreadFocus>, void>>;

/** Arm a restore for one thread, the way the page does as it closes the panel. */
function armFocus(rootEntryId: string) {
  act(() => mounted.result.current.arm(rootEntryId));
}

/** Advance `frames` animation frames, letting React commit anything they cause. */
function advance(frames: number) {
  act(() => {
    vi.advanceTimersByTime(FRAME_MS * frames);
  });
}

/** A focusable stand-in for a row the room draws, appended to the document. */
function addRow(id: string): HTMLButtonElement {
  const row = document.createElement('button');
  row.id = id;
  row.textContent = id;
  document.body.appendChild(row);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers();
  mounted = renderHook(() => useRestoreThreadFocus());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('useRestoreThreadFocus', () => {
  it('waits for a room that is not back yet, rather than looking once', () => {
    // The mobile case. The panel plays a 150ms exit before the room mounts at
    // all, so a single pass after the close finds nothing and leaves the caret
    // on the body. Delete the retry and this goes red.
    armFocus('entry-1');
    advance(1);
    expect(document.body).toHaveFocus();

    // …the room comes back several frames later, as the exit finishes.
    const row = addRow(threadRowId('entry-1'));
    advance(1);

    expect(row).toHaveFocus();
  });

  it('gives up once its window has passed', () => {
    // Without a deadline the loop runs for as long as the page is open, and a
    // room that reappears a minute later — a slow refetch, a route change and
    // back — would yank the caret out of whatever the reader had moved to.
    armFocus('entry-1');
    advance(Math.ceil(WINDOW_MS / FRAME_MS) + 2);

    const row = addRow(threadRowId('entry-1'));
    advance(2);

    expect(row).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it('leaves the caret where a reader has put it, and never comes back for it', () => {
    // The stand-down. This is the composer case: a reader typing in a box that
    // is still on screen must not have the caret pulled onto a message row
    // behind them, at the close or at any point in the window after it.
    const typing = addRow('composer');
    const row = addRow(threadRowId('entry-1'));
    typing.focus();

    armFocus('entry-1');
    advance(Math.ceil(WINDOW_MS / FRAME_MS) + 2);

    expect(typing).toHaveFocus();
    expect(row).not.toHaveFocus();
  });

  it('takes the caret from a control that has left the document', () => {
    // The other half of the same rule, and why "is focus on the body?" is not
    // enough on its own: the panel's close button is focused and CONNECTED
    // while its exit animation runs, then detaches. A restore that treated a
    // detached element as somebody's place would never fire on that path.
    const closeButton = addRow('close');
    closeButton.focus();
    armFocus('entry-1');

    const row = addRow(threadRowId('entry-1'));
    // Still connected and still focused: the panel is mid-exit. Nothing yet.
    advance(2);
    expect(row).not.toHaveFocus();

    closeButton.remove();
    advance(1);

    expect(row).toHaveFocus();
  });

  it('falls back to the message when the thread drew no reply row', () => {
    // "Reply in thread" opens a thread on a message nobody has answered, so
    // there is no "↳ N replies" row — the only thing the restore first looks
    // for.
    const message = addRow(entryRowId('entry-1'));

    armFocus('entry-1');
    advance(1);

    expect(message).toHaveFocus();
  });

  it('prefers the reply row over the message when both are on screen', () => {
    // Where a reader was standing when they opened it by reading.
    const message = addRow(entryRowId('entry-1'));
    const replyRow = addRow(threadRowId('entry-1'));

    armFocus('entry-1');
    advance(1);

    expect(replyRow).toHaveFocus();
    expect(message).not.toHaveFocus();
  });

  it('drops an armed restore when a second close supersedes it', () => {
    // Two closes in quick succession — switching threads, then closing — must
    // not leave two loops racing for the caret.
    const first = addRow(threadRowId('entry-1'));
    const second = addRow(threadRowId('entry-2'));

    armFocus('entry-1');
    armFocus('entry-2');
    advance(2);

    expect(second).toHaveFocus();
    expect(first).not.toHaveFocus();
  });
});
