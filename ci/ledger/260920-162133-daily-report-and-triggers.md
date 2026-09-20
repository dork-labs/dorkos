---
id: 260920-162133
title: A daily human-readable CI report, and improvement triggers computed from the data
kind: hygiene
status: active
actor: agent
gates: [wf.ci-steward.collect]
prs: []
ratchet-release: []
field-changes: []
---

The daily collector already knew everything worth knowing about the pipeline and
said it in JSON once a day, plus a Markdown report once a week. Nobody was going
to read either every morning, which meant a floor breach or a red spell on `main`
could sit there for six days before the Monday report named it.

So the daily job now also:

- computes **triggers** (`ci-steward triage` → `triggers.json`): ten rules, each
  with its threshold in `ci/config.yaml`'s fenced `triage:` block, ranked, with
  the measured numbers and a suggested next step. They are data. They open no
  pull request and touch nothing on `main`; phase 3's `ci-improve` is what will
  consume them, and until then a person or an agent reads them in `/ci-status`,
  in the report, or at SessionStart when one is red;
- writes **`reports/YYYY-MM-DD.html`** and an index, from a real template file
  (`packages/ci-steward/templates/report.html`) with its CSS inline, so the page
  can be restyled without touching engine code. Everything interpolated is
  escaped, because pull request titles and API error text reach the page.

The weekly `reports/YYYY-Www.md` stays exactly where it was and becomes the
Monday deep summary. Nothing statistical moved: SLO windows are still 7 days,
floors still tighten after 4 consecutive met windows, and verdicts still wait
for their after-window. Daily is the cadence of _reporting and triage_, not of
measurement.

`kind: hygiene` because nothing measurable about the pipeline should move: this
adds about a second to a job that runs once a day, and changes no gate. If the
daily job's own runtime grows noticeably, or a trigger rule turns out to nag
without ever being acted on, revert the rule rather than widening its threshold.
