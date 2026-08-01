---
title: 'Touched-File & Source Chip UI Patterns — How AI Agent Products Display Files and URLs an Agent Handled'
date: 2026-08-01
type: external-best-practices
status: active
tags:
  [
    chips,
    file-chips,
    source-chips,
    citations,
    diffstat,
    dedup,
    overflow,
    facepile,
    chat-ui,
    agent-activity,
  ]
feature_slug: chat-touch-chips
searches_performed: 19
sources_count: 25
---

# Touched-File & Source Chip UI Patterns

Commissioned for the chat touch-chips design (`specs/chat-touch-chips/`). Survey of how production AI-agent products display the files and URLs an agent touched during a working session.

## Coding Agents

### Cursor

Cursor renders active context as **chips/pills at the top of the Chat/Composer input** — files and directories attached to context appear as removable pills ([Dynamic context discovery — Cursor](https://cursor.com/blog/dynamic-context-discovery)). This is the "what am I looking at" surface, separate from "what did I change."

For **edited files**, Cursor has a distinct **Chat Review UI**: a list of agent-edited files above the input box, built from Cursor's change-tracking state rather than a ledger of every write. Per a confirmed Cursor team response, "the list above the input box is built from the changes the review UI is currently tracking, not from a record of everything the agent wrote" — so when a file already has _unreviewed_ changes pending, a new edit to that same file doesn't always register and can silently **drop off the list**, even though the edit is written to disk ([Chat review UI omits some Agent-edited files — Cursor Forum](https://forum.cursor.com/t/chat-review-ui-omits-some-agent-edited-files/166830)). A real-world case study in the failure mode of "dedup by latest-known-state" tracking.

### Windsurf Cascade

Cascade shows **per-message file references, command output, and inline diffs** in the conversational stream; proposed edits render **in the editor itself** with green/red highlighting — the live/settled distinction is spatial (chat vs. editor pane) ([Windsurf 2 Deep Dive](https://www.digitalapplied.com/blog/windsurf-2-deep-dive-cascade-agents-flows-2026)). Planning Mode persists a plan as Markdown (`~/.windsurf/plans/`) — a pre-commit review list, not a live activity feed ([Windsurf Wave 10 Planning Mode Guide](https://baeseokjae.github.io/posts/windsurf-wave-10-guide-2026/)).

### Cline

File changes appear as **VS Code diff views** opened per-file; no confirmed aggregate "Files Changed" badge/tab. Turn-by-turn approval, one diff at a time. Recent regressions (diff view not appearing; wrong file's diff shown) indicate per-file diff state is fragile against fast multi-file batches ([Cline #11934](https://github.com/cline/cline/issues/11934), [#9904](https://github.com/cline/cline/issues/9904)).

### GitHub Copilot agent mode / Copilot Workspace

Agent mode: an **"N files changed" panel** appears in chat after the agent finishes — **only files actually modified are listed** (dedup-by-file, one entry regardless of touch count). Confirmed pain point: the panel is **not collapsed by default** and with 5+ files "occupies large area and obscures chat output"; community requests default-collapsed with a summary line ([vscode #261081](https://github.com/microsoft/vscode/issues/261081)). Copilot Workspace generates an editable **plan listing every file** with per-file steps — a pre-commit intent list ([user manual](https://github.com/githubnext/copilot-workspace-user-manual/blob/main/changes.md)). VS Code 1.107 multi-agent sessions surface **file-change count as a per-session "cost" metric** ([Visual Studio Magazine](https://visualstudiomagazine.com/articles/2025/12/12/vs-code-1-107-november-2025-update-expands-multi-agent-orchestration-model-management.aspx)).

### Devin

Full **replay timeline** — every command, edit, and browser action logged, with rollback to any point ([DeployHQ Devin Guide](https://www.deployhq.com/guides/devin)). File tabs carry a **"View latest version"** affordance ([Devin Feb '25 update](https://cognition.com/blog/devin-february-25-product-update)). Maximalist "show everything," not summarize.

### Replit Agent

Chat supports **clicking file lists to view diffs and roll back** ([Medium](https://tomparandyk.medium.com/journey-through-code-generation-tools-exploring-replits-agents-d4cd7eeb5c9e)); Agent 4 added per-task status and a review gate ([Replit blog](https://replit.com/blog/introducing-agent-4-built-for-creativity)). No dedicated touched-file chip row; power users fall back to `git diff HEAD`.

### v0.dev

Files live in the **persistent Code/preview side panel**, not as chips in the transcript ([capacity.so](https://capacity.so/blog/what-is-v0.dev)) — a useful negative data point.

### Claude Code (terminal + `/diff`)

Unified diff per file at edit time with **diffstat `+15 -3`** summary lines. The `/diff` viewer offers **two dedup lenses simultaneously**:

- **`Current` view** = `git diff HEAD` — one row per file, **net diffstat merged across all turns** (deduped, settled).
- **Per-turn tabs (`T1`, `T2`…)**, most-recent-first — a file touched in two turns **appears twice**, once per tab: chronological buckets, not an index ([wmedia.es](https://wmedia.es/en/tips/claude-code-diff-changes-per-turn), [blog.vincentqiao.com](https://blog.vincentqiao.com/en/posts/claude-code-diff/)).

Open demand for a **collapsed one-line summary** (`"Edited src/foo.ts — 12 lines changed"`, `diffDisplay: collapsed|full|none`) confirms full-diff-by-default is too noisy on large refactors ([claude-code #39119](https://github.com/anthropics/claude-code/issues/39119)).

### claude.ai (artifacts)

Inline **clickable text links** open artifacts in the **side panel** (not a new tab); versions navigable via a selector; multi-artifact disambiguation via an explicit picker, not visual stacking ([Claude Help Center](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)).

### OpenAI Codex (web)

Files accumulate in a **per-session "files edited" sidebar**; on completion a diff viewer renders every file. At 17 files it degrades: **"Large diff detected — showing one file at a time"**, refusing even a collapsed file list because the size gate is computed over the _aggregate_ changeset ([codex #20233](https://github.com/openai/codex/issues/20233)) — anti-pattern: don't gate the lightweight list behind the cost of the heavy detail view.

### Amp (Sourcegraph)

Threads carry their own context/file changes; **no public documentation of chip/diffstat mechanics** ([ampcode.com/manual](https://ampcode.com/manual)) — research gap.

## Research UIs

### Perplexity

Layered citations: (1) **inline chips** with domain-first "+N" notation (`northjersey +3`); (2) research steps during generation; (3) a **favicon stack + count** ("10 sources") on the answer action bar; (4) **chip popovers** with 1/N navigation; (5) a Sources sidebar and full Links tab. Overflow: **the favicon stack truncates** — no wrap, no infinite scroll; click-through to the Links tab ([AI UX Playground teardown](https://aiuxplayground.com/teardowns/perplexity/citations/)).

### ChatGPT Deep Research

Live narration during the run (every query/page + stage label "Reading… / Analyzing… / Writing report…"), interruptible mid-run ([Peec AI](https://peec.ai/blog/how-chatgpt-deep-research-reads-your-site-what-the-logs-reveal)). Finished report: **publisher favicon + name pills on claims**, `+N` for multi-source claims, hover popovers with 1/N arrows, a "Sources" row opening a sidebar ([OpenAI Help Center](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt)).

### Gemini Deep Research

A **sources panel** ("snapshot of where a response is drawing from") with click-through; source universe scoping before running ([Google](https://gemini.google/overview/deep-research/)). No screenshot-level teardown of the live browsing list found — research gap.

## Generic Design-System Patterns

**Facepile/avatar-group overflow**: overlap with negative spacing; "+N" indicator past a 4–5 item threshold; when exactly one item would be hidden, **show it instead of "+1"** ([Ant Design #31233](https://github.com/ant-design/ant-design/issues/31233)); overflow indicators must be interactive ([Skiff Facepile](https://skiff.com/ui/facepile), [Preline Avatar Group](https://preline.co/docs/avatar-group.html)).

**Source chips / context pills** (NN/g explainable-AI guidance): style chips distinctly as interactive metadata; place next to the claim they support; meaningful labels over generic "Source"; link to the specific section; don't let chip presence overclaim certainty — users "rarely click citation links" ([NN/g](https://www.nngroup.com/articles/explainable-ai/)).

## Synthesis

**(a) Dedup: once per file, net state wins.** Copilot's panel, Claude Code's `Current` view, and Workspace's plan all dedupe to file identity with net diffstat. The sophisticated exception: Claude Code _also_ offers a chronological per-turn lens as an explicit toggle — **offer both lenses, aggregate by default**. No product documents an explicit read→edit state machine; edited entries simply carry diffstats and reads don't. Cursor's bug is the cautionary tale: dedup from tracked-state can silently drop edits — **dedupe by append-then-merge over the event stream**.

**(b) Overflow: two-tier disclosure, never infinite wrap/scroll.** Compact capped summary (favicon stack / count badge) → dedicated fuller view on click. Twice-confirmed anti-pattern: the expanded view eating primary content by default (Copilot #261081) or the roster being gated on aggregate diff size (Codex #20233). **Summary and detail must not share a size budget.**

**(c) Live arrival: quiet accretion.** No product does per-file pop-in toasts or continuous conveyors. Stage label + incrementing count during work; the settled chip layout is a different component from the live progress feed. Auto-expand while running, auto-collapse to a one-line summary on completion; snap-not-spring during streaming.

**(d) For a calm control-panel aesthetic:** one deduped diffstat-bearing chip per target from an append-then-merge accumulator; chronological lens as opt-in toggle; capped visible row deferring to click-through (facepile convention, `n > 1` gate); expanded view collapsed by default and bounded; live state quiet (label + count); clicks open in-context (side pane), never navigate away; chips styled as honest metadata.

## Research Gaps

- Amp: no public file-chip UI documentation; needs live product inspection.
- Gemini Deep Research: no teardown of the live in-progress browsing list.
- Cline: absence of an aggregate files-changed view inferred from absence of evidence.
- Motion specs (exact timing/easing of e.g. Perplexity's favicon stack) undocumented everywhere.

## Search Methodology

19 WebSearch + 10 WebFetch calls. Highest-signal sources: GitHub issues (confirmed real-world behavior and bugs), official product blogs/changelogs, aiuxplayground.com teardowns, design-system references (Ant Design, Preline, Skiff). Prior DorkOS research consulted: `20260316_subagent_activity_streaming_ui_patterns.md`, `20260323_tool_call_display_overhaul.md`, `20260310_file_attachment_chat_visibility.md`.
