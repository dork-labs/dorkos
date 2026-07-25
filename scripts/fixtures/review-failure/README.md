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

Add a fixture here whenever the classifier grows a branch.
