---
title: Litepaper Review
description: Review and issue tracking for Relay, Mesh, and main DorkOS litepapers.
---

# Litepaper Review — Working Document

**Date:** 2026-02-24
**Status:** In Progress
**Scope:** Review of Relay litepaper, Mesh litepaper, and main DorkOS litepaper v2

---

## Documents Under Review

| Document | Path |
|---|---|
| Main litepaper (v2) | [meta/dorkos-litepaper.md](../../meta/dorkos-litepaper.md) |
| Relay litepaper | [meta/modules/relay-litepaper.md](../../meta/modules/relay-litepaper.md) |
| Mesh litepaper | [meta/modules/mesh-litepaper.md](../../meta/modules/mesh-litepaper.md) |
| Relay design doc | [docs/plans/2026-02-24-relay-design.md](./2026-02-24-relay-design.md) |
| Mesh design doc | [docs/plans/2026-02-24-mesh-design.md](./2026-02-24-mesh-design.md) |
| Main litepaper v1 (archived) | [meta/archive/dorkos-litepaper-v1.md](../../meta/archive/dorkos-litepaper-v1.md) |
| Loop litepaper (tone reference) | [research/loop-litepaper.md](../../research/loop-litepaper.md) |
| Brand foundation | [meta/brand-foundation.md](../../meta/brand-foundation.md) |
| Website modules data | [apps/web/.../marketing/lib/modules.ts](../../apps/web/src/layers/features/marketing/lib/modules.ts) |
| Website architecture UI | [apps/web/.../marketing/ui/SystemArchitecture.tsx](../../apps/web/src/layers/features/marketing/ui/SystemArchitecture.tsx) |

---

## Review Summary

**Contradictions found:** None substantive. The Relay/Mesh responsibility split is consistent across all three litepapers. "Mesh writes rules, Relay enforces them" appears in both module litepapers and the main litepaper. The birthday example tells the same story from three perspectives without conflicting. Delivery guarantees, storage choices, and dependency direction all match.

**Cross-references:** All links between the three litepapers are consistent and point correctly. Module descriptions match across documents.

**Code leakage:** None. Zero TypeScript interfaces or code blocks in either module litepaper. One ASCII diagram in Relay (allowed). None in Mesh (allowed — plan said "one max").

**Tone:** Matches Loop litepaper. Short paragraphs, sentence fragments for emphasis, bold key phrases, no hedging.

---

## Issues

### Issue 1: Architecture diagram — ambiguous "poll" arrow

**Location:** Main litepaper lines 195-196
**Severity:** Medium
**Status:** Resolved

The `│ poll` arrow exits from the bottom of the Engine box, which now visually originates from beneath the Relay section. In v1 it clearly originated from the Pulse box. A reader could interpret this as "Relay polls Loop" when it's actually "Pulse polls Loop." The arrow's source is ambiguous because Pulse, Relay, and the Engine closing brace are stacked vertically.

**Resolution:** Switched all litepaper diagrams from ASCII art to Mermaid. Mermaid arrows have unambiguous sources — the `Pulse -- poll --> Loop` edge clearly originates from Pulse. Also converted Relay litepaper send flow and Loop litepaper feedback cycle for consistency. Mermaid renders natively in GitHub, Obsidian, Fumadocs, and VS Code.

---

### Issue 2: "A voice" metaphor is strained

**Location:** Main litepaper line 38
**Severity:** Low
**Status:** Resolved — kept intentionally

The bullet reads: `**A voice** — a universal message bus for agents, humans, and external services`. The word "voice" implies speaking outward (which matched v1's "outbound communication"). A "universal message bus" is bidirectional — it handles receiving just as much as sending. The metaphor now covers more ground than the word supports.

**Resolution:** Kept as-is. The bullet list is poetry, not documentation — every metaphor is imprecise ("heartbeat" doesn't pump blood, "memory" doesn't remember). "Voice" captures the most emotionally resonant transformation: agents go from mute to communicative. The description after the dash ("universal message bus") does the precision work. Alternatives ("nervous system", "switchboard", "language") either overlap with "A network" (Mesh) or lose the human resonance.

---

### Issue 3: Loop litepaper link is broken (pre-existing)

**Location:** Main litepaper line 163
**Severity:** Medium
**Status:** Resolved

`[Loop Litepaper](./loop-litepaper.md)` resolves to `meta/loop-litepaper.md`, but the Loop litepaper lives at `research/loop-litepaper.md`. This was broken in v1 — not introduced by our changes.

**Resolution:** Fixed link to `../research/loop-litepaper.md`.

---

### Issue 4: "Seven modules" includes Loop, which "is not part of DorkOS" (pre-existing)

**Location:** Main litepaper line 60 vs line 159
**Severity:** Low
**Status:** Resolved

Line 60: "DorkOS is seven modules." Line 159: "Loop is not part of DorkOS. It's a separate, fully deterministic data system." If Loop isn't part of DorkOS, there are six DorkOS modules plus one companion product. Pre-existing inconsistency — not introduced by our changes.

**Resolution:** Replaced the flat "seven modules" framing with a three-tier taxonomy matching the website architecture: **platform** (Engine, Console), **composable modules** (Pulse, Relay, Mesh — independent npm packages), and **extensions** (Wing, Loop). Updated Engine description from "host for" to "composes" the modules. Changed Loop from "not part of DorkOS" to "a standalone product that extends DorkOS." Added "(Extension)" label to Wing and Loop section headers. Also noted that the website needs Relay and Mesh description updates to match the redesign.

---

### Issue 5: Relay budget enforcement — phasing mismatch between prose and roadmap

**Location:** Relay litepaper lines 86-103 (prose) vs line 151 (roadmap)
**Severity:** Medium
**Status:** Resolved

The prose describes budget envelope enforcement as inherent to the delivery flow — "Before every delivery, Relay checks..." and the diagram shows budget checking inline with the send flow. But the roadmap placed budget enforcement in **Phase 2**, not Phase 1.

**Resolution:** Merged budget enforcement into Phase 1 ("Core Transport and Safety"). Budget checking is the safety mechanism that makes autonomous agent communication viable — shipping without it means no loop prevention. Renamed Phase 2 to "Advanced Reliability" (rate limiting, circuit breakers, backpressure) which are genuinely separable from core safety.

---

### Issue 6: Relay "What Relay Enables" — tense ambiguity

**Location:** Relay litepaper lines 119-129
**Severity:** Low
**Status:** Resolved — kept intentionally

This section describes Console-as-endpoint and Pulse-through-Relay as present-tense capabilities ("With Relay, the Console is..."), but the roadmap puts these in Phase 4. The "Today... With Relay..." framing partially mitigates this.

**Resolution:** Kept as-is. Litepapers describe vision in present tense — that's how you communicate conviction. The "Today... With Relay..." framing already signals future state. The roadmap section provides the phased reality for readers who want it. Adding qualifiers would weaken the confident tone that matches Loop litepaper conventions.

---

## Open Design Questions

These are architectural gaps surfaced during review. The litepapers don't necessarily need to resolve them, but they should be tracked for the design phase.

### OQ-1: How do agents send messages through Relay?

**Status:** Open

The Mesh litepaper mentions "It calls a Mesh MCP tool" (line 96) for discovery. But neither litepaper explains the agent-facing mechanism for *sending*. The design doc specifies MCP tools (`relay_send`, `relay_inbox` — Mesh design doc line 183), and the Relay litepaper describes Engine subscribing to receive messages (line 129), but the send-side interaction is absent.

An agent in a Claude Code session would presumably call an MCP tool to send a Relay message, but this isn't stated in any litepaper. The mechanism is important because it determines the developer experience — is sending a message as simple as calling a tool?

---

### OQ-2: Lazy activation — what happens when a message arrives for an offline agent?

**Status:** Open

Mesh litepaper roadmap mentions this (line 126: "Lazy activation — start an agent when a message arrives"). The Relay litepaper's delivery model assumes endpoints are live — messages land in a Maildir `new/` directory, and delivery is done. But who triggers the agent startup?

This is fundamental to the "every project is an agent" model since most project-agents won't be running at any given time. The Maildir naturally queues unprocessed messages, but the activation mechanism is undesigned.

**Design doc references:** Mesh design doc line 263 ("How does lazy activation work?") lists this as an open question.

---

### OQ-3: Agent identity fallback when no manifest exists

**Status:** Open

The Mesh litepaper says "A unique ID" in the manifest (line 42) and "The manifest is optional" (line 54). But if there's no manifest, where does the agent's ID come from? The Relay subject address `relay.agent.{project}.{agentId}` requires an ID.

The Mesh design doc (line 165-169) lists this as an open question with options: manifest ID, directory path hash, git remote URL. Research recommends "manifest ID if present, path hash as fallback." The litepaper is silent on the fallback.

---

### OQ-4: Relay access control not mentioned in Relay litepaper

**Status:** Open

The Relay design doc describes a full access control model (lines 282-299): pattern-based allow/deny rules, priority evaluation, default-allow, hot-reloaded via chokidar. The Mesh litepaper correctly states "Mesh writes rules. Relay enforces them." But the Relay litepaper never mentions that Relay *has* access control at all.

A reader of only the Relay litepaper wouldn't know Relay supports configurable access rules. The "Budget Envelopes" section covers safety, but access control (who can message whom) is a separate concern that's entirely absent.

**Possible fix:** Add a brief mention in the "Part of the DorkOS Suite" section or the "How Messages Flow" section — one paragraph noting that Relay supports pattern-based access rules that higher layers (Mesh) configure.

---

### OQ-5: `deadline` vs `ttl` redundancy in budget envelope

**Status:** Open

The design doc's `RelayBudget` interface (Relay design doc lines 46-53) has both `ttl` (Unix timestamp expiry) and `deadline` (wall-clock deadline). Both are time-based expiry mechanisms. The Relay litepaper only mentions TTL (line 96). The design doc never explains the distinction.

This may be intentional (TTL for the message, deadline for the overall conversation chain?) or it may be redundant. Should be resolved during implementation.

---

### OQ-6: Backpressure handling

**Status:** Open

The Relay design doc lists this as an open question (line 510): "How does Relay handle backpressure when an endpoint is overwhelmed?" Neither litepaper addresses it. For a local single-machine system this may not be critical, but a busy agent with a high-volume Slack channel subscription could fill its mailbox faster than it can process messages.

---

### OQ-7: Voice/streaming interaction with message + signal model

**Status:** Open

The Relay design doc asks (line 511): "How does voice streaming interact with the message + signal model?" Neither litepaper addresses this. Voice is mentioned as a potential adapter target (Relay litepaper line 109) but the real-time streaming requirements of voice don't map cleanly to either Messages (too persistent) or Signals (too ephemeral — no content delivery).

---

### OQ-8: Wing interaction with Relay and Mesh

**Status:** Open

Neither module litepaper mentions Wing. The main litepaper's workflow mentions Wing injecting context (step 4, line 210), but the relationship between Wing and the messaging/discovery layers is undefined.

When an agent receives a message through Relay, does Wing automatically inject context into the agent session? Does Mesh expose Wing data as part of agent manifests? The Mesh design doc asks this (line 267): "How does Mesh interact with Wing (persistent memory) when Wing is built?"

---

## Minor Observations (No Action Required)

- **Line counts:** Relay litepaper is 166 lines (plan estimated 230-250). Mesh litepaper is 137 lines (plan estimated 180-200). All planned sections are present — the estimates were high. Content is dense and complete.

- **Signal type enumeration:** Relay litepaper line 44 lists "typing indicators, read receipts, presence updates, progress notifications." Main litepaper line 116 says "typing, presence, receipts." Minor inconsistency in what's listed, but both are non-exhaustive examples.

- **`relay.human.console.{userId}` implies multi-user:** Relay litepaper line 123. DorkOS is currently single-user (no auth). The `{userId}` likely means "device/client identifier" rather than user identity. The litepaper doesn't clarify this, but it's a minor point for a vision document.

---

## Resolution Log

| Item | Date | Resolution |
|---|---|---|
| Issue 1 | 2026-02-24 | Switched all litepaper diagrams to Mermaid. Poll arrow now unambiguously originates from Pulse. Also converted Relay send flow and Loop feedback cycle for consistency. |
| Issue 2 | 2026-02-24 | Kept "A voice" intentionally. The bullet list is evocative shorthand; the description after the dash provides precision. |
| Issue 3 | 2026-02-24 | Fixed broken link: `./loop-litepaper.md` → `../research/loop-litepaper.md`. |
| Issue 4 | 2026-02-24 | Replaced "seven modules" with three-tier taxonomy (platform / modules / extensions). Fixed Loop contradiction. Website Relay/Mesh descriptions flagged as needing update. |
| Issue 5 | 2026-02-24 | Merged budget enforcement into Relay Phase 1. Renamed Phase 2 to "Advanced Reliability." |
| Issue 6 | 2026-02-24 | Kept as-is. Litepapers describe vision in present tense. The "Today... With Relay..." framing already signals future state. |
| Website updates | 2026-02-24 | Updated Relay description (universal message bus), Mesh description (discovery + topology + access control), Loop status (available + url to looped.me) in `modules.ts`. Updated `SystemArchitecture.tsx` to render "Live" badge and link for modules with external URLs. Updated `brand-foundation.md` Relay/Mesh sections and Loop status. Updated main litepaper Loop status to "Live" with link. |

<!-- When an item is discussed and resolved, add a row here and update the item's Status above -->
