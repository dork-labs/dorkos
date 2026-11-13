---
slug: agent-browser-panel-parallel-pages
id: 261113-215632
created: 2026-11-13
status: draft
---

# Agent browser: a page per chat in the DorkOS-browser panel

**Status:** Draft. Security reviews the design before build and the PR before arming.
**Author:** DorkOS Code (agent)
**Date:** 2026-11-13
**Tracker:** DOR-4289 (Should, after DOR-4273)
**Builds on:** [`specs/agent-browser-tab-per-chat/`](../agent-browser-tab-per-chat/02-specification.md)
**Why:** [Agent browser: keep building, adopt, or package?](../../research/20261113_agent-browser-build-vs-adopt.md)

## Overview

DOR-4273 gives each chat its own tab in the agent's own Chrome window. This spec does the same for the **DorkOS browser**: the live page shown inside the desktop app's right panel. Dorian uses the panel, so parallel chats have to work there too.

## Today

- The desktop bridge (`apps/desktop/src/main/local-browser/index.ts`) already keeps a map of guest pages, one per connection. Each is a `WebContentsView` in one shared session, `persist:dorkos-local-browser`.
- Each guest has its own debugger transport (`page-transport.ts`). It is scoped to that one page and refuses browser-wide and storage commands.
- The limit is above the bridge: the server's `LocalBrowserService` allows one holder per install, and the panel tells every other chat "Shared with another chat. Disconnect to use it here." (main). DOR-4265 (#3713) changes that to "This browser is open in another chat" with a **Take it here** button.

So the bridge is close to ready. The work is mostly on the server and in the panel.

## The open question, and the spike

**Do two guest pages in `persist:dorkos-local-browser` share sign-ins live?** They share one Electron session, so they should share one cookie jar and storage. We have not proven it with two pages open at once, and the answer decides the design.

**Spike (half a day, before build):**

1. A made-up local site sets a session cookie on sign-in and shows "signed in" when the cookie is present.
2. Open guest A and guest B for two test chats. Sign in on A.
3. Reload B. Pass: B shows "signed in" without signing in again.
4. Sign out on B. Pass: A shows "signed out" after a reload.
5. Forget sign-ins (`forget-sign-ins.ts`) with both open. Pass: both lose the sign-in, and both guests close or reload cleanly.

Run it under the desktop test harness in CI, never by launching the packaged app on a developer Mac. If step 3 fails, stop and write up the gap: a shared-session design is then not possible, and we pick between one shared guest with tab switching or parallel pages only in own-window mode.

## Design (if the spike passes)

1. **One guest per chat lease.** The server's per-chat lease from DOR-4273 maps to one guest connection id. A second chat opening the panel gets its own guest, in the same session.
2. **The panel shows the current chat's guest.** Switching chats swaps which guest view is visible. Hidden guests keep running; bounds and visibility already work per guest.
3. **Popups follow the opener.** The bridge already ties popups to their guest. Each popup belongs to the same chat as its opener.
4. **Forget and Disconnect** close every guest, as today.
5. **Caps.** The page cap from DOR-4273 counts panel guests and own-window tabs together.

## Security Musts (the DOR-4273 Musts, applied to the panel)

1. **Each page belongs to one chat, enforced by the server.** The owner comes from the server's chat id. No chat can list, read, screenshot, record or drive another chat's guest.
2. **A handed-off page belongs to the person.** While the person holds it, no agent can attach, read or screenshot it. **Whole-window captures matter more here than in own-window mode:** the panel lives inside the DorkOS window, and the desktop capture path (`apps/desktop/src/main/capture/`) captures that window with `capturePage()`. A capture for chat A must not show chat B's guest, or any guest the person holds. Hide other guests during an agent capture, or refuse the capture while another chat's guest is visible.
3. **An audit line per page:** agent, chat, page id, each origin visited (no full URLs or tokens), and the open, close and handoff events.
4. **Every existing rule works per page:** site blocks and allows, outsider holds, one active handoff. Test with two chats at once, one marked outsider.

## Acceptance

- The spike's five steps pass in CI and are kept as a test.
- Two chats each drive their own panel page at once, sharing sign-ins.
- Switching chats shows the right page. A hidden guest keeps its state.
- Agent captures never include another chat's guest or a person-held page.
- Tests cover every Must with two chats at once, one marked outsider.
- Memory: add 3 and 5 panel guests to the DOR-4273 memory check.
- Designer sign-off on the panel's chat-switch states (light, dark, 390 px).

## Out of scope

- Parallel pages on the web app or phone. They have no embedded panel. They see the page through the stream (DOR-2667).
- Separate saved sign-ins per agent (DOR-3218).

## Order and date

After DOR-4273 merges. Target: **Thu Dec 3, 2026** (spike Mon Nov 30, build Dec 1 to 3).
