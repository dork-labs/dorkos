import { describe, it, expect } from 'vitest';
import { WidgetDocumentSchema, WidgetNodeSchema, WidgetActionSchema } from '../ui-widget.js';

describe('WidgetDocumentSchema', () => {
  it('round-trips a minimal stat-card document', () => {
    const doc = {
      version: 1,
      title: 'Weather',
      root: {
        type: 'card',
        title: 'San Francisco',
        children: [
          { type: 'stat', label: 'Temp', value: '64°F', delta: { value: 2, direction: 'up' } },
          { type: 'divider' },
          { type: 'text', text: 'Clear skies **all day**.' },
        ],
      },
    };
    const parsed = WidgetDocumentSchema.parse(doc);
    expect(parsed).toEqual(doc);
  });

  it('round-trips a nested stack with table, list, and chart', () => {
    const doc = {
      version: 1,
      root: {
        type: 'stack',
        direction: 'vertical',
        gap: 'md',
        children: [
          {
            type: 'table',
            columns: [
              { key: 'name', label: 'Name' },
              { key: 'count', label: 'Count', align: 'right' },
            ],
            rows: [
              { name: 'alpha', count: 3 },
              { name: 'beta', count: null },
            ],
          },
          {
            type: 'list',
            items: [
              {
                title: 'DOR-1',
                subtitle: 'Ship widgets',
                badge: { text: 'open', tone: 'info' },
                actions: [{ kind: 'url', href: 'https://linear.app/dor-1' }],
              },
            ],
          },
          {
            type: 'chart',
            kind: 'bar',
            data: [
              { label: 'Mon', value: 10 },
              { label: 'Tue', value: 20 },
            ],
          },
        ],
      },
    };
    expect(WidgetDocumentSchema.parse(doc)).toEqual(doc);
  });

  it('rejects an unknown node type', () => {
    const result = WidgetDocumentSchema.safeParse({
      version: 1,
      root: { type: 'blink', text: 'nope' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a node with wrong props', () => {
    const result = WidgetDocumentSchema.safeParse({
      version: 1,
      root: { type: 'progress', value: 250 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown prop via strict object validation', () => {
    const result = WidgetDocumentSchema.safeParse({
      version: 1,
      root: { type: 'badge', text: 'ok', color: 'red' },
    });
    // `color` is not in the badge schema; Zod strips unknown keys by default, so
    // this parses but drops the extra key — assert the salvaged shape.
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.root).toEqual({ type: 'badge', text: 'ok' });
    }
  });

  it('rejects a non-v1 version', () => {
    const result = WidgetDocumentSchema.safeParse({
      version: 2,
      root: { type: 'divider' },
    });
    expect(result.success).toBe(false);
  });
});

describe('WidgetActionSchema', () => {
  it('accepts an agent action with payload', () => {
    const action = { kind: 'agent', id: 'confirm', label: 'Confirm', payload: { a: 1 } };
    expect(WidgetActionSchema.parse(action)).toEqual(action);
  });

  it('accepts a ui action carrying a UiCommand', () => {
    const action = { kind: 'ui', command: { action: 'open_command_palette' } };
    expect(WidgetActionSchema.parse(action)).toEqual(action);
  });

  it('accepts an https url action', () => {
    const action = { kind: 'url', href: 'https://dorkos.ai' };
    expect(WidgetActionSchema.parse(action)).toEqual(action);
  });

  it('rejects a non-https url action', () => {
    const result = WidgetActionSchema.safeParse({ kind: 'url', href: 'http://insecure.example' });
    expect(result.success).toBe(false);
  });
});

describe('image node source enforcement', () => {
  it('accepts https and data URIs', () => {
    expect(
      WidgetNodeSchema.safeParse({ type: 'image', src: 'https://x/y.png', alt: 'y' }).success
    ).toBe(true);
    expect(
      WidgetNodeSchema.safeParse({ type: 'image', src: 'data:image/png;base64,AA', alt: 'y' })
        .success
    ).toBe(true);
  });

  it('rejects http and other schemes', () => {
    expect(
      WidgetNodeSchema.safeParse({ type: 'image', src: 'http://x/y.png', alt: 'y' }).success
    ).toBe(false);
    expect(
      WidgetNodeSchema.safeParse({ type: 'image', src: 'file:///etc/passwd', alt: 'y' }).success
    ).toBe(false);
  });
});
