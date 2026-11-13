---
slug: agent-browser-tab-broker
id: 261113-215636
created: 2026-11-13
status: draft
---

# The tab broker: a boundary we can package later

**Status:** Draft boundary spec. It is built inside DOR-4273 and published only after the criteria below.
**Author:** DorkOS Code (agent)
**Date:** 2026-11-13
**Tracker:** DOR-4273 (the broker is built there); publishing is a Could, revisited mid-December
**Why:** [Agent browser: keep building, adopt, or package?](../../research/20261113_agent-browser-build-vs-adopt.md), §8

## Overview

DOR-4273 needs a small layer that decides which chat owns which tab, who holds a page, and what may run on it. We build that layer as its own directory with **no server imports**, so it can later become a package (working name `@dorkos/agent-browser-core`). It works over a Playwright `Page`. It knows nothing about chats, rooms, permissions or UI; DorkOS passes those in.

The package's value would be the ownership and takeover model, not the browser engine. Free tools with 40k to 50k stars already drive browsers. Treat publishing as an ecosystem bet, not a cost saver.

## Where it lives

`apps/server/src/services/session/local-browser/broker/` during DOR-4273. A lint rule (or a guard test) fails if any file there imports from outside the folder, except `playwright-core` types and Node built-ins.

## API surface

Names are illustrative; DOR-4273 settles them.

```ts
/** Owner ids are opaque strings DorkOS stamps on the server (the chat id). */
type OwnerId = string;

interface TabBroker {
  /** Bind a page to an owner. Fails with `tab_locked` if another owner has it. */
  bind(page: Page, owner: OwnerId): TabLease;
  /** Re-attach an owner to its own orphaned tab after a restart. */
  adopt(owner: OwnerId): TabLease | null;
  /** End a lease. The tab becomes unowned (the person's). */
  release(lease: TabLease): void;
  /** Pages this owner may see. Never another owner's. */
  list(owner: OwnerId): TabLease[];
  /** Popups join the opener's owner. */
  onPopup(opener: TabLease, popup: Page): TabLease;
}

interface TabLease {
  readonly pageId: string;
  readonly owner: OwnerId;
  /** Run one action. Actions on one page run one at a time, in order. */
  run<T>(action: (page: Page) => Promise<T>): Promise<T>;
  /** The person holds the page: agent actions are refused, observation for the person continues. */
  hold(): TakeoverLease;
}

interface TakeoverLease {
  /** Only the person hands it back. On idle or disconnect the page goes back to the person (unowned), never to the agent. */
  handBack(): void;
}
```

Also in the broker:

- **URL policy:** allow and block lists, schemes, private-network and redirect-chain checks (from OpenClaw's `navigation-guard.ts`), checked before every navigation.
- **Page-text fencing:** page text is marked as outsider content before an agent reads it.
- **An audit emitter:** open, close, bind, release, hold, hand-back and each origin visited. No full URLs, no tokens. DorkOS writes the lines into its own audit trail.
- **Limits:** a per-owner tab cap and idle cleanup, with persistence through an injected store.
- **Errors:** `tab_locked` (someone else's tab), `tab_gone` (your tab closed), `page_held` (the person has it), `url_blocked`.

## What stays out (in DorkOS)

- chat, room and agent identity, and who counts as an outsider (passed in as a callback);
- permission tiers and approval cards;
- profile grants and Forget;
- the Electron `webContents` transport and the Chrome launch;
- revision fencing on observe and act, which stays in the service for now;
- all UI.

## Publishing criteria

All of these, before anything goes to npm:

1. **Two releases in a row with no breaking change** to the API above.
2. Its own tests run without the DorkOS server, against made-up local pages, in CI.
3. A README with one complete example over a plain Playwright `Page`.
4. Security reads the public API and the threat notes in the README.
5. Copied code keeps its licence headers and a NOTICE file (OpenClaw MIT, nanobrowser and Chrome DevTools MCP Apache-2.0).
6. The PM decides it is worth the support cost.

## Order and date

Built inside DOR-4273 (Nov 18 to 25). Earliest publish decision: two releases after DOR-4273 ships, about **mid-December 2026**.
