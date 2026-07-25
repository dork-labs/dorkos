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

## Known gap: tool approvals stall a credentialed turn

A credentialed case that asks the agent to do something usually parks. The driven
session runs in the default permission mode, so the first tool call the runtime
wants confirmed emits `approval_required` and waits ten minutes for an answer that
never comes, and the harness's 90-second turn timeout ends the eval as a runner
error. You can see it in the transcript: the agent thinks, picks the right tool,
calls it with sensible arguments, and then the stream stops.

That is why every case that drives a real tool is still `quarantined`. The
credential path and the turn itself work; nothing answers the approval yet.

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
`quarantined: true` until a credentialed run shows it is stable.
