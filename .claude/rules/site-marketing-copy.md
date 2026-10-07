---
paths: apps/site/src/layers/features/marketing/**, apps/site/src/app/\(marketing\)/**
---

# Marketing Copy on dorkos.ai

Every string here is read by a stranger deciding whether to trust us. The primary reader is the founder who builds a business mostly with agents (`meta/personas/the-ai-native-founder.md`); Kai, the developer running many agents (`meta/personas/the-autonomous-builder.md`), comes second. The plain-language contract in `user-facing-writing.md` applies in full: 9th-grade level, short sentences, second person, active voice, no em dashes. This file adds what is specific to the marketing site.

## What to lead with

The canon is "What sets us apart" and "The message stack" in `meta/positioning-202610/00-overview.md` (decided 2026-10-06 and 2026-10-07).

- **The chat workspace is table stakes, not the edge.** Channels, DMs and threads with people and agents are what DorkOS is, and you may say so plainly. Never make them the headline, the lead or the reason to choose DorkOS. Everyone will have them.
- **The three differentiators, always in this order:** (1) **mini apps**: ask for a tool your business needs, and your agents build it inside DorkOS; (2) **built for founders**, not general purpose; (3) **ownership**: your agents, tools, files and data stay yours, wherever they run. They are the structure below the hero (its beats and sections), in that order, and mini apps lead every pitch and feature list.
- **The message stack (the hero, 2026-10-07):** (1) tagline "You, Multiplied." (keep each surface's established casing; the closing section says "You, multiplied."); (2) page title and main headline "Build and run your business with an agent team." (page title exactly "DorkOS: Build and run your business with an agent team"); (3) supporting line "Your agents join your team chat, take on real work, and build the custom tools your company runs on." It replaces "Ask for a tool. Your agents build it.", which may still head a mini apps section. The supporting line is backed by mini apps as they ship (an agent builds an extension, a person approves it) and by Connections (beta); lower copy never promises more (see "What backs the supporting line" in the overview).
- **Headline rules.** Headline copy is the hero, page titles, meta descriptions, OG and Twitter cards, section headlines, the README opening, the npm description and the llms.txt summary line. There, never say "on your computer", "on your own computer" or "runs on your computer" (DorkOS Cloud runs on our servers too), and never the literal words "open source". Say ownership as "yours": "yours to keep", or "Your agents, tools, files and data stay yours, wherever they run." Lower on the page (body text, FAQ, install details, the license section), plain facts like "MIT license" or "runs on your computer or a server" are fine.
- **Claim mini apps exactly as built.** An agent builds one, you say yes, and it opens inside DorkOS in fixed places (its own page, the side panel, the Activity page, the status bar, settings tabs, or a sidebar menu item). Safe verbs: "ask for", "builds", "you say yes", "opens inside DorkOS". Never "any tool", "no code ever", "instantly" or "builds anything". Every agent knowing how, the "inside DorkOS or its own website" choice, ready-made founder mini apps and goals are roadmap: say "coming" or leave them out. The LifeOS and flow dashboards are internal proof, never a public demo.
- **Mini apps versus Shapes.** "Mini apps" is the public name for apps agents build. The app still calls them extensions, so docs say "mini apps (the app calls them extensions)". A Shape is a setup bundle and keeps its name; it can carry mini apps. "Generative UI" is no longer a value word; the chat widgets are supporting proof.
- **Ownership, not local first.** Say "ownership" and "yours". Never "local first" or "local-first" in marketing copy.
- **Never equal accounts.** Never write "agents equal to humans", "equal accounts", "peers", "same account as you", "agents can run the place", "no human required" or "agents can be admins". Agents may be co-workers or teammates.
- **No Discord.** There is none. The official DorkOS Community Space is not built yet: say it is coming, never that it works, and never link to it.

## Voice

- **The category phrase is "a workspace for people and agents"**; the longer form is "the workspace where founders run their business with people and agents". It says what DorkOS is; it is not the headline (see above). "All your agents. One place." is retired as the category line, and runtime names (Claude Code, Codex, OpenCode) never lead a headline. Never redefine the product's Workspaces page (project checkouts) when you use the category word. For the product itself say "the DorkOS app" or "the app".
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
