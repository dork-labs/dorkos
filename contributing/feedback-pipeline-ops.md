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

| Part                        | Where                                                                                                                     | Identity                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Site intake + Linear client | `apps/site/src/app/api/feedback/route.ts`, `apps/site/src/lib/feedback/linear.ts`                                         | Vercel project `dorkos-web` (team `dopel`)                                      |
| Server forwarder            | `apps/server/src/services/core/feedback-reporter.ts`                                                                      | runs on every user's machine                                                    |
| Target Linear team          | **DorkOS User Feedback** (key `FB`)                                                                                       | team id `81f94d0d-8c04-424c-affc-b8462769c6b0`                                  |
| Kind labels (FB team)       | `Bug` / `Feature`                                                                                                         | `384c8c3f-3f98-492b-afea-a91f37ba117c` / `7d46bb73-289c-4a35-8e4f-552818d2d57b` |
| Webhook                     | "DorkOS Feedback Issue Updates" → `https://dorkos.ai/api/webhooks/linear`, **Issue** data-change events, all public teams | created 2026-08-06, secret shared with Vercel                                   |
| Triage routing              | Linear's Triage feature is ON for the FB team                                                                             | new API-created issues land in Triage automatically                             |

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

| Var                       | Value                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `LINEAR_API_KEY`          | the write-scoped, FB-team-restricted key (sensitive)                                                                              |
| `LINEAR_TEAM_ID`          | `81f94d0d-8c04-424c-affc-b8462769c6b0`                                                                                            |
| `LINEAR_WEBHOOK_SECRET`   | the webhook's signing secret (copy from the webhook's settings page; rotating it there requires updating here in the same breath) |
| `LINEAR_BUG_LABEL_ID`     | `384c8c3f-3f98-492b-afea-a91f37ba117c`                                                                                            |
| `LINEAR_FEATURE_LABEL_ID` | `7d46bb73-289c-4a35-8e4f-552818d2d57b`                                                                                            |
| `RESEND_API_KEY` etc.     | pre-existing; receipt/shipped emails                                                                                              |

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

Then in Linear: the issue is in the FB team's Triage with the `Bug` label. Move
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
`dork-labs/dorkos`, and the app sends them there itself: the help menu's "Report
on GitHub…", `dorkos feedback`, the README and two docs pages all point at
`github.com/dork-labs/dorkos/issues/new`. Until 2026-09-14 nothing read that
door. `/feedback:triage` now does, so both doors get the treatment
`meta/user-care.md` promises.

### Intake

Step 0 of Mode 1, before the FB queue read:

1. `gh issue list -R dork-labs/dorkos --state open --limit 100 --json number,title,body,author,createdAt,labels,url,comments` (without `--limit` it stops at 30, and a truncated queue looks like an empty one)
2. Read every FB issue, **unfiltered by state**, and look for the marker line.
   An open GitHub issue with no marker anywhere in FB has no mirror yet.
3. File the ones with no mirror into the FB team the same way the site intake
   does: one kind label, the title verbatim, the report quoted, and the two
   marker lines at the end of the description.

The mirror scan must not be state-filtered. A mirror in Done or Canceled still
counts; skipping those states would re-file a shipped issue and greet its
reporter twice.

### The `Source:` marker

Two lines at the end of an FB description identify a mirrored GitHub report:

```
Source: https://github.com/dork-labs/dorkos/issues/1840
Reporter: @karlohlemann
```

`Source:` is the idempotency key for the whole loop. It decides whether an issue
has already been mirrored, where the replies go, and which sweep rows owe a
GitHub comment. `Reporter:` is a GitHub handle for these, never an email; the
email decline path belongs to in-app reports, which carry an address and a
`Submission:` row id instead.

### The three beats and where each reply lands

| Beat        | Fires when                                            | In-app report                                 | GitHub report                                                      |
| ----------- | ----------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| **Heard**   | intake, within one business day                       | receipt email (automatic)                     | `gh issue comment`, drafted and approved                           |
| **Decided** | triage accepts or declines, within five business days | decline email only                            | `gh issue comment`; a decline also closes the issue as not planned |
| **Shipped** | `--sweep`, on release day only                        | shipped email, fired by the FB → Done webhook | `gh issue comment` then `gh issue close --reason completed`        |

Rules that hold for every one of them:

- A person approves the exact text before anything posts. Silence is a hold.
- Comment first, close second, so no close is silent.
- Nothing written on the Linear FB issue is visible to a reporter. The FB issue
  is our mirror, not a reply.
- Never close a GitHub issue at merge. The person cannot install the fix until
  the release, which is why the sweep is the only place that closes one as
  completed.

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
   verbatim, and a `Source:` line carrying your issue number.
4. Run `/feedback:triage` again without approving anything. The issue must now
   be skipped as already mirrored. That proves the idempotency key works.
5. Clean up: cancel the FB issue, and close the GitHub one with
   `gh issue close <n> -R dork-labs/dorkos --reason "not planned"`.

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
