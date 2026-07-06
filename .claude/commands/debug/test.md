---
description: Debug and fix failing tests using test-driven analysis and self-debugging methodology
argument-hint: '[test-file-path or test-name]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, TodoWrite, AskUserQuestion, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
---

# Test Failure Debugging

Debug and fix the failing test(s) described by `$ARGUMENTS` (a test file path, a test name pattern, or empty for the whole suite). Load the `debugging-test-failures` skill — it carries the methodology (read the failing test first, distinguish test bugs from implementation bugs, verify the fix would fail on wrong code). This command adds the project-specific ground truth below.

## Running tests in this repo

```bash
pnpm vitest run <path-to-test-file>        # ONE test file — fastest loop (~1-2s)
pnpm vitest run <path> -t "test name"      # One test case within a file
pnpm vitest run apps/server/src/services   # Positional filter — a directory or substring
pnpm test -- --run                         # Full suite via Turborepo (single run, no watch)
```

**Gotchas:**

- **Never use bare `pnpm vitest run` for full runs** — outside Turborepo it misses per-package env setup and **falsely fails 2 tests in the dev environment**. Full runs go through `pnpm test -- --run`. If a failure only reproduces under bare vitest, suspect this before suspecting the code.
- **Vitest filters are positional** (path or name substrings after `vitest run`), plus `-t` for test-name patterns. `--testPathPattern` is a Jest flag and is invalid here.
- Snapshot updates: `pnpm vitest run <path> -u` — only after confirming the change is intentional.
- Stale `@dorkos/shared` dist after a pull causes false-red type errors in tests — rebuild with `pnpm --filter @dorkos/shared build`.

## Project testing patterns

Full conventions: `.claude/rules/testing.md` and `contributing/` testing guide. The essentials:

- Tests live in `__tests__/` alongside source; Vitest with `vi.mock()`.
- **Client component tests**: need `/** @vitest-environment jsdom */`, React Testing Library, and a mock `Transport` via `TransportProvider` (`createMockTransport` from `@dorkos/test-utils`). Missing jsdom directive or missing Transport wrapper are the two most common setup failures.
- **Server route tests**: use `FakeAgentRuntime` + `TestScenario` from `@dorkos/test-utils`, never hand-rolled runtime mocks. If the `AgentRuntime` interface grew a method, `FakeAgentRuntime` tests fail to compile — that's intentional.
- **SSE integration tests**: message POSTs are trigger-only 202s; collect frames from the durable stream with `collectDurableEvents` (`@dorkos/test-utils`) and always pass `until` for live streams.
- **SDK-level scenarios**: builders in `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` — importable only inside `services/runtimes/claude-code/` (ESLint SDK boundary).

## Escalation

- Complex type errors surfacing in tests → `typescript-expert` agent.
- Library-specific behavior (Vitest config, Testing Library queries) → context7 (`resolve-library-id` → `query-docs`).

## Non-negotiables

- Read the failing test AND the implementation under test before proposing any fix.
- Never delete or weaken a test just to make it pass without understanding why it fails.
- Verify the fix by re-running the specific test, then the surrounding file; check the test would still fail if the implementation were wrong.

Wrap up with: failing test, root cause, whether the bug was in the test or the implementation, what changed, files modified.
