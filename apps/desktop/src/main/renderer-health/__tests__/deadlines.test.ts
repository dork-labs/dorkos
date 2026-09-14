/**
 * The two ten-second deadlines, held equal by a test rather than by a comment
 * (DOR-2046).
 *
 * The shell waits {@link HEARTBEAT_DEADLINE_MS} for a heartbeat; the boot
 * sentinel inlined in `apps/client/index.html` waits `BOOT_DEADLINE_MS` before
 * painting its own failure panel. ADR `260829-085851` chose to make them the
 * same length on purpose, and lists the coupling under Consequences/Negative:
 * a bundle that THROWS paints the sentinel's panel inside the shell's window,
 * so the ladder never touches it, while a page where NOTHING happens leaves the
 * sentinel waiting and the shell's deadline expires first and reloads. Both of
 * those arguments are about the two numbers being equal. Until now the only
 * thing holding them equal was a sentence in each file.
 *
 * The sentinel cannot be imported — it has to run when the bundle is exactly
 * what is broken, so it is inline `<script>` text and not a module. It is read
 * out of the shipped document instead, by a regex that throws rather than
 * skipping when it finds nothing: a parity test that quietly passes because it
 * could not find one of the two numbers is worth less than no test.
 *
 * @module renderer-health/__tests__/deadlines
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `renderer-health/index.ts` reaches Electron, the log transport and three
// sibling modules at import time. None of that is the subject here; the
// constant is.
vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));
vi.mock('../../diagnostics', () => ({
  saveDiagnosticReportInteractive: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../window-manager', () => ({ loadRenderer: vi.fn() }));
vi.mock('../../quit-guard', () => ({
  confirmInterruptingAgents: vi.fn(() => Promise.resolve(true)),
}));

import { HEARTBEAT_DEADLINE_MS } from '../index';

/** The shipped client document that carries the boot sentinel. */
const CLIENT_INDEX_HTML = fileURLToPath(
  new URL('../../../../../client/index.html', import.meta.url)
);

/** The sentinel's own name for its deadline, as written in that document. */
const SENTINEL_CONSTANT = 'BOOT_DEADLINE_MS';

/**
 * The boot sentinel's deadline, lifted out of the document that ships it.
 *
 * @returns The number `BOOT_DEADLINE_MS` is assigned in `apps/client/index.html`.
 * @throws If the constant is not there under that name, or is not a plain
 * number literal — either of which means this test can no longer see the value
 * it exists to compare, and must say so rather than pass.
 */
function readBootDeadlineMs(): number {
  const html = readFileSync(CLIENT_INDEX_HTML, 'utf-8');
  const match = new RegExp(`\\b${SENTINEL_CONSTANT}\\s*=\\s*([0-9_]+)\\s*;`).exec(html);
  if (!match) {
    throw new Error(
      `apps/client/index.html no longer declares \`${SENTINEL_CONSTANT} = <number>;\` — the boot ` +
        'sentinel’s deadline was renamed, moved out of the document, or is no longer a literal, ' +
        'and this test can no longer check it against the shell’s.'
    );
  }
  return Number(match[1].replaceAll('_', ''));
}

describe('the two boot deadlines', () => {
  it("holds the boot sentinel's deadline equal to the supervisor's", () => {
    expect(readBootDeadlineMs()).toBe(HEARTBEAT_DEADLINE_MS);
  });
});
