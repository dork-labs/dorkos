import { describe, expect, it } from 'vitest';
import { EmitWidgetActionSchema, WidgetNodeSchema, WidgetActionSchema } from '../ui-widget.js';
describe('native document widget actions', () => {
  it('accepts public emit on buttons, forms, checklists and board cells', () => {
    const action = {
      kind: 'emit',
      type: 'task.changed',
      payload: { done: true },
      coalesceKey: 'task-one',
    };
    expect(WidgetActionSchema.parse(action)).toEqual(action);
    for (const node of [
      { type: 'button', label: 'Save', action },
      {
        type: 'form',
        children: [{ type: 'input', name: 'title', required: true }],
        submit: { label: 'Save', action },
      },
      { type: 'checklist', items: [{ label: 'One' }], action },
      { type: 'board', rows: [[{ action }]] },
    ])
      expect(WidgetNodeSchema.safeParse(node).success).toBe(true);
  });
  it.each(['doc.edited', 'state.changed', 'event.status', 'app.ack'])(
    'refuses reserved %s',
    (type) => {
      expect(EmitWidgetActionSchema.safeParse({ kind: 'emit', type }).success).toBe(false);
    }
  );
  it('rejects authored event IDs, route authority, invalid coalescing and unsafe payload', () => {
    for (const patch of [
      { id: crypto.randomUUID() },
      { routeId: 'target' },
      { coalesceKey: 'x'.repeat(129) },
      { payload: JSON.parse('{"__proto__":{}}') },
      { payload: { n: Infinity } },
    ])
      expect(
        EmitWidgetActionSchema.safeParse({ kind: 'emit', type: 'task.changed', ...patch }).success
      ).toBe(false);
  });
  it('retains legacy submits and required field declarations, excluding URL submits', () => {
    expect(
      WidgetNodeSchema.parse({ type: 'select', name: 'task', required: true, options: [] })
    ).toMatchObject({ required: true });
    expect(
      WidgetNodeSchema.safeParse({
        type: 'form',
        children: [],
        submit: { label: 'Save', action: { kind: 'agent', id: 'save' } },
      }).success
    ).toBe(true);
    expect(
      WidgetNodeSchema.safeParse({
        type: 'form',
        children: [],
        submit: { label: 'Go', action: { kind: 'url', href: 'https://example.test' } },
      }).success
    ).toBe(false);
  });
});
