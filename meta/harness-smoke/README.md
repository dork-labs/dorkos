# Harness smoke reports

The H tier of [`plans/harness-sync-test-plan.md`](../../plans/harness-sync-test-plan.md) §8: an actual `claude`, `codex` or `opencode` binary reads a tree the projection engine just wrote, and reports what it found. Everything else in the harness suite is a claim about file **shape** — which is how the Codex hooks file stayed the wrong shape (HK-01) through four test files that all asserted the engine's own bytes.

**These are the FREE reports, and they are committed on purpose.** A `--free` run reaches no model and needs no key, so it can be re-run by anyone at any time and its output is evidence the contract can cite. Paid runs land in `test-results/harness-smoke/`, which is gitignored, because they cannot be reproduced without somebody's money.

Regenerate all four with:

```bash
pnpm exec turbo build --filter=@dorkos/harness
bash scripts/harness-smoke/run.sh claude --free --report meta/harness-smoke
bash scripts/harness-smoke/run.sh codex  --free --report meta/harness-smoke
bash scripts/harness-smoke/run.sh claude --free --scenario user-tier --report meta/harness-smoke
bash scripts/harness-smoke/run.sh codex  --free --scenario user-tier --report meta/harness-smoke
```

## Two scenarios, two questions

`--scenario` picks the fixture, and the two ask different things in different places.

- **`project`** (the default) stages a whole repository, projects it with the real engine, and asks
  what the binary finds inside a checkout. Its reports are `<stamp>-<harness>.md`.
- **`user-tier`** stages an **empty** project and a globally installed package reachable only through a
  link in the run's own home directory, then asks whether the harness opens that directory at all. It
  is the measurement DOR-1924 gates slice A3 of the global-scope programme on. Its reports are
  `<stamp>-<harness>-user-tier.md`, and they carry the raw listing entries behind every verdict — a
  verdict that said "listed once" without them would be the runner asking to be believed.

The user-tier scenario runs one staging per **round**, because both of its rounds ask which directory a
harness opens and one staging that wrote both could not tell "this harness does not read
`~/.agents/skills`" apart from "it stops reading it once its own skills folder exists".

The full operator guide — the paid half, the money gate, the oracle hierarchy and how far each verdict's claim goes — is [`contributing/harness-sync.md`](../../contributing/harness-sync.md) §13.

## What a free run can and cannot answer

It answers everything that happens **before the first API request**: what the harness enumerates, whether a projected hook fires, which credential it read, and how the engine's `harnessCoverage()` walk compares to the binary's own listing. It cannot answer anything that needs a model to reply — above all whether the harness **injected** a skill rather than the model having opened `SKILL.md` itself. Those verdicts read `UNKNOWN — NOT RUN` and say what would answer them.

## Housekeeping

One report per harness **per scenario** is kept here, replaced when it is regenerated. They are dated and name the binary version they were measured against, so a report older than the binary is a report to re-run rather than to trust.
