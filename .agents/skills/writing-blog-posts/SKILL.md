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

**Release posts.** `/system:release` Phase 6.7 (`.claude/commands/system/release.md:395-428`) scaffolds `blog/dorkos-X-Y-Z.mdx`, and the release commit stages it. Entry quality inside it comes from `writing-changelogs`. If a release post needs to be better, edit that phase's template. Do not build a second authority over a file another command writes, because the two will drift the way the hand-written `## Install / Update` section already has.

## Readability

The `writing-for-humans` skill sets the sentence-level standard for everything here: the readability contract, the punctuation rule, the failure modes, the honesty gate. Read it first. Everything below is what is specific to a blog post.

## Point of view

A post argues from a position. A neutral explainer is a docs page, and we already have docs.

The position comes from three places:

- **The thesis.** `meta/dorkos-litepaper.md:298`: "Intelligence doesn't scale. Coordination does." Most posts here are an instance of it. The manifesto line is licensed on this surface and almost nowhere else (see Voice below), which makes an essay the one place the argument can be stated outright rather than implied.
- **The design filters.** `AGENTS.md:15` names Jobs, Ive and Rams as the design mentors and states what they imply: every element justifies its existence, so if a paragraph would not be missed, cut it. The product "feels like a control panel, not a consumer app," and `meta/brand-foundation.md:425` says the same. The prose is instrument-panel prose, not lifestyle copy.
- **A named reader.** A post aimed at everyone reaches nobody. Name the persona before the first sentence.

| Post type      | Usually for                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Feature post   | Kai (`meta/personas/the-autonomous-builder.md`), running many agents, asking whether this does something his current setup cannot |
| Decision essay | Priya (`the-knowledge-architect.md`), who reads the source before adopting and is really evaluating our judgment                  |
| Ecosystem post | Kai plus the other project's users, who arrived because of that project and not because of us                                     |
| Release recap  | People already running DorkOS, who want to know what changed and whether it was worth the upgrade                                 |

A feature that removes the need to write code is Ikechi's (`the-ai-native-founder.md`), not Kai's. Pick one and write to them.

The test: **if the post could have been written by a competitor about their own product, it has no point of view.** Rewrite it or do not publish it.

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

## Titles and hooks

**Titles.** What travels with a technical audience is plain, declarative, first person, and carries either a specific number or a direct answer to a question the reader already holds. The patterns, taken from posts that actually traveled:

| Pattern                               | Example                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Answer the question they already have | Ably, "No, we don't use Kubernetes"                                            |
| A movement plus a number              | Segment, "Goodbye Microservices: From 100s of problem children to 1 superstar" |
| Plain first person, zero adjectives   | 37signals, "Why We're Leaving the Cloud"                                       |
| The procedural frame                  | Anthropic, "How we built our multi-agent research system"                      |

Failure modes: adjectives and superlatives ("powerful", "revolutionary", "the future of"), a question posed as bait rather than one the post answers in its first line, and a bare proper noun. Fly.io can title a post "Corrosion" and be read on the strength of the byline. We cannot, because nobody knows us yet.

And the mechanical trap from Mechanics below: any `x.y.z` in the title turns the post into a release card.

**Hooks.** The opening has one job, which is to earn the second paragraph. The strongest opening available to us is a verbatim quote from a real person, and the operator complaint at `specs/rooms/02-specification.md:570` quoted above is the proof. It is better than anything you would invent, and you do not have to invent it. The technique generalizes:

- **Specs** record operator rounds in the operator's own words, and mark which findings were surprises.
- **Tickets and PR reviews** hold real complaints and the moment someone was wrong.
- **Research reports** hold real measurements, and postmortems of other people's failures.

Openings to avoid: throat-clearing history ("Since the dawn of..."), defining a term the reader already knows, and announcing what the post will cover instead of starting it. Open on a concrete moment or a number. The one exemplar in the research that opens on a category definition is also the one whose central claim its own audience contested hardest.

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
- **"Intelligence doesn't scale. Coordination does." is licensed here.** `meta/brand-foundation.md:434` reserves the manifesto line for "essays, the litepaper, comparison/anti-positioning surfaces, and the Show HN comment thread." A blog essay is that surface, and the only writing surface here where the line belongs.
- **Byline: a named human.** Every one of the 61 existing posts says `DorkOS Team`, which is right for a release note and wrong for an opinion piece. A corporate byline on an argument reads as content marketing. The evidence is a consistent pattern across every strong exemplar in the research rather than a controlled finding, and it is worth following anyway: no one signs an essay "the team."

## Humor

Forced humor is worse than none, and worse than dryness.

**Fits this brand:** dry understatement, precise observation of something genuinely absurd, self-deprecation about our own mistakes. **Does not:** puns, exclamation marks, memes, quirky-startup voice, jokes at a competitor's expense, and anything you would have to explain to a reader in another timezone or language.

**Apply the lens to ourselves first.** `decisions/0070-per-agent-tool-filtering-via-allowedtools.md:45` on a security option we misread and shipped wrong for three months: "The option was misread on day one. Nothing drifted underneath us." That is dry, self-deprecating, funny, and true, and no part of it is phrasing. It is the shape to aim for.

**Then outward, carefully.** The Buzz reply storm in the worked example below contains no joke either. Every agent was politely announcing that it would stop replying, and the announcing is what kept the conversation alive. It is funny because it is precisely described and true. But it is somebody else's production failure, so the frame is analysis, not mockery: it belongs in a post because it teaches something true about multi-agent systems, and anyone reusing it owes Block the same honesty about what they got right that the competitor rule above demands. Precision about a failure is the technique. A named competitor is not the punchline.

So: **the humor comes from accuracy, not decoration.** If a line is funny because of how it is phrased rather than what it observes, cut it. If the funny version of a sentence is less true than the plain version, it is not funny, and the sentence loses. One test before you keep a joke: would this still read well in six months, to someone who does not know us?

## Mechanics

Frontmatter is validated by a Zod schema at `apps/site/source.config.ts:14-28`. Unknown keys pass silently and do nothing; a missing required field or a `category` outside the enum fails the site build.

| Field         | Required | Notes                                                                                                                                    |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | yes      | Also the version source. See the semver trap below                                                                                       |
| `date`        | yes      | `YYYY-MM-DD`. Rendered as UTC everywhere                                                                                                 |
| `description` | no       | Set it. See below                                                                                                                        |
| `author`      | no       | A name. Absent, the JSON-LD `author` switches from `Person` to `Organization` (`page.tsx:152-159`; `publisher` is always `Organization`) |
| `category`    | no       | `release` \| `tutorial` \| `announcement` \| `news`. Never `release` for these posts                                                     |
| `tags`        | no       | `string[]`. Feeds the OG tags and renders as pills                                                                                       |
| `image`       | no       | Declared in the schema and read by nothing. Use inline markdown images instead                                                           |

Five things that will otherwise bite you:

1. **`description` is the entire body of the RSS item.** `apps/site/src/app/blog/feed.xml/route.ts` emits title, link, date, and description, and no post body at all. It is also the OG description, the Twitter description, the JSON-LD description, and the subtitle on the page. It is the highest-leverage field in the file and it is not a subtitle. Write the sentence that has to work alone in a feed reader.
2. **`releaseVersion()` pulls any `x.y.z` out of the title** (`apps/site/src/lib/blog-order.ts:12-18`), and the OG image treats a parsed version as proof this is a release. An essay titled "What we learned shipping 0.56.0" renders as a giant version number on a release card. Keep bare semver out of non-release titles.
3. **The table of contents needs three or more headings.** The sidebar renders only when `page.data.toc.length > 2` (`page.tsx:307`) and is hidden below the `xl` breakpoint. Two headings gets you nothing.
4. **`ReleaseInstallFooter` is category-gated** (`page.tsx:258`) and stays silent for anything that is not `category: release`. Nothing breaks. Do not hand-write an install section to compensate.
5. **Titles are clamped at 90 characters** in the OG image.

## Images

**The mechanism, because the obvious one is a trap.** The `image` frontmatter field is declared in the schema and read by nothing (DOR-650), so setting it does nothing at all. Images go in the body, two ways:

- **Plain markdown.** All 11 images in the corpus are `![alt](/product/archive/vX.Y.Z/shot.png)`, pointing at a frozen release archive.
- **`<ProductShot id="…" alt="…" />`.** The blog template renders MDX with `getMDXComponents()` (`page.tsx:253`), the same set the docs get, so this component works in a blog post and plays a loop where the shot has one. Two catches: it throws on an unregistered id, and the guard test only scans `docs/` (`shots.test.ts`, `DOCS_ROOT`), so nothing catches a bad id in `blog/` before the build breaks. Check the id against `apps/e2e/capture/shots.ts` yourself.

**Never hand-place a file in `apps/site/public/product/`.** That directory belongs to the capture pipeline, and `resetOutputDir()` (`apps/e2e/capture/optimize.ts:493-501`) deletes every `.png` and `.webm` at its top level before each `capture:process` run. Your image disappears at the next capture and nobody will connect the two events. Product media is `capturing-product-media`'s job end to end: registry, capture, human overrides, frozen archives. A post that needs a shot of the product asks that pipeline for one. A post that needs its own non-product image puts it under `apps/site/public/blog/<post-slug>/`, which nothing else writes to.

**What to reach for, in this order.**

1. **Real product media beats everything.** The reader is deciding whether to believe the thing exists and works, and a capture of the actual app is the only image that answers that. `capturing-product-media` already captures from real UI on seeded data, and its loops are two-pass encoded to roughly 1.35MB against a 1.5MB budget.
2. **A diagram, when the point is a relationship** rather than a surface: architecture, sequence, before and after. A screenshot cannot show why two things talk.
3. **Generated or free stock, only where there is nothing real to show.** A decision essay has no screenshot, and that is the legitimate case.

**Three rules that matter more than the order above.**

- **The gate applies to images, and images break it more easily than prose.** A generated or composited picture that reads as a product screenshot is a false claim, and a more persuasive one than a sentence, because nobody fact-checks a picture. If an image depicts DorkOS, it is a capture of the real DorkOS. No mockups, no doctoring, no compositing a feature in. This is the same rule `capturing-product-media` enforces on the pipeline, and it does not relax because you are writing prose instead of running a capture.
- **Record the license, do not assume it.** Free stock is not license-free. Unsplash, Pexels and the rest each have their own terms, some requiring attribution and some restricting commercial or trademark use. Check the license at its source, not in a search result, and record source and license for every third-party image. Record that a generated image is generated.
- **Alt text is writing, not metadata.** It is part of the post and it is held to the same bar as the prose. An image with no alt text is nothing at all to a screen reader and to anyone whose images failed to load. We fix this class of defect on our own surfaces: a queued-message editor shipped with no name for a screen reader at all, and now announces what it is and what Enter will do (`changelog/unreleased/260726-004945-composer-shows-its-own-shortcut.md:17`). Describe what is in the image and why it is in the post, not "screenshot".

**Size.** A 12MB loop is a worse experience than no loop. Hold anything you produce by hand to the pipeline's 1.5MB budget. Prefer a webm through the capture pipeline over a hand-made GIF, which is far larger for the same seconds. Markdown `![]()` cannot play a webm, so a loop in a post means `<ProductShot>`.

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

- The post could not have been written by a competitor about their own product.
- One named reader, decided before the first sentence.
- Every capability claim has an artifact behind it, or it is in the future tense.
- Every external fact has a primary source you fetched yourself.
- Every comparison discloses its uncontrolled variables, or is not published.
- Competitors are named with a specific strength attributed before any rejection, and never in a hero paragraph.
- No operational incident of ours is in the post.
- Every image that depicts the product is a capture of the real product.
- Every image has alt text written as prose, and every third-party image has its source and license recorded.
- No image sits in `apps/site/public/product/` unless the capture pipeline put it there.
- Every joke survives the six-months test, and none of them cost the reader accuracy.
- `description` works alone in a feed reader.
- No bare semver in the title unless this really is a release post, in which case you are in the wrong skill.
- Three or more headings if the post wants a table of contents.
- `author` is a person.
- The five self-checks from `writing-for-humans` have been run on the finished prose.
