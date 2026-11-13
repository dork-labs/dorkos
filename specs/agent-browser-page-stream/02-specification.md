---
slug: agent-browser-page-stream
id: 261113-215633
created: 2026-11-13
status: draft
---

# Agent browser: watch and take over the live page from anywhere

**Status:** Draft. Security reviews the design before build and the PR before arming.
**Author:** DorkOS Code (agent)
**Date:** 2026-11-13
**Tracker:** DOR-2667 (Should, re-scoped Nov 13)
**Why this shape:** [Agent browser: keep building, adopt, or package?](../../research/20261113_agent-browser-build-vs-adopt.md), §4b, §5 and §7
**Replaces:** the managed-engine plan in [`specs/shared-browser-control/`](../shared-browser-control/01-ideation.md) (retired)

## Overview

A person can watch the Agent browser's live page, and take it over, from a place that has no panel: the web app, a phone, or a remote computer reached over the tunnel. The same stream is how a person sees a browser running on a cloud agent computer. The page stays where it runs. Only pictures go out, and only input comes back.

## Why a stream

- The embedded panel exists only in the desktop app.
- A cloud agent computer runs its browser on its own display, so a person always needs a stream there.
- Of the forms that pass through DorkOS's HTTP routes and tunnel, a page-level screencast plus input is the smallest. It keeps the person's input on one page, never the whole desktop.
- **No WebRTC.** WebRTC (Kernel, neko) needs a UDP or TCP mux port, and our tunnel carries HTTP only.

## What we reuse

**Our own prototype viewer**, ported from `scripts/browser-control-prototype/` onto the live Agent browser:

| File                 | Lines | What it does                                                                                      |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `viewer.mjs`         | ~490  | Serves frames over plain HTTP. Each `/frame` request carries the receipt for the last frame drawn |
| `viewer-client.mjs`  | ~490  | Draws frames, sends a receipt only after paint, and sends pointer and keyboard input              |
| `viewer-pointer.mjs` | ~50   | Shows the page's pointer and caret, scaled per viewport                                           |
| `manager-input.mjs`  | ~140  | Turns viewer input into page input                                                                |
| `viewer-page.html`   | ~140  | The viewer page shell                                                                             |

Properties we keep:

- **One pending frame at most.** A slow viewer drops old frames instead of piling them up.
- **A receipt after paint.** A missing, wrong or replayed receipt is refused.
- **Viewer lifetime never owns the page.** Closing a viewer never closes the browser.

**From Steel** (`page-screencast.ts`, `casting.handler.ts`, Apache-2.0): one screencast fanned out to many viewers, each with its own backpressure. **From dsh-browser-agent** (`pane.ts`, `login-mode.ts`, ISC): start the screencast on the first viewer and stop it on the last, and deny page reads while the person types credentials.

## Design

1. **Source.** Chrome's `Page.startScreencast` on the chat's own page, from the live service (`apps/server/src/services/session/local-browser/`). It runs only while at least one viewer is watching.
2. **Fan-out.** One screencast per page. Each viewer has its own one-frame slot. A slow viewer never slows a fast one.
3. **Transport.** Plain HTTP routes in the server's normal request chain: a frame request with a receipt, and an input post. They go through the same session gate and tunnel as every other route. No new port.
4. **Who can watch.** Only people allowed to see that chat. Agents never get the stream; they keep the existing observe tools for their own page.
5. **Taking over.** Input from a viewer is accepted only while the person holds the page (DOR-4273's takeover lease). Pressing Take over starts a handoff; the agent stops; **Hand back to {Agent}** returns it. (These are the planned names from the "who's driving" strip, DOR-4107, not buttons on main today. On main, the handoff card's buttons are **Continue** and **Stop task**.) While the person holds it, Security Must 2 applies: no agent reads or screenshots that page.
6. **Sign-in.** While the person is typing in a password field, page reads and screenshots for agents are denied (the dsh pattern), and the audit line records only that a sign-in happened.
7. **Audit.** One line per viewer session: person, chat, page id, origin, start, end, and whether they took over.

## Acceptance

- **Latency**, measured from a pointer event in the viewer to that change drawn in the viewer, 100 samples each:
  - local: p95 under 250 ms;
  - with 150 ms of added round-trip delay: **p95 under 600 ms**.
    The prototype passed both (163 ms and 543 ms p95, `specs/shared-browser-control/05-prototype-evidence.md`), but on the managed engine and with injected delay, not a real tunnel. Re-measure on the live service, and once through a real tunnel.
- **Many viewers:** three viewers on one page. One stalled viewer does not raise the others' p95 above 250 ms locally. The stalled viewer holds at most one pending frame.
- **No viewers, no screencast:** the screencast stops within 5 seconds of the last viewer leaving.
- Take over and **Hand back to {Agent}** work from the web app at 390 px wide, by touch and by keyboard.
- An agent cannot read or screenshot a page the person holds through the stream (Must 2), tested.
- A viewer for chat A cannot get frames from chat B's page (Must 1), tested.
- Runs in CI against made-up local pages. No real sites, and no Chrome launched on a developer Mac.

## Tunnel notes

- Frames are JPEG, sized to the viewer. Keep each under the prototype's frame limit, and lower quality before frame rate when bandwidth drops.
- The tunnel adds round-trip time to every receipt. The one-pending-frame rule keeps a slow link from building a backlog.
- Measure once over the real tunnel and record the numbers. The 600 ms target was set for injected delay; if the tunnel misses it, say so in the PR rather than loosening the target.

## Out of scope

- Whole-desktop streaming of a cloud computer (Selkies or noVNC). That belongs to the agent-computer work.
- Routing a cloud browser through the person's home network (DOR-4290).
- Recording streams.

## Order and date

After DOR-4273 (it needs the per-chat lease) and in parallel with DOR-4289. Target: **Fri Dec 11, 2026** (port Dec 3 to 7, take-over and tests Dec 8 to 10, tunnel measurement Dec 11).
