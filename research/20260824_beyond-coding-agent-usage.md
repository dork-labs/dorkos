---
date: 2026-08-24
type: competitive
status: current
topic: Evidence that coding agents are used for far more than coding, and what DorkOS may honestly claim about it
---

# Beyond coding: what people actually run coding agents for

**Purpose:** back the "these agents do more than code" positioning on `/compare` and the wider site with citable evidence, and fence off the claims that are not supportable. Companion reports: `research/20260823_comparison-pages-competitor-verification.md`, `research/20260824_comparison-maker-corrections.md`.

## 1. The headline number (first-party, safe to publish)

Anthropic's own study of roughly 400,000 Claude Code sessions between October 2025 and April 2026 found that **only 51% of sessions write or fix code** (25% writing, 26% fixing). The rest splits into operating software (17%), data analysis and document writing (13%), and planning or understanding a system (14%). Fixing code fell from 33% to 19% over the seven months measured.

Two further findings from the same report matter for how we talk about who the product is for:

- "Management occupations had the highest verified success rates."
- "Domain expertise, and not coding proficiency, amplifies effective use of the tool."

Source: <https://anthropic.com/research/claude-code-expertise>

Copy-ready phrasing that stays inside what the study says: **"Anthropic's own numbers: nearly half of Claude Code sessions aren't writing code."** Do not round this to "most", and do not restate it as a fact about _users_ (see §4).

## 2. The tension that is the actual argument

Anthropic's product surface has not caught up with Anthropic's own research. Their documentation still calls Claude Code "an agentic coding tool" (<https://code.claude.com/docs/en/overview>), and their answer for knowledge work is a separate product, Cowork (<https://claude.com/product/cowork>).

Cite both sides honestly. The research proves the general-agent thesis; the product naming has not moved. DorkOS's edge is **not** "non-coding work" on its own, because Cowork owns that with far bigger distribution. The edge is: all of it, across every agent tool you already run, on your own machine, against your own files.

## 3. Citable usage patterns

Real people, real URLs. These are the "show, don't claim" material.

| Pattern                                | Quote or substance                                                                                                                            | Source                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Life admin, in one sentence            | "I have Claude Code maintaining my Obsidian Vault, managing my Home Assistant setup via SSH, helping me buy life insurance and file my taxes" | dimitri-vs, Hacker News, 2026-03-07                                                              |
| Daily business operations              | A restaurant group in Sapporo runs daily operations on it, and endorses keeping files as the source of truth                                  | domaine_sat, Hacker News, 2026-05-22                                                             |
| The thesis sentence                    | "once you give it access to communication tools, coding becomes a fraction of what you use it for"                                            | qasim157, Hacker News, 2026-03-24                                                                |
| The reframe                            | "Claude Code is not a coding tool! It's a tool that does coding, which is subtly different."                                                  | mike_hearn, Hacker News, 2026-04-29                                                              |
| A definition a 9th grader gets         | "any task you do on your computer that doesn't consist of writing code" (decks, cross-tool search, prospect research)                         | Kjosbakken, Towards Data Science, 2026-04-13                                                     |
| Non-engineering teams inside Anthropic | Legal contract review; growth marketing generating hundreds of ad variants in minutes; security triage roughly 3x faster                      | <https://claude.com/blog/how-anthropic-teams-use-claude-code>                                    |
| Everyday knowledge work                | Expense reports built from transaction files; a year of content analysed                                                                      | <https://every.to/source-code/how-to-use-claude-code-for-everyday-tasks-no-programming-required> |
| The renaming instinct                  | "Forget that it's called Claude Code and instead think of it as Claude Local or Claude Agent" (500+ submissions)                              | <https://www.lennysnewsletter.com/p/everyone-should-be-using-claude-code>                        |
| The manifesto                          | "To me, code is a means to an end." / "I used to think 'non-technical' was an identity. Turns out it was just a skill I hadn't learned yet."  | <https://zarazhang.substack.com/p/coding-agents-are-general-agents>                              |

### Chief-of-staff builds (the most useful pattern for us)

- **Mike Murchison** (CEO of Ada): <https://github.com/mimurchison/claude-chief-of-staff>. Inbox triage, a daily briefing, and a self-building CRM that re-enriches 160+ contacts every 15 minutes. Configured through `goals.yaml` and `schedules.yaml`.
- **Ruben Dominguez**: <https://the-ai-corner.com/p/claude-code-chief-of-staff-system>. Email triage at 5:30am, a "Morning Sweep" dispatching six parallel subagents, a Dispatch/Prep/Yours/Skip taxonomy, and the cost comparison "$100/month vs $400 to $1,000/month for a human assistant".
- Second-brain and Obsidian variants: roland35 (HN, 2025-10-11), photon_garden ("everything's just a file", 2025-08-19), dtkav (2026-05-12).

**Why this matters to DorkOS:** every one of these builds hand-reinvents machinery DorkOS already ships. Scheduled runs (`schedules.yaml` becomes Tasks), named agents with roles (becomes the Team), and a way to reach a person for approval (becomes rooms, phone alerts and approval cards). The positioning line: **people are hand-building this in YAML; DorkOS is the version that already works.**

Do **not** extend that mapping to memory. See §4.

## 4. What we must not claim

- **No memory.** DorkOS has no memory subsystem: no store, no write path, no retrieval. The only thing in the codebase is a display-only card that renders the Claude Agent SDK's own `memory_recall` events. Any copy implying DorkOS remembers things across sessions is false.
- **No user-mix statistic.** No public number exists for "X% of Claude Code _users_ aren't developers". Task mix is not user mix. Do not invent one.
- **Thin evidence for the other runtimes.** Non-coding usage evidence for Codex and OpenCode is thin. Frame multi-runtime non-coding work as something you _can_ do, never as a statistic.
- **Do not cite:** Superpowers star counts (sources conflict at 94K/243K/277K), the "280K skills" figure, or "58% of small businesses" (search-farm numbers).
- **Obsidian plugin** stays behind the demo-claim gate; never state that it works.

## 5. Vocabulary, ranked for plain-language copy

**Use:** "personal assistant" (safest), "chief of staff" (best single frame), "a tool that does coding" (the reframe), "second brain" (notes context only), "a brilliant intern who never sleeps" (best analogy).

**Avoid:** "digital employee" and "AI teammate" (vendor hype, and Grok Bot's own words), "vibe coding", and "life OS" (collides with our own OS claim).

## 6. Caution on money and business operations

Hacker News trust-scepticism about automating money and business processes is sharp (see the payroll thread, HN 48130950). Lead any business-operations claim with the **approval gate**, not with the automation. "It drafts the invoice and waits for you" lands; "it runs your payroll" does not.

## 7. Competitive context: Anthropic's own life-admin primitives

Cite these precisely when contrasting reach.

- **Routines** — cloud-scheduled, run with the device off, research preview.
- **Desktop scheduled tasks** — local, and only while the machine is awake.
- **Channels** — research preview. Pipes Telegram, Discord and iMessage into a _running_ session. Needs Bun, is opt-in per session, delivers events only while that session is open, and is blocked by default on Team and Enterprise plans. <https://code.claude.com/docs/en/channels>
- **Remote Control** and **Dispatch**.

The fair contrast: their phone reach is a preview flag that needs a terminal left open; ours is a screen with rooms behind it.
