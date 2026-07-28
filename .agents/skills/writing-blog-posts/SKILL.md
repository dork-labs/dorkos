---
name: writing-blog-posts
description: Writes non-release DorkOS blog posts - feature posts, decision essays, ecosystem posts, and release recaps - from the repo's own ADRs, specs, research reports, and changelog fragments. Use when drafting, researching, or reviewing anything in blog/ that is not a version release note.
---

# Writing Blog Posts

The blog at `blog/*.mdx` holds 61 posts and every one of them is a release note. The `tutorial`, `announcement`, and `news` categories are declared in the schema, styled with their own colors, and have never been used. Whatever you are about to write is the first of its kind, not the sixty-second of an existing kind.

## The gate, before you write a sentence

A blog post is exactly where an unverified claim slips out. `AGENTS.md:7`:

> "In user-facing copy, docs, and release notes, never state that a still-unverified surface or pillar ... works (the demo-claim gate: `meta/positioning-202607/09-gtm-plan.md` §2.0)."

Under the gate right now, per that same line:

| Surface                                        | Status                                                          |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Obsidian plugin                                | Built but under-tested                                          |
| Windows x64 desktop                            | Early alpha, never confirmed by a real end-user install         |
| Mesh+Relay multi-agent coordination            | Shipped, unverified end to end                                  |
| Marketplace Claude-Code-superset compatibility | Shipped, unverified end to end                                  |
| Linux desktop                                  | Does not exist. Not gated, absent                               |
| Room slash commands, `post_to_room` everywhere | Designed, not built (`specs/rooms/02-specification.md:628-706`) |

Clear of the gate: the web cockpit via CLI install, and the macOS desktop app (signed, notarized, downloadable).

`AGENTS.md` is the live list. `09-gtm-plan.md` §2.0 is the rule behind it and is older, so where the two disagree, `AGENTS.md` wins.

**The instruction, and it is not optional.** Go through the finished draft one capability claim at a time. For each one, name the artifact that proves it shipped and was verified: a merged PR, a changelog fragment, a browser test, a docs page describing it as it works today. If you cannot find one, rewrite the sentence in the future tense or cut it. "DorkOS agents coordinate across machines" and "we are building toward agents that coordinate across machines" are different claims, and only one of them is currently true.

The same rule applies to your own numbers. Every threshold in the rooms design is self-declared unsourced (`meta/agent-etiquette.md:219`, "**Every number in this space is unsourced.**"). Publishing one as a researched finding is the same failure in a smaller package.

## What this skill does not cover

**Release posts.** `/system:release` Phase 6.7 (`.claude/commands/system/release.md:395-427`) scaffolds `blog/dorkos-X-Y-Z.mdx`, and the release commit stages it. Entry quality inside it comes from `writing-changelogs`. If a release post needs to be better, edit that phase's template. Do not build a second authority over a file another command writes, because the two will drift the way the hand-written `## Install / Update` section already has.

## Readability

The `writing-for-humans` skill sets the sentence-level standard for everything here: the readability contract, the punctuation rule, the failure modes, the honesty gate. Read it first. Everything below is what is specific to a blog post.

## The four post types

| Type           | Argues                                                           | Typical length         |
| -------------- | ---------------------------------------------------------------- | ---------------------- |
| Feature post   | Here is one capability and why it is built this way              | 800 to 2,500 words     |
| Decision essay | We chose X over Y, or we did not use Z                           | 1,500 to 3,000 words   |
| Ecosystem post | Someone else's project matters, and here is what we did about it | 300 to 800 words       |
| Release recap  | Several releases add up to one thing                             | Whatever the arc needs |

**Do not default to long.** Fly.io is the company most associated with the long dense technical post, and their own retrospective ([fly.io/blog/a-blog-if-kept](https://fly.io/blog/a-blog-if-kept/)) walks it back toward shorter and more frequent. Length follows the argument. A decision essay is the one type where length genuinely buys credibility, because its whole claim to authority is showing the work.

### Feature post

One capability, why it exists, why it is built the way it is.

Research method:

1. **Start at the changelog fragments** for the arc (`changelog/unreleased/`, or the compiled section in `CHANGELOG.md`). These are already written to the readability bar, and the `covers:` frontmatter maps each bullet back to its commits when you need depth.
2. **Get the "why" from the ADRs.** Search `decisions/manifest.json` on `specSlug` for the spec that drove the work.
3. **Get the hook from the spec.** Specs record verbatim operator complaints and struck-through open questions with their rationale preserved. This is where the opening lives.
4. **Get the spine from the merged PRs.** `git log --oneline <tag>..HEAD` gives the order things actually shipped in, which is usually the order the post should explain them in.
5. **Check `docs/` before writing an explainer.** If a concepts page already covers it, link the page and spend your words on the argument instead.

Shape: a concrete moment, what was broken, what was tried and rejected, what shipped, what it costs. Not a spec sheet.

**A verbatim operator complaint beats any invented hook.** The real one, at `specs/rooms/02-specification.md:570`:

> "I can't figure out how to add agents to channels… The fact that I can't figure it out means the UI/UX could be better."

Nothing you invent will be that good, and you do not have to invent it.

### Decision essay

Why we chose X over Y, or why we did not use Z.

Research method:

1. **The ADR is the seed, not the post.** ADR Context and Decision sections are 2 to 5 sentences by design (`writing-adrs`). They give you the frame and none of the narrative.
2. **Mine the rejected alternatives.** `## Alternatives Considered` sections, the two ADRs that survive as documents with `status: rejected`, and struck-through Open Questions in specs, which keep the rejected option inline with its reasoning rather than deleting it.
3. **Mine the errata.** Several ADRs correct themselves in place rather than being quietly rewritten, and `decisions/0070-per-agent-tool-filtering-via-allowedtools.md:21-23` states the principle: "an ADR is a record of what was believed, not a page to be quietly corrected." Those passages are the most trustworthy prose in the repo. Use them.
4. **If the essay rejects an external tool**, the strength paragraph comes from `research/` first, then re-verified. See Sourcing below.

Shape: context, what was tried, why it did not fit, what was chosen, what it costs. Concede a real negative in your own choice. PlanetScale's Vitess post names its own dependency's "operational complexity," "shortage of Vitess experts," and "steep learning curve" and reads more credible for it, not less.

### Ecosystem post

Someone else's project, covered by a party that is not neutral.

Research method:

1. **Check `research/` first.** `AGENTS.md` makes this a standing rule for research generally and it applies here with force: roughly 60 of the 335 reports are publishable landscape or competitor analysis. The teardown you are about to commission probably exists.
2. **Re-verify every fact against the project's own repo, docs, or release notes.** Nothing dated 2026-03-02 or later has been archived, so `status: active` on a research report is a default, not a freshness guarantee. Star counts, pricing, and feature claims go stale fastest.
3. **Say what we did about it.** Fly.io's Bun post spends more of its short length on bugs it hit, with issue links, than on praise. That is what buys the right to have an interest.

Keep it short and low-ceremony. This is the type to publish often.

### Release recap

Several releases as one narrative. Distinct from a release post, which belongs to `/system:release`.

Research method:

1. **Inputs:** the released sections of `CHANGELOG.md` including each version's theme blockquote, `git log` between tags, and `apps/site/public/product/archive/` for frozen media.
2. **Order by an argument, not by date.** A recap stops being a list when something other than chronology decides the order. Ask what these releases added up to, and lead with that.
3. **Media comes from the frozen archive path** (`/product/archive/vX.Y.Z/...`), never the live `/product/` path, which repoints on the next capture and would silently change what an old release shows.
4. **No bare semver in the title.** See the trap below.

## Sourcing

**Every external claim needs a primary source you actually fetched.** Not an aggregator summarizing one, not a search snippet, not memory. Then:

- **Control the variables or do not publish the comparison.** PlanetScale's Postgres benchmark was taken apart on Hacker News over an uncontrolled variable (their product on AWS against a competitor's on Google Cloud) and an undisclosed methodology deviation. Nobody proved intent and it did not matter. The reputational cost lands whether or not you meant to mislead.
- **Attach a checkable claim, never a characterization.** When Cockroach Labs got YugabyteDB's facts wrong in 2020, Yugabyte answered with a two-part public rebuttal, point by point, with their own benchmark evidence. They also conceded the one point that was fair. That partial concession is why the rebuttal reads as credible, and it is the standard you will be held to.
- **Our own `research/` is not publication grade as written.** Reports flag single-sourced claims, and that is adequate for an internal decision. It is not adequate for something with our name on it. Re-verify before a claim leaves the building.

## Naming competitors

The repo has no anti-disparagement rule. What it has is surface-scoped: brand surfaces (homepage, hero assets) never mention competitors (`meta/brand-foundation.md:386`), and comparison content is planned elsewhere and required to be "honest about their strengths" (`meta/positioning-202607/06-marketing-tactics.md:31`). A blog post sits between the two, so this skill settles it:

**Name them, name a specific strength and where it comes from, then narrow the rejection to our own context.**

Ably's "No, we don't use Kubernetes" credits Kubernetes's Borg lineage, its vendor ecosystem, and specific "commendable design choices" in EKS networking before narrowing the rejection to their own workload. The move that keeps it from reading as a hit piece is the scoping: good in general, wrong for us specifically. A general claim that the other thing is bad invites the fact-check you will lose.

Two limits:

- Not in a hero paragraph or a pull quote. Those are brand surfaces wherever they appear.
- `meta/brand-foundation.md:112`: "The villain isn't a company or a competitor. The villain is a missing layer." That is the framing to reach for instead of an opponent.

## Admitting error

**Publish design reasoning, including rejected alternatives and corrections made during design.** This is the strongest material we have and it is unusually plentiful: ADRs with errata admitting their own overclaims, specs that correct an earlier draft in the shipped document, decisions reversed with the original argument left standing.

**Do not publish operational failures or incidents.** The research is clear that admitting failure builds credibility, and equally clear that every exemplar was a company with an existing reputation to spend. GitLab live-streamed a database outage recovery and came out ahead. GitLab had years of standing first. DorkOS is a pre-launch alpha with roughly zero outside users, and there is no documented precedent for a product in that position spending credibility it has not yet earned. When we have a track record, revisit this. Until then the line is design reasoning yes, incidents no.

## Voice and lines you may use

- **"You, Multiplied." is hero-only.** Do not open a blog post with it.
- **"Intelligence doesn't scale. Coordination does." is licensed here.** `meta/brand-foundation.md:434` reserves the manifesto line for "essays, the litepaper, comparison/anti-positioning surfaces." A blog essay is that surface, and the only one where the line belongs.
- **Byline: a named human.** Every one of the 61 existing posts says `DorkOS Team`, which is right for a release note and wrong for an opinion piece. A corporate byline on an argument reads as content marketing. The evidence is a consistent pattern across every strong exemplar in the research rather than a controlled finding, and it is worth following anyway: no one signs an essay "the team."

## Mechanics

Frontmatter is validated by a Zod schema at `apps/site/source.config.ts:14-28`. Unknown keys pass silently and do nothing; a missing required field or a `category` outside the enum fails the site build.

| Field         | Required | Notes                                                                                |
| ------------- | -------- | ------------------------------------------------------------------------------------ |
| `title`       | yes      | Also the version source. See the semver trap below                                   |
| `date`        | yes      | `YYYY-MM-DD`. Rendered as UTC everywhere                                             |
| `description` | no       | Set it. See below                                                                    |
| `author`      | no       | A name. Absent, the JSON-LD publisher falls back from `Person` to `Organization`     |
| `category`    | no       | `release` \| `tutorial` \| `announcement` \| `news`. Never `release` for these posts |
| `tags`        | no       | `string[]`. Feeds the OG tags and renders as pills                                   |
| `image`       | no       | Declared in the schema and read by nothing. Use inline markdown images instead       |

Five things that will otherwise bite you:

1. **`description` is the entire body of the RSS item.** `apps/site/src/app/blog/feed.xml/route.ts` emits title, link, date, and description, and no post body at all. It is also the OG description, the Twitter description, the JSON-LD description, and the subtitle on the page. It is the highest-leverage field in the file and it is not a subtitle. Write the sentence that has to work alone in a feed reader.
2. **`releaseVersion()` pulls any `x.y.z` out of the title** (`apps/site/src/lib/blog-order.ts:12-18`), and the OG image treats a parsed version as proof this is a release. An essay titled "What we learned shipping 0.56.0" renders as a giant version number on a release card. Keep bare semver out of non-release titles.
3. **The table of contents needs three or more headings.** The sidebar renders only when `page.data.toc.length > 2` (`page.tsx:307`) and is hidden below the `xl` breakpoint. Two headings gets you nothing.
4. **`ReleaseInstallFooter` is category-gated** (`page.tsx:258`) and stays silent for anything that is not `category: release`. Nothing breaks. Do not hand-write an install section to compensate.
5. **Titles are clamped at 90 characters** in the OG image.

## Worked example: a feature post on rooms and channels

Everything this post needs already exists on disk.

| Need              | Where                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening           | `specs/rooms/02-specification.md:570`, the operator complaint quoted above                                                                                                            |
| Conceptual payoff | `specs/rooms/02-specification.md:606`: "a session is about a directory, a DM is about who you are talking to, and a channel is about what you are talking about"                      |
| Shipped spine     | 18 changelog fragments in `changelog/unreleased/` dated 07-26 to 07-28, already at the readability bar                                                                                |
| The "why"         | Six ADRs, `260726-170125` through `260728-022013`: the room primitive, opaque author identity, the cascade guard, the naming of "channel", the community server, threads as relations |
| PR order          | `git log --oneline` for #502 through #536, which runs primitive, sidebar, replies, composer, avatars, multi-agent DMs, menus, docs                                                    |
| Closing argument  | `meta/agent-etiquette.md`, the published standard                                                                                                                                     |

**The strongest narrative asset in the repo** is `research/20260727_buzz-conversational-behavior.md:284-301`, a first-hand postmortem of a production agent-to-agent reply storm in someone else's product, 21 replies deep. The finding at `:294`:

> "The content was the tell: every agent was trying to end the conversation, and announcing it is what kept it alive."

The root cause at `:296-301` is two individually correct prompt rules composing into perpetual motion: always reply, and tag whoever tagged you. On a mutual mention the circuit closes and never opens. That is the whole argument for building the cascade guard as a mechanism rather than a sentence in a prompt, made by someone else's failure rather than our assertion.

Three constraints on this specific post, and they generalize:

1. `docs/concepts/rooms.mdx` already exists. Link it, do not restate it.
2. Room slash commands are designed and not built, and `post_to_room` across every runtime is an open question. Both are gate territory.
3. Every threshold in the design is self-declared unsourced. None of them is a research finding.

Under the competitor rule above, naming Buzz in an analytical essay is fine, and it obliges you to be honest about what they got right and to not put their failure in a pull quote.

## Before you publish

- Every capability claim has an artifact behind it, or it is in the future tense.
- Every external fact has a primary source you fetched yourself.
- Every comparison discloses its uncontrolled variables, or is not published.
- Competitors are named with a specific strength attributed before any rejection, and never in a hero paragraph.
- No operational incident of ours is in the post.
- `description` works alone in a feed reader.
- No bare semver in the title unless this really is a release post, in which case you are in the wrong skill.
- Three or more headings if the post wants a table of contents.
- `author` is a person.
- The five self-checks from `writing-for-humans` have been run on the finished prose.
