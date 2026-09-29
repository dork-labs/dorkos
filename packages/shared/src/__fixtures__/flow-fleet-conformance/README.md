# Fleet conformance fixture

This folder is the shared contract between the flow plugin and DorkOS for three
things both of them read and write on one machine:

- **Accounts.** Who the accounts of each runtime (Claude Code, Codex, OpenCode)
  are (DorkOS's `config.json`, plus each runtime's `default`: the folder it runs
  in when nothing chooses one) and how flow may spend them (flow's `fleet.json`, keyed
  `<runtime>:<account-id>`).
- **The usage ledger.** One file per account at
  `<dorkHome>/runtimes/<runtime>/usage/<account-id>.json` with the latest reading
  of each rate-limit window, and the plan, credits and spend when the runtime
  reports them.
- **The session and item link.** The `FlowRun` records in `flow-state.json`.

The rules are written in `specs/flow-cli-core/02-specification.md` section 1
(rev 6, with rev 6d) of the `dork-labs/marketplace` repo. The case files here pin those rules as data, so
two independent implementations can prove they agree. flow runs them in
`plugins/flow/engine-tests/fleet-conformance.test.ts`.

## Version

`CONTRACT_VERSION` holds the contract version (semver). Any change to a rule or a
case is a contract change: bump the version and change both sides. A new case
that only pins an existing rule more tightly is a patch; a new field or window
key rule is a minor; a changed or removed rule is a major.

2.0.0 (rev 6) is a major: every contract names the runtime. The ledger moved to
`runtimes/<runtime>/usage/` with a required `runtime`, `fleet.json` keys became
`<runtime>:<account-id>` (bare keys still read as Claude Code), and
`resolveFleetPolicy`, `readIdentities` and `mergeLedger` take the runtime.

3.0.0 (rev 6d) is a major: it changes what `default` means. An account is its
folder, not its id. `claude-code:default` and `codex:default` always exist and
name the runtime's default folder, machine-wide: DorkOS's `defaultAccount`, else
`~/.claude`; `~/.codex`. A process's own `CLAUDE_CONFIG_DIR` or `CODEX_HOME`
never changes it. When a registered row has that folder, `default` is
another name for that row (one ledger file, one policy). When none does,
`default` is its own account, and beside registered accounts it defaults to
`main`. `readAccounts` takes the home folder and real paths as inputs, so a
runner needs no filesystem; the cases' `env` exists only to prove it is ignored.

4.0.0 (rev 6e) is a major: it changes the merge rule for a tie on `observedAt`
(before, the stored reading always stayed). Now the more severe reading wins:
`rejected` over `allowed_warning` over `allowed` over no status, then the higher
`usedPct`, then the later `resetsAt`, then the greater `source`, then the longer
`windowMinutes`, all on normalized values. A reading equal on all of these
keeps the stored one. Before it, a second reading from the same millisecond was
dropped, even a `rejected` one.

4.0.1 (rev 6f) is a patch: it pins what a reader does with a `usedPct`
outside 0-100, which the rules left unwritten. Writers clamp, and so does a
reader: 130 reads as 100 and -5 as 0 (`window-read` cases). A reader never
treats such an entry as invalid, and never drops the file over it.

4.1.0 (spec `flow-multiproject` §6, in this repo) is a minor: two new optional
`FlowRun` fields. `dispatchedBy` is the session id of the chat that launched a
run, when another chat did (a `flow drain`, or `flow claim --dispatched-by`), so
DorkOS can show the run in that chat too. `updatedAt` is when the record was last
written; every writer stamps it on the record it writes, and only there. Both
are plain strings; a record from before 4.1.0 has neither and still reads. A
`flow-run` write case gives the writer's clock as `input.now`: the written
record reads back with `updatedAt` equal to it. flow's runner checks this on
both the pure upsert and the real run store.

4.2.0 (spec `flow-multiproject` §8 in `dork-labs/dorkos`) is a minor: account
eligibility. A Claude Code account may be kept to projects (`onlyProjects` on its
row, `defaultAccountOnlyProjects` for Main) and a project may limit which accounts
it uses (`projectAccounts`). An account works in a project only when both allow
it, and an account kept to projects never works in a folder that is in no
project. A project is a git main checkout; roots compare canonically. The rules
are new optional fields, so a config from before 4.2.0 has none and every
account works everywhere, as before (`project-eligibility` cases).

## What is here

| File | What it pins | The call it drives |
| --- | --- | --- |
| `account-id.cases.json` | Minting an account id from a label and a path | `mint(label, path, taken) -> id` |
| `identity.cases.json` | Reading one runtime's rows (`runtimes.<claudeCode, codex or opencode>.accounts`) from `config.json` | `readIdentities(config, runtime) -> { accounts, warnings }` |
| `accounts.cases.json` | Every runtime's accounts, and which one `default` names: its own account, or an alias of the row in the default folder | `readAccounts(config, { home, realpath }) -> { accounts, warnings }` (never `input.env`) |
| `fleet-policy.cases.json` | Resolving `fleet.json` with defaults (key migration, the default account's role and aliases, runtime settings), plus which repos an account may serve | `resolveFleetPolicy(accounts, fleet)`, `parseOriginRepo(origin)`, `mayServe(policy, repo)` |
| `window-read.cases.json` | What one ledger window means at a given moment | `readWindow(entry, now, key) -> reading or null` |
| `room.cases.json` | The reserve in force and whether an account has room | `effectiveReservePct`, `fiveHourRoom`, `weeklyRoom`, `modelRoom` |
| `eligibility.cases.json` | Room for any kind of account: subscription windows, metered spend, local models | `accountRoom(runtime, policy, ledger, now)`, `spendRoom(spend)` |
| `ledger-merge.cases.json` | Folding new readings (windows, plan, credits, spend) into a ledger | `mergeLedger(existing, observations, now, { runtime, accountId })` |
| `codex-rate-limits.cases.json` | Codex's `rate_limits` payload as ledger observations | `codexObservations(rateLimits, observedAt, source)` |
| `prune.cases.json` | Which ledger files go when their account is no longer registered | `pruneTargets(registered, onDisk)` |
| `project-eligibility.cases.json` | Which Claude Code accounts may work in which projects (4.2.0) | `eligibility(config, account, projectRoot) -> { eligible, reason? }` |
| `flow-run.cases.json` | Reading `flow-state.json`, and keeping unknown fields when one run is written | the all-or-nothing reader, and an upsert by `issueId` |
| `usage-ledger.schema.json` | The ledger file shape a WRITER may store (JSON Schema draft-07). Readers accept more: a `usedPct` outside 0-100 reads clamped (spec 1.2 "One entry"), and one entry a reader does not understand never makes it drop the file | |
| `fleet-policy.schema.json` | The `fleet.json` shape a WRITER may store (JSON Schema draft-07). Readers accept more: no `v` reads as 1, and a bare key from before 2.0.0 reads as `claude-code:<key>` (see the `fleet-policy` cases and spec 1.1b) | |
| `*.examples.json` | Values each schema must accept (`valid`) and reject (`invalid`) | |

Each case file has an `about` field that states the rule and the exact meaning of
every input and expected field. Read it before writing a runner.

## Case format

Every case is `{ "name": string, "input": object, "expected": object }`.

- `now` is always an input when time matters. Never use the wall clock.
- Times are ISO-8601 with an explicit zone. Expected times are UTC with
  milliseconds and `Z`.
- `expected.warnings` is a list of warning codes. Compare it as a multiset (sort
  both sides): the codes are the contract, their order and message text are not.
- Compare every other expected value for deep equality.

## Running the cases from DorkOS

1. Vendor this folder at a pinned commit of `dork-labs/marketplace` (the DorkOS
   spec `claude-account-fleet` picks the mechanism). Record the commit and the
   `CONTRACT_VERSION` next to the copy.
2. Write one runner per case file that feeds `input` to the DorkOS
   implementation and compares against `expected` as described above. The
   `about` field of each file and flow's own runner
   (`fleet-conformance.test.ts`) show the mapping.
3. Fail when a case file is present that has no runner, so a new file in a later
   version cannot pass by being skipped.
4. Validate each `*.examples.json` value against its schema: every `valid` value
   passes and every `invalid` value fails.

## What the fixture does not cover

The cases pin the pure rules. The file mechanics (paths, modes, the
lock-and-rename steps in spec section 1.2 "Writing") are described in the spec
and proven by each side's own tests, because they need real files and real
processes.
