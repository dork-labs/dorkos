---
id: 261119-190201
title: One real Chrome per agent, two views
status: accepted
created: 2026-11-19
spec: agent-browser-page-stream
superseded-by: null
amends: null
---

# 261119-190201. One real Chrome per agent, two views

## Status

Accepted direction (Dorian and PM, November 19). The bridge (DOR-4741) and streamed panel (DOR-2667) are not implemented by this record.

## Context

The embedded desktop panel and Chrome's own window use different engines and sign-in stores. Switching between them can leave an agent with a different page or signed out. Each agent needs its own profile, while the person needs to watch and control that same page in either view.

## Decision

We will run each agent's profile in one engine: real Chrome, with one set of sign-ins. The DorkOS panel will stream that Chrome page, so the panel and own window show and control the same page ([streaming spec](../specs/agent-browser-page-stream/02-specification.md)). Until then, the panel is **Your browser** only and agent tabs live in their own Chrome window (DOR-4741). We will not sync cookies or other sign-in state between the Electron partition and Chrome.

## Rejected option

Copying cookies between Electron and Chrome keeps two engines and two sign-in stores. Chrome encrypts its cookies; copying them also conflicts with the no-copy decision and DOR-4136. It cannot provide the single live page required here. The [parallel embedded-pages plan](../specs/agent-browser-panel-parallel-pages/02-specification.md) is superseded by streaming, and DOR-4289 is canceled.

## Consequences

### Positive

- Switching views keeps the agent's page, profile and sign-ins together.
- Agents keep separate profiles; **Your browser** remains the person's browser.
- One engine removes the need to keep two sign-in stores in step.

### Negative

- The panel needs frame streaming and input handling before it can show and control agent pages.
- Until streaming ships, watching or taking over an agent page requires its own Chrome window.
- Stream latency and handoff restoration need proof on the release build in every shipped view, under the [live release check](../contributing/browser-verification.md#live-agent-browser-release-check).
