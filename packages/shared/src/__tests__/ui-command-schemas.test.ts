import { describe, it, expect } from 'vitest';
import {
  UiCommandSchema,
  type UiCommand,
  UiCanvasContentSchema,
  UiStateSchema,
  UiPanelIdSchema,
  UiSidebarTabSchema,
  UiCommandEventSchema,
} from '../schemas.js';

describe('UiCommandSchema', () => {
  it('parses open_panel command', () => {
    const result = UiCommandSchema.parse({ action: 'open_panel', panel: 'tasks' });
    expect(result).toEqual({ action: 'open_panel', panel: 'tasks' });
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
    const result = UiCommandSchema.parse({ action: 'switch_sidebar_tab', tab: 'connections' });
    expect(result).toEqual({ action: 'switch_sidebar_tab', tab: 'connections' });
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

  it('parses open_canvas with a widget definition', () => {
    const result = UiCommandSchema.parse({
      action: 'open_canvas',
      content: {
        type: 'widget',
        title: 'Weather',
        definition: { version: 1, root: { type: 'stat', label: 'Temp', value: '64°F' } },
      },
    });
    expect(result.action).toBe('open_canvas');
    if (result.action === 'open_canvas' && result.content?.type === 'widget') {
      expect(result.content.definition.root.type).toBe('stat');
    }
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

  it('parses open_file command', () => {
    expect(UiCommandSchema.parse({ action: 'open_file', sourcePath: 'src/index.ts' })).toEqual({
      action: 'open_file',
      sourcePath: 'src/index.ts',
    });
  });

  it('rejects open_file with an empty sourcePath', () => {
    expect(() => UiCommandSchema.parse({ action: 'open_file', sourcePath: '' })).toThrow();
  });

  it('parses open_diff command', () => {
    expect(UiCommandSchema.parse({ action: 'open_diff', sourcePath: 'src/App.tsx' })).toEqual({
      action: 'open_diff',
      sourcePath: 'src/App.tsx',
    });
  });

  it('rejects open_diff with an empty sourcePath', () => {
    expect(() => UiCommandSchema.parse({ action: 'open_diff', sourcePath: '' })).toThrow();
  });

  it('parses open_terminal with a cwd hint', () => {
    expect(UiCommandSchema.parse({ action: 'open_terminal', cwd: '/repo' })).toEqual({
      action: 'open_terminal',
      cwd: '/repo',
    });
  });

  it('parses open_terminal without a cwd (cwd is optional)', () => {
    expect(UiCommandSchema.parse({ action: 'open_terminal' })).toEqual({ action: 'open_terminal' });
  });

  it('rejects open_terminal with a non-string cwd', () => {
    expect(() => UiCommandSchema.parse({ action: 'open_terminal', cwd: 42 })).toThrow();
  });

  it('parses browser_navigate command', () => {
    expect(
      UiCommandSchema.parse({ action: 'browser_navigate', url: 'http://localhost:3000' })
    ).toEqual({ action: 'browser_navigate', url: 'http://localhost:3000' });
  });

  it('rejects browser_navigate with an empty url', () => {
    expect(() => UiCommandSchema.parse({ action: 'browser_navigate', url: '' })).toThrow();
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

  it('parses apply_layout command with a shape name', () => {
    expect(UiCommandSchema.parse({ action: 'apply_layout', shape: 'linear-ops' })).toEqual({
      action: 'apply_layout',
      shape: 'linear-ops',
    });
  });

  it('rejects apply_layout with an empty shape name', () => {
    expect(() => UiCommandSchema.parse({ action: 'apply_layout', shape: '' })).toThrow();
  });

  it('infers the apply_layout member on the UiCommand type', () => {
    const command: UiCommand = { action: 'apply_layout', shape: 'flow-board' };
    if (command.action === 'apply_layout') {
      expect(command.shape).toBe('flow-board');
    } else {
      throw new Error('expected apply_layout variant');
    }
  });

  it('parses open_command_palette command', () => {
    expect(UiCommandSchema.parse({ action: 'open_command_palette' })).toEqual({
      action: 'open_command_palette',
    });
  });

  it('rejects invalid action', () => {
    expect(() => UiCommandSchema.parse({ action: 'invalid_action' })).toThrow();
  });

  it('has a doc-comment variant count that matches the actual member count', () => {
    // The union's TSDoc claims "22 variants". Guard the count so the comment
    // and the schema never silently drift (the stale "20" this change fixed).
    const memberCount = UiCommandSchema.options.length;
    expect(memberCount).toBe(22);
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

  describe('celebrate command', () => {
    it('parses a bare celebrate (no kind)', () => {
      const result = UiCommandSchema.parse({ action: 'celebrate' });
      expect(result).toEqual({ action: 'celebrate' });
    });

    it('parses each canonical celebration kind', () => {
      for (const kind of ['burst', 'fireworks', 'cannons', 'emoji', 'rain', 'stars'] as const) {
        expect(UiCommandSchema.parse({ action: 'celebrate', kind })).toMatchObject({
          action: 'celebrate',
          kind,
        });
      }
    });

    it('coerces synonyms to canonical kinds', () => {
      expect(UiCommandSchema.parse({ action: 'celebrate', kind: 'FIREWORK' })).toMatchObject({
        kind: 'fireworks',
      });
      expect(UiCommandSchema.parse({ action: 'celebrate', kind: 'sparkle' })).toMatchObject({
        kind: 'stars',
      });
      expect(UiCommandSchema.parse({ action: 'celebrate', kind: 'party' })).toMatchObject({
        kind: 'burst',
      });
    });

    it('tolerates an unknown kind by falling back to burst (Postel)', () => {
      expect(UiCommandSchema.parse({ action: 'celebrate', kind: 'kaboom' })).toMatchObject({
        kind: 'burst',
      });
    });

    it('carries the emoji glyph', () => {
      expect(
        UiCommandSchema.parse({ action: 'celebrate', kind: 'emoji', emoji: '🏆' })
      ).toMatchObject({ kind: 'emoji', emoji: '🏆' });
    });

    it('rejects an over-long emoji string', () => {
      expect(() => UiCommandSchema.parse({ action: 'celebrate', emoji: 'x'.repeat(9) })).toThrow();
    });
  });
});

describe('UiCanvasContentSchema', () => {
  it('rejects invalid URL', () => {
    expect(() => UiCanvasContentSchema.parse({ type: 'url', url: 'not-a-url' })).toThrow();
  });

  it('accepts a valid URL and drops the retired sandbox field (DOR-233)', () => {
    // `url` now renders in the embedded browser (same renderer as `browser`),
    // which derives its sandbox from target classification — an agent-supplied
    // `sandbox` is no longer part of the contract and is stripped on parse.
    const result = UiCanvasContentSchema.parse({
      type: 'url',
      url: 'https://example.com',
      sandbox: 'allow-scripts',
    });
    expect(result).toEqual({ type: 'url', url: 'https://example.com' });
    expect(result).not.toHaveProperty('sandbox');
  });

  it('accepts image content with an optional alt', () => {
    const result = UiCanvasContentSchema.parse({
      type: 'image',
      src: 'assets/logo.png',
      alt: 'The logo',
    });
    expect(result).toMatchObject({ type: 'image', src: 'assets/logo.png', alt: 'The logo' });
  });

  it('accepts pdf content from a data URI', () => {
    const result = UiCanvasContentSchema.parse({
      type: 'pdf',
      src: 'data:application/pdf;base64,AAAA',
    });
    expect(result).toMatchObject({ type: 'pdf' });
  });

  it('rejects image content missing src', () => {
    expect(() => UiCanvasContentSchema.parse({ type: 'image' })).toThrow();
  });

  it('round-trips file content with an optional language + readOnly', () => {
    const content = {
      type: 'file' as const,
      sourcePath: 'src/index.ts',
      language: 'typescript',
      readOnly: true,
    };
    expect(UiCanvasContentSchema.parse(content)).toEqual(content);
  });

  it('rejects file content missing sourcePath', () => {
    expect(() => UiCanvasContentSchema.parse({ type: 'file' })).toThrow();
  });

  it('round-trips model3d content', () => {
    const content = { type: 'model3d' as const, src: 'assets/robot.glb', title: 'Robot' };
    expect(UiCanvasContentSchema.parse(content)).toEqual(content);
  });

  it('round-trips audio content with an optional title', () => {
    const content = { type: 'audio' as const, src: 'sounds/theme.mp3', title: 'Theme' };
    expect(UiCanvasContentSchema.parse(content)).toEqual(content);
  });

  it('rejects audio content missing src', () => {
    expect(() => UiCanvasContentSchema.parse({ type: 'audio' })).toThrow();
  });

  it('round-trips video content with an optional title', () => {
    const content = { type: 'video' as const, src: 'clips/demo.mp4', title: 'Demo' };
    expect(UiCanvasContentSchema.parse(content)).toEqual(content);
  });

  it('rejects video content missing src', () => {
    expect(() => UiCanvasContentSchema.parse({ type: 'video' })).toThrow();
  });

  it('round-trips csv content', () => {
    const content = { type: 'csv' as const, src: 'data/rows.csv' };
    expect(UiCanvasContentSchema.parse(content)).toEqual(content);
  });

  it('round-trips diff content with an optional mediaKind + title', () => {
    const content = {
      type: 'diff' as const,
      sourcePath: 'src/App.tsx',
      mediaKind: 'text' as const,
      title: 'App.tsx',
    };
    expect(UiCanvasContentSchema.parse(content)).toEqual(content);
  });

  it('round-trips diff content with only a sourcePath', () => {
    const content = { type: 'diff' as const, sourcePath: 'src/App.tsx' };
    expect(UiCanvasContentSchema.parse(content)).toEqual(content);
  });

  it('rejects diff content missing sourcePath', () => {
    expect(() => UiCanvasContentSchema.parse({ type: 'diff' })).toThrow();
  });

  it('rejects diff content with an unknown mediaKind', () => {
    expect(() =>
      UiCanvasContentSchema.parse({ type: 'diff', sourcePath: 'a.ts', mediaKind: 'video' })
    ).toThrow();
  });
});

describe('UiStateSchema', () => {
  it('parses a complete UI state', () => {
    const state = {
      canvas: { open: false, contentType: null },
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: true, activeTab: 'sessions' },
      agent: { id: null, cwd: '/home/user/project' },
    };
    expect(UiStateSchema.parse(state)).toEqual(state);
  });

  it('rejects missing fields', () => {
    expect(() => UiStateSchema.parse({ canvas: { open: false } })).toThrow();
  });

  it.each(['audio', 'video'] as const)('accepts %s as a canvas contentType', (contentType) => {
    const state = {
      canvas: { open: true, contentType },
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: true, activeTab: 'sessions' },
      agent: { id: null, cwd: '/home/user/project' },
    };
    expect(UiStateSchema.parse(state).canvas.contentType).toBe(contentType);
  });
});

describe('UiCommandEventSchema', () => {
  it('parses a ui_command payload (typeless — type lives on the enclosing event)', () => {
    const payload = {
      command: { action: 'open_panel', panel: 'tasks' },
    };
    expect(UiCommandEventSchema.parse(payload)).toEqual(payload);
  });
});

describe('UiPanelIdSchema', () => {
  it('accepts all valid panel ids', () => {
    for (const panel of ['settings', 'tasks', 'relay', 'picker'] as const) {
      expect(UiPanelIdSchema.parse(panel)).toBe(panel);
    }
  });

  it('rejects unknown panel id', () => {
    expect(() => UiPanelIdSchema.parse('unknown')).toThrow();
  });
});

describe('UiSidebarTabSchema', () => {
  it('accepts the built-in sidebar tabs', () => {
    expect(UiSidebarTabSchema.parse('overview')).toBe('overview');
    expect(UiSidebarTabSchema.parse('sessions')).toBe('sessions');
    expect(UiSidebarTabSchema.parse('schedules')).toBe('schedules');
    expect(UiSidebarTabSchema.parse('connections')).toBe('connections');
  });

  it('accepts and round-trips an extension-contributed tab id', () => {
    // Contributed tabs register under a namespaced `extId:tabId` id — the
    // schema is a bounded string, not a closed enum, so these must parse.
    const id = 'linear-issues:linear-loop-sidebar';
    expect(UiSidebarTabSchema.parse(id)).toBe(id);
  });

  it('rejects an empty id', () => {
    expect(() => UiSidebarTabSchema.parse('')).toThrow();
  });

  it('rejects ids outside the contribution-id alphabet', () => {
    expect(() => UiSidebarTabSchema.parse('has space')).toThrow();
    expect(() => UiSidebarTabSchema.parse('<script>alert(1)</script>')).toThrow();
    // First character must be alphanumeric.
    expect(() => UiSidebarTabSchema.parse(':leading-colon')).toThrow();
    expect(() => UiSidebarTabSchema.parse('-leading-dash')).toThrow();
  });

  it('caps the id length at 200 characters', () => {
    expect(UiSidebarTabSchema.parse('a'.repeat(200))).toBe('a'.repeat(200));
    expect(() => UiSidebarTabSchema.parse('a'.repeat(201))).toThrow();
  });
});
