---
id: 261115-161559
title: Composio write for every app
status: accepted
created: 2026-11-15
spec: null
superseded-by: null
amends: 260928-121730
---

# 261115-161559. Composio write for every app

## Status

Accepted (DOR-4194, DOR-4270).

Amends [260928-121730](260928-121730-composio-create-and-update-are-write-deletes-stay-out-of-levels.md): replaces “Only audited apps get a write tier,” widens “DorkOS keeps these out of levels,” and replaces the consequence that moving mail to trash is write. The hint rules, exact-action grants and shared classification on this computer and the hosted account path still govern.

## Context

“Read and write” was limited to Gmail and Google Calendar, so creating a Linear issue required an exact-action grant. People need the same level to mean the same thing across apps. Composio's create and update hints describe changes, but DorkOS also needs to account for reach, money and irreversible effects.

## Decision

We will accept Composio's clean write verdict for every app, without an audited-app list. We will keep four kinds of changing action out of write:

- **Account reach:** mail forwarding, rules, delivery and sending identity; live connections, webhooks and watches; sharing, visibility, membership and transfers; credentials, apps and runners; users, roles and team settings; security controls. An exact list also covers actions whose names do not identify their reach clearly, including destination changes for Drive files and Notion pages, publishing file revisions, visibility settings, profile and public status changes, org-wide Slack channels, and repository creation, updates and forks. Security controls include commit statuses and checks, SARIF uploads, dependency snapshots, dismissing pull request reviews, organization issue types, Actions variables, environments, authorization and starting deployments.
- **Money:** spending and billing actions, including sponsorships and codespaces.
- **Irreversible:** destructive hints and names for purging, resetting, revoking, cancelling or permanent changes, including updating a GitHub reference.
- **Deletes:** delete, remove, trash, archive, leave and close-DM actions. Restoring from trash or archive is not a delete. Batch edits are ordinary writes; removing paragraph bullets only changes formatting and stays write.

A name match tightens a write verdict to destructive; reads stay reads. No access level grants destructive actions: a person selects them one at a time under “Only explicitly.” Paid-marked actions never belong to any level (DOR-4204).

The delete decision is tracked in DOR-4451. `WRITE_INCLUDES_DELETES = false` in `packages/connector-providers/src/composio/action-classes.ts` is the single production switch. Turning it on admits only otherwise clean delete-family actions with a write verdict, or with solely destructive, idempotent and open-world hints; reach, money, irreversible names, Composio-described permanent deletions, whole-container deletions, unknown hints and conflicting verdicts stay out. Updates that can archive a Notion page or permanently delete a database column and its data stay explicit too. The remaining pinned delete-on list is what DOR-4451 would admit; that ticket reviews the list before enabling it. The existing Gmail batch-modify exception stays explicit with either setting.

Releases (creating, updating and uploading assets) and merges remain write. Writing files in a repository is write, including files that other tools run; keep an agent on Read where that matters. Drive's basic copy stays write because its description places the copy in the source folder; creating new content inside a place the agent can already write is write, like posting in a channel. Choosing a parent for a new Drive file, folder or upload, or a new or duplicated Notion page or database, does not change that. Moving or re-parenting existing items, copying with visibility changes, publishing and sharing stay explicit.

The tests pin exact read lists and both delete-off and delete-on write lists from the **2026-11-15** catalog for Gmail, Calendar, Drive, Docs, Slack, GitHub, Notion, Linear and Twitter. They also pin reach exceptions, both delete settings and paid-action exclusion. This computer and the hosted account path use the same package; both must run the updated version to apply the same rule.

## Consequences

### Positive

- Agents can create and edit in every app that offers clean Composio write verdicts, including Linear issues.
- Excluded actions still need an exact choice, and paid-marked actions never enter an access level.
- The full dated write lists make catalog changes visible in review.

### Negative

- Name families can exclude ordinary edits too; those actions require an exact choice.
- Trash and archive actions that previously counted as write now require an exact choice while the delete switch is off.
- Local and hosted deployments need the same package version to apply this decision consistently.
