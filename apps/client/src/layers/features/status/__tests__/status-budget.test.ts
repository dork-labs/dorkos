import { describe, it, expect } from 'vitest';
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import { resolveStatusBudget, applyStatusBudget } from '../model/status-budget';
import type { PromotedStatusItem } from '../model/promoted-items';
import type { StatusBarItemKey } from '../model/status-bar-registry';

/** A promoted item with an explicit rank, so ranking tests read as ranking tests. */
function item(
  key: StatusBarItemKey,
  cluster: 'left' | 'right',
  severity: number,
  pinned = false
): PromotedStatusItem {
  return { key, cluster, severity, pinned, node: `node:${key}` };
}

/** The degraded session from the design notes: everything promoted at once. */
function degradedLine(): PromotedStatusItem[] {
  return [
    item('agent', 'left', 1000),
    item('cwd', 'left', 5),
    item('git', 'left', 20),
    item('runtime', 'right', 30),
    item('model', 'right', 10),
    item('context', 'right', 90),
    item('usage', 'right', 80),
    item('permission', 'right', 40),
    item('subagents', 'right', 60),
    item('connection', 'right', 100),
  ];
}

describe('resolveStatusBudget', () => {
  it('draws everything until the bar has been measured', () => {
    // A 0 width is "not laid out yet", not a 0px screen. Guessing narrow would
    // flash a two-item bar on every desktop mount.
    for (const width of [null, 0]) {
      const budget = resolveStatusBudget(width);
      expect(budget.density).toBe('full');
      expect(budget.dropped).toEqual([]);
      expect(budget.rightBudget).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('gives full labels and three right-cluster slots at the 640px floor', () => {
    // Three, not four (DOR-461): the floor pays for the whole left cluster — this
    // is the only tier that keeps the directory — plus the `⋯` and the gap between
    // the clusters before it may sell a slot, and a fourth full-label item was
    // ~106px more than the row had. The bar showed it by truncating every value at
    // once and letting two items paint over their neighbours.
    const budget = resolveStatusBudget(640);
    expect(budget.density).toBe('full');
    expect(budget.rightBudget).toBe(3);
    expect(budget.dropped).toEqual([]);
  });

  it('buys another slot for every full-label slot the extra width can pay for', () => {
    // A slot is priced from STATUS_VALUE_MAX_CHARS (8px per bounded character, plus
    // 20px of glyph, gap and separator), so these boundaries move with the bound —
    // which is the point: a wider bound must buy fewer slots, not the same number
    // of wider ones.
    const slot = STATUS_VALUE_MAX_CHARS * 8 + 20;
    expect(resolveStatusBudget(640 + slot - 1).rightBudget).toBe(3);
    expect(resolveStatusBudget(640 + slot).rightBudget).toBe(4);
    expect(resolveStatusBudget(640 + slot * 4).rightBudget).toBe(7);
  });

  it('drops the directory and keeps three slots between 440 and 640px', () => {
    for (const width of [440, 639]) {
      const budget = resolveStatusBudget(width);
      expect(budget.density).toBe('compact');
      expect(budget.rightBudget).toBe(3);
      expect(budget.dropped).toEqual(['cwd']);
    }
  });

  it('keeps identity alone and three slots between 340 and 440px', () => {
    for (const width of [340, 439]) {
      const budget = resolveStatusBudget(width);
      expect(budget.density).toBe('identity');
      expect(budget.rightBudget).toBe(3);
      expect(budget.dropped).toEqual(['cwd', 'git']);
    }
  });

  it('falls back to the avatar and two slots below 340px', () => {
    for (const width of [339, 320, 1]) {
      const budget = resolveStatusBudget(width);
      expect(budget.density).toBe('avatar');
      expect(budget.rightBudget).toBe(2);
      expect(budget.dropped).toEqual(['cwd', 'git']);
    }
  });

  it('hands every measured width under the full tier the compact contract', () => {
    // This is what the slot count rests on (DOR-452): a count assumes the things
    // counted are about one size, and the only thing that makes them one size is
    // items rendering their compact form. `full` therefore has to mean "measured
    // at 640px or more" — any narrower width that reported `full` would be a bar
    // drawing "Default (recommended)" at ~160px in a 72px slot.
    for (const width of [1, 200, 339, 340, 439, 440, 500, 639]) {
      expect(resolveStatusBudget(width).density).not.toBe('full');
    }
    for (const width of [640, 900, 2000]) {
      expect(resolveStatusBudget(width).density).toBe('full');
    }
  });
});

describe('applyStatusBudget — truncation per tier', () => {
  it('keeps the whole degraded line before measurement', () => {
    const { items, overflow } = applyStatusBudget(degradedLine(), resolveStatusBudget(null));
    expect(items).toHaveLength(10);
    expect(overflow).toBe(0);
  });

  it('keeps the three loudest signals at the widest tier', () => {
    const { items, overflow } = applyStatusBudget(degradedLine(), resolveStatusBudget(640));
    expect(items.map((i) => i.key)).toEqual([
      'agent',
      'cwd',
      'git',
      'context',
      'usage',
      'connection',
    ]);
    expect(overflow).toBe(4);
  });

  it('drops the directory and three right-cluster slots survive at a tablet width', () => {
    const { items, overflow } = applyStatusBudget(degradedLine(), resolveStatusBudget(500));
    expect(items.map((i) => i.key)).toEqual(['agent', 'git', 'context', 'usage', 'connection']);
    expect(overflow).toBe(4);
  });

  it('leaves identity plus three signals on a phone', () => {
    const { items, overflow } = applyStatusBudget(degradedLine(), resolveStatusBudget(375));
    expect(items.map((i) => i.key)).toEqual(['agent', 'context', 'usage', 'connection']);
    expect(overflow).toBe(4);
  });

  it('leaves the avatar plus two signals on the narrowest screen', () => {
    const { items, overflow } = applyStatusBudget(degradedLine(), resolveStatusBudget(320));
    expect(items.map((i) => i.key)).toEqual(['agent', 'context', 'connection']);
    expect(overflow).toBe(5);
  });

  it('never drops the identity anchor, however narrow the bar', () => {
    const { items } = applyStatusBudget(degradedLine(), resolveStatusBudget(200));
    expect(items.map((i) => i.key)).toContain('agent');
  });
});

describe('applyStatusBudget — the +N count', () => {
  it('counts every right-cluster item the width could not afford', () => {
    const line = degradedLine();
    const right = line.filter((i) => i.cluster === 'right').length;
    const { items, overflow } = applyStatusBudget(line, resolveStatusBudget(320));
    expect(overflow).toBe(right - 2);
    expect(items.filter((i) => i.cluster === 'right')).toHaveLength(2);
  });

  it('reports nothing hidden when everything fits', () => {
    const line = [item('agent', 'left', 1000), item('model', 'right', 10)];
    expect(applyStatusBudget(line, resolveStatusBudget(1000)).overflow).toBe(0);
  });

  it('does not count a left-cluster item the density gave up', () => {
    // Saying less about where you are is not the same as withholding news, and a
    // permanent `+1` on every tablet would be the wallpaper this redesign removes.
    const line = [item('agent', 'left', 1000), item('cwd', 'left', 5), item('model', 'right', 10)];
    const { items, overflow } = applyStatusBudget(line, resolveStatusBudget(500));
    expect(items.map((i) => i.key)).toEqual(['agent', 'model']);
    expect(overflow).toBe(0);
  });
});

describe('applyStatusBudget — ranking', () => {
  it('chooses by urgency but renders in registry order', () => {
    // Positions stay put as numbers cross their thresholds; nothing shuffles under
    // the finger reaching for it.
    const { items } = applyStatusBudget(
      [
        item('runtime', 'right', 30),
        item('model', 'right', 10),
        item('context', 'right', 90),
        item('connection', 'right', 100),
      ],
      resolveStatusBudget(375)
    );
    expect(items.map((i) => i.key)).toEqual(['runtime', 'context', 'connection']);
  });

  it('makes a pinned but quiet item lose its slot to an urgent one', () => {
    // A pin says "show me", not "shout at me": it puts a quiet item in the line and
    // raises its priority, but never buys immunity from the budget — otherwise
    // pinning five items would recreate the overflow this design removes.
    const { items, overflow } = applyStatusBudget(
      [
        item('runtime', 'right', 0, true),
        item('usage', 'right', 0, true),
        item('context', 'right', 90),
        item('connection', 'right', 100),
      ],
      resolveStatusBudget(320)
    );
    expect(items.map((i) => i.key)).toEqual(['context', 'connection']);
    expect(overflow).toBe(2);
  });

  it('gives a pinned item the slot when two items are equally urgent', () => {
    const { items } = applyStatusBudget(
      [item('runtime', 'right', 30), item('permission', 'right', 30, true)],
      { density: 'avatar', rightBudget: 1, dropped: [] }
    );
    expect(items.map((i) => i.key)).toEqual(['permission']);
  });

  it('keeps the earlier registry entry when neither urgency nor a pin decides it', () => {
    const { items } = applyStatusBudget(
      [item('runtime', 'right', 30), item('permission', 'right', 30)],
      { density: 'avatar', rightBudget: 1, dropped: [] }
    );
    expect(items.map((i) => i.key)).toEqual(['runtime']);
  });
});
