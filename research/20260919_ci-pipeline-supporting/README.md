# Supporting material for the 2026-09-19 CI pipeline review

Start at `../20260919_ci-pipeline-deep-review.md`.

- `notes-*.md`: per-layer inventory notes (local hooks, workflows A and B, review/release/docs) behind `../20260919_ci-pipeline-01-inventory.md`.
- `scripts/`: the fetch and analysis scripts behind `../20260919_ci-pipeline-02-timings.md`, plus each script's markdown output. The raw JSON pulls (about 57 MB) were not committed. Re-fetch with `fetch_runs.sh`, `fetch_runs_split.sh`, `fetch_timelines.py` and `fetch_jobs.sh`, then run the `analyze_*.py` scripts.
- `local_gate_timings.py` reads Claude Code session transcripts under `~/.claude*/projects/`, so it only works on the operator's machine.
