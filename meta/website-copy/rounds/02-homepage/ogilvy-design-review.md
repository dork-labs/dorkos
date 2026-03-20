# Design Review: Applying New Copy to the Existing Site

## A Memorandum from David Ogilvy

---

## Preliminary Note

I have now read the current homepage code — every component, every prop, every CSS class — alongside the synthesis copy and my own Round 2 submission. What follows is not a design critique. The design is good. The cream palette, the IBM Plex type, the warm retro-tech aesthetic — these are honest choices that communicate craft. The question is whether the new copy fits inside this visual language, and where the seams will show.

I will address each question in the order it was asked.

---

## 1. The Headline Audit

**Current:** "Your AI Never Sleeps."

**Proposed:** "Your agents are brilliant. They just can't do anything when you leave."

The current headline is a promise. The proposed headline is a recognition. These are fundamentally different rhetorical devices, and the difference matters enormously.

"Your AI Never Sleeps" tells the visitor what the product does. It is a claim. Claims require proof, and the proof is below the fold. The visitor must take the headline on faith and keep scrolling. This is adequate. It is not exceptional.

"Your agents are brilliant. They just can't do anything when you leave." does something the current headline cannot: it creates a pause. The first sentence is warm — it validates the reader. The second sentence drops the floor. The reader does not need to scroll to understand the product; they understand the _problem_ in the headline itself. The product becomes the obvious solution rather than a claim that requires substantiation.

**In the context of the existing design**, the new headline is stronger for three specific reasons:

First, the activity feed panel to the right already proves the promise. Having a headline that _also_ promises ("Never Sleeps") creates redundancy — the feed and the headline are saying the same thing. The new headline creates tension; the feed resolves it. That is a proper left-right compositional argument.

Second, the current hero uses `clamp(32px, 5.5vw, 64px)` with `tracking-[-0.04em]` and a `text-balance` class. The new headline is longer — two sentences instead of four words. At the current clamp range, it will occupy two to three lines on desktop. This is acceptable. The subhead below ("the operating system for autonomous AI agents") is shorter than the current subhead, which compensates. The net vertical footprint is comparable.

Third, the eyebrow label currently reads "Autonomous by default." This pairs poorly with the current headline (both say the same thing in different registers). With the new headline, the eyebrow should change. I recommend: `the operating system for autonomous AI agents` — moved from subhead position to eyebrow position, in the existing `font-mono text-2xs tracking-[0.2em] uppercase text-brand-orange` style. This frees the subhead position for the tagline: **You slept. They shipped.**

**Specific recommendation for the hero layout:**

```
[eyebrow]  the operating system for autonomous AI agents
[headline] Your agents are brilliant.
           They just can't do anything when you leave.
[tagline]  You slept. They shipped.
[CTA]      npm install -g dorkos
```

The current `subhead` prop becomes the tagline. The current eyebrow text becomes the positioning line. This requires only prop changes in `page.tsx` — no structural changes to `ActivityFeedHero.tsx`.

**Verdict:** The headline change is a substantial improvement. Make it.

---

## 2. The Credibility Question

The current `CredibilityBar` component is eleven lines of code. It says: "Built on the Claude Agent SDK · Open Source · MIT Licensed." It sits between the hero and the system architecture section on a `bg-cream-secondary` background.

**Does it survive?** Yes. But it needs to move.

The synthesis copy introduces a dark-background prelude ("DorkOS is starting.") and a dark hero section. In the current warm-palette design, you are not going dark — that is the correct decision, as it would break the entire visual language. But the credibility bar's function changes in the new copy architecture.

In the current site, the credibility bar does early trust-building. The visitor sees the headline, then immediately gets reassurance: open source, SDK-based, MIT licensed. This is necessary because the current headline is a bold claim ("Never Sleeps") and the visitor needs grounding.

In the new copy, the headline is a recognition, not a claim. The visitor does not need reassurance — they need to keep reading. The credibility bar between hero and villain section would interrupt the emotional momentum. The reader has just felt the gut-punch of "when you leave" and should proceed directly into the villain cards that name the specific pains.

**Move the credibility bar to after the module reference section** (Section 5 in the synthesis), immediately above the install moment. At that point, the reader has been through the pain, the pivot, the timeline story, and the module breakdown. They are approaching the conversion point. "Built on the Claude Agent SDK · Open Source · MIT Licensed" becomes a trust signal at the moment of decision, not a premature reassurance.

Additionally, the bar's content should expand slightly. The synthesis introduces "Open source. Self-hosted. Yours." as install-adjacent copy. The credibility bar should incorporate this:

```
Built on the Claude Agent SDK  ·  Open Source  ·  MIT Licensed  ·  Self-Hosted
```

One line. Same monospaced style. Same muted warmth. Positioned where it converts rather than where it comforts.

**Verdict:** Keep it. Move it down. Add "Self-Hosted."

---

## 3. The Honesty Section

The current `HonestySection` is one of the most distinctive elements on the site. It has corner brackets that scale in on scroll. It has a green "Honest by Design" eyebrow. It says, plainly, that Claude Code sends your code to Anthropic's servers and that DorkOS does not change that.

The synthesis copy does not include this section. The new copy architecture moves from villain cards to pivot to timeline to modules to install to identity close. There is no designated slot for a transparency disclosure.

**This is a mistake in the synthesis, and I take partial responsibility for not including it in my Round 2 submission.**

Here is the argument for keeping it: the new copy is more emotionally driven than the current copy. The villain cards name pain. The timeline tells a story. The identity close builds tribal belonging. In a page with this much emotional architecture, a moment of radical honesty is not a interruption — it is a credibility anchor. It prevents the page from feeling like it is selling too hard.

The developers who will adopt DorkOS are precisely the developers who will notice the absence of a privacy disclosure on a page that asks them to run autonomous agents on their machine. The current honesty section answers their concern before they form it. That is good copywriting.

**However, the section needs to be repositioned and slightly rewritten.**

In the current page, it sits between "How It Works" and "About" — essentially in the middle of the page. In the new copy architecture, the right position is between the module reference and the install moment. The reader has now seen what each module does. Before they install, they should know the trust model.

The copy should tighten:

> **Honest by Design**
>
> Claude Code uses Anthropic's API. Your code context is sent to their servers. DorkOS does not change that.
>
> What DorkOS controls: the orchestration runs on your machine. Sessions are stored locally. Tools execute in your shell. The scheduling, the messaging, the coordination — yours.
>
> We believe in honest tools for serious builders.

Keep the corner brackets. Keep the green eyebrow. Keep the `bg-cream-white` background. This section is a signature element. Its visual distinctiveness (the brackets, the green accent against the otherwise orange palette) signals that it is saying something different from the rest of the page. That signal is correct and should be preserved.

**Verdict:** Keep it. Move it to before the install moment. Tighten the copy. The brackets stay.

---

## 4. The Contact Section

The current `ContactSection` is a reveal-email interaction. Click `reveal_email`, the address appears with a blinking cursor. It tracks the reveal via PostHog. The prompt text reads: "Have feedback, want to contribute, or just say hello?"

The synthesis ends with the identity close ("Built by dorks. For dorks. Run by you.") followed by "Your agents are ready. Leave the rest to them." and a final monospaced "Ready."

**The contact section should survive, but in reduced form.**

The identity close is the emotional end of the page. Nothing should come after it that diminishes its weight. A "Have feedback?" prompt after "Built by dorks. For dorks. Run by you." is anticlimactic — like applause followed by someone asking if you want to fill out a survey.

But removing contact entirely is wrong. The page needs a way for the reader to reach the builder. The synthesis suggests "Star the repo. Read the docs. Join the build." with links — that is the right instinct but insufficient. An email address is more personal than a GitHub link. It says: a human built this, and that human is reachable.

**The solution is to absorb contact into the identity close section.** After the origin story and the tribal close, add a single line:

> Questions, ideas, or just want to say hello — `reveal_email`

Same reveal interaction. Same PostHog tracking. But integrated into the identity section rather than standing alone as a separate section with its own eyebrow and padding. It becomes a postscript to the identity close, not a competing section.

The current `ContactSection` component can be simplified to a single inline element rather than a full `<section>` with `py-32` padding.

**Verdict:** Keep the email reveal. Kill the standalone section. Absorb it into the identity close as a quiet postscript.

---

## 5. What the Current Site Undersells

This is the most important question, so I will be specific.

**The current site undersells the problem.**

The existing hero says "Your AI Never Sleeps" — a solution statement with no problem context. The visitor must infer the problem. The use cases grid ("Ship while you sleep," "Agents that talk to each other") lists capabilities but never names what is broken today. The entire current page assumes the visitor already knows they have a problem and is looking for a solution. This is a fatal assumption for a product in a new category.

The new copy fixes this completely. The villain cards ("The Dead Terminal," "The Goldfish," "The Tab Graveyard," "The 3am Build") name four specific, recognizable failures. The reader does not need to infer anything — they see their own experience described with embarrassing accuracy. This is what separates adequate copy from copy that converts.

**The current site undersells the product's scope.**

The existing `SystemArchitecture` and `UseCasesGrid` sections present DorkOS as a collection of features. The module descriptions are functional but not memorable. "Pulse executes your roadmap autonomously" is accurate but lifeless. It tells the reader what the module does without making them feel why it matters.

The new copy fixes this through the timeline narrative. Instead of describing Pulse as "cron-based scheduling," it shows Pulse catching a CI failure at 2:47am and dispatching an agent to fix it while the developer sleeps. The reader does not learn what Pulse is — they experience what Pulse does. That is the difference between a feature list and a product story.

**The current site undersells the emotional identity.**

The existing "About" section is competent but generic: "DorkOS is an autonomous agent operating system by Dork Labs." The philosophy cards (if they follow the pattern of the `PhilosophyCard` component) are abstract. The closing line — "The name is playful. The tool is serious." — is the strongest line on the current page, but it arrives too late and without enough setup.

The new copy's identity close ("Built by dorks. For dorks. Run by you.") preceded by the origin story (library books, section 8 housing, thirty million users) earns the tribal claim. It transforms DorkOS from a product with a funny name into a product that _means something_ to a specific kind of builder. The current site hints at this identity. The new copy owns it.

**The current site undersells the activity feed.**

This may be the most important design observation in this review. The `ActivityFeedHero` component is extraordinary. A live-updating simulated agent feed with module-colored dots, staggered spring animations, and entries like "Agent found $2,400/yr in unused AWS resources — PR open to delete." This is the single most persuasive element on the current site. It does not argue that DorkOS works. It _shows_ DorkOS working.

The current site places this feed next to a four-word headline. That is an imbalance. The headline does not earn the feed. The feed does all the work.

With the new headline — "Your agents are brilliant. They just can't do anything when you leave." — the feed becomes the answer to the headline's implicit question. The left side names the problem. The right side shows the solution, live, in real time. The footer text of the feed panel currently reads: "While you read this, your agents could be doing all of this." That line lands harder when the headline has just told the reader that their agents currently do nothing.

**The feed is the hero. The new headline lets it be.**

---

## Summary of Recommendations

| Element             | Current State                                  | Recommendation                                                                                              |
| ------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Headline**        | "Your AI Never Sleeps."                        | Replace with "Your agents are brilliant. They just can't do anything when you leave."                       |
| **Eyebrow**         | "Autonomous by default"                        | Replace with "the operating system for autonomous AI agents"                                                |
| **Subhead**         | Long product description                       | Replace with "You slept. They shipped."                                                                     |
| **Credibility Bar** | Between hero and system architecture           | Move to before install moment. Add "Self-Hosted."                                                           |
| **Honesty Section** | Between How It Works and About                 | Move to before install moment (after credibility bar). Tighten copy. Keep brackets.                         |
| **Contact Section** | Standalone section with own eyebrow            | Absorb email reveal into identity close as postscript. Kill standalone section.                             |
| **Activity Feed**   | Unchanged                                      | No changes needed. The new headline makes it stronger.                                                      |
| **Use Cases Grid**  | Feature capabilities list                      | Replace with villain cards (synthesis Section 2). The current "What This Unlocks" becomes the pain section. |
| **About Section**   | Generic product description + philosophy cards | Replace with identity close (synthesis Section 7). Origin story + tribal claim.                             |

---

## A Final Note on the Design System

The synthesis recommends a dark background (#0A0A0A) with amber accents and JetBrains Mono. You have been told to ignore this. Good. The cream palette with IBM Plex is warmer, more distinctive, and more honest than the dark terminal aesthetic that every developer tool defaults to. Dark backgrounds say "we are technical." Cream backgrounds say "we are confident enough to be different." For a product called DorkOS, that confidence is the brand.

The new copy was written for dark backgrounds but works on cream. The emotional beats — the villain recognition, the timeline intimacy, the identity close — are voice-driven, not design-driven. They will land in any palette that does not fight them. This palette does not fight them. It supports them.

Apply the new words. Keep the warm light.

---

_David Ogilvy_
_February 27, 2026_
