import { describe, it, expect } from 'vitest';
import {
  UiCommandSchema,
  UiCanvasContentSchema,
  UiStateSchema,
  UiPanelIdSchema,
  UiSidebarTabSchema,
  UiCommandEventSchema,
} from '../schemas.js';

describe('UiCommandSchema', () => {
  it('parses open_panel command', () => {
    const result = UiCommandSchema.parse({ action: 'open_panel', panel: 'pulse' });
    expect(result).toEqual({ action: 'open_panel', panel: 'pulse' });
  });

  it('parses close_panel command', () => {
    const result = UiCommandSchema.parse({ action: 'close_panel', panel: 'settings' });
    expect(result).toEqual({ action: 'close_panel', panel: 'settings' });
  });

  it('parses toggle_panel command', () => {
    const result = UiCommandSchema.parse({ action: 'toggle_panel', panel: 'relay' });
    expect(result).toEqual({ action: 'toggle_panel', panel: 'relay' });
  });

  it('parses open_sidebar command', () => {
    expect(UiCommandSchema.parse({ action: 'open_sidebar' })).toEqual({ action: 'open_sidebar' });
  });

  it('parses close_sidebar command', () => {
    expect(UiCommandSchema.parse({ action: 'close_sidebar' })).toEqual({
      action: 'close_sidebar',
    });
  });

  it('parses switch_sidebar_tab command', () => {
    const result = UiCommandSchema.parse({ action: 'switch_sidebar_tab', tab: 'agents' });
    expect(result).toEqual({ action: 'switch_sidebar_tab', tab: 'agents' });
  });

  it('parses open_canvas with URL content', () => {
    const result = UiCommandSchema.parse({
      action: 'open_canvas',
      content: { type: 'url', url: 'https://example.com', title: 'Example' },
      preferredWidth: 60,
    });
    expect(result.action).toBe('open_canvas');
  });

  it('parses open_canvas with markdown content', () => {
    const result = UiCommandSchema.parse({
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hello' },
    });
    expect(result.action).toBe('open_canvas');
  });

  it('parses open_canvas with JSON content', () => {
    const result = UiCommandSchema.parse({
      action: 'open_canvas',
      content: { type: 'json', data: { key: 'value' } },
    });
    expect(result.action).toBe('open_canvas');
  });

  it('parses update_canvas command', () => {
    const result = UiCommandSchema.parse({
      action: 'update_canvas',
      content: { type: 'markdown', content: 'Updated' },
    });
    expect(result.action).toBe('update_canvas');
  });

  it('parses close_canvas command', () => {
    expect(UiCommandSchema.parse({ action: 'close_canvas' })).toEqual({ action: 'close_canvas' });
  });

  it('parses show_toast with defaults', () => {
    const result = UiCommandSchema.parse({ action: 'show_toast', message: 'Done!' });
    expect(result).toMatchObject({ action: 'show_toast', message: 'Done!', level: 'info' });
  });

  it('parses show_toast with all fields', () => {
    const result = UiCommandSchema.parse({
      action: 'show_toast',
      message: 'Error occurred',
      level: 'error',
      description: 'Details here',
    });
    expect(result).toMatchObject({ action: 'show_toast', level: 'error' });
  });

  it('parses set_theme command', () => {
    expect(UiCommandSchema.parse({ action: 'set_theme', theme: 'dark' })).toEqual({
      action: 'set_theme',
      theme: 'dark',
    });
  });

  it('parses scroll_to_message with optional messageId', () => {
    expect(UiCommandSchema.parse({ action: 'scroll_to_message' })).toEqual({
      action: 'scroll_to_message',
    });
    expect(UiCommandSchema.parse({ action: 'scroll_to_message', messageId: 'msg-123' })).toEqual({
      action: 'scroll_to_message',
      messageId: 'msg-123',
    });
  });

  it('parses switch_agent command', () => {
    expect(UiCommandSchema.parse({ action: 'switch_agent', cwd: '/home/user/project' })).toEqual({
      action: 'switch_agent',
      cwd: '/home/user/project',
    });
  });

  it('parses open_command_palette command', () => {
    expect(UiCommandSchema.parse({ action: 'open_command_palette' })).toEqual({
      action: 'open_command_palette',
    });
  });

  it('rejects invalid action', () => {
    expect(() => UiCommandSchema.parse({ action: 'invalid_action' })).toThrow();
  });

  it('rejects invalid panel id', () => {
    expect(() => UiCommandSchema.parse({ action: 'open_panel', panel: 'nonexistent' })).toThrow();
  });

  it('rejects preferredWidth outside range', () => {
    expect(() =>
      UiCommandSchema.parse({
        action: 'open_canvas',
        content: { type: 'markdown', content: 'hi' },
        preferredWidth: 5,
      })
    ).toThrow();
    expect(() =>
      UiCommandSchema.parse({
        action: 'open_canvas',
        content: { type: 'markdown', content: 'hi' },
        preferredWidth: 95,
      })
    ).toThrow();
  });

  it('rejects toast message over 500 chars', () => {
    expect(() =>
      UiCommandSchema.parse({ action: 'show_toast', message: 'x'.repeat(501) })
    ).toThrow();
  });
});

describe('UiCanvasContentSchema', () => {
  it('rejects invalid URL', () => {
    expect(() => UiCanvasContentSchema.parse({ type: 'url', url: 'not-a-url' })).toThrow();
  });

  it('accepts valid URL with optional sandbox override', () => {
    const result = UiCanvasContentSchema.parse({
      type: 'url',
      url: 'https://example.com',
      sandbox: 'allow-scripts',
    });
    expect(result).toMatchObject({ type: 'url', sandbox: 'allow-scripts' });
  });
});

describe('UiStateSchema', () => {
  it('parses a complete UI state', () => {
    const state = {
      canvas: { open: false, contentType: null },
      panels: { settings: false, pulse: false, relay: false, mesh: false },
      sidebar: { open: true, activeTab: 'sessions' },
      agent: { id: null, cwd: '/home/user/project' },
    };
    expect(UiStateSchema.parse(state)).toEqual(state);
  });

  it('rejects missing fields', () => {
    expect(() => UiStateSchema.parse({ canvas: { open: false } })).toThrow();
  });
});

describe('UiCommandEventSchema', () => {
  it('parses a ui_command event', () => {
    const event = {
      type: 'ui_command',
      command: { action: 'open_panel', panel: 'pulse' },
    };
    expect(UiCommandEventSchema.parse(event)).toEqual(event);
  });
});

describe('UiPanelIdSchema', () => {
  it('accepts all valid panel ids', () => {
    for (const panel of ['settings', 'pulse', 'relay', 'mesh', 'picker'] as const) {
      expect(UiPanelIdSchema.parse(panel)).toBe(panel);
    }
  });

  it('rejects unknown panel id', () => {
    expect(() => UiPanelIdSchema.parse('unknown')).toThrow();
  });
});

describe('UiSidebarTabSchema', () => {
  it('accepts sessions and agents', () => {
    expect(UiSidebarTabSchema.parse('sessions')).toBe('sessions');
    expect(UiSidebarTabSchema.parse('agents')).toBe('agents');
  });

  it('rejects unknown tab', () => {
    expect(() => UiSidebarTabSchema.parse('files')).toThrow();
  });
});
