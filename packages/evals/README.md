# @dorkos/evals

The eval harness. It prompts a real DorkOS agent session and then checks what
actually happened: a file on disk, a row in the database, a tool call on the
event stream. It never grades the agent's prose.

## Run them on your machine

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

# clean up sandboxes and containers an interrupted run left behind
pnpm evals:sweep
```

If you are not signed in, the run stops before it boots anything and tells you
the three ways to fix it. It never quietly passes.

## Reading the output

Two lines at the bottom of the table matter more than the rows above them:

- **GATING** says how many cases could actually fail the run. Most cases are
  quarantined, which means they run and report but never fail anything. A green
  run that gated on zero cases proves nothing, so the harness treats that as a
  failure rather than a pass.
- **CREDENTIAL** says which of the three credentials the run used, so nobody has
  to guess.

`$0.0000` on a local run is normal. Subscription turns do not report a per-turn
cost, so the harness prints a NOTE rather than a warning. On an API key, `$0.0000`
is a real symptom (either no turn ran or the cost signal broke), and there you get
a WARNING instead.

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

The harness gap is closed, but promotion is a separate question and the answer is
still no. All three governance cases have been observed passing against a real
model, and each also failed at least once on the same prompt for reasons that
belong entirely to the model: one run improvised `echo` narration instead of
calling the tool, another looped on `ToolSearch` thirty times until the turn timed
out. That is tool-choice variance, not a product regression, and a gating case
that goes red on it would train everyone to ignore it.

**The bar is 5 consecutive passing credentialed runs, per case.** Not "a stable
pass rate" — a number, because an exit criterion nobody can check is how a
quarantined case decays into permanent ignored noise. Record results here as you
get them; a failure resets that case's count to zero.

| Case                          | Consecutive passes | Last recorded |
| ----------------------------- | ------------------ | ------------- |
| `governance-approval-granted` | 2 of 5             | 2026-07-26    |
| `governance-approval-denied`  | 1 of 5             | 2026-07-26    |
| `governance-approval-expires` | 1 of 5             | 2026-07-26    |

Know what you are spending before you start a streak. `pnpm evals:local` runs
`--suite core`, which now contains three governance cases rather than one, so a
developer's own-subscription exposure for a full local run went up accordingly —
roughly $0.06 per governance case per run on the observed Haiku turns. Narrow with
`--suite <case-id> --budget <usd>` while working on one.

## A new oracle ships with a drill

An oracle that cannot be shown to fail is decoration. So when you add or change
one, **seed a change that should make it red, confirm it does, remove the seed,
confirm it goes green, and record the recipe and the dated result in the oracle's
TSDoc.** Keep it to a few lines; the worked example is the always-allow drill in
`src/suite/governance.ts`.

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
adds the `run-evals` label. A nightly job runs the free structural suite. The
credentialed suite is manual only, and promoting a case out of quarantine stays a
human decision made on the evidence it uploads.

## Adding a case

Cases live in `src/suite/`. Register a new one in `src/suite/index.ts`. Give it
oracles that read the API, the filesystem, or the collected stream, and start it
`quarantined: true` until credentialed runs show it is stable — see the bar above.
A case that drives a tool also needs an `approvalPolicy`, or its turn will park on
the first permission prompt. Each new oracle owes a drill.
