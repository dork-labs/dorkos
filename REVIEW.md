# Review instructions

Review-only calibration for automated PR review of DorkOS. Read by Claude Code
Review (the managed GitHub product, if enabled) and injected into the
`claude-code-review` GitHub Actions workflow. General project context lives in
`AGENTS.md`; keep this file focused on what changes review behavior.

## How to review (process)

Work the diff like a senior engineer, not a linter:

1. Get the full diff (`gh pr diff`) and the changed-file list. Read the enclosing
   function or module around each hunk: a bug in an unchanged line of a touched
   function is in scope.
2. Trace outward. For every symbol the diff changes, removes, or renames, grep the
   repo for its callers and references (`git grep`, Grep). A change is only safe
   once you have checked who depends on it.
3. Verify before posting. Every finding needs a `file:line` you actually read or
   grepped, never an inference from a name. If a quick grep settles it, run it.
4. Rank, then cap. Order findings by severity and post the top ones within the nit
   cap. Quality over volume.

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

## Deletions, renames, and moves (dangling-reference sweep)

Deletion and refactor PRs fail by leaving inbound references to things that no
longer exist. The diff shows what was removed; it does not show what still points
at it. For any PR that deletes or renames files, paths, exports, config keys,
hooks, commands, or scripts:

- Enumerate every removed identifier: package name, file path, directory, exported
  symbol, command, hook, env key, label.
- For each one, grep the whole post-merge tree (`git grep '<token>'`) and confirm
  zero surviving references. Check prose and config too, not just code: `*.md`,
  `*.json` manifests, `.github/`, `settings.json`, `CLAUDE.md` / `AGENTS.md`,
  `contributing/`, `docs/`.
- Search more than one token form: the package (`@scope/x`), the directory
  (`packages/x`), and the bare name (`x-thing`). A reference often survives under a
  token you did not think to search.
- Every surviving reference to a removed thing is a finding: 🟡 at least, 🔴 if a
  runtime, build, or CI path resolves it.

This is mechanical and cheap. Run it before concluding a deletion PR is clean.

## Conventions to check (cheap, high-signal)

- CHANGELOG entries land under the correct Keep a Changelog heading: a removal goes
  under `### Removed`, not `### Added`; behavior changes under `### Changed`.
- A comment or docstring that describes the old behavior after the code changed
  (for example "as it ships on disk" for a file the PR deletes) is drift.
- When a PR edits a manifest (`decisions/manifest.json` and similar), confirm the
  on-disk files agree and the diff did not re-serialize unrelated entries.

## Path-specific focus

- `apps/server/src/services/runtimes/claude-code/**`: the SDK-import confinement
  boundary (the SDK may not be imported elsewhere).
- `apps/client/src/layers/**`: FSD import direction; barrel imports only.
- `**/__tests__/**`: no arbitrary timeouts; mock at the Transport boundary;
  marketplace rollback safety (mock `_internal.isGitRepo`).
- config schema and migrations: a semver-keyed migration is present for any config
  change.
- `*.md`, `docs/**`, `contributing/**`: in-scope for the dangling-reference sweep;
  stale internal links are findings.

## Verification bar

Behavior claims need a `file:line` citation in the diff or surrounding code, not
an inference from a name. When unsure whether a finding is real, leave it out or
mark it 🟡 and state the uncertainty. A false 🔴 costs the author a round trip.

## Re-review convergence

Re-reviews are explicit, not automatic. The auto-review fires once when a PR is
opened or marked ready, and again only when the author applies the `re-review`
label (or asks via `@claude`); it does not run on every push. When you re-review:

- Read your prior review comments on the PR. Treat findings the author addressed
  or resolved as done, and do not repeat them.
- Review only what changed since your last pass, and post only NEW or
  still-unaddressed 🔴 Important findings. A round of fixes should not trigger a
  fresh wave of nits.

## Review controls (labels)

The author sets review behavior with labels (see the `creating-pull-requests`
skill for when to use each):

- `skip-review`: no automatic review at all. Honored by the workflow itself, so
  the action never starts.
- `review:light`: quick pass. Only 🔴 Important findings; skip nits and the
  deletion sweep.
- `review:deep`: exhaustive. Trace every caller and run the full sweep.
- `re-review`: request another pass after addressing feedback. Auto-cleared after
  the review runs, so re-apply it each time you want another look.

## Summary shape

Open the review body with a one-line tally (for example, `2 important, 3 nits`),
and lead with "No factual issues found" when that is the case. The author wants
the shape of the review before the details.
