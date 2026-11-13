---
slug: agent-browser-tab-per-chat
id: 261113-214252
created: 2026-11-13
status: draft
---

# Agent browser: a tab per chat, with shared sign-ins

**Status:** Draft. Security reviews this design before build (Nov 18) and the PR before arming.
**Author:** DorkOS Code (agent)
**Date:** 2026-11-13
**Tracker:** DOR-4273 (Must, first after launch; build Nov 18, ship by Nov 25)
**Builds on:** [`specs/local-playwright-browser/`](../local-playwright-browser/02-specification.md)
**Why this shape:** [Agent browser: keep building, adopt, or package?](../../research/20261113_agent-browser-build-vs-adopt.md)

## Overview

Two chats can use the Agent browser at the same time. Each chat drives its own tab. All tabs share one signed-in browser, so a sign-in made once works for every chat. This ticket ships the agent's own window first. Parallel pages in the embedded DorkOS-browser panel are the follow-up, DOR-4289.

## Problem

Today one chat holds the whole Agent browser for the install. `LocalBrowserService` keeps one session id, one selected tab, one revision and observation, and one action flight (`apps/server/src/services/session/local-browser/service.ts`). `requireSharedSession` (called from `capabilities.ts`) refuses every other chat with `not_shared`. That was a v1 choice, not a hard limit. Dorian's words (Nov 13): "two agents couldn't browse different sites in parallel? If so, that's no good."

## Decision

Keep our Agent browser and borrow patterns from others (research report, path A). The research scored every option on the local-first rule: the browser runs wherever DorkOS runs, with no VM or container per browser. A tab per chat costs one tab for each extra agent. A browser per agent costs a whole Chrome. A VM per agent costs about 8 GB. OpenClaw, BrowserOS and nanobrowser use the same tab-per-chat model.

## Design

1. **One context, many page leases.** The persistent browser context (the sign-ins) stays one per install. Each chat gets a lease: its own tab, revision, observation, node handle, action flight and paused flag. `requireSharedSession` becomes `leaseFor(sessionId)`.
2. **The owner is the server's chat id.** DorkOS stamps it on the server. It never comes from a tool argument.
3. **Actions queue per page, not globally.** Two chats act at once on their own tabs. Each lease keeps today's stale-page and Cloud-origin refusal. A Cloud refusal pauses only that lease.
4. **Opening.** If the window is open, Open browser in a chat adds a tab for that chat. If not, it launches the window with that chat's tab. Closing a chat's tab ends only its lease. Closing the window ends all of them.
5. **Agents see only their own tab.** `agentState` and every tool read the lease's page only.
6. **Popups join the opener's chat.** A tab opened by a chat's page belongs to that chat.
7. **Unowned tabs belong to the person.** A tab the person opened is no chat's. The person can give a tab to a chat. Moving a tab to another chat needs the person's OK.
8. **Adopt after a restart.** A chat that restarts can adopt its own orphaned tab, matched on the server-stamped chat id.
9. **Panel.** The panel shows the current chat's page and status. In own-window mode, the "in use in another chat" state goes away. The embedded DorkOS browser stays one holder here; the desktop bridge hands out one guest page per connection (DOR-4289 lifts that).

### Answering BrowserOS's two objections

BrowserOS removed enforced tab ownership on purpose (`page_ownership_notice.rs`). The design has to answer both reasons:

- **"The person's tabs became unreachable."** In DorkOS the person drives through the UI, not through the agent tools. Unowned tabs stay the person's, and the person can give a tab to a chat (design point 7).
- **"A lost session handle orphaned the agent's pages."** Our key is the chat id, which DorkOS stamps on the server, not a protocol session handle. A restarted chat can still adopt its orphaned tab (design point 8).

## Security Musts (DOR-4273, Nov 13)

1. **Each page belongs to one chat, enforced by the server.** The owner comes from DorkOS's chat id, never from a tool argument. No chat can list, read, screenshot, record or drive another chat's page.
2. **A handed-off page belongs to the person.** While the person holds it, no agent can attach to it, read it or screenshot it, including through whole-window captures. Only the person hands it back.
3. **An audit line per page:** agent, chat, page id, each origin visited (no full URLs or tokens), and the open, close and handoff events.
4. **Every existing rule works per page:** site blocks and allows, outsider holds, one active handoff. Test it with two chats at once, one marked outsider, and show the hold applies only to that chat's page.

## Security Shoulds

1. A downloads folder per chat.
2. A cap on open pages.
3. A chat's pages close when the chat ends.

## Patterns we borrow

All permissive licences (MIT, Apache-2.0 with NOTICE, ISC). Copied code keeps its licence header and attribution. AGPL projects are design only, never code.

| Borrow                                                                                                    | From                | Licence             | For                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-tab-{registry,store,tracking,identity,cleanup-claim}.ts`, the tab filter in `browser-request.ts` | OpenClaw            | MIT                 | Ownership by owner key + target id, kept across restarts, filtered tab lists, close-only-if-owner, a per-owner tab cap, idle cleanup. Our owner key is the server-stamped chat id |
| `operator-control.ts`                                                                                     | OpenClaw            | MIT                 | The person-holds-the-page lock: refuses agent input at one boundary, keeps observation for the person, releases on idle or disconnect (Must 2)                                    |
| `bindings.ts`, `core/lock.ts`                                                                             | nanobrowser         | Apache-2.0          | Tab-to-chat binding, moving a tab only with the person's OK, popups join the opener, a per-tab lock                                                                               |
| `tab_locked` / `tab_gone` errors                                                                          | agent-browser       | Apache-2.0 (design) | Clear agent-facing errors for "someone else's tab" and "your tab closed"                                                                                                          |
| Per-page task queue (`ToolHandler.ts`, `McpContext.ts`)                                                   | Chrome DevTools MCP | Apache-2.0          | Actions on one page never interleave                                                                                                                                              |
| `navigation-guard.ts`                                                                                     | OpenClaw            | MIT                 | Per-page allow and block lists, private-network and redirect-chain checks (Must 4)                                                                                                |
| `LEASE_HELD` / `LEASE_REQUIRED`, popups follow the opener                                                 | Skyvern             | AGPL (design only)  | Confirms the error model above                                                                                                                                                    |

## The tab broker boundary

Put the broker in one directory with **no server imports**, so it can become a package later (report §8). It holds:

- owner ids, bind, adopt and release, popups following the opener, idle cleanup and the tab cap, with persistence through an injected store;
- the takeover lease: hold, release, idle timeout, refusing agent input;
- the per-tab action queue;
- URL policy (allow, block, scheme, private network);
- an audit event emitter.

These stay in DorkOS, outside the broker: chat, room and agent identity; permission tiers and approval cards; outsider-content marks (passed in as a callback); profile grants and Forget; the Electron transport; the Chrome launch; all UI. We publish nothing until the broker's API holds steady for two releases.

## Acceptance

- Two chats browse two different sites at once in the agent's own window, sharing sign-ins.
- Each agent reads and acts only on its own tab. A request for another chat's tab gets `tab_locked`; a closed tab gets `tab_gone`.
- Tests cover parallel actions, one lease's pause or Cloud refusal not touching the other, a closed tab ending only its lease, adopting an orphaned tab after a restart, and every Security Must, with two chats at once and one marked outsider.
- **Memory check:** measure the browser's memory (RSS) with 1, 3 and 5 chats open, each on its own made-up local page. Record the numbers in the PR. Run it in CI or a sealed container, never by launching Chrome on a developer Mac.
- The agent-facing instruction block ships in the same release (release gate).
- Security's deep read of the design before build and of the PR before arming.

## Out of scope

- Parallel pages in the embedded DorkOS-browser panel: DOR-4289.
- Named profiles: DOR-3218.
- Streaming the page for remote and cloud viewing: DOR-2667.
- "Use my own Chrome": DOR-3214.
- Publishing the broker as a package.
