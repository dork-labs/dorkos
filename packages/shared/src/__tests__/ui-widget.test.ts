import { describe, it, expect } from 'vitest';
import {
  WidgetDocumentSchema,
  WidgetNodeSchema,
  WidgetActionSchema,
  formatUiActionMessage,
} from '../ui-widget.js';

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

  it('strips unknown props instead of rejecting (Postel posture for model output)', () => {
    const result = WidgetDocumentSchema.safeParse({
      version: 1,
      root: { type: 'badge', text: 'ok', color: 'red' },
    });
    // `color` is not in the badge schema; Zod strips unknown keys by default.
    // Deliberate: models often emit harmless extra fields, and "chat never
    // breaks" (D5) prefers salvaging the known shape over an error card.
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

  it('rejects negative chart values (v1 non-negative constraint)', () => {
    const result = WidgetDocumentSchema.safeParse({
      version: 1,
      root: {
        type: 'chart',
        kind: 'bar',
        data: [
          { label: 'up', value: 5 },
          { label: 'down', value: -3 },
        ],
      },
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

describe('formatUiActionMessage', () => {
  it('wraps the action, title, and payload in a <ui_action> block', () => {
    const block = formatUiActionMessage({
      actionId: 'refresh',
      widgetTitle: 'Weather',
      payload: { city: 'SF' },
    });
    expect(block.startsWith('<ui_action>')).toBe(true);
    expect(block.trimEnd().endsWith('</ui_action>')).toBe(true);
    expect(block).toContain('Widget: Weather');
    expect(block).toContain('Action: refresh');
    expect(block).toContain('"city": "SF"');
  });

  it('renders "(untitled)" and "(none)" when title and payload are absent', () => {
    const block = formatUiActionMessage({ actionId: 'ping' });
    expect(block).toContain('Widget: (untitled)');
    expect(block).toContain('Payload: (none)');
  });

  it('includes the widget id line only when provided', () => {
    expect(formatUiActionMessage({ actionId: 'a', widgetId: 'w-1' })).toContain('Widget ID: w-1');
    expect(formatUiActionMessage({ actionId: 'a' })).not.toContain('Widget ID:');
  });
});
