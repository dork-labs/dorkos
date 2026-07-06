---
name: requesting-code-review
description: Guides dispatching a code-reviewer subagent to verify work before proceeding. Use when completing tasks, implementing major features, or before merging to verify work meets requirements.
---

# Requesting Code Review

Dispatch a code-reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history. This keeps the reviewer focused on the work product, not your thought process, and preserves your own context for continued work.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**

- After each batch of related tasks in spec-driven development (`/flow:execute`) — holistic batch-level review, not per-task review
- After completing a major feature
- Before merge to main

**Optional but valuable:**

- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing a complex bug

## Lightweight Alternative

For quick self-review without dispatching a subagent, trace through recently modified functions yourself to verify correctness and completeness inline. Use the full code-reviewer subagent (below) for deeper, more rigorous review.

## How to Request

### 1. Get git SHAs

```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main for full branch review
HEAD_SHA=$(git rev-parse HEAD)
```

### 2. Dispatch code-reviewer subagent

Use the Agent tool with `subagent_type: "code-reviewer"`. Supply the following context:

**Required context:**

- `{WHAT_WAS_IMPLEMENTED}` — What you just built
- `{PLAN_OR_REQUIREMENTS}` — What it should do (spec path, task description, or requirements)
- `{BASE_SHA}` — Starting commit
- `{HEAD_SHA}` — Ending commit
- `{DESCRIPTION}` — Brief summary of the changes

**DorkOS-specific review concerns to include:**

- FSD layer violations (shared <- entities <- features <- widgets)
- Transport interface compliance (HttpTransport / DirectTransport)
- SDK import confinement — each runtime SDK stays in its adapter directory: `@anthropic-ai/claude-agent-sdk` → `services/runtimes/claude-code/`, `@openai/codex-sdk` → `services/runtimes/codex/`, `@opencode-ai/sdk` → `services/runtimes/opencode/`
- `os.homedir()` ban (must use `lib/dork-home.ts`)
- TSDoc on exports
- Tailwind class sorting (prettier-plugin-tailwindcss)
- Barrel import conventions (import from `index.ts`, never internal paths)

### 3. Act on feedback

- **Critical** — Fix immediately. Bugs, security issues, data loss risks.
- **Important** — Fix before proceeding. Architecture problems, missing tests, error handling gaps.
- **Minor** — Note for later. Code style, optimization opportunities.
- **Push back** if the reviewer is wrong — provide technical reasoning, show code or tests that prove correctness.

## Example

```
[Just completed the batch of tasks for the Telegram relay adapter]

You: Batch complete — let me request a holistic review before the next batch.

BASE_SHA=$(git rev-parse origin/main)  # or the SHA where the batch started
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code-reviewer subagent]
  WHAT_WAS_IMPLEMENTED: Telegram relay adapter with message formatting and rate limiting
  PLAN_OR_REQUIREMENTS: specs/telegram-adapter/02-specification.md, Tasks 1-3
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661
  DESCRIPTION: Added TelegramAdapter implementing RelayAdapter interface, with
    Markdown-to-Telegram formatting, rate limiter, and retry logic

[Subagent returns]:
  Strengths: Clean adapter interface, good test coverage, proper rate limiting
  Issues:
    Important: Missing FSD barrel export in features/relay/index.ts
    Minor: Magic number (30) for rate limit window — extract to constant
  Assessment: Ready to proceed with fixes

You: [Fix barrel export, extract constant]
[Continue to the next batch]
```

## Integration with Workflows

**Spec-Driven Development (`/flow:execute`):**

- Review holistically after each batch of related tasks — one review covering the whole batch beats per-task reviews
- Catch FSD violations and architecture drift early
- Fix before moving to the next batch

**Feature Development:**

- Review after completing the feature
- Verify against the spec before calling it done

**Ad-Hoc Development:**

- Review before merge to main
- Review when stuck for a fresh perspective

## Review Checklist (DorkOS-Specific)

The code-reviewer subagent should evaluate against these project standards:

**Architecture:**

- Hexagonal architecture boundaries respected
- Transport interface used correctly (no direct HTTP in components)
- Runtime SDK imports confined to their adapter directories (claude-code / codex / opencode under `services/runtimes/`)
- Path aliases used correctly (`@/*` for app-local, `@dorkos/*` for cross-package)

**Client (FSD):**

- Layer imports flow one direction: shared <- entities <- features <- widgets
- Components import from barrel `index.ts`, never internal module paths
- Zustand for UI state, TanStack Query for server state (not mixed)
- Motion library for animations (not raw CSS transitions)

**Server:**

- Routes use `runtimeRegistry.getDefault()` for runtime access
- `lib/dork-home.ts` for data directory, `lib/resolve-root.ts` for working directory
- Zod-validated env vars in `env.ts`
- TSDoc on all exported functions and classes

**Testing:**

- Tests in `__tests__/` alongside source
- Client tests use mock Transport via `TransportProvider`
- Server tests use `FakeAgentRuntime` from `@dorkos/test-utils`
- No implementation detail testing, no arbitrary timeouts

## Red Flags

**Never:**

- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer is wrong:**

- Push back with technical reasoning
- Show code or tests that prove correctness
- Request clarification on the concern
