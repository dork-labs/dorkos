# AGENTS.md

This file holds what you can't learn by reading the repo: intent, vocabulary, costly or dangerous operations, and the reasons behind enforced rules. For layout, packages, routes and APIs, read the code and `contributing/` (`contributing/INDEX.md` maps topics to guides).

## Vision

**DorkOS is a workspace for people and agents, built for founders.** The internal north star: millions of solopreneurs and founders use DorkOS every day to earn billions of dollars and compete with companies far bigger than them. Mission: the single interface a founder uses to run their whole business.

The message stack, top to bottom:

1. **You, Multiplied.**
2. **Build and run your business with an agent team.**
3. **Your agents join your team chat, take on real work, and build the custom tools your company runs on.**

Before you decide or write anything about what DorkOS is, read the north-star set in `meta/`. It wins over anything else in the repo:

- [VISION.md](meta/VISION.md): what and why, who it is for, what sets us apart
- [PRINCIPLES.md](meta/PRINCIPLES.md): how we decide (trusted by default, proactive co-workers, ownership, ready in under a minute, local first, claim only what works)
- [VOICE.md](meta/VOICE.md): the words we use and avoid
- [ROADMAP.md](meta/ROADMAP.md): what is built, then one ordered list of what is next (no dates), and the **demo-claim gate**. Public copy, docs and release notes may claim only what that gate lists as built.
- [PROACTIVE-AGENTS.md](meta/PROACTIVE-AGENTS.md): how our agents take initiative. Read it before designing anything an agent does on its own.
- The full story is [meta/dorkos-litepaper.md](meta/dorkos-litepaper.md). Personas are in `meta/personas/` (the founder first, Kai the developer second).

**Trust model.** Agents are trusted co-workers: full power, with an audit trail anyone can read. They run at the level their owner set, whatever the message's origin. Code from strangers that DorkOS didn't install (hooks, plugins and packages found in a folder) still needs a yes. Owner-only front-door settings (login, remote access, credentials, package sources) stay gated.

**Retired words in user-facing prose** (site, docs, READMEs, UI copy, errors, release notes): "mission control" and "cockpit". Say "the DorkOS app", "the app" or "one window". GitHub's product named "Mission Control" and the compiled changelog are the exceptions. `scripts/check-banned-words.sh` enforces it, line by line. <!-- vocab-allow: states the prohibition, so it has to name both retired words -->

**"Integration", "connector", "adapter" and "provider" are not user-facing nouns** (ADR `260804-021140`). The umbrella is **Connections**: a Telegram or Slack hookup is a _connection_, and a service an agent acts on is a _service_. Code keeps its own names (`RelayAdapter`, `ConnectorProvider` and so on). `scripts/check-vocab-gate.ts` enforces it; add a scoped, reasoned entry to `scripts/vocab-gate/allowlist.json` to keep a word in one file.

"Workspaces" is also the product noun for project checkouts (`/workspaces`), so write the category in full: "a workspace for people and agents".

## Quality Standard

World-class UI/UX **and** world-class DX. Every surface works on phone, tablet and desktop. APIs are clean, types precise, errors helpful.

- **Follow existing patterns.** Consistency is a feature; diverging needs a reason.
- **Finish things.** No lingering TODOs, half-done migrations, dead code or tolerated legacy. When something is superseded, remove it. If something weird must stay, comment _why_.
- **Upgrades:** DorkOS supports upgrades from the 20 minor versions before the current `VERSION`. Every JSDoc `@deprecated` tag starts with `since 0.x, remove in 0.y`; lint enforces the schedule.
- **Decision filters:** describe what happens for the user, not how the system works. Every element justifies its existence. No dark patterns, no hype. The product feels like a control panel, not a consumer app.
- **Writing:** user-facing prose follows the `writing-for-humans` skill (plain enough for a smart 9th grader who doesn't code). Copy the app renders adds `writing-app-copy` (dry, calm, no "we", at most 15 words per block; `pnpm check:copy-length`).
- **Agent behavior** in a room, DM or shared channel follows [meta/agent-etiquette.md](meta/agent-etiquette.md): useful and mostly quiet. Over-participation is what users complain about.
- **User care:** anyone who reports a bug or asks for something gets a real reply within one business day, a decision, and a note when it ships ([meta/user-care.md](meta/user-care.md), `writing-to-users` skill).

## DorkOS Cloud

DorkOS Cloud is the hosted, paid layer. Its control plane is closed-source and lives in another repo. Everything the app needs to talk to it is public here, in `packages/cloud-api`, and the app builds, tests and runs without the other side. Propose contract changes in an issue labelled `cloud-contract`. Prices, plan names, margins and supplier terms stay out of this repo; the pricing page announces them first.

## Commands

```bash
pnpm dev               # API server + Vite dev server (loads .env)
pnpm dev:dogfood       # Dev preview (:6241) + the built CLI app (:4242), the default workflow
pnpm verify            # Affected-only typecheck + lint + test, the full gate
pnpm verify:preopen    # Optional lighter check, for debugging (no package tests)
pnpm vitest run <path> # One test file (~1-2s); works for every package
pnpm test -- --run     # Full suite via turbo
pnpm --filter @dorkos/server typecheck   # One package (~4s vs ~28s full)
```

Use `pnpm test -- --run` for full runs, not bare `pnpm vitest run`: bare vitest skips the per-package env turbo sets up and has falsely failed tests. A project filter is the directory name (`--project client`, not `--project @dorkos/client`). "No test files found" means your path is wrong.

**Some paths spend real money.** Each needs its own opt-in flag beside its own key; a key alone arms nothing. None of those names may reach a task that `pnpm test`, `pnpm verify`, pre-push or CI runs (`packages/evals/src/runner/__tests__/paid-provider.test.ts` guards it). A fake key is not safe either: the test server falls back to your `claude` sign-in and bills that. The list, and how evals pick a credential: [contributing/paid-paths.md](contributing/paid-paths.md).

**Gotchas:**

- Outside a running `pnpm dev`, rebuild `@dorkos/shared` by hand if imports look stale (`pnpm --filter @dorkos/shared build`). Stale dists cause false type errors.
- A typecheck error starting with `TS6053` on a `@dorkos/typescript-config` extends means `node_modules` is stale: run `pnpm install`.
- Ports: dev uses 6xxx (from `.env`), production defaults to 4xxx, tests pin 4242/4241.

## Architecture

The map is `contributing/architecture.md` and `contributing/system-architecture.md`. What the code won't tell you:

- **Swappable seams:** `AgentRuntime` (agent backends: claude-code, codex, opencode, doe), `Transport` (client to backend), `ConnectorProvider`, and `CommunityAdapter` (rooms in more than one place). Every runtime passes `runtimeConformance` and every community backend passes `communityConformance`. Adding a runtime: `contributing/adding-a-runtime.md`.
- **The server is Hono.** Express runs only behind the extension bridge, and an ESLint rule bans it elsewhere (ADR `261009-192542`).
- **One space model** (ADR `261122-173853`). There are two kinds of state. Space data (members, agents, conversations, rules, memory, schedules, connections, settings, documents, mini apps) belongs to a space. Execution state (workspaces and worktrees, the runtimes' own transcripts and sign-ins, running processes) stays on the computer that runs turns. Nothing is Mac-only by design. A shared host never holds a member's credentials or a key to a member's computer. Today `services/rooms` is this computer's store and `services/spaces` (Postgres) is the space store; a new feature built only on `services/rooms` needs a ticket naming its move. The import wall between them (`apps/server/eslint-rules/space-boundary.js`) stays.
- **Telegram and Slack rooms are projections into local rooms**, not community backends (ADR `260814-024525`).
- **Sessions are runtime-owned** (ADR-0310). There is no unified DorkOS transcript store. Turns are delivered over the per-session SSE stream; `POST /api/sessions/:id/messages` only triggers.
- **Agents:** `.dork/agent.json` on disk is the source of truth, and SQLite is a derived cache (ADR-0043). DorkBot is the system agent; system agents can't be renamed, deleted or unregistered.
- **Data directory:** `lib/dork-home.ts` is the only source for it (`~/.dork/` in production, `apps/server/.temp/.dork/` in dev).
- **Config** lives in `~/.dork/config.json` via `conf`, with a Zod schema. A schema change needs a semver-keyed migration (`adding-config-fields` skill).
- **The external MCP server at `/mcp` is fail-closed** (`apps/server/src/middleware/mcp-auth.ts`). `MCP_API_KEY` is an optional override, not the thing that turns auth on.
- **Marketplace installs** use a file-scoped transaction: stage, back up, rename, restore on failure (ADR-0304).
- **Client:** Feature-Sliced Design, `shared ← entities ← features ← widgets`. Import from a layer's barrel `index.ts`. Zustand for UI state, TanStack Query for server state.

## Where the system is going

Decided. Target shape: `contributing/architecture-target.md`. Order: `meta/ROADMAP.md`.

- **Two sides, one contract** (ADR `261124-150516`). One program, one release. The space side holds space data; the computer side runs turns. One contract joins them: start, stream and stop a turn, answer an ask, call a DorkOS tool, sync an agent, report status. A Mac runs both; an agent computer runs only the computer side.
- **Turns survive restarts** (ADR `261124-150517`): a run record, follow-up work saved with the turn, capped recovery.
- **Every agent can be messaged directly** (ADR `261124-150518`): one send-to-agent capability for the API, CLI, MCP and A2A.
- **Playbooks** (ADR `261124-152801`): how agents work together is a setting of a space. DorkOS holds its rules at its own gate and the turn port, never in one runtime's hooks.

Rules today:

1. A feature goes in the server core only if the core acts on it, only the core can see it, or a mini app can't do it right. Otherwise: a mini app, or a schedule with a skill (ADR `261124-150519`).
2. No new service or process unless its lifetime or trust level differs.
3. Never plan, rank or write work by a date or a launch (ADR `261124-150515`).

## The `/flow` Workflow

`/flow` is the workflow engine. It lives in the marketplace repo (`dork-labs/marketplace`, `plugins/flow/`) and works here only once installed from the DorkOS Marketplace at project scope; there is no in-repo copy. All tracker I/O goes through its `linear-adapter` skill. The Linear team key is `DOR`. Reach Linear with Linear MCP or `composio execute LINEAR_* --account personal`, not the `artblocks` work account. Reference: `contributing/flow-engine.md`.

**Filing an issue means triaging it** ([contributing/prioritization.md](contributing/prioritization.md)): a MoSCoW priority, a size, a project, proof, a "done when" and a duplicate check. Group small follow-ups from one PR in one parent issue.

If compaction fires mid-`/flow`, keep verbatim: the work item id and title, stage and sub-step, gate state, spec dir, worktree path and branch, `flow-state.json`, open PR, and your assumptions.

## Worktrees

**One checkout, one writer.** Several agents work in this repo at once, and two writers in one checkout corrupt each other's work. Make code changes in your own worktree (`working-in-worktrees` skill, `/worktree:create`). Stay in `main` only when you are surely the only writer and the change is non-code (research, specs, tracker). Don't create a worktree from inside one, and don't remove one with uncommitted or unpushed work.

**Pin the base once.** Worktrees share `origin/*` and the object store, so another session's `git fetch` can move `origin/main` between two of your commands. Run `git rev-parse origin/main` once and compare against that SHA, pasted literally (Claude Code can't check a `$VAR` before it runs and will ask a person).

## Pull Requests

Everything lands through a PR and the merge queue; repository rules reject direct pushes to `main`. Open PRs with `scripts/open-pr.sh` from a worktree branch based on `origin/main`. It adds `skip-changelog` and the review label from the diff. Review labels and flow: `creating-pull-requests` skill; the reviewer rubric is `REVIEW.md`.

- One topic, one PR. If an open PR must land first, stack on it with `gh stack` and merge the stack with `gh stack merge` from its top.
- UI PRs: CI runs the affected browser smoke. Run a spec locally only to debug one, through `pnpm heavy`.
- **A wait names an owner and a time** ("@x answers by 15:00"), never "someone should" (E31 in `meta/agent-etiquette.md`). Security's sign-off counts only for the head it names (`pr-gates` checks this); any push needs a new one. QA and design review what merged, once a day.

## Hard Rules

All enforced, so a break fails a check. Rules 1-5 ride `lint`, 6-7 are hooks, 9 rides `typecheck`.

1. **FSD layer violations are errors** (`no-restricted-imports`).
2. **Each runtime SDK stays in its adapter dir** under `services/runtimes/`.
3. **`os.homedir()` is banned in `apps/server/src`**; use `lib/dork-home.ts`. The few carve-outs mirror another program's own directory and are listed in `.claude/rules/dork-home.md`.
4. **Exports carry TSDoc** with a real description (`eslint-plugin-jsdoc`, all `error`).
5. **Prettier and Tailwind class sorting run at turn end and pre-commit**, not after each edit, so your in-context copy stays valid. Don't hand-format. Pre-push checks formatting and names the files to fix.
6. **`git stash` and `git checkout -- <path>` are refused.** The stash is shared by every worktree, and the pathspec checkout silently drops uncommitted work. Park files in your scratchpad and restore with `cp`.
7. **`pkill`, `killall` and group kills are refused.** Other agents and the operator's dev servers run the same code here. Stop only a process you started, by its PID or `lsof -ti :<port>`. The guards match command text, so a line that only mentions one is refused too.
8. Path-specific rules in `.claude/rules/` load when you edit matching files.
9. **No file over 500 lines may grow** (`scripts/check-max-lines.ts`). Split it instead. After shrinking one, run `pnpm check:max-lines -- --update`; CI refuses a raised baseline. The HTTP API has the same kind of ratchet: `pnpm check:api-lint` (DOR-4996, rules in `contributing/api-reference.md`).

## Testing

Vitest, with tests in `__tests__/` beside the source. Patterns: `.claude/rules/testing.md`. Mock only at the edges (network, clock, filesystem, a model, a runtime SDK). The count of `vi.mock` calls on our own modules is a ratchet that may only fall (`pnpm check:own-mocks`). Fewer, better tests: write the fewest that would catch real failures and delete those that fail the keep-questions in `.claude/rules/testing.md`; coverage is an aim of about 60% (never a gate), and each package's test budget only tightens (`pnpm check:test-ratio`).

## CI

The full guide is [contributing/ci.md](contributing/ci.md). What you must know:

- **Change the pipeline as an experiment.** Every pipeline change carries a ledger entry in `ci/ledger/` with a hypothesis (`stewarding-ci-pipeline` skill).
- **`main` merges through a merge queue, with no human approval.** Don't update a branch to satisfy a gate; being behind blocks nothing.
- **Required checks** come from `ci/required-checks.json`. Each must report on both `pull_request` and `merge_group`, with no path filter that can skip it.
- **Done means open the PR; CI judges.** Locally only the git hooks run; `pnpm verify:preopen`/`pnpm verify` are optional, for debugging.
- **Open PRs only with `scripts/open-pr.sh`.** It turns on auto-merge, so a PR merges once every required check is green, including `pr-gates` (Security's sign-off: the cloud review's Security lens or Security's label). Never merge directly or with admin rights (`.claude/hooks/merge-guard.mjs` refuses that). Use the `hold` label, with a `hold:` comment, to keep a green PR from merging.
- **Only Security's `label-pr.sh` adds or removes `security-*` labels.** Ask Security if you think a PR needs one.
- **A red is not a reason to add load.** After a first queue ejection, read the failing job; once it's plainly not yours, re-queue it once with `gh pr merge --auto <n>`. The same check failing again at the same head is real: read the log and push a fix. Don't push empty commits.
- **Heavy local runs** (full verify, full suites, builds, installs, Playwright, Docker) wait in the load gate: `pnpm heavy <command>` or `bash scripts/heavy-run-lock.sh`. Exit 75 means try again later. Start nothing heavy while free disk is under the floor in `contributing/ci.md`.
- **Don't print full process command lines** (`ps -ww`, `ps aux`, `pgrep -a`); they can show tokens.
- **A throwaway test server gets a throwaway home:** a temp `DORK_HOME`, `DORKOS_TEST_RUNTIME=true`, and `HOME` and `CLAUDE_CONFIG_DIR` pointed inside the temp folder.
- **Test data uses made-up names only**, not a real person, account or email.
- **A release goes first.** The `release-window` check holds other merges until the new version is on npm; you add no `hold`. Heavy runs the release doesn't name wait too.

## Signing outward writes

Anything you post to a tracker or forge (a Linear comment or description, a GitHub PR body or comment) ends with one hidden line, so a later session can route a follow-up back to yours:

`<!-- agent:provenance {"v":1,"harness":"claude-code","sessionId":"…","account":"…","host":"…","surface":"…"} -->`

Emit only fields you actually know, as valid JSON. In a public repo, truncate `sessionId` to 8 characters. `account` is a short handle (for Claude Code, the `CLAUDE_CONFIG_DIR` basename, default `claude`), never an email. Full spec: `docs/provenance.md` in `dork-labs/marketplace`. Commits keep their `Claude-Session:` trailer.

## Artifacts

- **Research:** `research/YYYYMMDD_topic-slug.md`. Check `research/` before doing new research ([research/README.md](research/README.md)).
- **Ids:** new ADRs and specs use timestamp ids from `.claude/scripts/id.ts` (ADR-0312).
- **ADRs:** `decisions/<id>-<slug>.md` plus `manifest.json`; `/adr:*` commands.
- **Specs:** `specs/<slug>/` with `manifest.json` ([specs/README.md](specs/README.md)). **Plans:** `plans/`.
- **Audits:** one charter per domain in `audits/<domain>.md` (`audits/README.md`).
- **Changelog:** fragments in `changelog/unreleased/`, compiled at release. Don't edit `CHANGELOG.md` by hand (`changelog/README.md`).
