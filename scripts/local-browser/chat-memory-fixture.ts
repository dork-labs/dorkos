/** Synthetic article-list page shared by the memory run and its fixture-size regression. */
import assert from 'node:assert/strict';

export const MEMORY_FIXTURE_ARTICLES = 100;
/** Keep at least 75% headroom below production's observation limit, checked in tests. */
export const MEMORY_FIXTURE_SNAPSHOT_BUDGET_BYTES = 32 * 1024;
export const MEMORY_FIXTURE_HTML = `<!doctype html><html><head><title>Memory fixture</title></head>
<body><h1>Northwind research notes</h1><main>${Array.from(
  { length: MEMORY_FIXTURE_ARTICLES },
  (_, row) =>
    `<article><h2>Record ${row}</h2><p>Made-up research notes for browser memory measurement.</p>
  <button>Read record ${row}</button></article>`
).join('')}</main></body></html>`;

/** Check real browser ARIA snapshots before sampling and after every production observe. */
export function assertMemoryFixtureSnapshot(snapshot: string): number {
  const bytes = Buffer.byteLength(snapshot, 'utf8');
  assert(bytes > 0, 'The memory fixture must produce an accessibility snapshot.');
  assert(
    bytes <= MEMORY_FIXTURE_SNAPSHOT_BUDGET_BYTES,
    `Memory fixture snapshot is ${bytes} bytes; budget is ${MEMORY_FIXTURE_SNAPSHOT_BUDGET_BYTES}.`
  );
  return bytes;
}
