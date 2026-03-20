# Fix Relay History Rendering & Remaining SSE Delivery Gaps

## Origin

Chat self-test run 2 (2026-03-06). See `plans/2026-03-06-chat-self-test-findings.md`.

## Problem

Three critical bugs when Relay is enabled:

1. User messages completely missing from history reload
2. Skill tool_result content leaks as user messages in history
3. SSE `done` event still not delivered ~20% of the time

Secondary: 503 flood from SSE registration using Agent-ID instead of SDK-Session-ID.

## Root Causes

1. `transcript-parser.ts:231` — `startsWith('<relay_context>')` skips the entire message including user content after `</relay_context>`
2. `transcript-parser.ts:211-220` — renders text parts from tool_result+text messages as user messages
3. Remaining SSE gap in relay pipeline — `done` event not reaching client despite four-layer fix
4. `sessions.ts:351` — passes raw Agent-ID to registerClient without SDK-Session-ID translation

## Deeper Code Quality Issues (from review)

- transcript-parser.ts has DRY violations: duplicated tool_result handling (lines 164-181), duplicated command emission (lines 196-259)
- parseTranscript() is 220 lines with 4-level nesting, embedded state machine — exceeds complexity limits
- Magic strings for tool names (`'Skill'`, `'AskUserQuestion'`) instead of constants
- session-broadcaster.ts has unsafe async closure initialization, stringly-typed errors
- sessions.ts POST handler mixes lock management, relay dispatch, and SSE streaming

## Decision

Create a proper fix that addresses root causes while cleaning up the affected code quality issues.
