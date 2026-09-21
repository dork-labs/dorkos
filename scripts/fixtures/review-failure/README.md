# Review-failure fixtures

Execution logs shaped exactly like the ones `anthropics/claude-code-action` writes
to `$RUNNER_TEMP/claude-execution-output.json` — a JSON array of the SDK messages
the run produced. `scripts/classify-review-failure.sh` reads them; the expected
classification for each file lives in `scripts/test-review-classifier.sh`.

`never-started.json` is copied from the shape of the nine real failures behind
DOR-457 (runs `30135692592`, `30136499857`, `30139427543`). `died-mid-run.json` is
the shape that had no fixture before DOR-457 and that the old two-way split got
wrong: the same `subtype: "success"` + `is_error: true` error class, but reached
after real work, which the old code announced as an exhausted turn budget.

The three `error-*` fixtures that end early — `error-during-execution-at-turn-one`,
`error-during-execution-no-cost-field`, `error-unknown-subtype-no-turns` — pin the
second wrong-message bug (review round 3, finding 2). The turns-and-spend
heuristic used to run ahead of the catch-all, so an error subtype that died before
spending anything was announced as a credentials-or-quota problem: an MCP server
that failed to start sent the maintainer to rotate a working token. An explicit
`subtype` must always beat the heuristic.

The `errors` array (not `result`) in those fixtures is the real SDK shape:
`SDKResultError` carries `errors: string[]` and has no `result` field at all,
while `SDKResultSuccess` carries `result: string`. `error_invalid_api_key` is not
in the SDK's current subtype union (`error_during_execution`, `error_max_turns`,
`error_max_budget_usd`, `error_max_structured_output_retries`) on purpose — it
stands for a subtype added upstream later, and pins that any unrecognised
`error_*` is treated as the run naming its own cause rather than as a guess.

The three `limit-*.json` fixtures belong to the `limit` mode, which separates a
spent Claude subscription from a broken reviewer. `limit-session.json` and
`limit-weekly.json` are **synthetic** — the 30-day reliability read found no
failure it could attribute to a usage limit
(`research/20260919_ci-pipeline-supporting/07-claude-review-effectiveness.md` §6)
— so they pin the parsing, not the wording, and the first real one to appear
should replace them. The `unknown` case needs no synthetic fixture at all:
`never-started.json` and `died-mid-run.json` are real logs and both carry
`Claude AI usage limit reached|<epoch>`, which is the evidence that today's `no`
and `died` classes already hide quota stalls inside them.

`limit-model-prose.json` is the injection case and the reason the mode refuses to
read a clean run's `result` field: it is a successful review whose own summary
quotes every phrase the matcher looks for, because the PR it reviewed contained
them. It must classify as no limit at all.

Add a fixture here whenever the classifier grows a branch.
