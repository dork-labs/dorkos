/**
 * The runtime → harness table, against the runtimes this repo actually ships
 * (DOR-1901).
 *
 * `RUNTIME_HARNESSES` decides one thing: which agent tool a project DorkOS
 * manages has to enable, given the runtime its sessions start on. A runtime
 * added without an entry there resolves to `undefined`, which reads exactly like
 * "this runtime has no harness" — so the mistake is silent, and its symptom is
 * a person's project quietly not being set up for the tool DorkOS runs in it.
 *
 * So the table is checked against the filesystem rather than against a second
 * list somebody would have to remember to edit. `services/runtimes/<id>/<id>-runtime.ts`
 * is how every production runtime in this repo is laid out — it is the layout
 * `contributing/adding-a-runtime.md` asks for — and each of those directory
 * names IS the runtime's `type`, which the second assertion reads out of the
 * source rather than assuming.
 *
 * Adding a runtime therefore fails this test until somebody decides which
 * harness it reads, or states that it reads none.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_HARNESSES, harnessForRuntime } from '@dorkos/shared/harness-schemas';

/** `apps/server/src/services/runtimes`, four levels above this file. */
const RUNTIMES_DIR = path.resolve(import.meta.dirname, '../../runtimes');

/**
 * Every runtime this repo ships, by directory: a directory under
 * `services/runtimes/` holding its own `<name>-runtime.ts`.
 *
 * The file is what separates a runtime from the infrastructure beside it —
 * `connect/` (credentials), `connector-mcp/`, `shared/` and `__tests__/` have
 * no such file and are not runtimes.
 */
function shippedRuntimeDirs(): string[] {
  return readdirSync(RUNTIMES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      readdirSync(path.join(RUNTIMES_DIR, entry.name)).includes(`${entry.name}-runtime.ts`)
    )
    .map((entry) => entry.name)
    .sort();
}

describe('RUNTIME_HARNESSES', () => {
  it('TR-11: names every runtime this repo ships', () => {
    const shipped = shippedRuntimeDirs();

    // A floor, so a wrong path or a moved directory reds instead of passing on
    // an empty list. Four today: claude-code, codex, opencode, test-mode.
    expect(shipped.length).toBeGreaterThanOrEqual(4);
    expect(shipped.filter((id) => !(id in RUNTIME_HARNESSES))).toEqual([]);
  });

  it('TR-11: each directory name is the runtime type its class declares', () => {
    // The table is keyed by runtime TYPE and checked against directory NAMES, so
    // the two have to be the same string. They are, and this is what says so:
    // `readonly type = 'codex' as const` in `codex/codex-runtime.ts`.
    for (const id of shippedRuntimeDirs()) {
      const source = readFileSync(path.join(RUNTIMES_DIR, id, `${id}-runtime.ts`), 'utf8');
      // test-mode takes its type as a constructor argument (e2e registers a
      // second instance under another id), so its declaration is the default.
      expect(source, id).toMatch(
        new RegExp(
          String.raw`readonly type(?:\s*=\s*|: string;[\s\S]*?constructor\(type = )'${id}'`
        )
      );
    }
  });

  it('TR-11: maps the three runtimes that read a harness, and states the one that does not', () => {
    // Spelled out rather than derived: this is the decision, and a table that
    // only had to agree with itself would agree with any answer.
    expect(RUNTIME_HARNESSES).toEqual({
      'claude-code': 'claude-code',
      codex: 'codex',
      opencode: 'opencode',
      // The e2e fake. It reads nothing off disk, so enabling a harness for it
      // would write files for an agent that cannot read them.
      'test-mode': null,
    });
  });

  it('TR-11: answers undefined for a runtime with no harness and for one it has never heard of', () => {
    expect(harnessForRuntime('claude-code')).toBe('claude-code');
    expect(harnessForRuntime('test-mode')).toBeUndefined();
    expect(harnessForRuntime('some-future-runtime')).toBeUndefined();
  });
});
