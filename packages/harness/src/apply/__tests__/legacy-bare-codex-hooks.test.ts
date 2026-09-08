/**
 * The narrowness of migration rule 2.
 *
 * Rule 2 is the one place the engine overwrites a file it has no sidecar for, on
 * the grounds that only DorkOS could have written it. That licence is only
 * honest while the test is genuinely narrow, and every guard in it is load-
 * bearing: widen any one and the rule starts eating files somebody wrote.
 *
 * The vocabulary is the sharp edge. The old `generateCodexHooks` translated
 * Claude events into CODEX spellings and dropped every event Codex has no home
 * for, so the only keys it could ever have written are the TEN spelled out
 * below. A file keyed by anything else — a Claude name Codex never took, an
 * invented one, or a spelling the map has gained SINCE — is somebody else's,
 * whatever it looks like.
 *
 * Those ten are written out here rather than read from
 * `CANONICAL_TO_CODEXCLI_EVENT_NAMES`, and so is the frozen set the
 * implementation checks against. Deriving either from the live map makes this
 * test agree with whatever the map says today, so a map addition — `SessionEnd`
 * in DOR-1847 — would quietly hand rule 2 a licence over a file shape no DorkOS
 * build has ever written, and the suite would stay green while it happened.
 */
import { describe, it, expect } from 'vitest';
import { isLegacyBareCodexHooks } from '../generated-ownership.js';
import { CANONICAL_TO_CODEXCLI_EVENT_NAMES } from '../../vendor/rulesync-maps.js';

/** The exact Codex spellings the pre-DOR-1842 generator could emit. */
const PRE_SIDECAR_CODEX_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const;

/** A bare event map keyed by `event`, the shape the engine used to write. */
function bare(event: string): string {
  return `${JSON.stringify({ [event]: [{ hooks: [{ type: 'command', command: 'x' }] }] }, null, 2)}\n`;
}

describe('isLegacyBareCodexHooks', () => {
  it('HK-01: recognises a bare map keyed by any of the ten events the old generator emitted', () => {
    expect(PRE_SIDECAR_CODEX_EVENTS).toHaveLength(10);
    for (const event of PRE_SIDECAR_CODEX_EVENTS) {
      expect({ event, legacy: isLegacyBareCodexHooks(bare(event)) }).toEqual({
        event,
        legacy: true,
      });
    }
  });

  it('HK-01: rejects a Codex spelling the map has gained since the bare shape was retired', () => {
    // The frozen list is a claim about what a PAST build wrote, so it may not
    // track the present map. `SessionEnd` joined `CANONICAL_TO_CODEXCLI_EVENT_NAMES`
    // in DOR-1847, long after the bare shape stopped being written — so a bare
    // `SessionEnd` map is a person's file, and rule 2 must not overwrite it.
    const gained = Object.values(CANONICAL_TO_CODEXCLI_EVENT_NAMES).filter(
      (event) => !PRE_SIDECAR_CODEX_EVENTS.includes(event as never)
    );
    expect(gained).toEqual(['SessionEnd']);
    for (const event of gained) {
      expect({ event, legacy: isLegacyBareCodexHooks(bare(event)) }).toEqual({
        event,
        legacy: false,
      });
    }
  });

  it('HK-01, HK-11: rejects a bare map keyed by an event the engine could never have written', () => {
    // `Notification` is a Claude event with no Codex equivalent — the old
    // generator DROPPED it rather than writing it, so a file naming it was
    // written by a person, not by DorkOS.
    expect(isLegacyBareCodexHooks(bare('Notification'))).toBe(false);
    expect(isLegacyBareCodexHooks(bare('MadeUpEvent'))).toBe(false);
  });

  it("HK-01: rejects the vendor shape's keys on the vocabulary alone", () => {
    // Neither `hooks` nor `description` is a Codex event name, so the vocabulary
    // rules the documented file out by itself — which is exactly why the
    // function carries no separate check for it. The values here are ARRAYS on
    // purpose: give them their natural shapes and the value check rejects them
    // first, and the test would stay green even if somebody admitted these two
    // literal keys into the vocabulary. With arrays, only the vocabulary can
    // answer, so widening it reds here.
    expect(
      isLegacyBareCodexHooks(`${JSON.stringify({ hooks: [], description: [] }, null, 2)}\n`)
    ).toBe(false);
    expect(isLegacyBareCodexHooks(`${JSON.stringify({ hooks: [] }, null, 2)}\n`)).toBe(false);
    expect(isLegacyBareCodexHooks(`${JSON.stringify({ description: [] }, null, 2)}\n`)).toBe(false);
  });

  it('HK-01: rejects anything that is not a non-empty object of arrays', () => {
    expect(isLegacyBareCodexHooks('not json')).toBe(false);
    expect(isLegacyBareCodexHooks('[]')).toBe(false);
    expect(isLegacyBareCodexHooks('null')).toBe(false);
    expect(isLegacyBareCodexHooks('{}')).toBe(false);
    expect(isLegacyBareCodexHooks(`${JSON.stringify({ Stop: 'nope' })}\n`)).toBe(false);
  });
});
