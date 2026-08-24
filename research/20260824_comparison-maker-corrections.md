---
date: 2026-08-24
type: competitive
status: current
topic: Ownership and maker corrections for the /compare catalog, verified 2026-08-24
---

# Comparison pages: maker and ownership corrections

**Purpose:** record the ownership changes that made two `/compare` entries wrong, plus the smaller factual drift found in the same sweep. Corrections are applied to `apps/site/src/layers/features/marketing/lib/comparisons.ts` and noted in `research/20260823_comparison-pages-competitor-verification.md`.

## 1. Cursor: SpaceX acquired Anysphere (correction required)

**SpaceX acquired Anysphere, Inc., the maker of Cursor, for $60B in an all-stock deal.** The deal closed 2026-08-14 and was announced 2026-08-15.

- Cursor keeps its name, and Anysphere survives as the legal entity.
- It operates under the **SpaceXAI** unit.
- The stated rationale is compute: access to xAI's Colossus cluster.
- Revenue was roughly $4B annualised at close.

Timeline for context: SpaceX acquired xAI on 2026-02-02; an option agreement followed in April 2026; SpaceX went public on 2026-06-12; the option was exercised on 2026-06-16.

Sources: Cursor's own blog; CEO Michael Truell's post on X; the SEC 8-K; <https://techcrunch.com/2026/08/15/spacex-officially-closes-its-cursor-acquisition/>; Quartz; <https://en.wikipedia.org/wiki/Anysphere>.

**Page edit:** `maker` becomes "SpaceX (Anysphere)", the mid-August 2026 close is noted, and TechCrunch plus Cursor's blog are cited.

## 2. Grok Bot: the maker is SpaceXAI, not xAI (correction required)

xAI ceased to exist as a standalone company in February 2026, absorbed by SpaceX in an all-stock merger, and was rebranded **SpaceXAI** around May 2026.

Sources: <https://www.cnbc.com/2026/02/11/>; <https://en.wikipedia.org/wiki/SpaceXAI>.

**Page edit:** the Grok Bot `maker` becomes SpaceXAI (SpaceX).

**Cross-link, and this is the interesting part:** Cursor and Grok Bot now share an owner. The fact that Grok Bot comes bundled with some Cursor tiers is therefore **first-party bundling, not a partnership between two companies**. Both pages must say so, because a reader comparing them is otherwise being shown two rivals that are actually one.

## 3. Smaller corrections from the same sweep

- **OpenCode** — the canonical repository is now <https://github.com/anomalyco/opencode>; `sst/opencode` redirects there. Roughly 201K stars. Links re-pointed.
- **Claude Code** — Auto mode became the **default permission mode** for Pro, Max and Team on 2026-08-14, with no charge for the permission-classifier tokens. Sonnet 5 pricing of $2/$10 per million tokens was made permanent on 2026-08-11. **Do not hardcode** the 50% weekly-limit boost: it expires 2026-08-31.
- **GitHub Copilot / Agent HQ** — Agent Plugins 1.0 reached general availability on 2026-08-12 (VS Code, CLI, SDK and app). Copilot in Slack is in public preview. Grok 4.6 and Kimi K3 were added as model options.
- **Devin / Cognition** — Cognition's CEO **denied** a reported SpaceX acquisition on 2026-08-19. The company was in talks at a $40B+ valuation (Bloomberg via TechCrunch, 2026-08-12). Noting the valuation is fine; implying an acquisition is not.
- **Amp** — maker confirmed as Amp Frontier. Education pricing is $10/month.
- **Buzz** — roughly 30.4K stars, up from 16K in July. We deliberately do not cite star counts on any page, and this is a reason to keep it that way.

## 4. Checked, no change needed

Repository and site-level checks found nothing to correct for: Conductor (Melty Labs), Omnara, Claude Squad, Cline Bot Inc., DeepSeek Harness (still a developer preview), OpenClaw Foundation (transition to openclaw.org complete), Terragon (still shut down), and Roo Code (still shut down; the ZooCode and Cline successors are already named on our page).
