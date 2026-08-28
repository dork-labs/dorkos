/**
 * The relay carries every registered runtime, and `relayAgentRuntime` is
 * authoritative for its own type — never `runtimes.default` (DOR-768, DOR-1614,
 * spec `execution-defaults` §7).
 *
 * `relayAgentRuntime` used to be the ONLY runtime the relay held, because the
 * adapter was read as Claude-specific. It is not: everything below it speaks
 * `AgentRuntimeLike` and `StreamEvent` alone, so the map now carries every
 * runtime this server registered and the adapter picks one per message. What
 * has not changed is where the relay's own default comes from: the concrete
 * runtime the composition root constructed — ClaudeCodeRuntime in production,
 * TestModeRuntime under `DORKOS_TEST_RUNTIME` — keyed by that runtime's own
 * `type`, so the key is never a guess and never `getDefault()`.
 *
 * It used to receive `runtimeRegistry.getDefault()` through an `as unknown as
 * AgentRuntimeLike` cast, which is the exact shape of "this compiles because I
 * told it to". That cast is gone and stays gone. (It named
 * `ClaudeCodeAgentRuntimeLike`, the alias `@dorkos/relay` exported for the
 * years the adapter was read as Claude-only; DOR-1614 retired the alias, so the
 * guard below reads the surviving name.)
 *
 * ## Why a source guard
 *
 * The wiring lives in `start()` in `index.ts`, which boots the whole server:
 * databases, mesh, relay, extensions, the HTTP listener. There is no seam to
 * construct just the AdapterManager deps, and inventing one purely to observe a
 * single object property would be a worse change than the one it verifies. What
 * can actually regress is somebody reaching for `getDefault()` again at that
 * call site, and reading the call site catches it. The behavior on the other
 * side of the boundary — that a non-Claude default serves its own truth — is
 * covered behaviorally in `routes/__tests__/non-claude-default-runtime.test.ts`.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts');
const source = readFileSync(INDEX_PATH, 'utf-8');

/**
 * The dependency object literal passed to `new AdapterManager(...)`, from the
 * constructor call to the closing `});` of the call.
 *
 * Deliberately narrow: asserting over the whole 2000-line file would pass on any
 * `getDefault()` elsewhere in it, and there are legitimate ones.
 *
 * @returns The source text of the AdapterManager construction.
 */
function adapterManagerConstruction(): string {
  const start = source.indexOf('new AdapterManager(');
  expect(start, 'AdapterManager is no longer constructed in index.ts').toBeGreaterThan(-1);
  const end = source.indexOf('});', start);
  expect(end, 'could not find the end of the AdapterManager construction').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('the relay adapter binds every registered runtime, not the default one', () => {
  it('passes relayAgentRuntime keyed by its own type', () => {
    // Keyed by `.type`, not a literal: the AdapterManager map is read back by
    // session dispatch and by the binding subsystem's session creator, both of
    // which look up a real runtime type. A hardcoded key that happens to be
    // wrong makes the runtime invisible to every lookup, and the relay goes
    // quiet without erroring — which is how test mode shipped with binding
    // routing dead.
    expect(adapterManagerConstruction()).toMatch(
      /\[relayAgentRuntime\.type,\s*relayAgentRuntime\]/
    );
  });

  it('carries every registered runtime, not just the relay default', () => {
    // The whole of DOR-1614 at the composition root: a one-entry map is a relay
    // that can only ever answer on claude-code, so an agent whose manifest says
    // codex or opencode is answered by the wrong program under its own name.
    expect(adapterManagerConstruction()).toMatch(/runtimeRegistry\.listRuntimes\(\)/);
  });

  it('lists relayAgentRuntime AFTER the registry sweep so it wins its own key', () => {
    // Map construction is last-write-wins. `relayAgentRuntime` is the instance
    // `setRelayBindingContext` reaches into later, so the relay and that wiring
    // must hold the same object — which only holds if its entry comes second.
    const construction = adapterManagerConstruction();
    expect(construction.indexOf('runtimeRegistry.listRuntimes()')).toBeLessThan(
      construction.indexOf('[relayAgentRuntime.type, relayAgentRuntime]')
    );
  });

  it('does not use the deprecated single-agentManager field', () => {
    expect(adapterManagerConstruction()).not.toMatch(/\bagentManager:/);
  });

  it('never resolves the adapter runtime through the registry default', () => {
    expect(
      adapterManagerConstruction(),
      'The relay holds every runtime now, but its DEFAULT entry — what answers a message ' +
        'naming no runtime — must still be the concrete runtime this file constructed, not ' +
        'whatever runtimes.default points at. getDefault() here would move who answers an ' +
        'unaddressed message every time a person changes a setting, and would key the map ' +
        'from a lookup instead of from the object the setRelayBindingContext wiring below ' +
        'reaches into. Use relayAgentRuntime, which the runtime-registration block assigns ' +
        'from the concrete runtime it built.'
    ).not.toMatch(/getDefault\(\)/);
  });

  it('never casts a runtime into the adapter shape', () => {
    // The cast is what let the mismatch compile. Its absence is the reason the
    // typechecker now guards this instead of only this test.
    expect(source).not.toMatch(/as unknown as (ClaudeCode)?AgentRuntimeLike/);
  });

  it('assigns relayAgentRuntime on both the test-mode and production paths', () => {
    // A binding assigned on only one path would skip AdapterManager init on the
    // other. The guard now logs an error there rather than passing in silence,
    // but this keeps the mistake from reaching that log at all.
    const assignments = source.match(/^\s*relayAgentRuntime = /gm) ?? [];
    expect(assignments).toHaveLength(2);
  });

  it('reads a real AdapterManager construction, not an empty slice', () => {
    // The three assertions above are negatives over an extracted region: an
    // extraction that silently returned nothing would pass every one of them.
    const construction = adapterManagerConstruction();
    expect(construction.length).toBeGreaterThan(100);
    expect(construction).toContain('traceStore');
    expect(construction).toContain('relayCore');
  });
});
