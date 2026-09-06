// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { SIDEBAR_ROW_ATTRIBUTE } from '@/layers/shared/model';
import { focusRowOnArrival } from '../ui/dnd/restore-drop-focus';
import { SIDEBAR_DRAG_ROOT_ATTRIBUTE } from '../ui/dnd/SidebarDndPrimitives';

/**
 * The arrival wait behind the keyboard drop's focus restore (DOR-1790).
 *
 * **What this file can and cannot say.** Whether a keyboard drop leaves a reader
 * on `<body>` is a question about a real remount and a browser default action —
 * `apps/e2e/tests/dashboard-sidebar/sidebar-groups.spec.ts` is where that is
 * pinned, and it is where it was MEASURED (`<body>`, twice, before this shipped).
 * What lives here is the piece with no browser in it: given a row that turns up
 * late, does the wait find it; given one that turns up TOO late, does the wait
 * have stopped; and given two rows for one item, does it take the right one.
 */

/** Let `n` animation frames pass. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

/** Draw a drag root with a row inside it, the way the panel does. */
function mountRow(dragRootId: string): HTMLButtonElement {
  const root = document.createElement('div');
  root.setAttribute(SIDEBAR_DRAG_ROOT_ATTRIBUTE, dragRootId);
  const row = document.createElement('button');
  row.setAttribute(SIDEBAR_ROW_ATTRIBUTE, '');
  root.appendChild(row);
  document.body.appendChild(root);
  return row;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusRowOnArrival', () => {
  it('focuses the row once it is drawn in its new home', async () => {
    focusRowOnArrival('group-1::room:r-42', 10);
    // Nothing there yet — the write is optimistic, but it is still a render away.
    await frames(2);
    expect(document.activeElement).toBe(document.body);

    const row = mountRow('group-1::room:r-42');
    await frames(3);
    expect(document.activeElement).toBe(row);
  });

  it('stops looking once the budget is spent, even if the row turns up later', async () => {
    // **The budget's own test.** The case below — a row that never arrives —
    // passes just as happily with no budget at all, because nothing ever shows
    // up to be focused; deleting the frame limit left all of these green. This
    // is the one that goes red for it: the row DOES arrive, late, and a wait
    // still running would grab focus long after the reader has moved on.
    const elsewhere = mountRow('ungrouped::room:r-9');
    elsewhere.focus();

    focusRowOnArrival('group-1::room:r-42', 3);
    await frames(8);
    const late = mountRow('group-1::room:r-42');
    await frames(5);

    expect(document.activeElement, 'a spent wait still stole focus').toBe(elsewhere);
    expect(document.activeElement).not.toBe(late);
  });

  it('leaves focus alone when a row with that id never arrives', async () => {
    const elsewhere = mountRow('ungrouped::room:r-9');
    elsewhere.focus();

    focusRowOnArrival('group-1::room:r-42', 5);
    await frames(10);

    // Not the other row, and not `<body>` either: a wait that expired must
    // change nothing at all.
    expect(document.activeElement).toBe(elsewhere);
  });

  it('takes the row under the matching id, never the first one on the page', async () => {
    // Two rows for one item — the same channel drawn in Today and in its
    // section — is the ordinary case, and only one of them is the drop's
    // landing place.
    mountRow('ungrouped::room:r-42');
    const moved = mountRow('group-1::room:r-42');

    focusRowOnArrival('group-1::room:r-42', 5);
    await frames(3);

    expect(document.activeElement).toBe(moved);
  });
});
