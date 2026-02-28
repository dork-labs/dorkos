---
number: 48
title: Adopt llms.txt for AI Agent Discoverability
status: draft
created: 2026-02-28
spec: og-seo-ai-readability-overhaul
superseded-by: null
---

# 48. Adopt llms.txt for AI Agent Discoverability

## Status

Draft (auto-extracted from spec: og-seo-ai-readability-overhaul)

## Context

AI assistants are increasingly where developers discover tools. When someone asks "what's a web UI for Claude Code?", the AI needs structured content to cite DorkOS. There is currently no machine-readable entry point for AI agents visiting the site — they must parse HTML marketing pages to understand what DorkOS does. The llms.txt standard (proposed by Jeremy Howard, September 2024) has been adopted by Anthropic, Vercel, Stripe, Cloudflare, and Svelte, with 844,000+ implementors by October 2025.

## Decision

Add a static `llms.txt` file at `apps/web/public/llms.txt` following the llms.txt standard format: heading, blockquote summary, sections with markdown links to documentation. Skip `llms-full.txt` (full documentation dump) for now — the structured links in `llms.txt` are sufficient and low-maintenance.

## Consequences

### Positive

- Near-zero implementation and maintenance cost (static file)
- Improved discoverability when AI agents answer developer questions
- Follows an emerging standard adopted by major players
- No runtime performance impact (served as static asset)

### Negative

- Doc link accuracy depends on manual updates if doc slugs change
- The standard is a proposal, not an RFC — format may evolve
- No `llms-full.txt` means AI agents still need to follow links for full content
