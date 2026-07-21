---
slug: channel-sender-identity
id: 260721-215837
created: 2026-07-21
status: implemented
---

# Implementation Record — channel-sender-identity

**Shipped:** 2026-07-21, PR #396, squash-merged as `a54ba2f74`. Tracker DOR-411 (Done).

All 4 tasks from `03-tasks.json` delivered:

- `extractSenderIdentity` + `sanitizeIdentity` in `packages/relay/src/lib/payload-utils.ts` — the single sanitization choke point.
- `formatPromptWithContext` (`agent-handler.ts`) inserts `Sender:`/`Chat:` after `From:`; byte-identical without identity (regression-pinned).
- `classify-origin.ts` composes `"<Platform> · <chat ?? sender>"` for channel origins (60-char cap); lockstep fixture updated.
- Suites: relay 171, classify-origin 28; CI fully green.

**Deviations from the spec (both hardening additions found in review):**

1. The sanitizer's control-strip class was widened from C0+DEL to C0+C1+DEL — pre-PR review found NEL (U+0085) survived and could visually forge header lines.
2. Angle brackets are stripped — the automated PR review found a display name containing the literal `</relay_context>` could close the structured block early and shift the consumer's `indexOf` boundary. §Detailed Design was updated in lockstep.
