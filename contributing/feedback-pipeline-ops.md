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
