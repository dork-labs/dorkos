---
number: 221
title: Target Electron 39.x for electron-vite v5 Upgrade
status: proposed
created: 2026-04-01
spec: upgrade-electron-vite
superseded-by: null
---

# 221. Target Electron 39.x for electron-vite v5 Upgrade

## Status

Proposed

## Context

The desktop app's electron-vite upgrade from v3.1.0 to v5.0.0 required a decision on which Electron version to target. At the time of the upgrade (April 2026), the latest stable Electron is 41.1.1. However, electron-vite v5.0.0 was released in December 2025 and its build target matrix explicitly validates Electron 32–39. Electron 40 introduced a major breaking change: it switched the bundled Node.js runtime from 22.x to 24.x, making it a different ABI family.

## Decision

We target Electron 39.8.5 (the latest patch in the 39 line) rather than the absolute latest Electron release. Electron 39 is the last line shipping Node.js 22.x, which is the version our development environment (22.17.1) and CI (`node-version: 22`) already use. electron-vite v5 has explicit build targets for Electron 39 but has not published targets for Electron 40+. Upgrading to Electron 40/41 is deferred until electron-vite adds build targets for Node.js 24.

## Consequences

### Positive

- Electron 39 is fully validated by electron-vite v5 — no risk of build-target gaps
- Node.js 22.x ABI continuity with existing dev and CI environment
- Native module (`better-sqlite3`) rebuild is straightforward — same ABI family from 33→39
- Electron 39 graduates ASAR integrity validation to stable (security improvement)

### Negative

- We are ~2 Electron major versions behind the absolute latest at the time of the upgrade
- Electron 40/41 improvements (Node.js 24 APIs, performance) are unavailable until a follow-up upgrade
- Requires a second upgrade pass once electron-vite adds Electron 40+ build targets
