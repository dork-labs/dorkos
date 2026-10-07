---
paths: apps/site/src/layers/features/marketing/**, apps/site/src/app/\(marketing\)/**, apps/site/src/app/llms.txt/**, apps/site/src/app/opengraph-image.tsx
---

# Marketing Copy on dorkos.ai

Every string here is read by a stranger deciding whether to trust us. The primary reader is the founder who builds a business mostly with agents (`meta/personas/the-ai-native-founder.md`); Kai, the developer running many agents (`meta/personas/the-autonomous-builder.md`), comes second. The plain-language contract in `user-facing-writing.md` applies in full: 9th-grade level, short sentences, second person, active voice, no em dashes. This file adds what is specific to the marketing site.

## What to say

`meta/VOICE.md` is the single source for what the site says: the message stack in use, the headline rules, the words we use and the words and claims we never use. `meta/VISION.md` has the stack itself and the three differentiators; `meta/ROADMAP.md` has the demo-claim gate (what may be described as working, including exactly how far mini apps go today). Read them before you change a hero, a title, a meta description or a feature list. Do not restate their lists here or in a component comment; link to them.

What is specific to the site:

- **The hero is the message stack**, and below it the three differentiators are the structure, in order: mini apps, built for founders, ownership. Mini apps lead every pitch and feature list.
- **Titles, meta descriptions, OG cards and `llms.txt` are headline copy**, under the headline rules.
- **The LifeOS and flow dashboards are internal proof**, never a public demo.

## Voice

- **Site style words to avoid** (on top of `meta/VOICE.md`), though no script catches them: orchestration, coordination, multi-agent, fleet, platform, seamless, powerful, workflow, AI-powered, 10x, and the internal subsystem names (Mesh, Relay, Tasks, Console). A rival's own feature name is the exception: Buzz ships "Workflows" and Roo Code shipped "Orchestrator mode", so name them as they do.
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
