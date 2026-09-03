/**
 * The relay carries every registered runtime, and `relayAgentRuntime` is
 * authoritative for its own type — never `runtimes.default` (DOR-768, DOR-1614,
 * spec `execution-defaults` §7).
 *
 * `relayAgentRuntime` used to be the ONLY runtime the relay held, because the
 * adapter was read as Claude-specific. It is not: everything below it speaks
 * `AgentRuntimeLike` and `StreamEvent` alone, so the map now carries every
 * runtime this server registered and the adapter picks one per message. What
 * has not changed is which KEY the relay's own default is filed under: the
 * concrete runtime the composition root constructed — ClaudeCodeRuntime in
 * production, TestModeRuntime under `DORKOS_TEST_RUNTIME` — supplies its own
 * `type`, so the key is never a guess and never `getDefault()`.
 *
 * What DID change is the VALUE under that key (DOR-1654). It is now the
 * REGISTRY's instance, not the raw object this file constructed, because
 * `register()` wraps every runtime and only the wrapper notices a turn that
 * fails on a dead sign-in. `setRelayBindingContext` still takes the raw
 * `claudeRuntime`, and the two are deliberately different objects now — see
 * the two-consumers test below for why neither can take the other's.
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

/**
 * The dependency object literal passed to `new TaskSchedulerService(...)`, from
 * the constructor call to the closing `});` of the call.
 *
 * Same narrowing as {@link adapterManagerConstruction}, for the same reason: the
 * scheduler is built inside `start()` with a live registry, a relay and a task
 * store behind it, and there is no seam that constructs just its deps.
 *
 * @returns The source text of the TaskSchedulerService construction.
 */
function schedulerConstruction(): string {
  const start = source.indexOf('new TaskSchedulerService(');
  expect(start, 'TaskSchedulerService is no longer constructed in index.ts').toBeGreaterThan(-1);
  const end = source.indexOf('});', start);
  expect(end, 'could not find the end of the TaskSchedulerService construction').toBeGreaterThan(
    start
  );
  return source.slice(start, end);
}

describe('the Tasks scheduler asks the relay which runtimes it holds', () => {
  it('passes relayHoldsRuntime at all', () => {
    // DELETING this line is a silent revert, which is why it is asserted on its
    // own. `relayHoldsRuntime` is optional on SchedulerDeps — omitting it takes
    // the v1 default, claude-code and nothing else — so its absence typechecks
    // cleanly and every behavioural test still passes: the scheduler's own suite
    // constructs the predicate itself, and nothing else exercises this wiring.
    // Measured: removing this line passed the typecheck and 1398 tests.
    expect(
      schedulerConstruction(),
      'Without `relayHoldsRuntime` the scheduler falls back to the v1 reading and every ' +
        'codex/opencode scheduled run silently goes direct again — the whole of DOR-1614 ' +
        'at this call site, reverted with no test to notice.'
    ).toMatch(/relayHoldsRuntime:/);
  });

  it('answers it from LIVE adapter state, not a literal and not a boot-time map', () => {
    // The predicate must READ THE RELAY. A hardcoded `() => true` would strand
    // runs on a bus that refuses them; a hardcoded runtime name is the v1 bug
    // this replaced. `canRunTaskOnBus` is the one narrow question the relay
    // exposes for it — and it is the LIVENESS-reading one: its predecessor,
    // `hasAgentRuntime`, answered from a map built in the AdapterManager
    // constructor, so a disabled or boot-failed adapter still read as
    // deliverable and every scheduled run it green-lit failed with "No receiver
    // for the scheduled run" (DOR-1636).
    const construction = schedulerConstruction();
    expect(construction).toMatch(/adapterManager\?\.canRunTaskOnBus\(/);
    expect(
      construction,
      'hasAgentRuntime is the map-only reading DOR-1636 removed; asking it again reinstates ' +
        'the bug with nothing in this suite to notice.'
    ).not.toMatch(/hasAgentRuntime/);
  });

  it('asks about the subject the dispatch would publish to', () => {
    // Liveness is a property of the CLAIM: the answer is only meaningful when
    // it is read off the subject this run would actually be published to. A
    // call site that dropped the second argument would typecheck as `undefined`
    // nowhere — but one that passed a constant would compile and lie.
    expect(schedulerConstruction()).toMatch(/canRunTaskOnBus\(runtimeType,\s*subject\)/);
  });

  it('falls closed when the relay never built or failed building', () => {
    // `adapterManager` is undefined before Phase C and is RESET to undefined
    // when Phase C throws. Optional-chaining alone yields `undefined`, which is
    // neither deliverable nor a verdict; `?? RELAY_NOT_BUILT` is what makes the
    // contract explicit — and carries the reason an operator needs.
    expect(schedulerConstruction()).toMatch(
      /canRunTaskOnBus\(runtimeType,\s*subject\)\s*\?\?\s*RELAY_NOT_BUILT/
    );
  });

  it('reads a real TaskSchedulerService construction, not an empty slice', () => {
    // The assertions above are positives, but a broken extraction would fail
    // them for the wrong reason and send a reader hunting the wrong bug.
    const construction = schedulerConstruction();
    expect(construction.length).toBeGreaterThan(100);
    expect(construction).toContain('runtimes:');
    expect(construction).toContain('store:');
  });
});

describe('the relay adapter binds every registered runtime, not the default one', () => {
  it('keys the relay default by relayAgentRuntime.type', () => {
    // Keyed by `.type`, not a literal: the AdapterManager map is read back by
    // session dispatch and by the binding subsystem's session creator, both of
    // which look up a real runtime type. A hardcoded key that happens to be
    // wrong makes the runtime invisible to every lookup, and the relay goes
    // quiet without erroring — which is how test mode shipped with binding
    // routing dead.
    expect(adapterManagerConstruction()).toMatch(/\[relayAgentRuntime\.type,/);
  });

  it('carries the registry’s WATCHED runtime as that entry, never the raw object', () => {
    // DOR-1654. The key was always right; the VALUE was not. `relayAgentRuntime`
    // is the raw runtime this file constructed, while the registry holds the
    // wrapped one (tracing, and the sign-in watch). Because this entry is
    // appended last and wins its key, naming the raw object here put it in the
    // map — and from there into `deps.agentManager`, since `adapter-factory.ts`'s
    // `defaultRuntimeFor` reads this very map, and back over the map again in
    // `ClaudeCodeAdapter`'s constructor. Every relay turn on claude-code then ran
    // unwatched, so a Telegram or Slack bridged agent on an expired sign-in told
    // nobody. That is precisely the gap the ticket exists to close, surviving on
    // the one path nothing looked at.
    //
    // Resolved by TYPE rather than by identity so this entry and `agentManager`
    // are the SAME proxy instance: `register()` builds the wrapper once and
    // stores it, so repeated `get()` calls return one reference and the adapter's
    // `r !== this.deps.agentManager` dedupe still holds.
    //
    // The behavioural half of this — a real `ClaudeCodeAdapter` delivering a real
    // envelope, raising the notification over the watched map and staying silent
    // over the raw one — lives in
    // `services/notifications/__tests__/runtime-signin.test.ts`. This is the
    // source half, because the wiring itself has no seam to construct.
    const construction = adapterManagerConstruction();
    expect(
      construction,
      'The relay default must be the registry’s wrapper, not the raw runtime this file ' +
        'built. Spelling the value `relayAgentRuntime` reverts DOR-1654 on the relay path ' +
        'with nothing else to notice: no test fails, the relay simply stops being watched.'
    ).not.toMatch(/\[relayAgentRuntime\.type,\s*relayAgentRuntime\s*\]/);
    expect(construction).toMatch(
      /\[relayAgentRuntime\.type,\s*runtimeRegistry\.get\(relayAgentRuntime\.type\)\s*\]/
    );
  });

  it('carries every registered runtime, not just the relay default', () => {
    // The whole of DOR-1614 at the composition root: a one-entry map is a relay
    // that can only ever answer on claude-code, so an agent whose manifest says
    // codex or opencode is answered by the wrong program under its own name.
    expect(adapterManagerConstruction()).toMatch(/runtimeRegistry\.listRuntimes\(\)/);
  });

  it('gives the relay the watched wrapper while the binding context keeps the raw runtime', () => {
    // **Two consumers, two objects, on purpose** — and this used to be one
    // object on purpose, which is why it is spelled out rather than left to
    // read as an inconsistency.
    //
    // The old rule was "the relay and `setRelayBindingContext` must hold the
    // SAME instance", enforced by listing `relayAgentRuntime` last so it won
    // its own key. DOR-1654 retired that: the relay wants the registry's
    // WRAPPED runtime so its turns are watched, while `setRelayBindingContext`
    // calls a `ClaudeCodeRuntime`-only method that is not on `AgentRuntime` and
    // therefore wants the concrete object. Neither can take the other's.
    //
    // Ordering is no longer what decides this. Both the registry sweep and the
    // trailing entry now yield the same wrapped instance for that key, so the
    // last-write-wins hazard that made ordering load-bearing is gone; what
    // matters is only which OBJECT each consumer names.
    expect(
      source,
      'setRelayBindingContext must be called on the concrete claudeRuntime. A registry ' +
        'lookup here would hand it an AgentRuntime-shaped proxy that does not carry the ' +
        'ClaudeCodeRuntime-only method it calls.'
    ).toMatch(/claudeRuntime\.setRelayBindingContext\(/);
    expect(
      source,
      'setRelayBindingContext must not be fed from the registry — that is the relay map’s ' +
        'job, not this one’s.'
    ).not.toMatch(/runtimeRegistry\.get\([^)]*\)\.setRelayBindingContext\(/);
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
