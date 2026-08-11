// @vitest-environment node
/**
 * The inline three-session panel is gone, and stays gone (P2 AC-4, BC-34).
 *
 * **A grep that finds nothing proves nothing.** The obvious way to write this
 * check — "search the tree for `MAX_PREVIEW_SESSIONS`, expect zero hits" — is
 * exactly the shape that cannot fail: the branch that deletes the constant is
 * the branch that makes the search vacuous, and a search with a typo'd token, a
 * wrong root or a broken file walk passes just as loudly. This repo has already
 * shipped one guard like that.
 *
 * So every negative assertion here is paired with a positive one that fails
 * first if the machinery is broken:
 *
 * - The **matcher** is tested against a fixture that DOES contain the token, so
 *   a regex that can never match is caught by the test above the sweep.
 * - The **walk** is asserted to find a control token that genuinely exists in
 *   the client tree, so a wrong root or an empty file list is caught before any
 *   "zero hits" claim is made.
 * - The **subject** is asserted to still be the row it should be, so a check
 *   reading an empty or missing file cannot pass by accident.
 *
 * And the panel's machinery is named by things that still EXIST — `SessionRow`,
 * the row primitive's `expansion` slot — not only by the constant this change
 * deleted. Reinstating the panel turns this file red.
 *
 * @module features/dashboard-sidebar/__tests__/no-inline-session-panel
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/**
 * `apps/client/src`, from this file.
 *
 * Resolved off `import.meta.url` under the `node` environment declared at the
 * top: jsdom hands out an `http:` one, which `fileURLToPath` refuses.
 */
const CLIENT_SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const AGENT_ROW = join(CLIENT_SRC, 'layers/features/dashboard-sidebar/ui/AgentListItem.tsx');
const SIDEBAR_UI = join(CLIENT_SRC, 'layers/features/dashboard-sidebar/ui');

/**
 * A token appears in a source file as a whole word.
 *
 * Whole-word, so `SessionRow` does not match `SessionRowCompact` and
 * `SessionSwitcher` does not match anything by accident.
 *
 * @param source - The file's text.
 * @param token - The identifier to look for.
 */
function mentions(source: string, token: string): boolean {
  return new RegExp(`\\b${token}\\b`).test(source);
}

/**
 * Every `.ts`/`.tsx` file under `dir`, as `[path, text]`, skipping this guard
 * itself — a file that names the forbidden tokens in order to forbid them.
 *
 * @param dir - Directory to walk.
 */
function sources(dir: string): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (entry === 'no-inline-session-panel.test.ts') continue;
    out.push([path, readFileSync(path, 'utf8')]);
  }
  return out;
}

describe('the inline session panel is gone', () => {
  // --- The guard's own machinery, checked before it is trusted ---

  it('its matcher finds a token that IS present', () => {
    const fixture = 'const MAX_PREVIEW_SESSIONS = 3;\nconst other = 1;\n';
    expect(mentions(fixture, 'MAX_PREVIEW_SESSIONS')).toBe(true);
    expect(mentions(fixture, 'MAX_PREVIEW')).toBe(false);
    expect(mentions('const previewSessions = [];', 'MAX_PREVIEW_SESSIONS')).toBe(false);
  });

  it('its walk reaches the real client tree', () => {
    const files = sources(CLIENT_SRC);
    expect(files.length).toBeGreaterThan(500);
    // A control token that genuinely exists. If the root is wrong, the walk is
    // empty, or the reader returns nothing, this fails BEFORE any "zero hits"
    // claim below is allowed to mean anything.
    expect(files.filter(([, text]) => mentions(text, 'MAX_JUMP_BACK_IN')).length).toBeGreaterThan(
      0
    );
  });

  it('its subject is still the agent row', () => {
    const row = readFileSync(AGENT_ROW, 'utf8');
    expect(row.length).toBeGreaterThan(1000);
    expect(mentions(row, 'AgentListItem')).toBe(true);
    expect(mentions(row, 'SidebarRow')).toBe(true);
  });

  // --- The assertions those three earn ---

  it('no file in the client mentions MAX_PREVIEW_SESSIONS', () => {
    const offenders = sources(CLIENT_SRC)
      .filter(([, text]) => mentions(text, 'MAX_PREVIEW_SESSIONS'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('the agent row lists no sessions', () => {
    const row = readFileSync(AGENT_ROW, 'utf8');
    // Named by what a reinstated panel would have to bring back — symbols that
    // still exist elsewhere in the tree — rather than only by the constant this
    // change deleted. Each of these is what turns the guard red again.
    for (const token of [
      'SessionRow',
      'useAgentSessions',
      'partitionSessionsByOrigin',
      'AnimatePresence',
      'previewSessions',
    ]) {
      expect({ token, present: mentions(row, token) }).toEqual({ token, present: false });
    }
  });

  it('the agent row uses no expansion slot at all, and draws no list', () => {
    // Two structural claims, and the first one got STRONGER when `SidebarRow`
    // grew its `trailingAction` slot (DOR-1111). The "N live" chip used to ride
    // `expansion` as a hand-rolled satellite — the only sibling slot the row
    // published — so this could only bound `expansion` to one occurrence. The
    // row now owns the trailing satellite, the chip moved into it, and the panel
    // slot is free to be banned outright: the row has nothing to unfold.
    //
    // The second claim survives any rename. A panel is a LIST: whatever it is
    // built from, it has to iterate. The row does not.
    // Matched as a PROP (`expansion=` in JSX, `expansion:` in a spread), not as
    // a bare word — the comment above the chip explains what the slot used to
    // hold, and prose about a defect is not the defect.
    const row = readFileSync(AGENT_ROW, 'utf8');
    expect(row).not.toMatch(/\bexpansion\s*[:=]/);
    expect(row).not.toMatch(/\.map\(/);
  });

  it('no sidebar row component renders a SessionRow', () => {
    // The panel could be reinstated one file over rather than in place. The
    // switcher is the one surface allowed to list an agent's sessions, and it
    // uses `SidebarRow` — the shared row — not `SessionRow`.
    const offenders = sources(SIDEBAR_UI)
      .filter(([, text]) => mentions(text, 'SessionRow'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('the switcher is what replaced it, and the row reaches it', () => {
    // The other half of AC-4: the panel is not merely deleted, it is superseded.
    // A guard that only asserts absence would pass on a branch that deleted the
    // panel and shipped nothing in its place.
    const row = readFileSync(AGENT_ROW, 'utf8');
    expect(mentions(row, 'SessionSwitcher')).toBe(true);
    expect(readFileSync(join(SIDEBAR_UI, 'SessionSwitcher.tsx'), 'utf8').length).toBeGreaterThan(
      1000
    );
  });
});
