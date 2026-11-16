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
- **Money:** every change on an ads, crypto, payments or shopping toolkit, identified by its verified app slug. Store administration that can charge or refund counts as payments. Money-related names also stay explicit on any other app, including sponsorships, codespaces, campaigns, budgets, bids, boosts, withdrawals, trades and purchases.
- **Irreversible:** destructive hints and names for purging, resetting, revoking, cancelling or permanent changes, including updating a GitHub reference.
- **Deletes:** delete, remove, trash, archive, leave and close-DM actions. Restoring from trash or archive is not a delete. Batch actions are judged one by one: value-only batches (like the Sheets batch update) are write; batches that can delete stay explicit. Removing paragraph bullets only changes formatting and stays write.

Action names are split at camel-case boundaries, uppercased, and separated with underscores before any family or exact-list match. Empty names and names containing non-ASCII characters are unknown and stay destructive, even with a read hint. Toolkit names are lowercased for the money-app check. Known repository persistence actions stay destructive regardless of their hints. For other valid names, a name or money-app match tightens a changing verdict to destructive; reads stay reads. No access level grants destructive actions: a person selects them one at a time under “Only explicitly.” Paid-marked actions never belong to any level (DOR-4204).

The delete decision is tracked in DOR-4451. `WRITE_INCLUDES_DELETES = false` in `packages/connector-providers/src/composio/action-classes.ts` is the single production switch. Turning it on admits only otherwise clean delete-family actions with a write verdict, or with solely destructive, idempotent and open-world hints; reach, money, irreversible names, Composio-described permanent deletions, whole-container deletions, unknown hints and conflicting verdicts stay out. Updates that can archive a Notion page or permanently delete a database column and its data stay explicit too. The remaining pinned delete-on list is what DOR-4451 would admit; that ticket reviews the list before enabling it. The existing Gmail batch-modify exception stays explicit with either setting.

Creating and updating a release remain write. Uploading or updating release assets requires an exact-action grant.

Merging and creating branches or references are one-by-one picks. This is Security's persistence rule, which Dorian accepted, not an exception to Read and write: a merge is how a repository change goes live and keeps running. Anyone can still give that one action. One exact list in `action-classes.ts` names the confirmed GitHub, GitLab and Gitea actions, including GitHub fork synchronization and branch renames, GitLab tags, cherry-picks, reverts and rebases, and GitHub MCP actions. Known actions on this list remain explicit even if their hints change. Dorian may overrule the rule.

Reviewed actions `GITHUB_UPDATE_A_PULL_REQUEST_BRANCH` and `GITHUB_MCP_UPDATE_PULL_REQUEST_BRANCH` remain write because the pull request still has to be merged. `GITHUB_CREATE_A_TAG_OBJECT` remains write because a tag object alone makes no reference.

The execution guard requires the same exact grant for any nested `force` or `force_push` argument set to true, or a non-empty `new_branch`, `start_branch` or `base_branch` string. Ordinary file edits without these choices remain write.

The path guard checks configuration-file paths. It does not follow the scripts those files call.

Repository file edits remain write, except repository controls: `.github/`, `.gitlab-ci.yml`, `.gitlab/`, `.gitea/`, `.forgejo/`, `bitbucket-pipelines.yml`, `.circleci/`, `.buildkite/`, root and `docs/` `CODEOWNERS`, `Jenkinsfile`, `azure-pipelines.yml`/`.yaml`, `.travis.yml`, `.drone.yml`, `.woodpecker.yml`/`.yaml`, `.woodpecker/`, `appveyor.yml`, `.appveyor.yml`, `.semaphore/` and `cloudbuild.yaml`/`.yml`, including directory tree entries. (`.github/` and `.gitlab/` also cover their `CODEOWNERS` files.) Execution requires that action hand-picked for that agent, independent of access levels, sessions or every-agent sharing. This applies to every toolkit and action. The execution check recursively inspects path arguments and multi-file deletes, repeatedly decodes percent encoding, maps backslashes to slashes, trims path segments, resolves dot segments and compares without case. When full decoding fails, valid percent-byte escapes are also decoded while earlier spellings are retained. Malformed encoding alone does not require an exact action. Each retained spelling is checked from its top folder. A control path rooted there stays explicit; an ordinary folder containing a percent sign does not turn a nested filename into a repository control.

Drive's basic copy stays write because its description places the copy in the source folder; creating new content inside a place the agent can already write is write, like posting in a channel. Choosing a parent for a new Drive file, folder or upload, or a new or duplicated Notion page or database, does not change that. Moving or re-parenting existing items, copying with visibility changes, publishing and sharing stay explicit.

The first start with this policy lowers existing Composio Read and write levels to Read, except Gmail and Google Calendar, which already offered writes. This covers named-agent levels and every-agent sharing; hand-picked actions stay as chosen. The connector application-upgrade ledger records completion once per install. Lowered intent, revoked changing revisions, one Activity row per level and one inbox notice per affected account commit together before the catalog follower starts. A person can then choose Read and write again; later starts preserve that choice.

The tests pin exact read lists and both delete-off and delete-on write lists from the **2026-11-15** catalog for Gmail, Calendar, Drive, Docs, Slack, GitHub, Notion, Linear and Twitter. They also pin reach exceptions, both delete settings and paid-action exclusion. This computer and the hosted account path use the same package; both must run the updated version to apply the same rule.

## Consequences

### Positive

- Agents can create and edit in every app that offers clean Composio write verdicts, including Linear issues.
- Excluded actions still need an exact choice, and paid-marked actions never enter an access level.
- The full dated write lists make catalog changes visible in review.

### Negative

- Name families can exclude ordinary edits too; those actions require an exact choice.
- Trash and archive actions that previously counted as write now require an exact choice while the delete switch is off.
- Existing levels on newly writable apps require choosing Read and write again; the account notice explains the choice.
- Local and hosted deployments need the same package version to apply this decision consistently.
