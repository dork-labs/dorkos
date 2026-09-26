# Feedback Pipeline Operations

The operational runbook for the in-app feedback pipeline: every moving part, the
exact credentials it needs, how to verify it end to end, and how to recover it.
The pipeline was activated 2026-09-09 (DOR-909) and extended with screenshots
and richer context through 2026-09-10 (the Feedback Attachments programme,
`specs/feedback-attachments/`). This guide is the durable record of the setup
that otherwise lives only in the Vercel dashboard and Linear's settings UI.

## The moving parts

```
app dialog → local server /api/feedback → site POST dorkos.ai/api/feedback
  → Neon (system of record)  → Linear issue (best-effort, screenshot uploaded
                                to Linear's own asset store)
Linear issue status change → webhook POST dorkos.ai/api/webhooks/linear
  → Neon status mirror → "shipped" email on the transition into shipped
```

| Part                        | Where                                                                                                                     | Identity                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Site intake + Linear client | `apps/site/src/app/api/feedback/route.ts`, `apps/site/src/lib/feedback/linear.ts`                                         | Vercel project `dorkos-web` (team `dopel`)                                                 |
| Server forwarder            | `apps/server/src/services/core/feedback-reporter.ts`                                                                      | runs on every user's machine                                                               |
| Target Linear team          | **DorkOS User Feedback** (key `FB`)                                                                                       | team id `81f94d0d-8c04-424c-affc-b8462769c6b0`                                             |
| Kind labels (FB team)       | `reported/defect` / `reported/idea` / `reported/feedback`, one per issue, for the form's `bug` / `idea` / `feedback` kind | looked up by name at runtime (`apps/site/src/lib/feedback/reported-labels.ts`); no env var |
| Webhook                     | "DorkOS Feedback Issue Updates" → `https://dorkos.ai/api/webhooks/linear`, **Issue** data-change events, all public teams | created 2026-08-06, secret shared with Vercel                                              |
| Triage routing              | Linear's Triage feature is ON for the FB team                                                                             | new API-created issues land in Triage automatically                                        |

There is deliberately **no** `LINEAR_FEEDBACK_PROJECT_ID`: issues file at team
level, and the FB team's Triage is the intake surface.

## The API key — requirements that are not obvious

The key in `LINEAR_API_KEY` must be a Linear personal API key with:

- **Permission: Write** — not "Create issues". Linear gates the `fileUpload`
  mutation (screenshot storage) on the `write` scope; a create-issues key is
  refused with `Invalid scope: 'write' required`. Linear's own docs imply
  create-issues covers "issues and their attachments" — verified false on
  2026-09-09. Do not narrow the key on the strength of the documentation.
- **Team access: only the DorkOS User Feedback team** — this is what keeps
  `write` from meaning workspace-wide mutation authority. The key lives
  unattended in a public site's server env; team restriction is the blast-radius
  bound.

Mint/rotate at Linear → Settings → Security & access → Personal API keys →
New API key (name it so the next person knows what it serves, pick "Only select
permissions… → Write", "Only select teams… → DorkOS User Feedback"). After
swapping the Vercel env var, revoke the old key on the same page. Uploaded
screenshot assets (`uploads.linear.app`) are workspace-private — a leaked asset
URL does not leak the image.

## Vercel environment (project `dorkos-web`, set for Production AND Preview)

| Var                     | Value                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `LINEAR_API_KEY`        | the write-scoped, FB-team-restricted key (sensitive)                                                                              |
| `LINEAR_TEAM_ID`        | `81f94d0d-8c04-424c-affc-b8462769c6b0`                                                                                            |
| `LINEAR_WEBHOOK_SECRET` | the webhook's signing secret (copy from the webhook's settings page; rotating it there requires updating here in the same breath) |
| `RESEND_API_KEY` etc.   | pre-existing; receipt/shipped emails                                                                                              |

CLI shape (run from a directory linked to the project, e.g. `apps/site` in the
main checkout): `vercel env rm <NAME> production -y` then
`printf '%s' "<value>" | vercel env add <NAME> production --sensitive`, repeat
for `preview`.

**Deploy gotchas, both hit in practice:**

- Env var changes reach functions only on the **next deployment**. To force a
  fully clean build, set `VERCEL_FORCE_NO_BUILD_CACHE=1` on the project, run
  `vercel redeploy <current-prod-url> --scope dopel`, then remove the var.
- Vercel sometimes **cancels** the automatic deploy of a merge to main (shows
  as a 30-second Canceled build). The fix is `vercel redeploy <canceled-url>`
  — it rebuilds that deployment's own git source.

## Verifying end to end (do this after any key/secret/deploy change)

```bash
curl -s -X POST https://dorkos.ai/api/feedback -H "Content-Type: application/json" \
  -d '{"kind":"bug","message":"Pipeline verification (will be canceled).","instanceId":"ops-check","surface":"site"}'
# → {"ok":true,"id":"<row-id>"}
curl -s https://dorkos.ai/api/feedback/<row-id>
# → {"status":"triaged", ...}   "triaged" proves the Linear issue was created;
#                               "received" means Linear creation failed — check scope/env.
```

Then in Linear: the issue is in the FB team's Triage with the `reported/defect`
label (what the form's `bug` kind maps to). Move
its state; re-fetch the status URL and confirm the mirror moved (`in_progress`
etc.) — that proves the webhook secret matches (mismatch = 401s on the
webhook's Delivery failures panel, and the mirror never moves). To also prove
the screenshot leg, add
`"screenshot":{"dataUrl":"data:image/png;base64,<any real tiny PNG>"}` to the
POST and confirm the issue body renders the image. Cancel the test issue when
done.

## Processing the queue

Intake fills the FB team's Triage; **`/feedback:triage` is the processing
loop** — run it in any session. It triages new reports (dedupe → accept with a
linked DOR issue / decline with a reason / duplicates share the original's DOR
link so both reporters ship together), refreshes the status mirror, and ends
with an anomaly report (unlinked items, early promises, stale Triage,
dropped-work cases needing a human). Its first step reads the open GitHub
issues and mirrors the new ones in, so both front doors land in the same queue
(see "GitHub issues" below). Full rules live in the command itself.

Three invariants worth restating here because breaking them lies to a reporter:

- **On the FB team, Done means "the reporter has been told it shipped."**
  Moving an FB issue to Done fires their email. Decline is Canceled.
- **The shipped-email pass (`/feedback:triage --sweep`) runs only from the
  release flow.** A DOR issue is Done at merge; the fix is only in the
  reporter's hands at release. `/system:release` owns the trigger.
- **Relations are read via GraphQL only** — `LINEAR_GET_LINEAR_ISSUE` returns
  `relations: null` and would make the sweep believe nothing is linked.

Dependency: team-scoped groom/snapshot behavior in the flow plugin is
guaranteed as of `dork-labs/marketplace` commit `1c43bd5` (2026-09-11). A
plugin regression there could let a DOR-team groom ingest FB issues; the repo
cannot enforce an external plugin's behavior, so this note names the SHA
instead.

## GitHub issues

The in-app dialog is not the only front door. People also open issues on
`dork-labs/dorkos`, and the app points them there: the help menu's "Report on
GitHub…", `dorkos feedback`, and the README's "File an issue" link all lead to a
new GitHub issue. Until 2026-09-14 nothing read that door. `/feedback:triage`
now does, so both doors get the treatment `meta/user-care.md` promises.

### Two keys

| Key                                       | Answers                                           | Used for                                             |
| ----------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| the FB mirror (a `Source:` URL in FB)     | has this issue been filed into Linear?            | not filing a second FB issue. Nothing else.          |
| a beat marker comment on the GitHub issue | which replies does this person still have coming? | every reply decision, every health row, both medians |

Keeping them apart is the whole design. A mirror created in a run whose approval
was held says nothing about whether the reporter has heard from us, so the
mirror must never gate a reply.

### Intake

Step 0 of Mode 1, before the FB queue read:

1. Read GitHub twice, open and closed, with `--limit 100` on both. Without
   `--limit`, `gh` stops at 30, and a truncated queue looks like an empty one.
   The closed read is what three health rows and both medians are computed from.

   ```bash
   gh issue list -R dork-labs/dorkos --state open --limit 100 \
     --json number,title,author,createdAt,labels,url,comments
   gh issue list -R dork-labs/dorkos --state closed --limit 100 \
     --json number,title,url,author,createdAt,closedAt,stateReason,comments
   ```

   Neither call asks for `body`: a hundred issue bodies blow the context for no
   gain. Fetch one per issue you are actually mirroring, with
   `gh issue view <n> -R dork-labs/dorkos --json body`. Comment objects come back
   whole, with `body`, `createdAt` and `authorAssociation`.

2. Read every FB issue with `includeArchived: true` and no state filter, paging
   on `pageInfo.hasNextPage` with `after: "<endCursor>"` until it is false. A
   mirror in Done, Canceled or the archive is still a mirror, and a truncated
   read re-files everything.

3. File each open issue that matches nothing in FB: one kind label, the title
   verbatim, the report fenced, and the marker block after the fence.

### The `Source:` marker, and how to match it

A mirrored GitHub report carries these two lines in the marker block of its
FB description:

```
Source: https://github.com/dork-labs/dorkos/issues/1840
Reporter: @karlohlemann
```

Two things about reading it back, both of which have bitten:

- **Linear rewrites a bare URL into a markdown autolink on write.** FB-22's
  stored description is literally
  `Source: [https://github.com/dork-labs/dorkos/issues/1841](<https://github.com/dork-labs/dorkos/issues/1841>)`.
  Matching a line that reads `Source: https://…` therefore finds nothing, every
  issue looks unmirrored, and the next run files a second FB issue and greets
  the reporter twice. The test is a substring of that line:
  `github.com/dork-labs/dorkos/issues/<n>` followed by a non-digit or the end of
  the line. The non-digit guard keeps issue 184 from matching issue 1841.
- **The description does not end with the marker block.** Site-intake mirrors
  carry `Submission:`, `Product:` and `Severity:` lines too. Read the block as
  the run of `Key: value` lines at the end, and when a key appears more than
  once, take the last one. The mirror test runs on the **last** `Source:` line
  only. A reporter who pastes another issue's URL into their own report would
  otherwise make an unmirrored issue look mirrored.

The reporter's own text is quoted above that run inside a **four-backtick**
fence, so a `Source:` or `Reporter:` line typed inside a report is never the
last one and is ignored. Four backticks rather than three because reports carry
their own fenced blocks: a three-backtick wrapper is closed by the reporter's
first inner fence and the rest of the report lands in the region the loop
parses. `Reporter:` on a GitHub mirror is always a `@login` and never an email,
which is what keeps the email decline path scoped to in-app reports.

### The three beats and where each reply lands

`/feedback:triage` defines a business day as Monday to Friday in the operator's
local time.

| Beat        | Fires when                                            | In-app report                                   | GitHub report                                                                              |
| ----------- | ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Heard**   | intake, within one business day                       | receipt email, if the report carried an address | a comment carrying `<!-- beat:heard -->`                                                   |
| **Decided** | triage accepts or declines, within five business days | decline email only                              | a comment carrying `<!-- beat:decided -->`; a decline also closes the issue as not planned |
| **Shipped** | `--sweep`, on release day only                        | shipped email, fired by the FB → Done webhook   | a comment carrying `<!-- beat:shipped -->`, then close as completed                        |

Rules that hold for every one of them:

- A person approves the exact text before anything posts. Silence is a hold.
- One reply per beat. If two beats come due in the same run, they go out as one
  comment carrying both markers, never as two comments minutes apart.
- Comment first, close second, so no close is silent.
- Nothing written on the Linear FB issue is visible to a reporter. The FB issue
  is our mirror, not a reply.
- Never close a GitHub issue at merge. The person cannot install the fix until
  the release, which is why the sweep is the only place that closes one as
  completed.
- Posts go out through `gh issue comment <n> --body-file -` fed by a heredoc, so
  a reply never needs a temp file.

Moving a GitHub mirror to Done fires no email. Nothing at all reaches that
reporter until the shipped comment is posted on their issue.

### Auth

`gh` runs as the operator's own GitHub login (`gh auth status` to check). There
is no bot token and no machine account, which is deliberate: every comment this
posts on a public repo is the operator's, so every comment is approved by hand
first. The dormant `.github/dorkbot-triage/` scaffold is the only place a bot
identity is discussed, and it is still off.

### Verifying end to end

Do this after any change to the intake step:

1. Open a throwaway issue:

   ```bash
   gh issue create -R dork-labs/dorkos --label bug \
     --title "Intake verification (will be closed)" \
     --body "Ignore. Verifying the /feedback:triage intake step."
   ```

2. Run `/feedback:triage`. It should list the issue as having no mirror, file an
   FB issue for it, and present a drafted "heard" reply for approval.
3. Check Linear: the new FB issue is in Triage with the `Bug` label, the title
   verbatim, and a `Source:` line carrying your issue number. Confirm the stored
   description shows Linear's autolink form, which is the case the matcher has
   to survive.
4. Approve the reply, then run `/feedback:triage` again. The issue must be
   skipped on both counts: already mirrored, and already greeted.
   Then open a second throwaway issue whose body pastes the first issue's full
   URL, and run again. The second issue must still come up as unmirrored: that
   is the check that the matcher reads the last `Source:` line and not the whole
   description.
5. Run it a third time after deleting nothing. Same result. This is the check
   that catches a matcher that silently stopped matching.
6. Clean up: cancel the FB issues, and close both GitHub issues with
   `gh issue close <n> -R dork-labs/dorkos --reason "not planned"`.

To test the held-approval case, run step 2 and decline the approval. The mirror
exists and the reply does not, so the next run must still offer the reply and
must not file a second FB issue.

## Failure modes → causes

| Symptom                                                | Cause                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Row stays `received`, no issue                         | Linear creation failed: key unset/revoked/wrong scope, wrong team id. Linear is best-effort by design — the submission is never lost. |
| Webhook Delivery failures show 401                     | `LINEAR_WEBHOOK_SECRET` doesn't match the webhook's signing secret (or was never deployed).                                           |
| Issue created but screenshot line says `upload failed` | Key lacks `write` scope, or Linear upload hiccup — the report itself still lands.                                                     |
| Everything green locally, prod unchanged               | Env set but never redeployed, or the auto-deploy was Canceled (see gotchas).                                                          |

## Related records

- Specs: `specs/feedback-pipeline/` (original pipeline), `specs/feedback-attachments/` (screenshots, capture, point-at-element)
- ADR `260803-205035` (dual-write, Neon as system of record, Linear hosts heavy content)
- Var-by-var documentation: `apps/site/src/env.ts`; scope rationale: `apps/site/src/lib/feedback/linear.ts` module doc
- Cap lockstep rule between the server forwarder and the site intake: comment in `feedback-reporter.ts`
