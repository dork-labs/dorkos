/**
 * Both boots that run turns register Claude Code's folder facts as their first step
 * (DOR-4928): until then the protected-path policy refuses every path and turn code
 * honours no agent file's runtime, so a step that ran earlier would see a server that
 * refuses everything. `start()` cannot be booted in a unit test, so its order is read
 * from source; the harness boot's registration is also proved by booting it
 * (`src/__tests__/harness-boot-claude-code-facts.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../', import.meta.url);

/** The source of one function, from its declaration to the next top-level close. */
function body(file: string, declaration: string): string {
  const text = readFileSync(new URL(file, SRC), 'utf8');
  const start = text.indexOf(declaration);
  expect(start, `${file} declares ${declaration}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n}\n', start));
}

/** Where `call` first appears in `source`, failing when it does not. */
function at(source: string, call: string): number {
  const index = source.indexOf(call);
  expect(index, `calls ${call}`).toBeGreaterThan(-1);
  return index;
}

describe('Claude Code facts are registered first', () => {
  it('in start(), before the data directory and the extensions', () => {
    // Purpose: fails if the registration moves after a step that can check a path.
    const start = body('index.ts', 'async function start()');
    const registered = at(start, 'registerClaudeCodeFacts();');
    expect(registered).toBeLessThan(at(start, 'claimDataDirectory('));
    expect(registered).toBeLessThan(at(start, 'startTelemetryExtensionsAndRuntimes('));
  });

  it('in the in-process test server, before the config store', () => {
    const boot = body('harness-boot.ts', 'export async function bootInProcessTestServer(');
    expect(at(boot, 'registerClaudeCodeFacts();')).toBeLessThan(at(boot, 'initConfigManager('));
  });
});
