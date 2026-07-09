# Brand Doc Changes: brand-foundation, customer-voice, value-architecture, personas

> Positioning review deliverable (July 2026). Concrete edits to the existing meta docs, with reasons. The docs are structurally sound; most changes are (a) catching the docs up to the shipped product, (b) folding in the market shift from `01-market-landscape.md`, and (c) finishing the pro-human sweep that Decision 16 started.

## 1. `brand-foundation.md`

1. **Update the runtime story everywhere** (sections 1, 6.1). "Claude Code first, Codex/OpenCode coming" is now false in the good direction: all three are shipped, conformance-tested, per-session switchable. This upgrades an aspiration into the brand's strongest proof point; the doc currently undersells its own best fact.
2. **Add vendor neutrality as a named brand position** (new subsection under Core Brand Position). One paragraph: DorkOS is structurally neutral across model vendors; first parties cannot be; every model release is marketing for the neutral layer. This is the answer-of-record to "what if Anthropic builds this?" and belongs in the foundation, not scattered in chat logs.
3. **Add a security stance to "We Believe" and the Honesty note** (sections 7, 9). Post-OpenClaw, "self-hosted" without "secure by default" reads as risk. Add: localhost-first defaults, permission gates, published threat model, no silent network exposure. Trust language exists in the doc; harden it into commitments.
4. **Reconcile shipped naming** (section 6): Pulse shipped as **Tasks**; the module list should match the product (Engine/Console naming vs the app's actual surfaces). Keep internal codenames if desired, but the customer-facing doc should use customer-facing names. The staleness banner currently does this work; do the edit instead.
5. **Rescope Wing, retire "coming soon" marketing** (section 6.5). Nothing named Wing exists in the repo. Either mark it explicitly as vision (not product), or cut it from the architecture list and keep it in Long-Term Vision. Honesty is a stated pillar; vapor modules contradict it.
6. **Update the villain** (section 5). The dead-terminal villain is being solved by first parties for their own agents. Keep the pattern structure but promote the _15-tab juggle_ and add a new pattern: **the vendor silo** (two agents, two workflows, no shared anything). The villain evolves from "nothing runs while you're away" to "nothing coordinates what you run."
7. **Taglines bank** (section 12): add the fleet-era lines: "Mission control for your agents." / "One cockpit. Any agent." / "Your agents, any vendor." Keep the existing bank; nothing there needs deleting except confirming "You slept. They shipped." stays marked as awareness-noted secondary.
8. **Section 15 (Ten-Agent Team)**: refresh the table so agents span runtimes (e.g., Atlas on Claude Code, Lens on Codex) to make neutrality concrete in the flagship illustration.

## 2. `customer-voice.md`

1. **Re-validate Themes 1-2 against mid-2026 reality.** Terminal isolation and background execution quotes predate Claude Code web/Remote Control/Cowork maturity. Many still hold (self-hosted users, non-Claude runtimes), but the doc should annotate which pains first parties now partially solve, or the copy built on it will feel dated to exactly the power users it targets.
2. **Add Theme 7: Vendor sprawl / multi-agent chaos.** Collect quotes on running Claude + Codex side by side, model price/perf hedging, "everyone's building an orchestrator" fatigue, and orchestrator-comparison threads. This theme is the new positioning's evidentiary base and currently has zero entries.
3. **Add Theme 8: Agent security fear (post-OpenClaw).** The OpenClaw CVE/exposed-instances discourse produced hundreds of quotable developer reactions. This is the trust-pillar quote bank.
4. **Refresh the workaround table** with the current peer group (Conductor, Vibe Kanban, Claude Squad, Omnara) replacing the 2025-era one-off scripts. The argument form ("the workaround economy proves demand") gets stronger, because the workarounds became products.
5. Update the collection date and re-run the sweep; February 2026 is five product-generations old in this market.

## 3. `value-architecture-applied.md`

1. **Add two value ladders**: VL-11 Multi-runtime cockpit (Feature: three runtimes, per-session → Identity: "I don't bet my workflow on one vendor") and VL-12 Marketplace (Feature: one-command installs → Identity: "my team ships shared capability"). These are now Tier-1/Tier-2 features (see `03-feature-ranking.md`) with no ladder.
2. **Fill the proof placeholders that now have real values**: 3 runtimes behind 1 interface, 44 public releases in 5 months, 1,244 commits, marketplace live with N packages, four client surfaces. Most "social proof" fields stay placeholder until launch; functional proof no longer needs to.
3. **Update the Message House to the v2 draft** in `02-positioning.md` §5 (same roof, pillars become: One cockpit any agent / A team not tabs / Yours and safe to run). The current pillars (Autonomy/Communication/Control) map cleanly onto the new ones; this is a re-lead, not a rewrite.
4. **Mark VL-08 (Wing/memory) as vision-stage** so activation templates stop drawing on it.

## 4. `value-architecture.md` and handbook

No changes. The method is sound and product-agnostic; it is the applied doc that drifts.

## 5. Personas

1. **Kai (`the-autonomous-builder.md`)**: add the vendor-hedging trait (runs Codex for bulk work because it is fast and cheap, Claude for hard problems; hates the two-workflow tax). Update the trigger: still the 7am red CI, plus "I have three agent CLIs and no idea what any of them did." Review-by date is 2026-08-27; this counts as the review.
2. **Priya (`the-knowledge-architect.md`)**: unchanged in substance; add a note that the Obsidian plugin is shipped and thus the persona is now _actionable_ (a launch target, not a design fiction).
3. **New proto-persona to consider: "The Fleet Operator"** only if evidence emerges post-launch; do not multiply personas from imagination (handbook rule: personas need validation dates and owners).
4. **ICP (`icp-ai-native-dev-shop.md`)**: past its stated review window in ~6 weeks. Add multi-runtime hedging to the characteristics ("uses 2+ agent vendors" as an adoption signal). Keep the monetization hypotheses as hypotheses; nothing in this review changes them yet.

## 6. `dorkos-litepaper.md`

1. Update Runtime Adapters section to shipped-fact tense (three runtimes, conformance suite, per-session binding).
2. Add a short "The Landscape" section reflecting `01-market-landscape.md`: first parties orchestrate their own agents; DorkOS coordinates all of them. The litepaper currently argues against a world with no competitors, which weakens it with informed readers.
3. Same Wing/Loop status hygiene as brand-foundation.
4. Keep everything else; the OS analogy and design principles aged well.

## 7. Sequencing note

Do these edits _after_ the positioning direction in `02-positioning.md` is approved, in one sweep, so the meta corpus stays internally consistent (the Q1 docs' main hygiene win was consistency). The INDEX.md staleness banners can then come off the updated files.

## 8. Addendum: hero reframe + persona expansion (2026-07-09, applied)

Founder-approved changes applied directly to the meta corpus in one sweep:

1. **Tagline/roof change**: primary tagline is now **"You, Multiplied."**; "Intelligence doesn't scale. Coordination does." demotes to **manifesto line** (essays, litepaper, 4C anti-positioning, launch-thread defense — not hero surfaces). Rationale: the thesis is a Layer 2 mechanism claim occupying the Layer 5 roof, violating both the framework's construction rules and the §8.1 guide-not-hero discipline; it is also attackable from both halves (scaling laws; Brooks's law) unless given room to argue. Applied to: `brand-foundation.md` (§1 banner, §4 Big Idea, §10 core line + hero test, §12, §13 hero), `value-architecture-applied.md` (v1.2: addendum roof, Headline Bank, 4A, 4C annotation, empowerment guideline, changelog), `02-positioning.md` (§2 What stays, §5 roof).
2. **Framework hardening** (supersedes §4's "No changes"): the **hero test** added to `value-architecture.md` Phase 3A construction rules and the handbook's 3A step 5 — the roof's subject is the customer; a mechanism claim on the roof is a construction defect.
3. **Personas**: added **Ikechi — The AI-Native Founder** (secondary, grounded on a real user) and **Lil — The Private Professional** (horizon, staged, grounded on a real user); both carry founder-adjacent validation caveats and explicit boundaries (Kai remains the beachhead; launch messaging unchanged). Anti-persona (`the-prompt-dabbler.md`) boundary redrawn: **operator mentality, not technical skill**. `manifest.json` updated. This satisfies §5.3's evidence rule — these are observed users, not imagined ones; the outstanding validation is _unassisted_ use.
4. **customer-voice.md**: `[aspiration]` quote type added; **Theme 9: The Non-Developer Operator** opened (no quotes yet; interview Ikechi/Lil with founder-adjacent disclosure; milestone is the first organic quote).
5. **Downstream surfaces owed** (not yet done, gate on founder go): site hero, README opener, GitHub description re-lead ("You, multiplied. Mission control for…"), OG image copy, and the `06-marketing-tactics.md` tactic-1 copy which the 2026-07-09 GitHub description used pre-reframe.
