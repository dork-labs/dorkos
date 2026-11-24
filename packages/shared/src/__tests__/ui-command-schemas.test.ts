import { describe, it, expect } from 'vitest';
import { UiCommandSchema, UiCanvasContentSchema, UiStateSchema } from '../schemas.js';

describe('UiCommandSchema', () => {
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
    it('tolerates an unknown kind by falling back to burst (Postel)', () => {
      expect(UiCommandSchema.parse({ action: 'celebrate', kind: 'kaboom' })).toMatchObject({
        kind: 'burst',
      });
    });

    it('rejects an over-long emoji string', () => {
      expect(() => UiCommandSchema.parse({ action: 'celebrate', emoji: 'x'.repeat(9) })).toThrow();
    });
  });
});

describe('UiCanvasContentSchema', () => {
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
});

describe('UiStateSchema — what the client SENDS', () => {
  const state = {
    panels: { settings: false, tasks: false, relay: false, picker: false },
    sidebar: { open: true },
    agent: { id: null, cwd: '/home/user/project' },
  };

  it('no longer declares canvas, and an OLDER client still parses', () => {
    // The one non-additive schema change in `canvas-agent-seat`, and the half
    // that makes it safe: a client built before this release still sends its
    // view of the canvas, and Zod strips it rather than refusing the whole
    // context bag. Without the strip, every older client's first turn breaks.
    expect(UiStateSchema.shape).not.toHaveProperty('canvas');
    const fromAnOlderClient = { ...state, canvas: { open: true, contentType: 'markdown' } };
    expect(UiStateSchema.parse(fromAnOlderClient)).toEqual(state);
  });

  it('strips an older client’s sidebar tab without dropping its UI state', () => {
    const fromAnOlderClient = {
      ...state,
      sidebar: { ...state.sidebar, activeTab: 'sessions' },
    };
    expect(UiStateSchema.parse(fromAnOlderClient)).toEqual(state);
  });
});
