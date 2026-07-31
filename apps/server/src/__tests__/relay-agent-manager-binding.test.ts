/**
 * The relay's Claude Code adapter is bound to the claude-code runtime, never to
 * whatever `runtimes.default` happens to be (DOR-768, spec `execution-defaults`
 * §7).
 *
 * The adapter speaks the Claude Agent SDK's session/approval vocabulary
 * (`ensureSession`, `getSdkSessionId`, `approveTool`). It used to receive
 * `runtimeRegistry.getDefault()` through an `as unknown as
 * ClaudeCodeAgentRuntimeLike` cast, which is the exact shape of "this compiles
 * because I told it to": pointing `runtimes.default` at codex or opencode would
 * have handed the relay a runtime with none of those methods, and the cast made
 * the compiler agree. The composition root now assigns `relayAgentRuntime` from
 * the concrete runtime it constructs — ClaudeCodeRuntime in production,
 * TestModeRuntime under `DORKOS_TEST_RUNTIME` — and passes it as a map keyed by
 * that runtime's own `type`, so the binding is independent of the default and
 * the key is never a guess.
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

describe('the relay adapter binds claude-code, not the default runtime', () => {
  it('passes relayAgentRuntime keyed by its own type', () => {
    // Keyed by `.type`, not a literal: the AdapterManager map is read back by
    // session dispatch and by the binding subsystem's session creator, both of
    // which look up a real runtime type. A hardcoded key that happens to be
    // wrong makes the runtime invisible to every lookup, and the relay goes
    // quiet without erroring — which is how test mode shipped with binding
    // routing dead.
    expect(adapterManagerConstruction()).toMatch(
      /agentRuntimes:\s*new Map\(\[\[relayAgentRuntime\.type,\s*relayAgentRuntime\]\]\)/
    );
  });

  it('does not use the deprecated single-agentManager field', () => {
    expect(adapterManagerConstruction()).not.toMatch(/\bagentManager:/);
  });

  it('never resolves the adapter runtime through the registry default', () => {
    expect(
      adapterManagerConstruction(),
      'The relay adapter is Claude-specific: it calls getSdkSessionId/approveTool, which ' +
        'codex and opencode runtimes do not implement. Binding it to ' +
        'runtimeRegistry.getDefault() means a person who sets runtimes.default to opencode ' +
        'gets a relay that throws on the first agent message. Use relayAgentRuntime, which ' +
        'the runtime-registration block assigns from the concrete runtime it built.'
    ).not.toMatch(/getDefault\(\)/);
  });

  it('never casts a runtime into the adapter shape', () => {
    // The cast is what let the mismatch compile. Its absence is the reason the
    // typechecker now guards this instead of only this test.
    expect(source).not.toMatch(/as unknown as ClaudeCodeAgentRuntimeLike/);
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
