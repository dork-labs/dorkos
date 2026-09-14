---
description: Process the user-feedback queue — triage new reports, keep the status mirror honest, and (at release time only) send the shipped emails
argument-hint: '[--sweep]'
allowed-tools: Read, Bash(composio:*), Bash(gh:*), Bash(curl:*), Bash(python3:*), Bash(node:*), AskUserQuestion
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

Both modes serve one promise, `meta/user-care.md`: a person who reports
something hears back within one business day (**heard**), hears what we decided
within five (**decided**), and hears when it ships (**shipped**). Nobody gets
silence. Reports arrive through two doors. The in-app "Send feedback" dialog
files into FB directly. GitHub issues on `dork-labs/dorkos` are mirrored in by
step 0 below. The door decides where each reply goes, never whether it happens.
How to word a reply is the `writing-to-users` skill.

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
- Every word a reporter reads (a decline email, a GitHub comment) follows
  `meta/user-care.md` and is written with the `writing-to-users` skill: name one
  detail from their report, say when they hear next, and a person approves the
  exact text before it posts.
- **The FB issue is our internal mirror, and never a reply.** Nothing written
  there reaches the person who reported: their status page shows state, kind and
  date only, and a GitHub reporter never sees Linear at all. Replies go back on
  the channel the person used. A GitHub issue gets a GitHub comment; an in-app
  report gets the pipeline's email. Never ask anyone to move channels.

## Mode 1 — Triage (default)

### Step 0: GitHub intake (before the FB queue read)

GitHub is the second front door, and it is the one nothing watched until this
step existed. Mirror each open issue into FB so it rides the rest of this loop
with no special case, then answer its reporter on GitHub.

Read both sides:

```bash
gh issue list -R dork-labs/dorkos --state open --limit 100 \
  --json number,title,body,author,createdAt,labels,url,comments

composio execute LINEAR_RUN_QUERY_OR_MUTATION --account dorkos -d '{"query_or_mutation":
"query { team(id: \"81f94d0d-8c04-424c-affc-b8462769c6b0\") { issues(first: 100, includeArchived: false)
{ nodes { identifier title description state { name type } } } } }", "variables": {}}'
```

`gh issue list` returns 30 rows without `--limit`, and a silently truncated
queue reads exactly like an empty one. The mirror scan carries **no state
filter**, unlike the queue read below. A
mirror that already reached Done or Canceled is still a mirror; skipping those
states would re-file a shipped issue and greet its reporter a second time.

An issue has a mirror when some FB description carries the line
`Source: https://github.com/dork-labs/dorkos/issues/<n>` for that number. For
each open issue **without** one:

1. **Create the FB issue**, in the shape the site intake uses, so the rest of
   this command cannot tell the two doors apart:
   - Team `81f94d0d-8c04-424c-affc-b8462769c6b0`. Triage is on, so it lands
     there by itself.
   - One kind label: GitHub `bug` → `Bug`
     (`384c8c3f-3f98-492b-afea-a91f37ba117c`), GitHub `enhancement` → `Feature`
     (`7d46bb73-289c-4a35-8e4f-552818d2d57b`). If the issue has neither label or
     both, read the body and pick one. Every FB issue carries exactly one.
   - The title **verbatim**. Do not summarize it or re-title it.
   - A description that quotes the report as the reporter wrote it, and ends
     with these two lines:

     ```
     Source: https://github.com/dork-labs/dorkos/issues/<n>
     Reporter: @<github-login>
     ```

     `Reporter:` is a GitHub handle here, and never an email. A GitHub reporter
     has not given us an address, so the decline-email path below does not apply
     to them; their replies go on their issue. There is no `Submission:` line
     and no status page either. The GitHub issue is that reporter's status page.

2. **Draft the "heard" reply** with the `writing-to-users` skill: their name,
   one detail only their report contains, what is happening right now, and the
   day they hear next. Never a date for the fix.

3. **Get it approved, then post it.** Present each reply the way this command
   presents a decline email: one at a time, the full text and the exact issue
   number, approved on its own. A batch "continue" never covers a public
   comment, and silence is a HOLD, not a post. After approval:

   ```bash
   gh issue comment <n> -R dork-labs/dorkos --body-file <drafted-reply>
   ```

   End the body with the `agent:provenance` line. The repo is public, so omit
   `resumeUrl` and truncate `sessionId` to 8 characters.

**One "heard" reply per issue, ever.** The FB mirror is the idempotency key. An
issue that already has a mirror is never re-filed and never re-greeted, whatever
its comment count says.

A mirrored issue is now an ordinary FB Triage item. Everything below applies to
it unchanged.

### Step 1: work the FB queue

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
     exists to define the sweep's input set. If the FB issue carries a `Source:`
     GitHub line, this is also the **decided** beat: draft the "we're fixing
     this" reply (the decision in the first sentence, one sentence of why in
     their terms, then "I'll comment here when it's in a release"), approve it
     per reply, and post it with `gh issue comment` as in step 0. No fix date.
     Leave the issue open; it closes in the sweep, on release day.
   - **Decline** → comment the reason on the FB issue, then move to
     **Canceled** (reporter's page shows "closed"). If the issue's
     `Reporter:` line carries an email: DRAFT a one-paragraph reply (plain,
     honest, no hype), and present it for approval — **per email, quoting the
     full body and the exact recipient**; a batch "continue" never covers an
     outbound email, and silence is a HOLD, not a send. Send via the Resend
     tooling with the from-address READ from a prior pipeline send
     (`list-emails`/`get-email`) — never guessed. No `Reporter:` line →
     comment-only, proceed.

     If the `Reporter:` line is a GitHub handle, the decline goes on GitHub
     instead of by email. Draft a kind no with the `writing-to-users` skill (the
     decision first, one sentence of why, what they can do instead if anything,
     and thanks anyway), approve it the same per-reply way, post it with
     `gh issue comment`, and only then close their issue:

     ```bash
     gh issue close <n> -R dork-labs/dorkos --reason "not planned"
     ```

     Comment first, close second, so the close is never silent. Closing without
     a reply is forbidden.

   - **Needs info** → depends on the door. A GitHub reporter has a channel:
     ask for the missing piece in the reply on their issue, name what you
     already have so they are not asked to repeat it, and say when they hear
     next. An in-app reporter has none (their emails are receipt and shipped
     only), so triage on what they sent; if it is truly unactionable, decline
     with the reason as above.

Then the **status refresh** for accepted items (silent, safe): any FB issue in
Backlog whose linked DOR issue is `started` → move FB to **In Progress**
(reporter's page moves to "in progress"; no email fires on that transition).

End EVERY run by printing the **anomaly report**. Never silently skip it.

Queue health:

- FB in Backlog with **no** DOR relation (half-finished manual triage)
- FB in **Done** whose links are not all `completed` (a promise made early)
- FB in Triage older than 7 days
- FB whose linked DOR issue is `canceled` (reporter was told "triaged", work
  was dropped — needs a human decision, not a rule)
- open GitHub issues with **no** FB mirror (intake did not finish)
- FB mirrors whose GitHub issue was **closed by somebody else** (the reporter
  gave up, or a maintainer closed it by hand)

Promise health, the five rows from `meta/user-care.md` §5. A non-zero row is a
defect to fix that day, not a statistic:

- reports with **no reply after one business day**
- reports **heard but not decided** after five business days
- reports **decided as a fix with no linked work item**
- reports whose fix **shipped with no "shipped" reply**
- reports **closed by hand with no reply** on the thread

For an in-app report the first reply is the pipeline's receipt email, which
sends itself, so the first row almost always means a GitHub issue nobody has
answered.

Then the two numbers `meta/user-care.md` §5 watches:

- median hours to first reply
- median days to decision

Compute them from the GitHub issue timeline where that data exists: `createdAt`
against the first reply comment, and `createdAt` against the comment that
carried the decision. Print `n/a` for a number the data does not support, and
never estimate one. If the first number goes over a day, clear the queue before
doing anything else.

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

### The GitHub half of the sweep

When the table moves an FB issue that carries a `Source:` GitHub line to
**Done**, the same release owes its reporter a comment on their own issue:

1. Draft the **shipped** reply with the `writing-to-users` skill: the version
   and the release link, one plain line on what changed for them, and thanks
   that names what they contributed.
2. Approve it per reply, full text and exact issue number, as in Mode 1.
   Silence is a HOLD.
3. Post it, then close the issue:

   ```bash
   gh issue comment <n> -R dork-labs/dorkos --body-file <drafted-reply>
   gh issue close <n> -R dork-labs/dorkos --reason completed
   ```

Comment first, close second. The release-only rule that gates the email gates
this comment too, for the same reason: a DOR issue is Done at merge, but the
person cannot install the fix until the release. Closing their issue at merge
tells them to go and get something that does not exist yet.

Announce results: how many reporters were emailed, how many GitHub issues were
answered and closed, how many were held, how many were skipped.

## Notes

- The reporter's public page (`dorkos.ai/feedback/<row-id>`) shows only
  status/kind/date — a comment on the FB issue is never reporter-visible.
- Team-scoped reads depend on the flow plugin's adapter contract as of
  marketplace `1c43bd5` (`getBacklogSnapshot`/groom are team-scoped; before
  that SHA a groom could ingest FB issues — verified never to have happened,
  2026-09-11).
- Concurrent human triage in the Linear UI is normal and expected; the anomaly
  report is how their half-done work surfaces instead of being skipped.
- `gh` runs as the operator's own GitHub login. There is no bot token and no
  bot account, so every comment this command posts on the public repo is the
  operator's own. That is exactly why each one is approved by hand first.
- Every comment this command posts ends with the `agent:provenance` line (see
  "Signing outward writes" in AGENTS.md) so a later session can route a
  follow-up back to the one that wrote it.
