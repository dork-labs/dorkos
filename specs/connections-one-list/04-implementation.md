# Connections, one list — implementation record

Shipped 2026-09-26 → 2026-09-27. Every item was built in its own worktree, adversarially reviewed against `REVIEW.md` by a separate agent before its PR (every one came back FIX-FIRST at least once), and landed through the merge queue. Design: [design-decisions.md](./design-decisions.md) (its "As built" notes record where the build departed from the design, and why).

## What shipped

| Item     | PR    | What the person gets                                                                                                                                                                                                                                                                                                              |
| -------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOR-2421 | #2172 | The app list is never empty: popular apps are always listed. The first Connect asks once how DorkOS reaches your apps, skipped when a way already works. One line before sign-in names who the consent page will ask about. Agents get honest guidance when nothing reaches an app.                                               |
| DOR-2417 | #2174 | After connecting, "Who can use it?" — pick agents, Read / Read and write, plain warnings before any removal or downgrade. A one-agent mode for the chat card that never touches other agents and never lowers access.                                                                                                             |
| DOR-2419 | #2179 | Settings › Connections: how DorkOS reaches your apps (status, app counts, confirms that list every app that stops) and the chat-app settings in plain words.                                                                                                                                                                      |
| DOR-2422 | #2175 | Connect a community from the sidebar switcher, with its waiting and approval state; the Communities form left the Connections page.                                                                                                                                                                                               |
| DOR-2420 | #2191 | Share an app with every agent, including ones added later, with a write/delete warning; every way an agent arrives says what it inherits; stop sharing needs no review. ADR `260926-192625`.                                                                                                                                      |
| DOR-2418 | #2198 | `/connections` is one list: Yours (one row per account or chat app, with its one next action), All apps (category chips, For developers), a Needs-you strip, and a side panel per app. New accounts are ready to share at once; migration `0116` settles older never-shared accounts. ADR `260927-033250` amends `260804-021140`. |
| DOR-2415 | #2195 | Connect an app and allow access from a card in the chat; the agent carries on by itself. New `current_access` decision; one shared grant-scope rule (`execution/agent-grant-scope.ts`) behind both execution and requests. Agents never receive a DorkOS link.                                                                    |
| —        | #2181 | Fixed the `git-tree-size` test's stdin race that ejected unrelated PRs.                                                                                                                                                                                                                                                           |

## What is not done (filed)

- **DOR-2437** — "Allow once" needs one-conversation grants the server can't write yet.
- **DOR-2438** — access levels in each app's own words ("Read and send").
- **DOR-2439** — "Every agent" for apps connected through a DorkOS account (public contract first).
- **DOR-2440** — with login off, a local process can make wide-reach owner writes (documented in ADR `260926-192625`; turning login on closes it).
- **DOR-2444** — the undefined `text-warning` class elsewhere in the app.
- **DOR-2448** — no screen yet turns an app back on for one chat.
- **DOR-2449** — an owner-only one-tap way from Telegram/Slack to a waiting request.
- **DOR-2436** — Nango-only setups list a popular app twice.
- **DOR-2450**, **DOR-2451** — test flakes found along the way.

## Don't "fix" these back

- **No link is sent to chat apps.** Four separate "safe to post" rules failed open during review; the link was removed on purpose (DOR-2449 tracks the owner-only replacement).
- **The chat card's Allow never lowers access and never writes other agents.** That is the point of one-agent mode, not a missing feature.
- **A new connection starts `ready`.** It has nothing to reconcile; review is asked for only when someone holds live access and the key or mode changes.
- **`current_access` writes no grant.** The card saves through reconciliation (raise-only), then answers the request with exactly the access the agent holds.
