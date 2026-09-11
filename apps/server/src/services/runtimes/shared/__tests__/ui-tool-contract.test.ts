/**
 * Drift guard: what the `control_ui` surfaces TEACH is what the schema ACCEPTS.
 *
 * ## The failure this exists for
 *
 * Three hand-written lists taught three different UIs. The tool description
 * named 6 canvas content types, the `<ui_tools>` system-prompt block named 10,
 * the tool's own input hint named 6, and `UiCanvasContentSchema` accepted 14 —
 * so `mcp_app`, `file`, `model3d`, `csv`, `browser` and `diff` were reachable
 * and taught nowhere, and `apply_layout` was a whole action no surface
 * mentioned. Nothing was broken; the prose was stale, in the one place a model
 * reads it.
 *
 * ## What this pins
 *
 * It re-derives both sets from the schemas — never from a table of its own —
 * and asserts each rendered surface names exactly those, no more and no fewer.
 * A superset would be a lie about what the schema takes; a subset is the drift
 * that was there.
 *
 * ## Shown to fail before it was trusted
 *
 * - The description's action catalog cut to the first 15 actions (the shape of
 *   the drift that was there): red, naming `scroll_to_message`, `set_theme`,
 *   `show_toast`, `switch_agent` and the rest it stopped mentioning.
 * - A 15th content variant added to a real discriminated union and walked
 *   through the real generator: red, and it is the last case in this file.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { UiCanvasContentSchema, UiCommandSchema } from '@dorkos/shared/schemas';

import {
  CONTROL_UI_DESCRIPTION,
  CONTROL_UI_INPUT,
  buildCanvasContentCatalog,
  buildUiActionCatalog,
  canvasContentTypes,
  uiActionNames,
} from '../ui-tool-contract.js';
import { _UI_TOOLS_CONTEXT } from '../../claude-code/messaging/context-builder.js';

/**
 * Which of `names` a rendered surface mentions as a whole word.
 *
 * Whole-word, so `open_canvas` is not credited by `close_canvas` and `url` is
 * not credited by the word "url" inside `https://…` — the substring version of
 * this check passed on a description that named neither.
 */
function named(surface: string, names: readonly string[]): string[] {
  return names.filter((name) =>
    new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(surface)
  );
}

const CONTENT_TYPES = canvasContentTypes();
const ACTIONS = uiActionNames();

describe('the schemas are what the catalogs are derived from', () => {
  it('reads all 14 canvas content types off UiCanvasContentSchema', () => {
    // The count is pinned as well as the set: a variant DELETED from the schema
    // and from a surface together would leave the set check green.
    expect(CONTENT_TYPES).toHaveLength(14);
    expect([...CONTENT_TYPES].sort()).toEqual(
      [
        'audio',
        'browser',
        'csv',
        'diff',
        'file',
        'image',
        'json',
        'markdown',
        'mcp_app',
        'model3d',
        'pdf',
        'url',
        'video',
        'widget',
      ].sort()
    );
  });

  it('reads all 22 UI actions off UiCommandSchema', () => {
    expect(ACTIONS).toHaveLength(22);
    expect(ACTIONS).toContain('apply_layout');
  });
});

describe('CONTROL_UI_DESCRIPTION names exactly what the schema accepts', () => {
  it('names every canvas content type and no invented one', () => {
    expect(named(CONTROL_UI_DESCRIPTION, CONTENT_TYPES).sort()).toEqual([...CONTENT_TYPES].sort());
  });

  it('names every action, including the five that were taught nowhere', () => {
    expect(named(CONTROL_UI_DESCRIPTION, ACTIONS).sort()).toEqual([...ACTIONS].sort());
    for (const taught of ['apply_layout', 'open_pip', 'close_pip', 'open_diff', 'open_terminal']) {
      expect(CONTROL_UI_DESCRIPTION).toContain(taught);
    }
  });

  it('gives each action and each content type a sentence of its own', () => {
    // One line per entry, each carrying prose beyond its shape — the property a
    // bare name list would not have.
    for (const line of buildUiActionCatalog({ indent: '- ' }).split('\n')) {
      expect(line).toMatch(/ — .+\./);
    }
    for (const line of buildCanvasContentCatalog({ indent: '  ' }).split('\n')) {
      expect(line).toMatch(/ {2}\/\/ .+\./);
    }
  });
});

describe('the <ui_tools> system-prompt block names exactly the same sets', () => {
  it('names every canvas content type', () => {
    expect(named(_UI_TOOLS_CONTEXT, CONTENT_TYPES).sort()).toEqual([...CONTENT_TYPES].sort());
  });

  it('names every action', () => {
    expect(named(_UI_TOOLS_CONTEXT, ACTIONS).sort()).toEqual([...ACTIONS].sort());
  });
});

describe('the tool input schema can carry every action it teaches', () => {
  it('hints every canvas content type on the `content` field', () => {
    const hint = CONTROL_UI_INPUT.content.description ?? '';
    expect(named(hint, CONTENT_TYPES).sort()).toEqual([...CONTENT_TYPES].sort());
  });

  it('carries no z.record at any depth, which would empty the whole tool list', () => {
    // claude-agent-sdk 0.3.257+ with zod 4.5.3+ throws inside its record
    // processor while answering `tools/list`, and the model is handed NO DorkOS
    // tools at all — silently (repo memory: "Claude SDK + zod record tools
    // vanish"; the full story is in `claude-code/mcp-tools/tool-exposure.ts`).
    // `z.object({}).catchall(...)` accepts the same values and does not.
    //
    // Checked on the JSON Schema the SDK actually serializes, rather than on the
    // source text: `propertyNames` appears there if and only if a record is in
    // the tree, at ANY depth, however the record was spelled or re-exported.
    // `tool-exposure.test.ts` owns the behavioural half over the whole tool
    // surface; this owns THIS schema, which is the one a catalog edit touches.
    const json = JSON.stringify(z.toJSONSchema(z.object(CONTROL_UI_INPUT), { io: 'input' }));
    expect(json).not.toContain('propertyNames');

    // The probe: the same schema with the record restored does contain it, so a
    // green result above is a fact about the input and not about the matcher.
    const withRecord = JSON.stringify(
      z.toJSONSchema(
        z.object({ ...CONTROL_UI_INPUT, content: z.record(z.string(), z.unknown()).optional() }),
        { io: 'input' }
      )
    );
    expect(withRecord).toContain('propertyNames');
  });

  it('accepts apply_layout with its shape name, which it used to strip', () => {
    // `tool()` narrows arguments to CONTROL_UI_INPUT's keys before the handler
    // parses them, so an `apply_layout` whose `shape` is not a key arrives
    // without one and fails UiCommandSchema — the action was uncallable while
    // being advertised. Asserted through the same narrowing the SDK applies.
    const narrowed = z.object(CONTROL_UI_INPUT).parse({ action: 'apply_layout', shape: 'focus' });
    expect(UiCommandSchema.safeParse(narrowed).success).toBe(true);
  });
});

describe('a variant the schema accepts and no table teaches cannot ship', () => {
  it('refuses to render a 15th content type that has no sentence', () => {
    const fifteen = z.discriminatedUnion('type', [
      ...UiCanvasContentSchema.options,
      z.object({ type: z.literal('spreadsheet'), src: z.string() }),
    ]);

    // The walk itself still succeeds — the schema is a real one.
    expect(canvasContentTypes(fifteen)).toHaveLength(15);
    expect(canvasContentTypes(fifteen)).toContain('spreadsheet');

    // Rendering it is what fails, and the message says where to write the line.
    expect(() => buildCanvasContentCatalog({ names: canvasContentTypes(fifteen) })).toThrow(
      /spreadsheet.*CANVAS_CONTENT_CATALOG/s
    );
  });

  it('refuses to render a 23rd action that has no sentence', () => {
    const twentyThree = z.discriminatedUnion('action', [
      ...UiCommandSchema.options,
      z.object({ action: z.literal('open_inbox') }),
    ]);

    expect(() => buildUiActionCatalog({ names: uiActionNames(twentyThree) })).toThrow(
      /open_inbox.*UI_ACTION_CATALOG/s
    );
  });
});
