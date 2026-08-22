---
id: 260822-083227
title: Every route declares its header as typed staticData, not a shell-side switch
status: accepted
created: 2026-08-22
spec: one-bar-header
superseded-by: null
amends: null
---

# 260822-083227. Every route declares its header as typed staticData, not a shell-side switch

## Status

Accepted — shipped in PR #1161 (DOR-1400).

## Context

The app shell used to map routes to header components through a hardcoded `switch (pathname)` (`useHeaderSlot` in AppShell), a second registry that had to be kept in sync with `router.tsx` by hand. A route added without a matching case rendered a silently wrong header, and per-route header props were plumbed through the shell's own state.

## Decision

Every TanStack route declares its header component in `staticData.header` in `router.tsx`, and the `StaticDataRouteOption` augmentation makes the field required — a route without a header is a compile error, not a runtime surprise. AppShell resolves the matched chain leaf-first (`resolveRouteHeader`) and keys its cross-fade on the header component's identity, so several routes sharing one bar (the home surfaces) keep a single mounted instance across navigation. Per-route data rides a typed `OneBarProvider` context; header components take zero props.

## Consequences

- Adding a route forces the header question at the type level; the route and its header live in one file.
- Component-identity keying is load-bearing: shared bars survive tab switches (no remount flicker), distinct bars still cross-fade. Inline arrow headers in route declarations would mint new identities per render and must stay module-level consts.
- Test/dev routers must satisfy the required field (`header: null` for shell-less trees) — a small tax the compiler collects.
