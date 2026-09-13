---
paths: '**/__tests__/**/*.ts, **/__tests__/**/*.tsx, **/*.test.ts, **/*.test.tsx'
---

# Testing Rules

These rules apply to all test files in the `__tests__/` directory.

## Test File Structure

Tests live alongside source in `__tests__/` directories. Server services are domain-grouped; client code lives in FSD layers:

```
apps/server/src/
├── services/
│   ├── session/__tests__/       # session-lock.test.ts, event-log-history.test.ts, ...
│   ├── session/replay/__tests__/ # event-log.test.ts, ring-buffer.test.ts, ...
│   ├── core/__tests__/          # config-manager.test.ts, ...
│   └── __tests__/               # cross-domain integration tests
└── routes/__tests__/
apps/client/src/layers/
├── features/session-list/__tests__/   # SessionSidebar.test.tsx
├── entities/tasks/__tests__/
└── shared/lib/__tests__/
```

## Required Patterns

### Environment Directive

Component tests need jsdom environment:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
```

### Mock Transport (Required for Client Components)

Components use the Transport interface via React Context. Always provide a mock Transport in tests:

```typescript
import { TransportProvider } from '@/layers/shared/model'
import { createMockTransport } from '@dorkos/test-utils'

const mockTransport = createMockTransport()

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <TransportProvider transport={mockTransport}>
      {children}
    </TransportProvider>
  )
}
```

### Mock Browser APIs

When testing components that use browser APIs:

```typescript
beforeAll(() => {
  // Mock matchMedia for responsive components
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
```

### Wrapper Components

Wrap components that need context providers:

```typescript
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        {children}
      </SidebarProvider>
    </QueryClientProvider>
  )
}

render(<MyComponent />, { wrapper: Wrapper })
```

## Test Types

### Component Tests (UI)

```typescript
describe('ComponentName', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders expected content', () => {
    render(<Component />)
    expect(screen.getByText('Expected')).toBeInTheDocument()
  })

  it('handles user interaction', async () => {
    const user = userEvent.setup()
    render(<Component />)

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Updated')).toBeInTheDocument()
  })
})
```

### Service Tests

```typescript
describe('TranscriptReader', () => {
  it('returns session when found', async () => {
    // Mock fs/promises for transcript reading
    vi.mocked(readFile).mockResolvedValue(Buffer.from(mockJsonl));

    const result = await transcriptReader.getSession('test-id');
    expect(result).toEqual(expect.objectContaining({ id: 'test-id' }));
  });

  it('throws when session not found', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    await expect(transcriptReader.getSession('missing')).rejects.toThrow();
  });
});
```

### Hook Tests

```typescript
import { renderHook, waitFor } from '@testing-library/react';

describe('useCustomHook', () => {
  it('returns expected state', async () => {
    const { result } = renderHook(() => useCustomHook(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
  });
});
```

## Naming Conventions

| Pattern        | Example                             |
| -------------- | ----------------------------------- |
| Describe block | Component/function name             |
| Test case      | `it('does specific behavior', ...)` |
| Mock files     | `__mocks__/moduleName.ts`           |

## Anti-Patterns (Never Do)

```typescript
// NEVER test implementation details
expect(component.state.isOpen).toBe(true); // Wrong - test behavior

// NEVER use waitFor without assertion
await waitFor(() => {}); // Wrong

// NEVER leave console mocks without cleanup
vi.spyOn(console, 'error'); // Add mockRestore in afterEach

// NEVER use arbitrary timeouts
await new Promise((r) => setTimeout(r, 1000)); // Wrong - use waitFor
```

## Assertions that cannot fail

A test that cannot fail is worse than no test: it reports safety it never checked, and it makes the next person trust the area less once they find out. Eleven of these were found in one day (2026-07-25) across the composer, the status line, the session endpoints and CI — every one green, every one certifying something false. The signatures repeat, so they are worth recognising on sight.

**The rule:** before you write an assertion, say in one sentence _what change to the product would make this red_. If you cannot, the assertion is decoration. Then prove it — **break the behaviour and watch the test fail.** Red-then-green is the only evidence that a test discriminates; a passing test is evidence of nothing on its own.

### Catalogue

| Shape                                                                                  | Why it can't fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expect(el.querySelector('.x')).toBeDefined()`                                         | `querySelector` returns `null`, and only `undefined` fails `toBeDefined`. Use `.not.toBeNull()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Asserting `input.value === ''` on a **controlled** input                               | If the `value` prop never moves, React reverts the DOM node — so it equals whatever it started as, whether or not the clear worked. Drive a controlled host and assert the value the host _received_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Seeding the exact cache key the reader reads                                           | The test builds the world in which the code works. Mount the real writer instead. (A banner read `['session', id]` while the app wrote `['session', id, cwd]`; its own test was the only thing that ever wrote the short key.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A parity test that pins one of the two inputs it compares                              | "The two endpoints agree" cannot fail if the fake returns the same value for every id. Vary every input the comparison spans.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Measuring a geometry the layout structurally pins                                      | `scrollWidth === clientWidth` can never differ inside `overflow-hidden` with `min-w-0` shrinkable children. Measure painted extent, or adjacent rects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A probe whose selector excludes where the bug lives                                    | Querying `[data-testid^="status-item-"]` cannot see overflow **into** a sibling anchor that the selector omits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A mutation test whose anchor is not unique                                             | `replace(pattern, 1)` patched a _comment_ three lines earlier, so the mutant was never applied and reported green. Assert the anchor is unique before mutating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Reproducing on a fresh **source** checkout when the hypothesis is a **build artifact** | `git checkout origin/main -- .` restores source, not dists, so it re-runs against the same stale dist and confirms the answer you already had. See gotcha 13 in the agent-gotchas memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Verifying a permission/deny rule by reading it                                         | `Read(/etc/**)` silently does not apply (needs `//`); `Grep(//etc/**)` does nothing at all. Attempt the access and observe the refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Trusting a red that a **stale `packages/shared/dist`** produced                        | A stale dist does not only break typecheck. Zod strips unknown keys, so a schema field added this session is silently dropped by `.parse` and the test fails as `expected undefined to be 'thread-aware'`, an assertion failure that reads exactly like a real bug. Run `pnpm --filter @dorkos/shared build` before believing any red on a field you just added. CI builds shared first, so this never reaches the pipeline and only ever wastes local time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fake timers against a platform timer they do not intercept                             | `AbortSignal.timeout` does not run on vitest's fake clock, so advancing time proves nothing. Assert the value passed instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Comparing a **recorded timestamp against a later real-clock reading**                  | `expect(recorded).toBeLessThanOrEqual(Date.now())` is not a safe claim, it is a race: production reads the clock at A, the assertion reads it again at B, and the margin is whatever the runner had left. **Two different mechanisms break it, and they need different fixes.** _Elapsed time_ — a deadline or TTL spent between A and B — is the load-sensitive one: it reds as `expected <ts> to be <= <ts>` on a busy runner, on a PR that touched nothing near it. _Quantization or clock skew in the recorded value itself_ is load-INsensitive and reds a machine that is not even busy: `ps -o lstart=` prints whole seconds, so `startedAt <= Date.now()` had no headroom beyond the sub-second remainder of when the worker happened to launch, and a `btime` off by one puts the reading past the reference outright (DOR-1716). Fix either by capturing `after` **at the call** and asserting `before <= recorded <= after`; or by freezing the clock (`vi.setSystemTime`, or `vi.spyOn(Date, 'now')` where real timers are needed on the path) and asserting the exact value; or by passing the instant in, where production already takes one. For a quantized value, anchor to the same physical event both sides describe rather than to a second clock reading. Widening the tolerance is not a fix — it makes the assertion accept the defect it exists to catch. Fixture timestamps get the same discipline — state them, never default them to `Date.now()` (DOR-1502). Genuine duration budgets ("this finished in under a second") are the deliberate exception; say so at the assertion.                                                                             |
| A **fixed sleep** standing in for the completion of real async work                    | `await new Promise((r) => setTimeout(r, 100))` then `expect(spy).toHaveBeenCalled…` is the same race as the row above, one layer up: the sleep is a guess at how long production takes, and a loaded runner spends it before the work lands. It reds as `Number of calls: 0` / `expected 'running' to be 'failed'` — a mismatch that reads like a real bug — on a PR that touched nothing near it, and it is green in isolation, so it is dismissed as flake. Wait on the **outcome** instead: the returned promise if the API hands you one, otherwise `vi.waitFor` on the spy, the store row, or the event. Fire-and-forget APIs (`triggerManualRun` kicks off `executeRun` and returns the row) hand you no promise, so name the observable the work produces. Prove the conversion the same way every time: put a delay longer than the old sleep into production's async step, watch the OLD form red and the NEW form stay green (DOR-1840; 14 sites in one file, one of which the probe left green — that one was vacuous, asserting a status `createRun` had already written). **Two sweep-shape lessons.** First, grep the mechanism, not the previous bug's spelling: DOR-1716's sweep matched `Date.now()` comparisons and walked straight past `setTimeout` + `toHaveBeenCalled`, which is the same defect. Second, most surviving sleeps in `apps/server` are **not** this shape — a bounded window for a **negative** assertion ("no second turn fired", "the watchdog stayed silent") has no event to wait on, and a sleep that IS the thing under test (a grace, a cap, an idle TTL, spacing two mtimes) is deliberate. Leave those, and say at the sleep which one it is. |
| A test that passes with **and** without the fix                                        | If you cannot make it red by reverting the change, delete it and say why rather than shipping a green check that proves nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Checking a config **migration** through `configManager.get`/`getDot`                   | conf's `store` getter re-reads and re-parses `config.json` on every access and validates the copy it is about to hand back, so Ajv's `useDefaults` fills the missing key into that copy and the copy is discarded. Nothing reaches the file. Delete the migration body and the assertion still passes. Read `config.json` itself. (A whole TOP-LEVEL section is the exception — conf writes its merged `defaults` to the file before the first migration key, so neither form can attribute that to the body; say so instead of pretending. DOR-1496.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Two corollaries

- **jsdom reports every element as `0 × 0`.** Nothing geometric — height, overlap, truncation, animation frames — can be settled in a unit test. Say so in the test rather than asserting a proxy and implying coverage.
- **A comment admitting an assertion is weak does not make it acceptable.** Three tests shipped carrying "browser-verified rather than asserted here"; they were vacuous, and the note is why nobody looked again.

## Mock AgentRuntime (Server Tests)

### Stable HTTP listeners for server route tests

Server route tests import the request builder and its types through the stable-target facade:

```typescript
import request, { type Response, type Test } from '@dorkos/test-utils/supertest';
import { listeningServer, swappableServer } from '@dorkos/test-utils/listening-server';
```

Pass `request()` only an already-listening `http.Server` or an explicit HTTP(S) URL. For a
fixed module or `describe` app, call `listeningServer(app)` once at the same scope and use its
returned Server. For an app rebuilt by `beforeEach` or a local factory, create one
`swappableServer()` at the owning scope and explicitly `mount(app)` when that logical app
begins. The swappable helper retains its last mount; remount it whenever a new logical app
begins, while keeping dependent multi-request sequences on the same mount.

When a raw SSE or HTTP client exercises the same app as Supertest, give it the file-owned
server's URL or port. Keep a separate explicit listener only for a distinct upstream, probe,
provider, preview server, or listener that is itself under test. Those fixtures own and close
their listeners directly rather than routing them through the facade.

Server route tests that touch session endpoints need a mock `AgentRuntime`. Use `FakeAgentRuntime` from `@dorkos/test-utils` instead of hand-rolling a mock object:

```typescript
import { FakeAgentRuntime, TestScenario } from '@dorkos/test-utils';

let fakeRuntime: FakeAgentRuntime;

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.mocked(runtimeRegistry.getDefault).mockReturnValue(fakeRuntime);
});
```

Load scenarios to control what `sendMessage()` yields:

```typescript
import { testScenarios } from '@dorkos/test-utils';

fakeRuntime.withScenarios([testScenarios[TestScenario.SimpleText]('Hello')]);
```

`FakeAgentRuntime` implements every method on the `AgentRuntime` interface with `vi.fn()` spies. If the interface adds a method, tests using `FakeAgentRuntime` will fail to compile — this is intentional.

### SDK-Level Scenarios (Tier 1)

For tests that operate at the `SDKMessage` level (e.g., `claude-code-runtime.test.ts`), use the shared scenario builders in `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts`:

```typescript
import { wrapSdkQuery, sdkSimpleText, sdkToolCall } from './sdk-scenarios.js';

const queryResult = wrapSdkQuery(sdkSimpleText('Echo: Hello'));
```

These builders live inside the ESLint boundary for `@anthropic-ai/claude-agent-sdk` imports. Do not import them from outside `services/runtimes/claude-code/`.

### SSE Integration Tests

Use `collectDurableEvents` from `@dorkos/test-utils` to collect frames off the durable `GET /api/sessions/:id/events` stream (message POSTs are trigger-only 202s per ADR-0264 — trigger the turn first, then collect):

```typescript
import { collectDurableEvents } from '@dorkos/test-utils';

const { frames } = await collectDurableEvents(app, sessionId, {
  after: 0, // replay from the start; omit for snapshot-first delivery
  until: (fs) => fs.some((f) => f.event === 'turn_end'), // required for live streams
});
expect(frames.some((f) => f.event === 'text_delta')).toBe(true);
```

Omit `until` only for finite mocked `subscribeSession` sources — a real projector stream never ends on its own.

## Runner and environment traps

Failures that blame the wrong thing, each measured on this machine:

- **A loaded machine manufactures false reds in interaction-heavy tests.** With
  several agents' suites running (load average >100), the client suite stretches
  250s → 1300s and default 5s timeouts fail 11–26 files with zero assertion
  mismatches. The discriminator: re-run the exact failed set at low load. Never
  inflate `testTimeout` to pass a gate — that is a check that cannot fail.
- **A test that waits on a real filesystem watcher asserts through chokidar's
  POLLING backend.** macOS drops fs events outright rather than late — measured
  2026-09-12/13, 7 of 20 single writes under a native watch went unreported at a
  load average of 78, and from inside a Vitest worker as few as 2 of 7 fresh
  watches saw their file — so "I wrote the file and nothing happened" cannot tell
  a broken handler from a dropped event, and a case resting on it reds on
  somebody else's branch (DOR-2012). Use `watchWithPolling`
  (`packages/relay/src/__tests__/fake-watcher.ts`, and its twin in
  `apps/server/src/services/harness/__tests__/skills-watcher.test.ts` — one copy
  per package, because each spies on its own resolved `chokidar`): it spreads
  PRODUCTION's options and adds only `usePolling`, so the real file, real
  chokidar, real event names and real handlers are all still under test and only
  the OS notification source is substituted. Exactly one case keeps a NATIVE
  watch — `watcher-manager.test.ts`'s real-filesystem smoke — so the suite still
  exercises kernel delivery somewhere; it re-arms its watch on any empty window,
  exits at once when the watch reports `EMFILE`/`ENOSPC` at arming, and skips
  LOUDLY (never passes) when every window came back exhausted. Do not add a
  second native one.
- **Budgets for those waits come from `@dorkos/shared/test-budget`.** Fixed
  millisecond ceilings are a claim about how fast the machine is, and this repo
  runs several agents' suites at once. `loadScaledMs(base)` widens a ceiling by
  the per-core load average and must be called WHEN THE WAIT STARTS — `loadavg()`
  is a one-minute average, so a budget frozen at module load reads from before
  the sweep that needed it began. A test's own timeout cannot resample, so derive
  it from `loadCeilingMs(base)` and cap it absolutely (60-120s): a ceiling that
  cannot be reached is a failure message lost to a bare timeout, and
  `VITEST_RETRY=2` on the pre-push hook triples whatever you write.
- **Exit 143 with no test summary is starvation, not a red.** The run was
  SIGTERM'd, usually by memory/CPU pressure from orphaned runners. Check
  `pgrep -fl vitest` for strays from earlier runs before concluding the gate is
  broken — killing them and re-running has turned "broken gate" into 880/880.
- **Stopping a backgrounded test task kills the wrapper, not the workers.** After
  stopping any heavy run, verify with `pgrep`/`ps` filtered by worktree path that
  zero processes remain; a stopped wrapper is an exit code, zero processes is the
  outcome.
- **A shared-package type change needs the full forced typecheck.** A narrowing
  regression can pass `--filter <pkg> typecheck` and still break a downstream
  package's build; run `turbo run typecheck --force` when an exported type in
  `packages/*` changes.
- **Drizzle ignores standalone `index(...)` exports silently.** Indexes must live
  in the table's third argument; read the generated SQL to confirm every index
  survived. Two branches minting the same migration number conflict in
  `drizzle/meta/_journal.json` — roll back and regenerate against updated main.
- **`pnpm verify --force` is a footgun** — pnpm passes `--force` through to
  vitest, which hard-fails with `CACError: Unknown option --force` and reads as a
  test failure. Forced forms that work: `turbo run typecheck lint --force` and
  `turbo run test --force -- --run`.
- **Targeted server vitest runs read some `@dorkos/shared` subpaths from `dist`**
  (only aliased subpaths load from source), so a source-edited schema tests stale
  until `pnpm --filter @dorkos/shared build`. CI is safe via turbo `^build`;
  local targeted runs are not.
- **Servers bind IPv6** — probe `localhost`, not `127.0.0.1`.
- **zsh does not word-split unquoted variables** — `pnpm vitest run $FILES`
  silently runs nothing; write explicit paths.
- **Diff against `$(git merge-base origin/main HEAD)`**, never `origin/main..HEAD`.

## Running Tests

```bash
pnpm test                          # Run all tests via Turborepo
pnpm test -- --run                 # Single run (no watch)
pnpm vitest run path/to/test.ts    # One test file — the inner loop
pnpm vitest watch path/to/test.ts  # Watch that file
```

The targeted forms take a path and work for every package: the root `vitest.config.ts` registers every workspace package that has tests, plus repo-root `scripts/`. "No test files found, exiting with code 1" means the path is wrong, not that the package is unreachable.

Never run bare `pnpm vitest run` or `pnpm vitest watch` over the whole workspace. `pnpm test` is `dotenv -- turbo test`, so it loads `.env` and gives each package its own environment; bare vitest does neither, and whole-workspace bare runs have falsely failed tests in the dev environment. Full runs go through turbo (`pnpm test -- --run`); bare vitest is for scoped paths only.
