/**
 * The work graph is space data (ADR 261124-131941, ADR 261122-173853): turn
 * code hands it facts through hooks or events and never imports it, so its
 * move to the space store (DOR-5139) is a store move, not a rewrite.
 *
 * This fails if any file under `services/runtimes/` or `services/session/`
 * imports `services/work-graph`, by any relative path or a dynamic import.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TURN_CODE = ['runtimes', 'session'];

/** Any static, dynamic or re-export specifier that names the work-graph domain. */
const WORK_GRAPH_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/work-graph(?:\/[^'"]*)?['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(name))
    .map((name) => join(dir, name));
}

describe('the work graph stays on the space side', () => {
  it('finds the turn code it guards', () => {
    for (const domain of TURN_CODE)
      expect(sourceFiles(join(SERVICES, domain)).length).toBeGreaterThan(10);
  });

  it('is never imported by runtime or session code', () => {
    const offenders = TURN_CODE.flatMap((domain) => sourceFiles(join(SERVICES, domain)))
      .filter((file) => WORK_GRAPH_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SERVICES, file));
    expect(offenders).toEqual([]);
  });

  it('recognises every import form it is meant to catch', () => {
    for (const line of [
      "import { recordChatFork } from '../../work-graph/index.js';",
      "export { x } from '../work-graph';",
      "const m = await import('../../work-graph/work-link-store.js');",
    ])
      expect(WORK_GRAPH_IMPORT.test(line)).toBe(true);
    expect(WORK_GRAPH_IMPORT.test("import { x } from './work-graphs-elsewhere.js';")).toBe(false);
  });
});
