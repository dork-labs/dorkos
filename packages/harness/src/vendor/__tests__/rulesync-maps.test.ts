import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_TO_CLAUDE_EVENT_NAMES,
  CLAUDE_TO_CANONICAL_EVENT_NAMES,
  CANONICAL_TO_CODEXCLI_EVENT_NAMES,
  CODEXCLI_TO_CANONICAL_EVENT_NAMES,
  CANONICAL_TO_CURSOR_EVENT_NAMES,
  CURSOR_TO_CANONICAL_EVENT_NAMES,
  CANONICAL_TO_COPILOT_EVENT_NAMES,
  COPILOT_TO_CANONICAL_EVENT_NAMES,
  CANONICAL_TO_COPILOTCLI_EVENT_NAMES,
  COPILOTCLI_TO_CANONICAL_EVENT_NAMES,
  CLAUDE_HOOK_EVENTS,
  CODEXCLI_HOOK_EVENTS,
  CURSOR_HOOK_EVENTS,
  COPILOT_HOOK_EVENTS,
  COPILOTCLI_HOOK_EVENTS,
} from '../rulesync-maps.js';
import { CANONICAL_TO_GEMINI_EVENT_NAMES, GEMINI_HOOK_EVENTS } from '../gemini-maps.js';

/** The five translation maps, paired with their derived reverse maps. */
const TRANSLATION_MAPS: Array<{
  name: string;
  forward: Record<string, string>;
  reverse: Record<string, string>;
}> = [
  {
    name: 'claude',
    forward: CANONICAL_TO_CLAUDE_EVENT_NAMES,
    reverse: CLAUDE_TO_CANONICAL_EVENT_NAMES,
  },
  {
    name: 'codexcli',
    forward: CANONICAL_TO_CODEXCLI_EVENT_NAMES,
    reverse: CODEXCLI_TO_CANONICAL_EVENT_NAMES,
  },
  {
    name: 'cursor',
    forward: CANONICAL_TO_CURSOR_EVENT_NAMES,
    reverse: CURSOR_TO_CANONICAL_EVENT_NAMES,
  },
  {
    name: 'copilot',
    forward: CANONICAL_TO_COPILOT_EVENT_NAMES,
    reverse: COPILOT_TO_CANONICAL_EVENT_NAMES,
  },
  {
    name: 'copilotcli',
    forward: CANONICAL_TO_COPILOTCLI_EVENT_NAMES,
    reverse: COPILOTCLI_TO_CANONICAL_EVENT_NAMES,
  },
];

/** The per-tool supported-event arrays. */
const HOOK_EVENT_ARRAYS: Array<{ name: string; events: readonly string[] }> = [
  { name: 'claude', events: CLAUDE_HOOK_EVENTS },
  { name: 'codexcli', events: CODEXCLI_HOOK_EVENTS },
  { name: 'cursor', events: CURSOR_HOOK_EVENTS },
  { name: 'copilot', events: COPILOT_HOOK_EVENTS },
  { name: 'copilotcli', events: COPILOTCLI_HOOK_EVENTS },
];

describe('rulesync-maps', () => {
  // Every forward translation must round-trip back through its reverse map.
  describe.each(TRANSLATION_MAPS)('$name translation map round-trips', ({ forward, reverse }) => {
    it('reverse[forward[e]] === e for every canonical key', () => {
      for (const canonical of Object.keys(forward)) {
        expect(reverse[forward[canonical]]).toBe(canonical);
      }
    });
  });

  // No translation map should be empty (a missing/renamed upstream table).
  it.each(TRANSLATION_MAPS)(
    '$name forward + reverse maps are non-empty',
    ({ forward, reverse }) => {
      expect(Object.keys(forward).length).toBeGreaterThan(0);
      expect(Object.keys(reverse).length).toBeGreaterThan(0);
    }
  );

  // No supported-event array should be empty.
  it.each(HOOK_EVENT_ARRAYS)('$name hook-event array is non-empty', ({ events }) => {
    expect(events.length).toBeGreaterThan(0);
  });

  // The vendored file must carry its MIT attribution to rulesync's author + pinned commit.
  it('carries the rulesync MIT attribution header', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../rulesync-maps.ts', import.meta.url)),
      'utf8'
    );
    expect(source).toContain('dyoshikawa');
    expect(source).toContain('b4bf09d5');
    expect(source).toContain('MIT');
  });
});

describe('gemini-maps', () => {
  // The in-repo Gemini map and its derived event list must be non-empty.
  it('exports a non-empty hook map and event list', () => {
    expect(Object.keys(CANONICAL_TO_GEMINI_EVENT_NAMES).length).toBeGreaterThan(0);
    expect(GEMINI_HOOK_EVENTS.length).toBeGreaterThan(0);
  });
});
