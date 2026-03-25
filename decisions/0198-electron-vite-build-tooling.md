---
number: 198
title: Use electron-vite for Electron Build Tooling
status: draft
created: 2026-03-24
spec: electron-desktop-app
superseded-by: null
---

# 0198. Use electron-vite for Electron Build Tooling

## Status

Draft (auto-extracted from spec: electron-desktop-app)

## Context

The DorkOS monorepo uses Vite 6 for the client and Obsidian plugin builds. Adding an Electron app requires bundling three targets: main process (Node.js), preload scripts (Node.js with Electron APIs), and renderer (browser). Two options were considered: Electron Forge with its experimental Vite plugin, or electron-vite — a purpose-built Vite integration for Electron.

## Decision

Use electron-vite with a single `electron.vite.config.ts` that drives three Vite configurations (main, preload, renderer). Pair with electron-builder for packaging, signing, and auto-updates.

## Consequences

### Positive

- Single config file for all three targets — consistent with project's Vite-first approach
- Renderer config reuses the same path aliases and Tailwind setup as apps/client
- HMR works in the renderer during development
- electron-builder is the most mature macOS packaging solution (1.1M weekly downloads)

### Negative

- electron-vite compatibility with Vite 6 needs verification early in development
- Different build tooling than the CLI (which uses esbuild) — two bundling strategies in the monorepo
