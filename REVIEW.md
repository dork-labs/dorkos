# Review instructions

Review-only calibration for automated PR review of DorkOS. Read by Claude Code
Review (the managed GitHub product, if enabled) and injected into the
`claude-code-review` GitHub Actions workflow. General project context lives in
`AGENTS.md`; keep this file focused on what changes review behavior.

## How to review (process)

Work the diff like a senior engineer, not a linter:

1. Get the full diff and the changed-file list, with whatever command your harness
   gives you for it — the `claude-code-review` workflow pins that to a helper and
   says so in its prompt, so do not reach for `gh` there. Read the enclosing
   function or module around each hunk: a bug in an unchanged line of a touched
   function is in scope.
2. Trace outward. For every symbol the diff changes, removes, or renames, search the
   repo for its callers and references (the Grep tool). A change is only safe
   once you have checked who depends on it.
3. Verify before posting. Every finding needs a `file:line` you actually read or
   searched for, never an inference from a name. If a quick search settles it, run
   it.
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
  - **SDK confinement** — each runtime SDK may only be imported under its own
    adapter directory in `apps/server/src/services/runtimes/`:
    `@anthropic-ai/claude-agent-sdk` → `claude-code/`, `@openai/codex-sdk` →
    `codex/`, `@opencode-ai/sdk` → `opencode/`.
  - **`os.homedir()` ban** — server code resolves the data dir via
    `lib/dork-home.ts`, never `os.homedir()`. Five carve-outs are declared and
    are NOT findings: `lib/dork-home.ts`, `lib/boundary.ts` (two inline-disabled
    call sites), `claude-code/claude-config-dir.ts`, `codex/codex-home.ts`, and
    `opencode/opencode-data-dir.ts` — the last three mirror another program's own
    path resolution rather than DorkOS's. The full list, with reasons, is
    `.claude/rules/dork-home.md`.
  - **Marketplace rollback safety**: install failures roll back via a file-scoped
    target backup/restore, not git. A test on an install failure path should assert
    the target is restored (overwrite) or removed (fresh install), never that a git
    branch was reset. (ADR-0304, supersedes 0231)

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

- TSDoc **content** matches behavior (the linter enforces presence, not accuracy):
  a doc that describes stale parameters, wrong defaults, or the pre-change
  behavior is drift and a finding.
- New server routes obtain the runtime via `runtimeRegistry.getDefault()` rather
  than importing the SDK directly.
- New client data access goes through the `Transport` interface, not raw `fetch`.
- New or changed behavior has a test: client tests use a mock `Transport` via
  `TransportProvider`; server tests use `FakeAgentRuntime` from
  `@dorkos/test-utils`.
- Dead code Knip can't see: unreachable branches, commented-out code, TODOs,
  half-finished migrations, and exports kept alive only by stale callers the PR
  should have removed.
- Client-facing UI diffs meet the design bar: loading/empty/error states are
  handled (not just the happy path), interactive elements are keyboard-reachable
  with visible `focus-visible` styles, and colors use theme tokens so dark mode
  works — no hardcoded hex.

## Deletions, renames, and moves (dangling-reference sweep)

Deletion and refactor PRs fail by leaving inbound references to things that no
longer exist. The diff shows what was removed; it does not show what still points
at it. For any PR that deletes or renames files, paths, exports, config keys,
hooks, commands, or scripts:

- Enumerate every removed identifier: package name, file path, directory, exported
  symbol, command, hook, env key, label. **A changed user-visible string counts
  too** — a placeholder, a label, an error message. Anything that matches on the
  old text (a Playwright locator in another directory, a fixture, a snapshot) is
  broken exactly like a renamed export, and a diff that "just" reworded a string
  is where this is easiest to miss (PR #575: a composer placeholder changed from
  "Search agents, features, commands..." to "Search rooms, agents, commands...",
  and a locator matching on the old copy broke in a directory the author never
  looked in).
- For each one, search the whole post-merge tree for that token and confirm
  zero surviving references. Check prose and config too, not just code: `*.md`,
  `*.json` manifests, `.github/`, `settings.json`, `CLAUDE.md` / `AGENTS.md`,
  `contributing/`, `docs/`.
- Search more than one token form: the package (`@scope/x`), the directory
  (`packages/x`), and the bare name (`x-thing`). A reference often survives under a
  token you did not think to search.
- This whole sweep is a search over the working tree, so the Grep and Glob tools are
  enough for it — including `.github/`, `.claude/` and the other dot-directories
  above, which Grep descends into, so one pass covers them. (A bare `rg` would not:
  ripgrep skips hidden directories unless asked. If your harness searches that way
  rather than through the Grep tool, name those directories explicitly.) In the
  `claude-code-review` workflow the Grep and Glob tools are all you have: that job
  grants no shell beyond one fixed-shape GitHub helper.
- Every surviving reference to a removed thing is a finding: 🟡 at least, 🔴 if a
  runtime, build, or CI path resolves it.

When a PR touches a Playwright locator that matches on copy, flag it: prefer a
stable `data-testid` instead. Copy changes for reasons that have nothing to do
with the test — a rewording, a translation, an A/B test — and a locator tied to
it breaks every time, often in a directory nobody thought to check (see the
PR #575 example above).

This is mechanical and cheap. Run it before concluding a deletion PR is clean.

## Conventions to check (cheap, high-signal)

- Changelog entries live in **fragments** under `changelog/unreleased/` (one file per
  change), not in `CHANGELOG.md`. A user-facing PR should add a fragment; its bullets land
  under the correct Keep a Changelog heading (a removal under `### Removed`, not `### Added`;
  behavior changes under `### Changed`). A direct edit to `CHANGELOG.md`'s `[Unreleased]`
  section — or any edit to `CHANGELOG.md` outside a `chore(release):` commit — is a flag.
- A comment or docstring that describes the old behavior after the code changed
  (for example "as it ships on disk" for a file the PR deletes) is drift.
- When a PR edits a manifest (`decisions/manifest.json` and similar), confirm the
  on-disk files agree and the diff did not re-serialize unrelated entries.

## Path-specific focus

- `apps/server/src/services/runtimes/**`: each adapter directory is its SDK's
  import-confinement boundary. Any behavioral change here must keep the shared
  conformance suite (`runtimeConformance` from `@dorkos/test-utils`) passing;
  changes to the `AgentRuntime` contract itself should extend that suite, not
  just one adapter's own tests.
- `apps/client/src/layers/**`: FSD import direction; barrel imports only.
- `**/__tests__/**`: no arbitrary timeouts; mock at the Transport boundary;
  marketplace install failures roll back file-scoped (assert target restore or removal, not a git reset).
- config schema and migrations: a semver-keyed migration is present for any config
  change.
- `*.md`, `docs/**`, `contributing/**`: in-scope for the dangling-reference sweep;
  stale internal links are findings.

## A passing test is not evidence the test works

A green suite tells you the assertions held. It does not tell you they would have
failed. Those are different claims, and the gap between them is where real
defects live — three separate times on one PR (DOR-526), a **passing test was
certifying a bug**:

- a test asserting an untriggered post starts a fresh cascade, which was the
  exact hole a fix had left open — so the suite pinned the bug in as intended
  behavior;
- `expect(notices.length).toBeGreaterThan(0)`, satisfied by a _different_
  agent's notice than the one whose loss was the bug;
- `expect(turns.length).toBeGreaterThan(2)` where the answer was knowably
  exactly 3.

None of these is visible by reading the diff. All three are visible in seconds
by changing the code.

So when a PR's correctness rests on a test — a guard, a limit, a security
boundary, a race — do not report "covered". **Revert the fix and confirm the
intended tests go red, and nothing else does.** A fix whose removal breaks
nothing is untested; a fix whose removal breaks twenty things has a test that
is measuring something else.

Two smells worth naming, both of which produce green suites over broken code:

- **A bound where a number is knowable.** `toBeGreaterThan(2)` passes for 3 and
  for 300. If the shape under test yields exactly N, assert N.
- **An assertion satisfied by the wrong subject.** "Some notice exists" is not
  "this agent's notice exists"; "a row was written" is not "this row was
  written". Name the subject.

Also check _where_ a test enters the system. A test that calls a service method
directly is downstream of every decision the route made — including, on
DOR-526, the one that was wrong. **The seam an exploit uses is often the seam no
test crosses.**

### Ask what the check counted, not what it concluded

A checker that answers "clean" having examined nothing is the most dangerous
green, because it is indistinguishable from success. Shapes that have each
produced a false green in this repo:

- **A zero-subject pass.** `it.each([])` registers zero tests and reports green;
  an axe run at a small viewport evaluated 1 node of ~343 and reported no
  violations; `vi.waitFor(() => expect(x).not.toHaveBeenCalled())` returns on its
  first poll. For any "X did not happen" assertion, also assert X was observable;
  for any scanner, assert how much it scanned.
- **A guard that enumerates from a literal list.** A guard "so a new key cannot
  be forgotten" that filters through a hardcoded key list discards the new key
  before comparing. Guards must enumerate from the source of truth
  (`schema.shape`, `readdirSync`), never from a list that must itself be
  remembered.
- **A selector that only exists in a mock.** Before asserting on a
  `data-testid`, grep where it is stamped — if the only hits are `__tests__/`,
  the test queries a mock. And when a number is derived from a selector, assert
  the selector found something first.
- **A mutation run with no green baseline.** "All mutants red" certifies nothing
  unless the harness first proves the unmutated suite green and actually
  collected tests — a bad reporter flag made every batch exit non-zero and read
  as 12 kills.

For UI diffs, two standing requirements: **run the browser suite** — three UI
branches in one night each broke `@smoke` specs that were invisible to unit
tests and typecheck (the e2e page objects are part of the change, not downstream
of it) — and treat **green browser tests as functional, not visual, evidence**:
position and clickability survive a visually broken layout, so screenshot the
designed states and eyeball them.

## Cross the seam

The single highest-yield move in this repo's reviews, measured over one day of
them: **stop reading the diff and drive the real thing.**

On DOR-579 the diff read clean, every test was green, and the migration was
correct — when it ran. Booting a real `ConfigManager` over a real prior-shape
`config.json` showed it **destroying the entire config file**, silently reverting
a telemetry opt-out to opt-in. On DOR-571 the picker's logic read fine; driving
it with a typo and pressing Enter opened the wrong conversation. On DOR-583 the
JSX looked correct; Chromium's accessibility tree announced the channel name
twice.

None of those was visible by reading, and none needed cleverness — only
executing the thing at the boundary a user actually reaches it from.

Concretely, prefer in this order:

1. **Drive the real component or class** over asserting on a mock. A mock store
   cannot fail the way `conf` + Ajv fails; `UserConfigSchema.parse` cannot
   substitute for it, because **Zod strips unknown keys where Ajv rejects them**.
2. **Read the browser's accessibility tree**, not the JSX, for any naming or
   labelling claim. jsdom loads no CSS and never blockifies flex children, so
   accessible names differ between it and a real browser.
3. **Reproduce the user's sequence**, not the unit's contract — switch rooms
   mid-flight, type a typo, remove the item you had highlighted.

And when a claim rests on a stored field being populated, **query the data**.
DOR-570 shipped an avatar unification on the premise that `AuthorRef` carries the
agent's emoji. The wiring was correct end to end and the feature was inert:
4 of 24 agents had one stored. An author, an adversarial reviewer, and the
orchestrator all confirmed the premise from the schema. A screenshot found it in
seconds.

**Calibration, worth knowing when weighing your own verdict:** on both PRs above,
this repo's automated review returned "0 important, 0 nits". Nothing in those
verdicts was wrong on its face. They just never crossed the seam.

## When the code under review is a recovery path, ask whether it can fail

For most code the review question is "does this do the right thing." For code
that runs **because something already went wrong** — a catch block, a fallback, a
repair, a retry, a migration's error branch — that question is secondary. The
first one is: **can this itself fail, and what happens if it does?**

On DOR-584 a fix for a config-destruction bug introduced a **boot**-destruction
bug, and it did it _inside the catch block that was the last-resort "always
boots" guarantee_. The salvage carried a stored value forward after checking its
JavaScript type; the value was type-correct but violated its own schema's
minimum, so `conf` re-validated it through Ajv on write and threw. Nothing up the
stack handled it, and the server did not start — on inputs that the unfixed code
recovered from cleanly. The file was left half-restored, because the write
iterated sections and had already committed two before the third threw.

The PR's own comment said the function "never throws — a throw here would take
down the boot it is trying to rescue." It was the right thing to worry about and
it was not true, and no test caught it because the suite was green at 2813
passing.

Two transferable checks:

- **`typeof` is not validation.** A type check sees `number`; it does not see
  `min`, `format`, `enum`, or any other constraint the schema enforces on write.
  Any value that will be re-validated downstream must be validated against its
  **own** schema first, not merely type-narrowed.
- **A multi-step repair needs to be all-or-nothing, or explicitly resumable.** A
  loop of writes that can throw partway leaves state no code path anticipated —
  worse than the corruption it was repairing, because it looks recovered.

So for any diff touching a recovery path: find every write it performs, ask what
validates that write, and construct the input where validation says no. Then run
it. Compare against the pre-change behavior on the same input — if the old code
survived what the new code dies on, that is a 🔴 regression regardless of how
well the new code handles the case it was written for.

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
