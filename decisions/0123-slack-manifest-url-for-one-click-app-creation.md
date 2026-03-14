---
number: 123
title: Use Slack Manifest URL for One-Click App Creation
status: draft
created: 2026-03-14
spec: adapter-setup-experience
superseded-by: null
---

# 0123. Use Slack Manifest URL for One-Click App Creation

## Status

Draft (auto-extracted from spec: adapter-setup-experience)

## Context

Setting up a Slack adapter requires configuring Socket Mode, Event Subscriptions (4 bot events), OAuth scopes (11 bot scopes), and a Bot User — any of which can be misconfigured. During live testing, we discovered that enabling "Agents & AI Apps" silently adds user-level scopes that cause `invalid_scope` errors on most workspace plans. Slack's API supports a manifest URL scheme (`https://api.slack.com/apps?new_app=1&manifest_yaml=<encoded>`) that pre-fills all app configuration from a YAML manifest.

## Decision

Generate a YAML manifest containing all required DorkOS Relay configuration (Socket Mode, bot events, OAuth bot scopes, bot user) and URL-encode it into the adapter's `actionButton.url`. Users click "Create Slack App" and Slack opens with everything pre-filled. The manifest explicitly excludes user scopes to avoid the "Agents & AI Apps" pitfall.

## Consequences

### Positive

- Eliminates the most error-prone part of Slack setup (manual scope/event configuration)
- One click replaces ~8 manual configuration steps across 4 Slack settings pages
- Prevents the critical "Agents & AI Apps" pitfall by not including user scopes
- No secrets in the URL — only public scope/feature configuration

### Negative

- If Slack changes the manifest format or URL scheme, the link breaks
- The manifest YAML must be kept in sync with adapter requirements
- Users who need custom scopes must edit the app after creation
