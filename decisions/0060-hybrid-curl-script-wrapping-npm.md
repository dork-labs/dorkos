---
number: 60
title: Use Hybrid Curl Script Wrapping npm for Primary Install
status: draft
created: 2026-03-01
spec: installation-experience
superseded-by: null
---

# 0060. Use Hybrid Curl Script Wrapping npm for Primary Install

## Status

Draft (auto-extracted from spec: installation-experience)

## Context

DorkOS is a Node.js application (Express + React + Claude Agent SDK) that currently distributes only via `npm install -g dorkos`. Every competitor in the space (Claude Code, OpenClaw, OpenCode, Codex) offers 3+ install methods with `curl | bash` as the dominant primary method. The `npm install -g` pattern signals "side project" while `curl -fsSL https://dorkos.ai/install | bash` signals "first-class infrastructure."

Two approaches exist for adding curl support: (1) compile to a standalone binary (like Claude Code's bootstrap.sh) or (2) wrap npm inside a curl script (like OpenClaw's install.sh). Binary compilation requires migrating to Bun compile or pkg, a significant architectural change with ongoing maintenance burden.

## Decision

Use the hybrid approach: a bash install script served at `https://dorkos.ai/install` that wraps `npm install -g dorkos` but adds Node.js version detection, dependency validation, clean post-install messaging, and an optional setup wizard prompt. The script is served via a Next.js Route Handler for cache control and clean URL routing.

This provides the `curl | bash` UX without requiring binary compilation, keeping the existing npm distribution channel as the underlying mechanism.

## Consequences

### Positive

- Achieves install UX parity with competitors in days rather than weeks
- No new build tooling, CI/CD pipelines, or platform-specific binaries to maintain
- Existing npm install path remains unchanged (backward compatible)
- Script adds value over raw npm: pre-flight checks, helpful errors, post-install guidance
- Security surface is identical to running `npm install -g` directly

### Negative

- Still requires Node.js 18+ as a prerequisite (unlike Claude Code's standalone binary)
- Cannot offer true offline or air-gapped installation
- npm resolution time (~15-30s) is visible to the user during install
- No auto-update mechanism possible without binary distribution
- May need to revisit if/when DorkOS moves to binary distribution via Bun compile
