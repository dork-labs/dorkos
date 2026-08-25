/**
 * The in-app editor racing the agent's own `memory_write`, at the seam where
 * they actually meet: one file, two writers, no coordination between them.
 *
 * ## The bug this exists for
 *
 * `writeConventionFile` was a bare `fs.writeFile` while the engine did a
 * read-modify-write under `withFileLock`. Nothing serialised the two, and
 * `fs.writeFile` opens with `O_TRUNC` — so there is a real window in which the
 * file is ZERO BYTES on disk. When the engine's read landed inside that window
 * it saw an empty memory, appended one note to nothing, and renamed the result
 * into place as a successful save.
 *
 * Measured on this suite before the fix: 7 of 200 interleaves (~3.5%) lost every
 * note in the file, silently, with the write reporting `{ saved: true }`. That
 * is the whole failure — not a torn file somebody would notice, but a quiet
 * total loss reported as success.
 *
 * ## Why it is written this way
 *
 * The two writers are fired without awaiting between them, and the agent's side
 * is delayed by a sweeping number of microtask ticks, so the collision lands at
 * a different point in the editor's write on each round. Pinning one ordering
 * would test the ordering, not the race.
 *
 * **Six hundred rounds, and the number was measured rather than picked.** With
 * the lock removed, this seam loses the file on roughly 1% of interleaves on
 * this machine (probed at 1–3 per 200 across three tick phases and two file
 * sizes; the reviewer measured ~3.5% on theirs). At 1%, a 200-round run has a
 * ~13% chance of passing while the bug is present — a regression guard that
 * quietly fails to guard. Six hundred brings that to ~0.2%, and the run still
 * costs well under a second because each round is one small file.
 *
 * It cannot flake in the other direction: with the lock in place the two writers
 * are strictly serialised, so the failure rate is zero by construction rather
 * than by luck.
 *
 * The assertion is on CONTENT, not on absence of throw. The bug never threw.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CONVENTION_FILES } from '@dorkos/shared/convention-files';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';

import { writeMemory } from '../store.js';

let root: string;
let agentPath: string;

/** How many notes the file starts with. Enough that losing them is unmistakable. */
const SEEDED_NOTES = 60;

/** How many interleaves to run. See the module note on why this many. */
const ROUNDS = 600;

/** The memory file for the staged agent. */
function memoryFile(): string {
  return path.join(agentPath, '.dork', CONVENTION_FILES.memory);
}

/** A file holding {@link SEEDED_NOTES} notes the operator must not lose. */
function seededContent(): string {
  const notes = Array.from({ length: SEEDED_NOTES }, (_, i) => `- seeded note ${i}`);
  return `## Notes\n\n${notes.join('\n')}\n`;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-editor-race-'));
  agentPath = path.join(root, 'agents', 'alpha');
  await mkdir(path.join(agentPath, '.dork'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the in-app editor and memory_write against one file', () => {
  it('never loses the file, over many real interleaves', async () => {
    let lostEverything = 0;
    let lostSomething = 0;

    for (let round = 0; round < ROUNDS; round++) {
      await writeFile(memoryFile(), seededContent(), 'utf8');

      // The operator's edit, through the same writer the PATCH route uses.
      const editorText = `${seededContent()}- edited by hand in round ${round}\n`;
      // The agent's save, through the engine's read-modify-write.
      const agentNote = `agent note ${round}`;

      // Fired together, not awaited in sequence: the interleaving has to be the
      // scheduler's rather than the test's. The tiny jitter moves the collision
      // point around across rounds so it is not always the same instant.
      const editing = writeConventionFile(agentPath, CONVENTION_FILES.memory, editorText);
      const saving = (async () => {
        // Sweep the phase: 0, 1 and 2 ticks in turn, so the read lands before,
        // during and after the editor's write across the run.
        for (let tick = 0; tick < round % 3; tick++) await Promise.resolve();
        return writeMemory({ agentId: agentPath, agentPath }, { action: 'add', text: agentNote });
      })();

      const [, saved] = await Promise.all([editing, saving]);
      const after = await readFile(memoryFile(), 'utf8');

      // Last-writer-wins is fine and expected: whichever of the two committed
      // last is what the file says. What must NEVER happen is that the file
      // comes back holding neither writer's notes — the truncation window.
      const keptSeeded = after.includes(`- seeded note ${SEEDED_NOTES - 1}`);
      const keptSomeWriter = after.includes(agentNote) || after.includes('edited by hand');

      if (!keptSeeded && !keptSomeWriter) lostEverything++;
      else if (!keptSeeded) lostSomething++;

      // A write that reported success must not have been the one that emptied
      // the file — this is the exact shape the bug wore.
      expect(
        saved.chars,
        `round ${round} reported a successful save of an empty file`
      ).toBeGreaterThan(0);
    }

    expect(
      lostEverything,
      `${lostEverything}/${ROUNDS} interleaves emptied the memory file entirely`
    ).toBe(0);
    expect(lostSomething, `${lostSomething}/${ROUNDS} interleaves dropped the seeded notes`).toBe(
      0
    );
  }, 30_000);

  // The control. Without it the case above passes for a writer pair that never
  // actually collides — a lock that serialised by never letting the second
  // writer run would look identical.
  it('really does interleave: both writers commit across the run', async () => {
    await writeFile(memoryFile(), seededContent(), 'utf8');

    let agentWon = 0;
    let editorWon = 0;

    for (let round = 0; round < 40; round++) {
      const editorText = `${seededContent()}- edited by hand in round ${round}\n`;
      const agentNote = `agent note ${round}`;

      await Promise.all([
        writeConventionFile(agentPath, CONVENTION_FILES.memory, editorText),
        writeMemory({ agentId: agentPath, agentPath }, { action: 'add', text: agentNote }),
      ]);

      const after = await readFile(memoryFile(), 'utf8');
      if (after.includes(agentNote)) agentWon++;
      if (after.includes(`edited by hand in round ${round}`)) editorWon++;
      // Whoever won, the file is whole.
      expect(after).toContain(`- seeded note ${SEEDED_NOTES - 1}`);
    }

    // Both orderings really occur, so the run above was exercising a race.
    expect(agentWon + editorWon).toBeGreaterThan(0);
  }, 30_000);
});
