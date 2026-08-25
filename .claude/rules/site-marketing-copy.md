---
paths: apps/site/src/layers/features/marketing/**, apps/site/src/app/\(marketing\)/**
---

# Marketing Copy on dorkos.ai

Every string here is read by a stranger deciding whether to trust us. The plain-language contract in `user-facing-writing.md` applies in full: 9th-grade level, short sentences, second person, active voice, no em dashes. This file adds what is specific to the marketing site.

## Voice

- **The category phrase is "one place"** — "All your agents. One place." / "one place for every AI agent you run". Say "the DorkOS app", "the app", "one place" or "one window".
- **Banned words.** "mission control" and "cockpit" are retired and CI-enforced (`scripts/check-banned-words.sh`, `scripts/check-vocab-gate.ts`). Also avoid, though no script catches them: orchestration, coordination, multi-agent, fleet, platform, seamless, powerful, workflow, AI-powered, 10x, and the internal subsystem names (Mesh, Relay, Tasks, Console). A rival's own feature name is the exception — Buzz ships "Workflows" and Roo Code shipped "Orchestrator mode", so name them as they do.
- **DorkOS _is_.** Never "trying to be", "what we're building toward", "aims to", "we think", "arguably", "probably". DorkOS is the fixed point a sentence measures other things against: "DeepSeek Harness is the closest thing on this list to what DorkOS is", never "the closest thing to what DorkOS is trying to be".
- **Condense over pad.** Cut throat-clearing openers, doubled statements, and any sentence whose removal loses nothing. Brevity comes from tighter sentences, never from dropping a fact, a concession or a caveat.

## Honesty

- Claims about DorkOS come from the shipped feature catalog, never from ambition. An unverified surface (`AGENTS.md`, demo-claim gate) is never described as working.
- Facts about other products stay sourced and fair, and keep their evidential honesty. Where a doc genuinely says nothing, write "we found no cap on the messages"; where the fact is verified, state it flat: "There is no phone app."
- Say where the other product is better. Every comparison page does, on the record.

## /compare Structure

`comparisons.ts` is the catalog; `ui/compare/` renders it.

- **DorkOS cells are derived, never authored.** `dorkosCellFor` scores our side from the backing features' status: any alpha or unreleased feature forces `partial` and gets named. Bias belongs in which axes exist, never in a shaded cell. Do not hand-edit a DorkOS verdict, `lastVerified`, or a source.
- **The DorkOS audience column reads first** in every framing, phone and desktop, with `text-brand-green` ticks; the other product keeps `text-brand-orange`. `ComparisonAudience` is the only section that ignores `theirColumnFirst`. The table and the criteria deep-dives both honour it, so a runtime or shut-down page leads with the other product in those two — before-and-after is the point there.
- **`oneLiner` is 120–160 characters** — it is the meta description, and the invariant suite fails outside that range.
- `theirStrengths` entries and `wantPhrase` finish a heading, so both start lowercase and carry no trailing period.
- FAQ answers: 2–5 per page, every one visible on the page rather than behind a click.

`lib/__tests__/comparisons.test.ts` enforces the mechanical half of all this. Run it after any copy edit.
