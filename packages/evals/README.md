# @dorkos/evals

The eval harness. It prompts a real DorkOS agent session and then checks what
actually happened: a file on disk, a row in the database, a tool call on the
event stream. It never grades the agent's prose.

## Run them on your machine

In a fresh checkout or a new worktree, build the workspace packages first:

```bash
pnpm install
pnpm --filter "./packages/*" build
```

The harness loads its sibling packages from their built output, and `dist/` is
not committed. Skip this and the run dies on `ERR_MODULE_NOT_FOUND` before it
does anything, once for `@dorkos/shared` and then again for
`@dorkos/marketplace`. It costs nothing but a minute of confusion, and it is the
first thing a new person meets.

Then:

```bash
pnpm evals:local
```

That is the whole setup, as long as you are signed in to Claude. If `claude
auth status` says you are signed in, the harness can reach a model, and the runs
spend against your own Claude subscription.

The command runs the `core` suite against a real model, in a child process, with
a $2 ceiling for the whole run. Add flags to narrow it down, and the later flag
wins:

```bash
# one case, a smaller ceiling
pnpm evals:local --suite activity-read --budget 0.50

# the free structural suite: no model, no spend, seconds
pnpm evals -- --suite core --tier test-mode

# the channel suite's free half: four mechanism cases, no model, seconds
pnpm evals -- --suite rooms --tier test-mode

# clean up sandboxes and containers an interrupted run left behind
pnpm evals:sweep
```

If you are not signed in, the run stops before it boots anything and tells you
the three ways to fix it. It never quietly passes.

## The suites, and which of them spend

`--suite <name>` takes a suite name or a single case id. The name decides the
bill, so it is worth knowing which is which:

| Suite          | What is in it                                                   | Spends?                             |
| -------------- | --------------------------------------------------------------- | ----------------------------------- |
| `core`         | the product suite: governance, operate, agents, the widget case | yes, on `pnpm evals:local`          |
| `smoke`        | the cheap label-gated subset (the harness self-test today)      | only if you run it credentialed     |
| `rooms`        | channels: four free mechanism cases + eight quarantined probes  | only the probes, and only on a tier |
| `connector`    | connector routing, quarantined                                  | yes, credentialed                   |
| `experimental` | cases kept out of `core` by a known harness gap                 | yes, credentialed                   |
| `all`          | everything registered                                           | yes                                 |

### The `rooms` suite (channels)

It is the only suite split across two tiers on purpose, because half of what a
channel does can be measured with no model at all.

- **`--suite rooms --tier test-mode` is free and it GATES.** Four mechanism
  cases: a mentioned agent always runs a turn; a message that addresses nobody
  runs none and spends none; three messages inside the gathering window become
  one turn charged once; Stop interrupts a running turn and the room says so
  exactly once. They read the room's own event stream and the `room_turn_spend`
  rows, so none of them can be satisfied by an agent that merely said something
  plausible. The suite's other eight cases appear in that run as
  `skipped-wrong-tier` — see below.
- **The eight credentialed cases are quarantined**: the context-recall probes
  X-01 to X-06 from `meta/chat-capabilities.md` §7, plus restraint (an engaged
  agent staying out of a conversation that is not about it) and the adversarial
  injection case A-15. X-07 (bridged rooms) and X-08 (after compaction) are NOT
  implemented, and `src/suite/rooms.ts` says why rather than shipping a case that
  asserts nothing.

**A declared tier is enforced, not described.** A case whose `runtimeTier` is
credentialed is SKIPPED on a `test-mode` run (`skipped-wrong-tier`) instead of
being run against the deterministic runtime. It is not a tidiness rule: the
injection case reported `pass` on test-mode, because a scripted echo obeys no
injected instruction — a green about a security property nothing had
exercised.

**Merely declaring `test-mode` does NOT skip a case on a credentialed run
(DOR-1228).** `widget-round-trip` is runtime-agnostic by construction — its
`/ui-action` trigger needs no model — and is meant to run, and gate, on a
credentialed tier too; skipping it there would remove coverage rather than a
lie, and that coverage is what catches DOR-1239, a real `409 SESSION_LOCKED`
race between a widget action and its own seed turn's lock release. Only a case
marked `testModeOnly: true` skips downward: one that leans on a mechanism
`test-mode` alone offers, with no real-runtime equivalent at all.
`rooms-halt-stops-and-says-so` is the one case that needs it — it needs a turn
that holds still for Stop, which only the `test-mode` scenario control
provides deterministically. Before the flag existed, `--suite rooms --tier
claude-code-cheap` ran it anyway, into its own "test-mode only" throw,
reported as `error` and gating the run for a verdict it could never produce
there; now it reports an honest skip instead. A skipped case neither gates nor
counts as quarantined coverage, so the GATING line still says what a run
actually proved.

**A rooms case reports `unmetered`, and it is not lying about that.** The only
cost signal the harness can see rides the per-SESSION stream, and a room drive
collects the ROOM's stream — the room binds its session internally and never
names it. So `--budget` cannot see a room turn and `perEvalCeilingUsd` cannot
abort one. What bounds a rooms case is its DRIVE CEILING: one budget from the
subscribe to the last settle, five minutes for the credentialed cases (they run
at most two model turns each), one minute for the structural ones. That is the
honest wall-clock bound; the dollar ceiling each case declares is a statement of
intent.

Writing one: `runner/room-drive.ts` posts as a person and collects the room
stream; `oracles/rooms.ts` answers "was a turn triggered for agent X"; a case
carries a `roomScript` instead of a prompt. Seed agents by writing their
manifests into `<DORK_HOME>/agents/<slug>/` (`suite/rooms-setup.ts`) — the same
seeding works on both tiers, because both servers adopt an agents home at boot.

## Reading the output

Two lines at the bottom of the table matter more than the rows above them:

- **GATING** says how many of the cases a run STARTED could actually fail it.
  Most cases are quarantined, which means they run and report but never fail
  anything; cases that cannot run on the tier the run booted — a credentialed
  case on a `test-mode` run, or a `testModeOnly` case on a credentialed run —
  are not started at all (`skipped-wrong-tier`) and count as neither. The
  footer names the count and direction: "N needing a credentialed tier" on a
  `test-mode` run, "N needing test-mode" on a credentialed one. A green run
  that gated on zero cases proves nothing, so
  the harness treats that as a failure rather than a pass.
- **CREDENTIAL** says which of the three credentials the run used, so nobody has
  to guess.

### What the cost column means, and when it is lying

A case that finished a turn reports what that turn cost. On a Claude
subscription that number is an estimate of what the same tokens would have cost
through the API, not money billed to you, because a subscription is spent as
quota. It is still the only spend figure `--budget` has to work with.

A case that reports **`unmetered`** spent something nobody measured. The only
cost signal the harness can see rides the frame a turn sends when it ends, so a
turn killed by the 90-second guard reports nothing at all. Ten measured runs
made the problem concrete: the two runs that timed out each burned about 92
seconds and 29 tool calls, and both were recorded as `$0.0000`. They were the
two most expensive runs of the ten and they printed as the cheapest. The budget
cap could not see them either, which is backwards, since a runaway loop is the
exact thing a spend ceiling exists to catch.

So the harness now says unknown instead of zero:

- an `unmetered` row means "real turn, no measurement", never "free";
- a **SPEND** line appears when a run mixes measured and unmetered cases, saying
  the printed total is a floor rather than a total;
- a whole run at `$0.0000` gets a WARNING whichever credential it used, and it
  says which of the two reasons applies: every turn died before reporting, or
  turns finished and the cost signal is broken.

There is no way to estimate what an unmetered turn spent. Per-message output
tokens do reach the stream, but input and cache tokens are the bulk of the bill
on a tool-heavy turn and neither of those arrives before the turn ends. An
output-only floor would be low by roughly an order of magnitude, and a confident
wrong number is worse than a blank.

## Debugging a failure: what a red case leaves behind

Every non-`pass` outcome — `fail`, `error`, `skipped-over-budget` — retains its
sandbox `DORK_HOME` on disk instead of deleting it, **whether or not the case is
quarantined.** A quarantined case fails by design on some tiers, but a
quarantined red on a tier it is meant to run on is exactly the failure someone
needs to read next; deleting its sandbox took the evidence with it, which is how
the DOR-1229 hang first went unexplained. A `pass` — quarantined or gating — is
still torn down; there is nothing to debug about a run that worked.

A row's console output and its `results.json` entry both carry two paths when
retention applies:

- **`retainedSandbox`** — the sandbox's `DORK_HOME`, printed under the row as
  `↳ retained: <path>`. This is the raw sandbox: agent manifests, the SQLite db,
  and (on the credentialed tiers) the real server's `logs/dorkos.log`. It is
  what `pnpm evals:sweep` removes later, so treat it as temporary — read it
  before you clean up, not after.
- **`retainedLogsPath`** — when the sandbox had a `logs/` directory to copy, its
  copy lands at `<run dir>/<case id>/logs/`, beside `results.json`. This copy is
  the durable one: a later `pnpm evals:sweep` does not touch the run directory,
  so it is what survives after the sandbox itself is gone. `test-mode` boots
  in-process and never calls `initLogger`, so its cases have no server log to
  copy — `retainedLogsPath` is omitted there, and `retainedSandbox` is the only
  read left.

`pnpm evals:sweep` is still the cleanup path for every retained sandbox,
regardless of why it was retained — it keys on the `dorkos-evals-` tmpdir
prefix every sandbox stamps, not on quarantine or pass/fail.

## Answering an approval mid-run

A credentialed case that asks the agent to _do_ something gets stopped twice, by
two unrelated mechanisms, and until DOR-498 nothing answered either one:

1. the **runtime's tool permission** — the prompt a person answers in the chat
   pane, with a ten-minute window;
2. the **capability tier gate** — a destructive action refusing to run until
   somebody approves it, with a two-hour window.

Nobody answered, so every such case sat until the 90-second turn timeout and
reported a runner error. In the transcript the agent would think, pick a tool,
call it with sensible arguments, and then the stream just stopped.

A case now carries an `approvalPolicy` saying what it answers
(`runner/approval-driver.ts`). It allows the named tools past prompt 1 and
**denies everything else**, and it decides at most one named capability at
prompt 2 — never a blanket yes, so a "denied" case cannot inherit a "granted"
case's approval.

The harness is a legitimate decider here, not a hole in the gate. Deciding is
refused for anyone presenting an agent identity or an approval token
(`services/core/approvals/decision-authority.ts`); the driver sends neither
header, so it lands in the same `local-trust` posture the cockpit uses on a
single-user machine. **Nothing in the server was loosened to allow this.** If a
future change makes the driver's decisions 403, the fix is in the harness, never
in that check.

The **allowlist is not a sandbox.** The driver can only answer what it is asked,
and the runtime auto-allows some tools without asking. On a real run, `ToolSearch`
and a `Bash` running a bare `echo` both executed with no prompt, while every
`Bash` that touched the filesystem was prompted and denied. The container
(`preferDocker`) is what actually bounds a turn.

**Reading transcripts: frames are not calls.** A `tool_call` frame is re-emitted
as the tool's input streams in, so one call shows up as many frames. Twenty-seven
`Bash` frames is one `Bash` call. Count distinct `toolCallId` values, not frames,
or you will conclude the agent is thrashing when it made a single call.

## Why the tool cases are still quarantined, and how they get out

### What ten runs actually showed

Ten credentialed runs against a real model on 2026-07-25, in two parts. The
counting matters, so here it is in full:

- **2 runs were the falsifiability drill** (below): one where the model drifted,
  one clean. Both reached oracles.
- **8 runs were the stability sample**: 3 of `granted`, 3 of `denied`, 2 of
  `expires`. That is the sample the table further down reports, which is why the
  table totals 8 rather than 10.

Of the 8 stability runs, **6 produced verdicts and 2 did not**. Add the 2 drill
runs and you get **8 runs that reached an oracle, and all 8 oracle verdicts were
correct**. That is where "8 for 8" comes from, and it is a different 8 from the
8-run sample. Check the arithmetic rather than taking it: 6 + 2 = 8 verdicts,
8 + 2 = 10 runs.

The two runs that produced no verdict **never reached an oracle at all**. Both
times the model resolved the gated tool's schema, said in its own reasoning that
it would call the tool, and then searched for the schema again instead.
Twenty-nine tool calls later the 90-second turn guard cut the turn off. The two
runs stopped at 91,776ms and 91,778ms, two milliseconds apart, which is a state
the model falls into rather than random bad luck.

So there are two different things wearing one label. The product mechanism under
test is stable: every oracle that ran was right. The model's route to it is not.

### The bar counts oracle verdicts, not lucky runs

The old bar was five consecutive passing runs per case. At the measured rate of
about two passes in three, a five-run streak lands roughly 13% of the time, so a
green streak would have been luck rather than evidence, and it would have to be
re-earned after every prompt tweak. It was measuring the model's mood.

**The bar is three runs that reach the oracles, per case, with every oracle green
in all three.** Still a number, because an exit criterion nobody can check is how
a quarantined case decays into permanent ignored noise. What changed is what gets
counted.

- an oracle going red **resets that case to zero**. That is the signal the bar
  exists to catch, and nothing about it is negotiable;
- a run classified as **infrastructure** (see below) neither counts nor resets.
  The harness retries it once automatically;
- **two infrastructure runs in a row for the same case means stop.** That is a
  harness problem to fix, not a dice roll to keep paying for.

### What counts as infrastructure, exactly

A result is infrastructure only when all three of these hold (`runner/retry.ts`):

1. its status is `error`, not `fail`. A red oracle scores `fail`, so no oracle
   verdict can reach this rule at all;
2. **zero oracles ran.** Not "no reds": none executed. One oracle result of any
   colour disqualifies it, because once the product has been observed, what was
   observed is the answer;
3. the error is exactly the turn-timeout message. A locked session, a rejected
   trigger, a boundary 403 and a launcher fault each stay a plain error, because
   any of them can be the product breaking.

This buys one more attempt and nothing else. It never overrides something an
oracle said, because a run that reached an oracle cannot be retried in the first
place. It does not exempt a case from the run gate, and a second timeout is still
an error on the record, shown as `retried:error`. A product bug that hangs a turn
forever costs one extra attempt and then reports itself as what it is.

Be exact about one thing: if the first attempt times out and the second passes,
the recorded result is a pass where an un-retried run would have reported an
error. That is what the retry is for. The claim is about verdicts, not about
statuses.

### Where each case stands

Reset on 2026-07-25 to the 8-run stability sample above. The counts below are
runs that reached the oracles with everything green, so they exclude the 2 drill
runs, which tested the oracles rather than the cases.

| Case                          | Green verdicts | Last recorded | Evidence                              |
| ----------------------------- | -------------- | ------------- | ------------------------------------- |
| `governance-approval-granted` | 2 of 3         | 2026-07-25    | 3 runs, 1 timed out before any oracle |
| `governance-approval-denied`  | 2 of 3         | 2026-07-25    | 3 runs, 1 timed out before any oracle |
| `governance-approval-expires` | 2 of 3         | 2026-07-25    | 2 runs, both green                    |

The earlier seeded counts were dropped rather than carried forward: two of those
greens came from the same drill session on the same day, which is one
confirmation looked at twice.

**Record the run directory when you add a row.** `results.json` and the JSONL
transcripts under `.evals-runs/<run id>/` are what let a later reader check a row
instead of believing it. The rows above have no directory to point at, which is
the gap this column exists to close.

### What a streak costs

`pnpm evals:local` runs `--suite core`, which holds three governance cases. On
the measured Haiku turns a passing case cost **$0.038 to $0.057**. Budget higher
than that: a run that drifts costs more, not less. The falsifiability drill's
diverging run cost **$0.1220**, about 3.2 times a clean pass, and a run that times
out reports nothing at all while still spending. Narrow with
`--suite <case-id> --budget <usd>` while working on one case.

### Two things worth knowing about the failure mode

**The 90-second turn guard is the only thing that stops the loop.** `ToolSearch`
is auto-allowed by the runtime, so it is never offered to the approval driver,
which means the case's allowlist cannot deny it or cap it. Every observed failure
was a `ToolSearch` loop, and nothing in the policy layer can reach it.

**The loop is reproducible, so it may be fixable rather than only retryable.**
Two independent runs stopping two milliseconds apart at the same tool-call count
is an attractor, not jitter. Retrying is the right response to variance the
harness cannot control, but this one looks addressable in the prompt or in how
many tools the turn is shown. Worth an attempt before treating the retry as the
permanent answer.

## A new oracle ships with a drill

An oracle that cannot be shown to fail is decoration. So when you add or change
one, **seed a change that should make it red, confirm it does, remove the seed,
confirm it goes green, and record the recipe in the oracle's TSDoc.** The worked
example is the always-allow drill in `src/suite/governance.ts`.

A recipe that someone else can actually run has five parts. The governance drill
was missing three of them, and it is standing guidance for every oracle that
comes after it:

1. **the seed**: the exact edit that should break the oracle;
2. **the command**, in full. Flags that look like defaults are not. The
   governance drill needs `--isolation child-process`, because the case prefers
   docker and a container cannot see your local Claude sign-in;
3. **what to expect, separated into what always happens and what varies.** Record
   the outcome that is structural, and say plainly which reds depend on what the
   model chose to do that run. A recipe that reports one run's exact set of reds
   as the expected result will look broken the first time someone repeats it;
4. **how to tell a reproduction from noise**: the detail that says the drill
   worked, and the symptom that says the run never got far enough to prove
   anything and should be repeated;
5. **where to read the answer.** Selecting only quarantined cases always exits
   non-zero, so the exit code tells you nothing. Read `results.json`.

This is not ceremony, and the governance suite is the argument for it. That drill
disproved something the code's own comments asserted twice: the intuitive claim
was "remove the tier gate and several oracles go red", and the run showed only ONE
does. Everything else stayed green, because a second mechanism writes an
indistinguishable approval row. Nobody would have found that by reading, and
without it a future cleanup would have had a persuasive case for deleting the one
oracle holding the suite up.

Reasoning about what an assertion would catch is not evidence about what it does
catch. Run the drill.

## Where a credential comes from

The harness asks "can the runtime reach a model?", not "is one variable set?".
Three answers, tried in this order:

| Order | Source                               | Who pays                     | Made with             |
| ----- | ------------------------------------ | ---------------------------- | --------------------- |
| 1     | `ANTHROPIC_API_KEY`                  | that Anthropic API account   | the Anthropic console |
| 2     | `CLAUDE_CODE_OAUTH_TOKEN`            | that Claude subscription     | `claude setup-token`  |
| 3     | the `claude` sign-in on this machine | your own Claude subscription | `claude auth login`   |

Those two variable names are fixed in the code and in the workflow. Nothing lets
a caller name a different variable to read, and nothing should: an earlier version
of the eval workflow allowed exactly that, which meant a stale or mistyped name
would ship an unrelated repository secret to a third party as an auth header.
Adding a source means adding a literal name, never an input.

CI has no sign-in of its own, so the credentialed workflow needs one of the two
secrets. When neither is configured it skips with a notice instead of failing.

## Where each tier can run

`--isolation` decides how a credentialed eval's server is contained.

| Tier             | What it is                           | Credentials it can use     |
| ---------------- | ------------------------------------ | -------------------------- |
| `child-process`  | a server subprocess on your machine  | all three                  |
| `docker`         | one throwaway container per eval     | the two variables only     |
| `auto` (default) | container for cases that ask for one | depends which one it picks |

The container is the reason for the split. It gets no network, no host home, and
a short list of environment variables, which is what makes it safe to let an
agent attempt something destructive inside it (ADR
`260725-133222-eval-isolation-and-cadence-are-infrastructure.md`). Your local
`claude` sign-in lives in your keychain and your home folder, so a container
cannot see it, and handing it in would undo the containment the tier exists for.
So the docker tier asks for `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and
says so plainly when it has neither.

The docker tier also needs the `dorkos-eval:latest` image to already exist. It
never builds one for you, because building is minutes and would quietly dominate
a run. Without the image, `auto` falls back to a child process and says so.

## What runs in CI

See `.github/workflows/evals.yml`. Nothing runs on a pull request unless someone
adds the `run-evals` label. A nightly job runs the free structural suites — both
of them, `core` and `rooms`, as two steps, because `--suite` takes one name. The
credentialed suite is manual only, and promoting a case out of quarantine stays a
human decision made on the evidence it uploads.

## Adding a case

Cases live in `src/suite/`. Register a new one in `src/suite/index.ts`. Give it
oracles that read the API, the filesystem, or the collected stream, and start it
`quarantined: true` until credentialed runs show it is stable — see the bar above.
A case that drives a tool also needs an `approvalPolicy`, or its turn will park on
the first permission prompt. Each new oracle owes a drill.

**Mind the tags, because they decide the bill.** `pnpm evals:local` runs `core`
against a real model, so a free `test-mode` case tagged `core` would quietly
spend on every local run. Tag a free case with the suite it belongs to and keep
it out of `core`; `src/suite/__tests__/rooms.test.ts` pins that for the rooms
suite rather than leaving it to review.
