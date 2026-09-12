/**
 * What the browser verbs tell an agent about finding a tab has to be true where
 * the agent is standing.
 *
 * ## The defect this pins
 *
 * Four places told an agent to call `get_ui_state` to find a browser tab's
 * `documentId`. In a ROOM that works — the room branch answers with
 * `canvas.documents[{ id, … }]`. In a one-on-one session it does not:
 * `UiStateSchema.canvas` is `{ open, contentType }`, with no list and no ids
 * (`packages/shared/src/schemas.ts`). So the one discovery path every note
 * leaned on was unreachable for the surface the notes are mostly read on, and an
 * agent following them would call a tool, get no ids, and be no better off.
 *
 * `control_ui` does not close the gap either: its private-session branch answers
 * `{ success, action }` and nothing else, because the client mints the document
 * id there and the server never learns it. (Making the session canvas
 * server-side is DOR-2006's job, and it is what will eventually let
 * `get_ui_state` list tabs everywhere. Until then these notes must not promise
 * it.)
 *
 * ## What IS true in a private session, and therefore what the notes may say
 *
 * - Omitting `documentId` acts on the tab the driving window has in front.
 * - Every one of the six driving verbs answers with the tab it acted on and that
 *   tab's id — on success AND on refusal — which is where an id worth passing
 *   back comes from. `handlers.test.ts` holds that half.
 *
 * So the rule below is narrow and mechanical: a note may name the UI-state read
 * as a way to list tabs only while saying that is a room thing.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { _UI_TOOLS_CONTEXT } from '../../../runtimes/claude-code/messaging/context-builder.js';
import { UNKNOWN_DOCUMENT_NOTE, drivingTimeoutNote } from '../act-protocol.js';
import { DOCUMENT_INPUT } from '../target.js';

/** Every string that tells an agent how to find a browser tab, by where it lives. */
const DISCOVERY_NOTES: Record<string, string> = {
  UNKNOWN_DOCUMENT_NOTE,
  drivingTimeoutNote: drivingTimeoutNote('browser_click', 8_000),
  'DOCUMENT_INPUT.documentId': DOCUMENT_INPUT.documentId.description ?? '',
  '<ui_tools>': _UI_TOOLS_CONTEXT,
};

describe('the notes that tell an agent how to find a browser tab', () => {
  it('never sends a private session to a UI-state read that cannot answer it', () => {
    const offenders: string[] = [];
    for (const [where, note] of Object.entries(DISCOVERY_NOTES)) {
      // EVERY mention, not the first: `<ui_tools>` names the UI-state read twice
      // and only one of those is about tabs. Scanning one would have let the
      // other say anything.
      for (const match of note.matchAll(/get_ui_state/g)) {
        const around = note.slice(Math.max(0, (match.index ?? 0) - 240), (match.index ?? 0) + 240);
        // Only a mention that offers to FIND A TAB is in scope. The other one
        // answers about panels and the sidebar, which it really does report in
        // a private session — forbidding that would be a different, wrong rule.
        if (!/\btabs?\b/i.test(around)) continue;
        if (!/in a room/i.test(around)) offenders.push(where);
      }
    }
    expect(
      offenders,
      'these tell an agent to find a tab id with get_ui_state without saying that only ' +
        'answers in a room. In a one-on-one session UiStateSchema.canvas is { open, ' +
        'contentType } — no list, no ids — so the agent is sent somewhere that cannot help.'
    ).toEqual([]);
  });

  it('points every note at the discovery path that works everywhere', () => {
    // The guard above only forbids; this is what must be there instead, so a
    // rewrite that deletes the bad advice without replacing it still fails.
    expect(UNKNOWN_DOCUMENT_NOTE).toMatch(/leave documentId out/i);
    expect(drivingTimeoutNote('browser_click', 8_000)).toMatch(/without documentId/i);
    expect(DOCUMENT_INPUT.documentId.description).toMatch(/names the tab it acted on and its id/i);
    expect(_UI_TOOLS_CONTEXT).toMatch(/answers with the tab it acted on and that tab's id/i);
  });

  it('is written for a person to read, not as a tool listing', () => {
    // `writing-for-humans`: these reach an approval card and a transcript.
    expect(UNKNOWN_DOCUMENT_NOTE.endsWith('.')).toBe(true);
    expect(drivingTimeoutNote('browser_click', 8_000).endsWith('.')).toBe(true);
  });
});
