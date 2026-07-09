---
name: writing-for-humans
description: Writes user-facing DorkOS prose a non-developer can read: changelog fragments, release notes, READMEs, npm copy, docs guides and concept pages, blog posts, UI microcopy, and error messages. Use when writing or reviewing any copy a person (not a coding agent) will read.
---

# Writing for Humans

Every word a user reads should be plain enough for a smart 9th grader who does not write code. This skill is the readability standard for user-facing DorkOS writing. It is the shared source the other writing skills build on.

## The readability contract

Hold every user-facing sentence to these five rules:

1. **Aim for a 9th-grade reading level.** If a sentence needs a second read, rewrite it.
2. **Keep sentences short.** Aim under 20 words. Never pack two big ideas into one sentence. Split them.
3. **Use active voice with a clear actor.** Say who does what: "DorkOS opens your browser," not "the browser is opened."
4. **Lead with the benefit, then the mechanism (if at all).** Say what the user gets first. Most of the time you can drop the mechanism.
5. **Define or drop every technical term.** Either avoid the jargon or gloss it in the same sentence. Prefer numbers and concrete scenarios over abstractions.

House punctuation rule: no em dashes. They invite run-on sentences that smuggle in a second idea; use a comma, colon, parentheses, or a new sentence instead.

## What this governs (and what it does not)

**Governs** every surface a user reads: changelog fragments, release notes, READMEs, npm package copy, the GitHub repo description, `docs/` guide and concept pages, blog posts, UI microcopy, and error messages.

**Does not govern** surfaces written for developers or coding agents, which stay precise and technical:

- ADRs → `writing-adrs`
- `contributing/` developer guides and API reference pages → `writing-developer-guides`
- Code comments → keep them technical (`.claude/rules/conventions.md`)

When a page mixes both (a user guide with a developer-reference tail), split it with a clear heading like `## Reference` and a framing sentence so the reader knows the audience just shifted.

Brand voice note: `meta/brand-foundation.md` §10 has two registers. This skill is the plain-language register. Brand vocabulary (Autonomous, Orchestration, Operator) is allowed here only with an in-sentence gloss.

## Ten ways we ruin our writing

Each is a real quote from this repo, then a rewrite.

**1. Leading with mechanism instead of benefit.**
Before: "per-turn context (git status, UI state, queued-message notes) travels alongside them instead of being injected into the text."
After: "Your notes to the agent (like git status) now arrive as context, so the agent never mistakes them for something you typed."

**2. A ticket or PR ID carrying the meaning.**
Before: "Batch 9 — browser acceptance PASS; implementation complete (DOR-73)."
After: "Fix the chat losing your place when you switch between two running sessions (DOR-73)." The ID is a footnote; the sentence stands on its own.

**3. Acronyms with no gloss on first use.**
Before: "A ULID is assigned, providing a unique, time-ordered identifier."
After: "Each agent gets an ID that also records when it was created, so lists stay in order." Name the concept, not the acronym.

**4. Shipping a commit message to users.**
Before: "SDK-native breakdown via held-open prompt (A1)."
Can you tell what the user got? Neither can we, and that is the lesson: when the commit message does not tell you, do not paraphrase it into the changelog. Dig into the PR or the code until you can say what changed for the user, then write that sentence. Internal batch, task, and tracking notes never ship: cut them when you curate.

**5. One sentence carrying three or four ideas.**
Before: a single 68-word highlight making four separate claims.
After: one idea per sentence. Break it into a short lead plus a bullet each.

**6. A reference table with no framing sentence.**
Before: a flags table dropped in with no lead-in.
After: "Most people never change these. Here is the full list if you need it," then the table.

**7. Tonal whiplash: warm opening, then man-page.**
A README that opens with a story ("It's 7am, CI has been red since 2:47am") and then jumps to bare command lists reads like two documents. Bridge the shift with a sentence, or keep the reference in its own section.

**8. Describing a visual feature in text only.**
"Glance at your browser tabs and know which are working" is telling, not showing. When a feature is visual, add a screenshot or short clip. (Media is a separate task, so at minimum flag the gap.)

**9. Developer reference mixed into a user page with no signal.**
A concepts page that slides from "what you get" into file paths and type names loses the non-developer mid-page. Put the deep-dive under its own heading and say who it is for.

**10. Passive, nominalized phrasing that hides the actor.**
Before: "An AgentManifest is assembled from discovery hints merged with any overrides you provide."
After: "DorkOS builds each agent's profile from what it finds on disk, plus any details you add."

## Self-checks before you ship

Run all five on the finished prose:

- **So what?** Ask "so what?" after each sentence. If the answer is not obvious, add the benefit or cut the line.
- **Explain-back.** Could a non-developer read it once and explain it back? If not, simplify.
- **Acronym scan.** Find every acronym. Gloss it in the same sentence, or cut it.
- **Read aloud.** If you have to inhale in the middle of a sentence, split it.
- **Us or them?** Does the sentence describe what the _user gets_, or what _we did_? Rewrite anything that is about us.

## When jargon is unavoidable

Some terms have no plain replacement. Name the term, then gloss it in the same breath:

- "MCP (the standard that lets AI tools talk to each other)"
- "a boundary (the folders on your computer DorkOS is allowed to touch)"
- "CORS (the browser rule that controls which sites may call your server)"

Gloss on first use only; after that the reader knows it.

## The honesty gate

Plain language never means overclaiming. Follow the demo-claim gate in `AGENTS.md`: never say an unverified surface or feature works. Describe what a user can actually do today. No hype words ("powerful," "seamless," "effortless"): show the outcome instead.
