/**
 * What the record costs on disk for a realistic chat: a long session append
 * that holds steady across turns, and a fresh set of per-turn blocks each
 * turn. Made-up text at real sizes. Set `DORKOS_MEASURE_TURN_CONTEXT=1` to
 * print the figures; the assertions hold either way.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import { TurnContextStore } from '../turn-context-store.js';

const TURNS = 40;
/** A session append the size of a real one: about 22 blocks, roughly 24 KB. */
const APPEND = Array.from(
  { length: 22 },
  (_, i) => `<block_${i}>\n${'Made-up guidance line for the agent. '.repeat(30)}\n</block_${i}>`
).join('\n\n');

/** One turn's blocks: git status, window state, a room page and the words, about 3 KB. */
function perTurn(turn: number): string {
  return [
    `<git_status>branch: main, clean: ${turn % 2 === 0}</git_status>`,
    `<ui_state>${JSON.stringify({ panel: 'chat', turn, open: ['canvas'] })}</ui_state>`,
    `<room_context nonce="${turn.toString(16).padStart(8, '0')}">\n${'A made-up room message. '.repeat(100)}\n</room_context>`,
    `Turn ${turn}: please keep going.`,
  ].join('\n\n');
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('stores a steady append once, so a turn costs about its own blocks', () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'turn-context-storage-'));
  const file = path.join(dir, 'dork.db');
  const db = createDb(file);
  runMigrations(db);
  db.$client.pragma('wal_checkpoint(TRUNCATE)');
  const before = statSync(file).size;

  const store = new TurnContextStore(db);
  let perTurnBytes = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    const prompt = perTurn(turn);
    perTurnBytes += Buffer.byteLength(prompt);
    store.record({
      sessionId: 'measure',
      runtime: 'claude-code',
      place: 'room',
      permissionMode: 'default',
      systemSentThisTurn: turn === 0,
      parts: [
        { slot: 'system_append', text: APPEND },
        { slot: 'prompt', text: prompt },
      ],
    });
  }
  db.$client.pragma('wal_checkpoint(TRUNCATE)');
  const grew = statSync(file).size - before;
  const bodyBytes = (
    db.$client
      .prepare('SELECT sum(length(CAST(body AS BLOB))) AS n FROM turn_context_bodies')
      .get() as {
      n: number;
    }
  ).n;
  const appendBytes = Buffer.byteLength(APPEND);

  // The append is stored once, not once per turn.
  expect(bodyBytes).toBe(appendBytes + perTurnBytes);
  // On disk, well under a third of storing the append with every turn.
  expect(grew).toBeLessThan((appendBytes * TURNS + perTurnBytes) / 3);

  if (process.env.DORKOS_MEASURE_TURN_CONTEXT === '1') {
    console.info(
      JSON.stringify({
        turns: TURNS,
        appendBytes,
        perTurnBlocksAvgBytes: Math.round(perTurnBytes / TURNS),
        undedupedTotalBytes: (appendBytes + perTurnBytes / TURNS) * TURNS,
        storedBodyBytes: bodyBytes,
        dbGrowthBytes: grew,
        dbGrowthPerTurnBytes: Math.round(grew / TURNS),
      })
    );
  }
  db.$client.close();
});
