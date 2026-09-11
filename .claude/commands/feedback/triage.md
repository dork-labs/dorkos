---
description: Process the user-feedback queue — triage new reports, keep the status mirror honest, and (at release time only) send the shipped emails
argument-hint: '[--sweep]'
allowed-tools: Read, Bash(composio:*), Bash(curl:*), Bash(python3:*), Bash(node:*), AskUserQuestion
category: operations
---

# Process the User-Feedback Queue

**Argument:** $ARGUMENTS

---

## Purpose

User bug reports and ideas land as Linear issues in the **DorkOS User Feedback**
(`FB`) team's Triage. Nothing works that queue automatically — this command is
the whole processing loop. It has two modes with deliberately different safety
profiles:

- **Default (no argument): triage + anomaly report.** Safe to run any time.
  Every write it makes is silent to reporters and reversible.
- **`--sweep`: the shipped-email pass.** Its ONLY sanctioned trigger is the
  release flow (`/system:release` invokes it). A DOR issue goes Done at
  **merge**; the reporter's fix is only real at **release**. Running the sweep
  at any other moment tells a named human "this shipped" about work they cannot
  get yet. Do not run `--sweep` ad hoc.

Ground rules that protect reporters (from the process design debate,
2026-09-11; ops context in `contributing/feedback-pipeline-ops.md`):

- **On the FB team, "Done" is a promise**: moving an FB issue to Done fires the
  reporter's "your report shipped" email. Never move one to Done to tidy the
  board. Decline is **Canceled**.
- All tracker I/O goes through `composio … --account dorkos`. Read relations
  ONLY via `LINEAR_RUN_QUERY_OR_MUTATION` GraphQL (`LINEAR_GET_LINEAR_ISSUE`
  returns `relations: null` and would silently report "nothing linked").
- The FB team id is `81f94d0d-8c04-424c-affc-b8462769c6b0`; scope every read
  through `team(id:)` — list slugs are workspace-wide.

## Mode 1 — Triage (default)

Pull the queue (one call; note the double `data` nesting in results):

```bash
composio execute LINEAR_RUN_QUERY_OR_MUTATION --account dorkos -d '{"query_or_mutation":
"query { team(id: \"81f94d0d-8c04-424c-affc-b8462769c6b0\") { issues(first: 50, includeArchived: false,
filter: { state: { type: { in: [\"triage\",\"backlog\",\"unstarted\",\"started\"] } } })
{ nodes { identifier title description createdAt state { name type }
relations { nodes { type relatedIssue { identifier state { type } } } } } } }", "variables": {}}'
```

For each issue in a **`triage`-type state**:

1. **Dedupe** — search FB and DOR for the same defect (GraphQL
   `searchIssues(term:, first:, includeArchived: false)`; results are
   cross-team, filter by prefix). A duplicate stays in **Backlog** (never the
   Duplicate state — that maps to "closed" and orphans the reporter) and gets a
   `related` link to the **same DOR issue** as the original, so both reporters
   ship together. Note the FB↔FB duplication in a **comment**, never a
   duplicate _relation_ (relation-writes can flip state).
2. **Classify and decide:**
   - **Accept** → create a DOR issue (normal backlog conventions: `type/*`
     label, plain description quoting the report, link back), add a `related`
     relation FB→DOR, move the FB issue to **Backlog**. This is invisible to
     the reporter (their page keeps saying "triaged") — FB state discipline
     exists to define the sweep's input set.
   - **Decline** → comment the reason on the FB issue, then move to
     **Canceled** (reporter's page shows "closed"). If the issue's
     `Reporter:` line carries an email: DRAFT a one-paragraph reply (plain,
     honest, no hype), and present it for approval — **per email, quoting the
     full body and the exact recipient**; a batch "continue" never covers an
     outbound email, and silence is a HOLD, not a send. Send via the Resend
     tooling with the from-address READ from a prior pipeline send
     (`list-emails`/`get-email`) — never guessed. No `Reporter:` line →
     comment-only, proceed.
   - **Needs info** → there is no ask-the-reporter channel (emails are
     receipt + shipped only). Best-effort triage; if truly unactionable,
     decline with reason as above.

Then the **status refresh** for accepted items (silent, safe): any FB issue in
Backlog whose linked DOR issue is `started` → move FB to **In Progress**
(reporter's page moves to "in progress"; no email fires on that transition).

End EVERY run by printing the **anomaly report** — never silently skip:

- FB in Backlog with **no** DOR relation (half-finished manual triage)
- FB in **Done** whose links are not all `completed` (a promise made early)
- FB in Triage older than 7 days
- FB whose linked DOR issue is `canceled` (reporter was told "triaged", work
  was dropped — needs a human decision, not a rule)

## Mode 2 — `--sweep` (release flow only)

**Pre-flight (mandatory):** the shipped email must be proven live before any
state moves. Read one known-good row through the public status endpoint (the
row id is in every FB description's `Submission:` line); confirm production
answers and the versionless-email fix is deployed (see the runbook's history —
before 2026-09-11 the email was version-gated and silently never sent). Keep
these probes to a handful; the endpoint is rate-limited.

Decision table, per FB issue in Backlog/Todo/In Progress with DOR links —
filter by state **category**, never display names:

| Linked DOR issues         | Action                                       |
| ------------------------- | -------------------------------------------- |
| ALL `completed`           | move FB → **Done** (fires the shipped email) |
| any `started`             | move FB → **In Progress**                    |
| all `backlog`/`unstarted` | leave                                        |
| mixed `completed` + open  | **hold** — print in the report               |
| all `canceled`            | **print and ask** — human decision           |

Announce results: how many reporters were emailed, held, skipped.

## Notes

- The reporter's public page (`dorkos.ai/feedback/<row-id>`) shows only
  status/kind/date — a comment on the FB issue is never reporter-visible.
- Team-scoped reads depend on the flow plugin's adapter contract as of
  marketplace `1c43bd5` (`getBacklogSnapshot`/groom are team-scoped; before
  that SHA a groom could ingest FB issues — verified never to have happened,
  2026-09-11).
- Concurrent human triage in the Linear UI is normal and expected; the anomaly
  report is how their half-done work surfaces instead of being skipped.
- Every comment this command posts ends with the `agent:provenance` line (see
  "Signing outward writes" in AGENTS.md) so a later session can route a
  follow-up back to the one that wrote it.
