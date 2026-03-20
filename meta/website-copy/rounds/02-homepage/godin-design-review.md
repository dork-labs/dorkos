# Design Review: Current Site vs. New Copy

**Reviewer:** Seth Godin perspective
**Constraint:** Keep the existing design system (cream palette, IBM Plex, warm retro-tech aesthetic). Change copy and structure, not visual language.

---

## 1. The Word-of-Mouth Test

**After the current site, someone says:**
"It's like a dashboard for Claude Code that can also schedule things and connect agents together."

That sentence is a feature list. It doesn't travel. Nobody repeats a feature list at a dinner party. The current hero -- "Your AI Never Sleeps" -- is a claim, not a story. The subhead explains what DorkOS is rather than what it means. The activity feed is fascinating to watch but doesn't give the visitor language to carry away.

**After the new-copy site, someone says:**
"You know how your AI agents forget everything and can't do anything when you close the terminal? Someone built an OS for that."

That sentence has a setup, a recognition moment, and a punchline. It travels because the listener has felt the pain. They nod before you finish. The new copy earns this sentence by spending the first three sections making the reader feel the problem before ever naming the product.

**The new sentence is categorically stronger.** The current site tries to impress. The new copy tries to be retold.

---

## 2. Section Surgery

### What Gets Cut

| Current Section                                                       | Verdict                                                                                | Reason                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Credibility Bar** ("Built on Claude Agent SDK / Open Source / MIT") | **Cut.**                                                                               | Three cold facts that no one was asking about yet. The reader hasn't felt the problem, so they don't care about the credentials. "Open source. Self-hosted. Yours." appears later in the new copy, at the install moment, where it actually matters -- when someone is deciding whether to trust you with their machine.                                                         |
| **System Architecture** (SVG diagram + grouped module cards)          | **Cut as a standalone section.** The module cards become the compact Subsystems table. | The architecture diagram is an engineer's artifact, not a persuasion device. It answers "how does it work?" before the reader has asked "why should I care?" The new Module Reference table gives the architect brain what it needs in half the space, after the timeline has built desire.                                                                                      |
| **Use Cases Grid** ("What This Unlocks" -- 6 cards)                   | **Cut.**                                                                               | These capabilities are now embedded in the timeline narrative, where they appear as moments in a story rather than bullet points in a grid. "Ship while you sleep" becomes something you experience in the 11:14 PM entry, not something you read in a card. Capabilities shown in context are ten times more compelling than capabilities listed in a grid.                     |
| **Honesty Section** ("Honest by Design")                              | **Cut as a standalone section.**                                                       | The honesty signals move into the identity close and the install moment. "Open source. Self-hosted. Yours." does the work of the entire honesty section in six words. The current version also inadvertently introduces doubt ("Your code context is sent to their servers") at a moment when the reader should be building trust, not second-guessing the product's data model. |

### What Stays (Transformed)

| Current Section                        | New Section                    | What Changes                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ActivityFeedHero**                   | **Prelude + Hero**             | The activity feed was the crown jewel of the current site. It stays -- but it moves. The hero space becomes copy-first (the problem statement). The feed reappears later, perhaps as a complement to the timeline or the install moment, as proof that the system actually runs. More on this below. |
| **HowItWorksSection** (3-step install) | **Install Moment** (Section 6) | The 3-step install was functional but buried. The new version elevates the install command to a gravitational center -- the single most important moment on the page. Same terminal aesthetic. Same typing animation. But positioned at peak desire, not as an afterthought.                         |
| **AboutSection** + philosophy grid     | **Identity Close** (Section 7) | The philosophy items (Autonomous, Open Source, Honest, Extensible) were abstract. The new identity section replaces them with origin story and tribal declaration. "Built by dorks. For dorks. Run by you." does what the philosophy grid was trying to do, but with feeling.                        |
| **ContactSection**                     | **The Close** (Section 8)      | The reveal-email interaction is clever and should be preserved. But the close needs to be more than a contact form. "Your agents are ready. Leave the rest to them." then `Ready.` -- that is a close. The email can live in the footer.                                                             |

### What's New

| New Section                                    | Purpose                                                          | Why It Didn't Exist Before                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prelude** ("DorkOS is starting.")            | Set the tone. This is not a website, it is something turning on. | The current site opens with marketing. The new site opens with an experience.                                                                                              |
| **Villain Section** (4 pain-point cards)       | Make the reader feel the problem before you sell the solution.   | The current site skips straight to features. It assumes the reader already knows why they need DorkOS. The villain section earns the right to sell.                        |
| **Pivot** ("We solved this fifty years ago.")  | Turn the OS metaphor from a claim into an inevitability.         | The current site says "operating system" but never earns it. The pivot section -- cron, IPC, registries, filesystems -- makes the reader discover the metaphor themselves. |
| **Timeline Narrative** ("A Night with DorkOS") | Show the product through story, not features.                    | This is the biggest structural addition. The current site has no narrative. The timeline is the proof that the product works, told as a story someone can retell.          |

---

## 3. The Shareability Audit

### Current Site: What's Shareable

1. **The activity feed.** It is visually distinctive, animated, and screenshot-worthy. Someone might share a screenshot of "Mesh coordinating world domination -- ETA 47 minutes" because it is funny and specific. This is the most shareable element on the current site.

2. **The tagline "You slept. They shipped."** is present in the current subhead copy but buried. It is not given the visual prominence it deserves. When it is isolated and treated as a design element, it becomes sticker-material.

3. **The corner-bracket honesty section** is visually distinctive but the copy inside it undermines confidence rather than building it.

4. **The architecture SVG** is beautiful engineering documentation but not shareable in a marketing context. Nobody screenshots a node graph to share with a friend.

### New Copy: What's More Shareable

1. **"Your agents are brilliant. They just can't do anything when you leave."** -- This is a tweet. It is a Slack message. It is the sentence you send to a coworker. It works because it recognizes something the reader already feels.

2. **The villain cards** -- especially "The Goldfish" and "The 3am Build" -- are screenshot-worthy because they name specific shared frustrations. People share pain recognition more than product descriptions.

3. **The timeline** (11:14 PM through 7:04 AM) -- "Your agents have been productive for eight hours. You have been awake for four minutes." That line is a screenshot. It is the proof.

4. **"$4.20 in API calls"** -- The specificity makes it shareable. It grounds the aspirational in the concrete. People will quote this number.

5. **"This is not a demo. This is Tuesday."** -- Seven words. Quotable, repeatable, loaded with confidence.

6. **"Built by dorks. For dorks. Run by you."** -- Tribal identifier. The people who resonate will put this in their bio.

The new copy is significantly more shareable because it is built from sentences that work outside the page. The current site's shareability depends almost entirely on the visual of the activity feed.

---

## 4. What the Current Site Does Right

**Do not discard these:**

1. **The activity feed is a remarkable piece of engineering and design.** The live-updating panel with module badges, color-coded dots, fading opacity, and the spring animations -- this is the single best "show, don't tell" element on the site. It proves the product is real and active. It should survive the redesign, repositioned but preserved.

2. **The cream palette and warm retro-tech aesthetic.** This is genuinely differentiated. Every AI tool website is dark mode with blue accents. The cream, the warm grays, the graph-paper background, the IBM Plex fonts -- this says "we are different" before the reader processes a single word. It is a purple cow in a sea of dark-mode sameness.

3. **The terminal interaction patterns.** The typing animation in HowItWorks, the cursor blink on CTAs, the `reveal_email` interaction in Contact -- these are cohesive and on-brand. They reinforce the "operating system" identity through interaction design.

4. **The module card hover effect** (spotlight tracking with cursor position) is subtle and well-crafted. It rewards exploration without demanding attention.

5. **The responsive CTA strategy.** Desktop gets `npm install -g dorkos`, mobile gets "Get started" pointing to docs. This is thoughtful. Phone users cannot run npm commands. Keep this logic.

6. **"The name is playful. The tool is serious."** -- This line in the current About section is doing real work. It addresses the name objection before it forms. The new copy handles this differently (the tribal identity section), but this line is worth preserving somewhere -- README, docs, FAQ.

---

## 5. What I'd Fight to Change

Even within the existing design system, these must shift:

### A. Kill the Feature-First Structure

The current page goes: Hero claim -> Credentials -> Architecture -> Features -> Install -> Honesty -> About -> Contact. This is the structure of a product datasheet. It assumes desire and tries to justify it with features.

The new structure goes: Problem -> Recognition -> Reframe -> Story -> Reference -> Action -> Identity -> Close. This is the structure of persuasion. It creates desire and then satisfies it.

You cannot pour new copy into the old structure. The section order is the argument, and the current argument is "here's what we built." The new argument is "here's what you're missing, here's what's possible, here's how to get it."

### B. The Hero Must Lead with the Problem, Not the Product

"Your AI Never Sleeps" is a solution headline on a page where the reader hasn't admitted they have a problem yet. Swap it. "Your agents are brilliant. They just can't do anything when you leave." -- that is a hero headline that earns the scroll.

The activity feed can still appear on the page, but it cannot be the hero. The hero must be language, not animation. The words have to carry the weight because words are what people retell.

### C. The Activity Feed Needs a New Home

The feed is too good to cut but wrong as a hero element. Two options within the existing design system:

**Option 1:** Move it to the timeline section. After the 7:04 AM entry, the feed activates -- showing real-time agent activity as if the reader is watching the system described in the story. It becomes proof, not decoration.

**Option 2:** Move it to the install section. After the reader sees `$ npm install -g dorkos`, the feed appears below -- showing what starts running. The feed becomes the answer to "what happens next?"

Either position is stronger than hero because the reader has context. In the hero, the feed is impressive but meaningless -- the reader doesn't know what Mesh, Relay, or Pulse are yet. After the timeline, every feed entry carries weight.

### D. Add the Villain Section -- This is Non-Negotiable

The single biggest gap in the current site is that it never names the problem. It jumps straight to "here's our system." The villain section (Dead Terminal, Goldfish, Tab Graveyard, 3am Build) is the foundation that makes everything else work.

Within the existing design system, these cards work naturally. Cream cards with warm borders, monospaced labels, the same reveal-on-scroll animations. The visual language is already there. The content simply wasn't.

### E. The Pivot Must Exist as Its Own Moment

"We solved this for applications fifty years ago. We called it an operating system." -- This line needs vertical space, typographic weight, and isolation. In the current cream palette, this could be a full-width section with generous padding, a single centered line in the larger serif weight, and nothing else around it. The graph-paper background subtly visible. Let it breathe.

This is where "operating system" stops being a marketing term and becomes obvious. The current site never earns this transition. The new copy does, but only if the pivot gets its own space.

### F. The Install Command Must Move to Peak Desire

Currently, `npm install -g dorkos` appears in the hero (as a CTA button) and in HowItWorks (as step 1 of 3). Both are too early. The reader hasn't decided they want this yet.

In the new structure, the install command appears after the timeline (proof the product works) and after the module reference (proof the system is real). By this point the reader is asking "how do I get this?" -- and the answer is one line. That is the moment the command carries maximum weight.

### G. Cut the Philosophy Grid, Add the Origin

The four philosophy items (Autonomous, Open Source, Honest, Extensible) are abstract values that could describe any open-source project. Replace them with the origin story and tribal identity from the new copy. "One developer. Section 8 housing. Library books." -- that is specific, human, and memorable. Abstract values are forgettable. Specific origins stick.

---

## Summary: The Transformation Map

```
CURRENT                          NEW
────────────────────────────────────────────────────────
                          →      Prelude ("DorkOS is starting.")
Hero (Activity Feed)      →      Hero (Problem headline + tagline)
Credibility Bar           →      [removed — absorbed into install]
System Architecture       →      [removed — replaced by Module Reference]
                          →      Villain (4 pain-point cards)
                          →      Pivot ("We solved this 50 years ago.")
                          →      Timeline ("A Night with DorkOS")
Use Cases Grid            →      [removed — embedded in timeline]
                          →      Module Reference (compact table)
How It Works              →      Install Moment (elevated, at peak desire)
Honesty Section           →      [removed — absorbed into install + identity]
About + Philosophy        →      Identity Close (origin + tribal)
Contact                   →      The Close ("Ready.") + footer contact
```

The cream palette stays. The IBM Plex stays. The graph paper stays. The terminal interactions stay. The activity feed stays (repositioned). The warm, retro-tech aesthetic stays.

What changes is the argument. And the argument is everything.
