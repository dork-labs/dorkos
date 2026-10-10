---
paths: blog/**, changelog/unreleased/**, docs/**/*.mdx, README.md, packages/cli/README.md, apps/site/src/layers/features/marketing/lib/features.ts, package.json, packages/*/package.json, apps/*/package.json, packages/operating-skills/src/**, packages/shared/src/dorkbot-templates.ts
---

# User-Facing Writing

You are editing prose a **user** reads, not a developer or coding agent. Write it so a smart 9th grader who does not code can follow it. The full standard is the **`writing-for-humans`** skill: load it before writing.

The contract in one line: 9th-grade level, short sentences (one big idea each), active voice with a clear actor, benefit before mechanism, every acronym glossed or cut, no em dashes.

Run these five self-checks before you save:

1. **So what?**: every sentence gives the user a benefit, not a mechanism.
2. **Explain-back**: a non-developer could read it once and explain it back.
3. **Acronym scan**: every acronym is glossed in the same sentence, or gone.
4. **Read aloud**: if you inhale mid-sentence, split it.
5. **Us or them?**: it describes what the user gets, not what we did.

**What to say about DorkOS** (the message stack, the words we use, the words and claims we never use) is `meta/VOICE.md`, the single source. Read it before writing a sentence about what DorkOS is or does; never restate its lists here or in a skill. A `package.json` `description` is headline copy under its rules.

Honesty gate: never claim an unverified surface or feature works. What may be claimed today is the demo-claim gate in `meta/ROADMAP.md`. No hype words: show the outcome.

Operating skills (`packages/operating-skills`) and the DorkBot templates are prose an agent repeats to the person it works for: describe DorkOS there in the same words.

In-app copy (strings the app renders) has its own, stricter standard: `app-copy.md` and the `writing-app-copy` skill.

Not covered here: ADRs (`writing-adrs`), `contributing/` guides and API reference (`writing-developer-guides`), and code comments (`conventions.md`) stay precise and technical.
