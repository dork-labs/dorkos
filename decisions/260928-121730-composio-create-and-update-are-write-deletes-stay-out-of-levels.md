---
id: 260928-121730
title: Composio create and update actions are write; deletes stay out of every level
status: accepted
created: 2026-09-28
spec: connection-app-details
superseded-by: null
amends: null
---

# 260928-121730. Composio create and update actions are write; deletes stay out of every level

## Status

Accepted (owner decision A on DOR-2466, 2026-09-28).

Amended by `260929-071355` (DOR-2506, 2026-09-29): a level is now stored as the owner's intent and follows the app by class, so a "Read" grant no longer keeps exactly the revisions it had; exact actions still do. `levelIncludes` moved to `packages/shared/src/connector-schemas.ts`.

## Context

The access levels read one rule (`levelIncludes`): "Read" grants `read` actions, "Read and write" adds `write`, and no level ever grants `destructive`, which is allowed one action at a time. Composio's classifier (`classify` in `packages/connector-providers/src/composio/sdk-client.ts`) only ever returned `read` or `destructive`, so every Composio app offered "Read" alone, and sending an email or adding an event meant picking exact actions.

Composio labels every action with at least one of four verdict tags, which it enforces in its own CI and documents in its session guide: `readOnlyHint` (changes nothing), `createHint` (creates something, "such as sending an email or opening an issue"), `updateHint` (changes something in place) and `destructiveHint` ("irreversibly removes, cancels or revokes data"; an irreversible update carries `updateHint` too). `idempotentHint` and `openWorldHint` are partial MCP hints and prove nothing. The earlier rule predates `createHint`/`updateHint`, and MCP's own default ("no `destructiveHint` means destructive") is why a missing tag can never be read as safe.

## Decision

We classify from Composio's safety hints only: the tags ending in `Hint`. A read of Composio's live Gmail and Google Calendar lists (112 actions, 2026-09-28) showed the same `tags` list also carries category labels ("gmail", "messages", "Events Management", "deprecated", "batch") and the `important` mark. The earlier rule treated any tag it did not know as a contradiction, so those labels pushed most reads into `destructive` (about 12 of 62 Gmail actions and 1 of 50 Calendar actions came out `read`) and would have kept every Calendar create and update out of "Read and write". Labels say nothing about what an action does, so we ignore them; an unknown `…Hint` still counts, as a verdict we do not understand.

- `read`: `readOnlyHint`, and every hint is `readOnlyHint`, `idempotentHint` or `openWorldHint`.
- `write`: `createHint` or `updateHint`, and every hint is one of those or `idempotentHint`, `openWorldHint` — so never beside `destructiveHint` or `readOnlyHint`.
- `destructive`: everything else — a destructive verdict, contradictory verdicts, no verdict at all, or an unknown hint.

Deletes stay out of both levels because Composio marks them `destructiveHint`, which our rule never lets through. On the live lists every action whose name says delete, remove or clear comes out `destructive`, as do `GMAIL_SEND_DRAFT` and `GMAIL_STOP_WATCH` (Composio marks both irreversible). The read tier widens for the same reason the write tier appears: reads that were only mislabelled by category tags, such as `GMAIL_GET_DRAFT` and `GOOGLECALENDAR_FIND_FREE_SLOTS`, now count as reads.

### Only audited apps get a write tier

A `write` verdict counts only for an app whose live tags DorkOS has audited: today Gmail and Google Calendar (`AUDITED_WRITE_TOOLKITS`). For every other app, create and update actions stay `destructive`, as before, because nobody has checked what its actions reach. Adding an app means reading its live tags, adding them to the test fixture, and pinning its write list in the test.

### DorkOS keeps these out of levels

Composio's hints say whether an action changes or removes something, not how far its effect reaches. Some actions it calls create or update can hand data or access to someone else: sharing a calendar (`GOOGLECALENDAR_ACL_*`), forwarding or redirecting mail (`GMAIL_FORWARD_MESSAGE`, `GMAIL_CREATE_FILTER`), changing the sending identity (`GMAIL_PATCH_SEND_AS`, `GMAIL_UPDATE_SEND_AS`), changing how the account delivers mail (`GMAIL_UPDATE_IMAP_SETTINGS`, `GMAIL_UPDATE_POP_SETTINGS`, `GMAIL_IMPORT_MESSAGE`, `GMAIL_INSERT_MESSAGE`), turning on an automatic reply that writes to anyone who emails (`GMAIL_UPDATE_VACATION_SETTINGS`), starting a subscription (`*_WATCH`), changing many messages at once (`GMAIL_BATCH_MODIFY_MESSAGES`), and moving an event to another calendar, whose owners and sharing may differ (`GOOGLECALENDAR_EVENTS_MOVE`). After the hints, `classifyComposioAction` moves any `write` action named in an exact list, or whose name matches a defensive pattern for sharing, permissions, rules, webhooks, subscriptions, secrets and transfers (`_ACL_`, `FORWARD`, `SEND_AS`, `FILTER`, `VACATION`, `WATCH`, `PERMISSION`, `SHARE_`, `COLLABORAT`, `_RULE`, `WEBHOOK`, `SUBSCRI`, `SECRET`, `TRANSFER`, `DELEGAT` and more) so later tools are caught too, to `destructive`. It never moves anything the other way, so a pattern that matches too much costs convenience, not safety. These actions stay grantable one at a time, like a delete. The allowlist, the list and the pattern live in one place, `packages/connector-providers/src/composio/sdk-client.ts`. The hosted DorkOS account service must classify with this same function; the two can disagree if it runs an older copy, so each change here has to reach it too.

Classification is not rewritten on stored data. Operation revisions are immutable and their identity includes the classification, so the next discovery records a send action as a new `write` revision (and a newly recognised read as a new `read` revision) beside the old `destructive` one. Nobody is moved onto it: a "Read" grant keeps exactly the revisions it had, and an agent that picked the old destructive send action exactly keeps it, still behind per-action approval, until the person next changes that agent's access (the old revision shows as no longer offered). On the hosted DorkOS account path the hosted service classifies with the same function (when it runs the same version of it), and the hosted store already retires the old revision and its grant on a reclassification, so access there can only shrink until the person chooses again.

## Consequences

### What "Read and write" still allows

- Sending can still share content: an agent that sends or replies can quote anything it can read.
- Editing an event (`GOOGLECALENDAR_UPDATE_EVENT`, `GOOGLECALENDAR_PATCH_EVENT`) can add or drop attendees. That is the same reach as sending an invitation email, and is accepted.
- Changing a thread's labels (`GMAIL_MODIFY_THREAD_LABELS`) can archive a thread or mark it spam. That is accepted because it can be undone.
- Moving mail to the trash is `write` because it can be undone, but Gmail empties the trash after 30 days.

### Positive

- Gmail and Google Calendar offer "Read and write": send, create and edit, never delete, share or forward.
- The rule reads only what Composio asserts; an unknown future hint or a missing verdict still lands in the strictest tier, and a test runs it over Composio's live Gmail and Calendar tags.
- This computer and the hosted account path share one classification function, so they agree as long as both run the same version of it.

### Negative

- We trust Composio's verdict. Sending an email cannot be undone, yet Composio calls it `createHint`, so "Read and write" lets an agent send; the owner chose this on purpose.
- If a pinned toolkit version still lists tools without `createHint`/`updateHint`, those tools stay `destructive` and the app keeps offering "Read" only until Composio re-syncs it.
- Anyone who picked Composio send or create actions one by one sees them as no longer offered and chooses again the next time they change that agent's access. On a DorkOS account the hosted store retires the old action and its grant when its class changes, so such an agent loses that action until the person allows it again.
- A "Read" grant made before this change no longer matches the wider "Read" preset, so the access card shows it as exact actions until the person picks "Read" again. That is the honest state (it covers fewer reads than "Read" now does), the same one a new service version already produces.
- DorkOS's own list of account-reach actions is a judgment on top of Composio's hints. It is by name, so a risky action Composio adds under a name the pattern misses lands in "Read and write" until the list is updated; the live-tags test pins today's full write list so any change is reviewed.
