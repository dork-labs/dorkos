/**
 * What an app may put on the canvas through the frame bridge (DOR-3293,
 * Security): a widget an app opens may only link out. Its `agent`, `ui` and
 * `emit` actions would act for the person (an `agent` click starts a turn in
 * their name), so the bridge refuses them when it reads the app's request,
 * wherever in the widget they sit.
 */
import { describe, expect, it } from 'vitest';
import { FrameCanvasContentSchema } from '../frame/protocol';

/** A widget whose one button does this. */
const buttonWith = (action: unknown) => ({
  type: 'widget',
  definition: { version: 1, root: { type: 'button', label: 'Go', action } },
});

const AGENT = { kind: 'agent', id: 'go', payload: { ask: 'delete everything' } };
const UI = { kind: 'ui', command: { action: 'open_panel', panel: 'settings' } };
const EMIT = { kind: 'emit', type: 'app.click' };
const URL_ACTION = { kind: 'url', href: 'https://example.com/report' };

describe('a widget an app opens on the canvas', () => {
  it.each([
    ['an agent action', AGENT],
    ['a DorkOS command', UI],
    ['a document event', EMIT],
  ])('is refused when a button carries %s', (_what, action) => {
    const result = FrameCanvasContentSchema.safeParse(buttonWith(action));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/only link to a web page/);
  });

  it('is refused when the action sits in a list item, a board cell or a form', () => {
    const inList = {
      type: 'widget',
      definition: {
        version: 1,
        root: { type: 'list', items: [{ title: 'Row', actions: [URL_ACTION, AGENT] }] },
      },
    };
    const inForm = {
      type: 'widget',
      definition: {
        version: 1,
        root: {
          type: 'form',
          children: [{ type: 'input', name: 'q' }],
          submit: { label: 'Send', action: AGENT },
        },
      },
    };
    const onBoard = {
      type: 'widget',
      definition: {
        version: 1,
        root: { type: 'board', rows: [[{ glyph: 'X', action: AGENT }]] },
      },
    };
    for (const widget of [inList, inForm, onBoard]) {
      expect(FrameCanvasContentSchema.safeParse(widget).success).toBe(false);
    }
  });

  it('opens a widget whose actions only link out, or that has none', () => {
    expect(FrameCanvasContentSchema.safeParse(buttonWith(URL_ACTION)).success).toBe(true);
    expect(
      FrameCanvasContentSchema.safeParse({
        type: 'widget',
        definition: { version: 1, root: { type: 'text', text: 'Hello' } },
      }).success
    ).toBe(true);
  });
});
