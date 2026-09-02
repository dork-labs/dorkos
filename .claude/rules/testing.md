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

| Shape                                                                                  | Why it can't fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expect(el.querySelector('.x')).toBeDefined()`                                         | `querySelector` returns `null`, and only `undefined` fails `toBeDefined`. Use `.not.toBeNull()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Asserting `input.value === ''` on a **controlled** input                               | If the `value` prop never moves, React reverts the DOM node — so it equals whatever it started as, whether or not the clear worked. Drive a controlled host and assert the value the host _received_.                                                                                                                                                                                                                                                                                                                                                  |
| Seeding the exact cache key the reader reads                                           | The test builds the world in which the code works. Mount the real writer instead. (A banner read `['session', id]` while the app wrote `['session', id, cwd]`; its own test was the only thing that ever wrote the short key.)                                                                                                                                                                                                                                                                                                                         |
| A parity test that pins one of the two inputs it compares                              | "The two endpoints agree" cannot fail if the fake returns the same value for every id. Vary every input the comparison spans.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Measuring a geometry the layout structurally pins                                      | `scrollWidth === clientWidth` can never differ inside `overflow-hidden` with `min-w-0` shrinkable children. Measure painted extent, or adjacent rects.                                                                                                                                                                                                                                                                                                                                                                                                 |
| A probe whose selector excludes where the bug lives                                    | Querying `[data-testid^="status-item-"]` cannot see overflow **into** a sibling anchor that the selector omits.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A mutation test whose anchor is not unique                                             | `replace(pattern, 1)` patched a _comment_ three lines earlier, so the mutant was never applied and reported green. Assert the anchor is unique before mutating.                                                                                                                                                                                                                                                                                                                                                                                        |
| Reproducing on a fresh **source** checkout when the hypothesis is a **build artifact** | `git checkout origin/main -- .` restores source, not dists, so it re-runs against the same stale dist and confirms the answer you already had. See gotcha 13 in the agent-gotchas memory.                                                                                                                                                                                                                                                                                                                                                              |
| Verifying a permission/deny rule by reading it                                         | `Read(/etc/**)` silently does not apply (needs `//`); `Grep(//etc/**)` does nothing at all. Attempt the access and observe the refusal.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Trusting a red that a **stale `packages/shared/dist`** produced                        | A stale dist does not only break typecheck. Zod strips unknown keys, so a schema field added this session is silently dropped by `.parse` and the test fails as `expected undefined to be 'thread-aware'`, an assertion failure that reads exactly like a real bug. Run `pnpm --filter @dorkos/shared build` before believing any red on a field you just added. CI builds shared first, so this never reaches the pipeline and only ever wastes local time.                                                                                           |
| Fake timers against a platform timer they do not intercept                             | `AbortSignal.timeout` does not run on vitest's fake clock, so advancing time proves nothing. Assert the value passed instead.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A test that passes with **and** without the fix                                        | If you cannot make it red by reverting the change, delete it and say why rather than shipping a green check that proves nothing.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Checking a config **migration** through `configManager.get`/`getDot`                   | conf's `store` getter re-reads and re-parses `config.json` on every access and validates the copy it is about to hand back, so Ajv's `useDefaults` fills the missing key into that copy and the copy is discarded. Nothing reaches the file. Delete the migration body and the assertion still passes. Read `config.json` itself. (A whole TOP-LEVEL section is the exception — conf writes its merged `defaults` to the file before the first migration key, so neither form can attribute that to the body; say so instead of pretending. DOR-1496.) |

### Two corollaries

- **jsdom reports every element as `0 × 0`.** Nothing geometric — height, overlap, truncation, animation frames — can be settled in a unit test. Say so in the test rather than asserting a proxy and implying coverage.
- **A comment admitting an assertion is weak does not make it acceptable.** Three tests shipped carrying "browser-verified rather than asserted here"; they were vacuous, and the note is why nobody looked again.

## Mock AgentRuntime (Server Tests)

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
