# Review instructions

Review-only calibration for automated PR review of DorkOS. Read by Claude Code
Review (the managed GitHub product, if enabled) and injected into the
`claude-code-review` GitHub Actions workflow. General project context lives in
`AGENTS.md`; keep this file focused on what changes review behavior.

## What Important (🔴) means here

Reserve 🔴 Important for findings that would break behavior, lose data, leak
secrets, or violate a non-negotiable architectural rule:

- Logic bugs, broken edge cases, and regressions in the changed code.
- Security issues: untrusted input reaching a shell, SQL, or filesystem path;
  secrets or PII in logs or error messages; a new route missing authorization.
- **DorkOS Hard Rule violations are 🔴, not nits:**
  - **FSD layers** — imports must follow `shared ← entities ← features ← widgets`.
    No cross-feature model/hook imports. Import from a barrel `index.ts`, never an
    internal path. (`.claude/rules/fsd-layers.md`)
  - **SDK confinement** — `@anthropic-ai/claude-agent-sdk` may only be imported
    under `apps/server/src/services/runtimes/claude-code/`.
  - **`os.homedir()` ban** — server code resolves the data dir via
    `lib/dork-home.ts`, never `os.homedir()` (carve-out: that file only).
  - **Marketplace rollback safety** — any test exercising a `rollbackBranch: true`
    flow must mock `_internal.isGitRepo` to return false in `beforeEach`, or the
    real `git reset --hard` destroys uncommitted work. (ADR-0231)

Architecture, naming, refactoring, and style suggestions are 🟡 Nit at most.

## Cap the nits

Report at most five 🟡 Nits per review. If you found more, say "plus N similar
items" in the summary instead of posting them all inline. If everything you found
is a Nit, open the summary with "No blocking issues."

## Do not report

- Anything CI already enforces: ESLint, Prettier and Tailwind class sorting, `tsc`
  type errors, Knip dead-code. Each has its own gate.
- Generated or vendored files: `pnpm-lock.yaml`, `docs/api/**`, and
  `apps/server/src/core-extensions/**` (runtime-compiled JSX-in-`.ts`, excluded
  from tsc/eslint/prettier by design).
- Pure formatting opinions.

## Always check

- Exported functions and classes have TSDoc (no `{type}` annotations; TypeScript
  provides the types). FSD barrel files have module-level TSDoc.
- New server routes obtain the runtime via `runtimeRegistry.getDefault()` rather
  than importing the SDK directly.
- New client data access goes through the `Transport` interface, not raw `fetch`.
- New or changed behavior has a test: client tests use a mock `Transport` via
  `TransportProvider`; server tests use `FakeAgentRuntime` from
  `@dorkos/test-utils`.
- No lingering TODOs, commented-out code, dead code, or half-finished migrations.

## Verification bar

Behavior claims need a `file:line` citation in the diff or surrounding code, not
an inference from a name. When unsure whether a finding is real, leave it out or
mark it 🟡 and state the uncertainty. A false 🔴 costs the author a round trip.

## Re-review convergence

After the first review on a PR, suppress new nits on later pushes and post only
🔴 Important findings. A one-line fix should not trigger a fresh wave of style
comments.

## Summary shape

Open the review body with a one-line tally (for example, `2 important, 3 nits`),
and lead with "No factual issues found" when that is the case. The author wants
the shape of the review before the details.
