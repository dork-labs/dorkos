import { it, expect } from 'vitest';
import { createPointerLedger } from '../pointer.js';
import { tabFixture } from '../../__tests__/parent-fixture.js';
it('owns one ticket, consumes completion and refuses old lifetime settlement', () => {
  const h = tabFixture(),
    p = h.tab.pointer;
  const old = p.beginMove(2, 3),
    latest = p.beginMove(4, 5);
  p.success(old);
  expect(p.read().marker).toBe(null);
  p.success(latest);
  expect(p.read().marker).toMatchObject({ x: 4, y: 5 });
  expect(p.accepts(latest)).toBe(false);
  h.tab.binding = { ...h.tab.binding, epoch: 1 };
  expect(p.read().marker).toBe(null);
});
it('terminal transition at MAX invalidates marker without requiring revision advance', () => {
  const h = tabFixture(),
    p = createPointerLedger(() => h.tab.binding, Number.MAX_SAFE_INTEGER - 1);
  p.success(p.beginMove(1, 2));
  const before = p.read();
  expect(before.marker).not.toBe(null);
  p.invalidate();
  expect(p.read()).toEqual({ revision: before.revision, terminal: true, marker: null });
});
it('reentrant binding observation cannot publish an outer ticket after invalidation', () => {
  const h = tabFixture();
  let reenter = false;
  const p = createPointerLedger(() => {
    if (reenter) p.invalidate();
    return h.tab.binding;
  });
  reenter = true;
  expect(p.beginMove(1, 2)).toBe(null);
  expect(p.read().marker).toBe(null);
});
it('completion reentry cannot consume a newer ticket or publish its coordinates', () => {
  const h = tabFixture();
  let reenter = false;
  let newer: object | null = null;
  const p = createPointerLedger(() => {
    if (reenter) {
      reenter = false;
      newer = p.beginMove(7, 8);
    }
    return h.tab.binding;
  });
  const old = p.beginMove(1, 2);
  reenter = true;
  p.success(old);
  expect(p.read().marker).toBe(null);
  expect(p.accepts(newer)).toBe(false);
  p.success(newer);
  expect(p.read().marker).toBe(null);
});
