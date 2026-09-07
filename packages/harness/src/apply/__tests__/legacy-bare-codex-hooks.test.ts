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
 * for, so the only keys it could ever have written are the ten values of
 * `CANONICAL_TO_CODEXCLI_EVENT_NAMES`. A file keyed by anything else — a Claude
 * name Codex never took, an invented one — is somebody else's, whatever it looks
 * like.
 */
import { describe, it, expect } from 'vitest';
import { isLegacyBareCodexHooks } from '../generated-ownership.js';
import { CANONICAL_TO_CODEXCLI_EVENT_NAMES } from '../../vendor/rulesync-maps.js';

/** A bare event map keyed by `event`, the shape the engine used to write. */
function bare(event: string): string {
  return `${JSON.stringify({ [event]: [{ hooks: [{ type: 'command', command: 'x' }] }] }, null, 2)}\n`;
}

describe('isLegacyBareCodexHooks', () => {
  it('recognises a bare map keyed by an event Codex actually has', () => {
    for (const event of Object.values(CANONICAL_TO_CODEXCLI_EVENT_NAMES)) {
      expect({ event, legacy: isLegacyBareCodexHooks(bare(event)) }).toEqual({
        event,
        legacy: true,
      });
    }
  });

  it('rejects a bare map keyed by an event the engine could never have written', () => {
    // `Notification` is a Claude event with no Codex equivalent — the old
    // generator DROPPED it rather than writing it, so a file naming it was
    // written by a person, not by DorkOS.
    expect(isLegacyBareCodexHooks(bare('Notification'))).toBe(false);
    expect(isLegacyBareCodexHooks(bare('MadeUpEvent'))).toBe(false);
  });

  it('rejects the vendor shape, by either of its two keys', () => {
    // Neither `hooks` nor `description` is a Codex event name, so the vocabulary
    // alone rules the documented file out — which is exactly why the function
    // carries no separate check for it. This pins that outcome, so widening the
    // vocabulary can never quietly hand rule 2 the vendor's own shape.
    expect(isLegacyBareCodexHooks(`${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`)).toBe(
      false
    );
    expect(isLegacyBareCodexHooks(`${JSON.stringify({ description: 'mine' }, null, 2)}\n`)).toBe(
      false
    );
  });

  it('rejects anything that is not a non-empty object of arrays', () => {
    expect(isLegacyBareCodexHooks('not json')).toBe(false);
    expect(isLegacyBareCodexHooks('[]')).toBe(false);
    expect(isLegacyBareCodexHooks('null')).toBe(false);
    expect(isLegacyBareCodexHooks('{}')).toBe(false);
    expect(isLegacyBareCodexHooks(`${JSON.stringify({ Stop: 'nope' })}\n`)).toBe(false);
  });
});
