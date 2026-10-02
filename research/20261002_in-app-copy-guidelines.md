---
title: 'In-app UI copy guidelines: what the best design systems publish, and how it maps to DorkOS'
date: 2026-10-02
type: external-best-practices
status: active
tags:
  [
    microcopy,
    ux-writing,
    ui-copy,
    error-messages,
    buttons,
    empty-states,
    confirmations,
    toasts,
    permission-prompts,
    ai-copy,
    voice-and-tone,
  ]
searches_performed: 10
sources_count: 26
---

# In-app UI copy guidelines

## Research summary

The published guides from Apple, Microsoft, Google Material, Shopify Polaris, Atlassian, GitHub Primer, Mailchimp and Intuit agree on a stable core: sentence case, verbs on buttons, no "OK/Yes/No" when a specific verb exists, errors that say what happened and what to do without blame or jargon, empty states that state a fact and offer a pathway, and no exclamation marks or humour in failure states. They split on three things that matter to DorkOS: whether the product may say "we" (Microsoft and Atlassian say yes, Apple and Material say no), how much warmth to project, and whether "please" and "sorry" are ever allowed. Most of DorkOS's existing decisions are backed by at least two major guides; the clearest conflicts are Apple's actorless error style ("Unable to load content") against DorkOS's "name the actor" rule, and Microsoft's advice to avoid "you" in error messages.

Note on access: Apple HIG pages, Material 3, Atlassian and Polaris render client-side. Apple was read through its JSON data endpoints (`developer.apple.com/tutorials/data/design/human-interface-guidelines/*.json`), Atlassian's error page loaded directly, Material was read through the static Material 1 page and Google's Material communication codelab, and Polaris through search-indexed excerpts of its pages plus `shopify.dev`. Stripe, Linear and Figma publish no in-app microcopy guide that could be found; Slack publishes a marketing-copy voice piece and app-design guidelines, not UI copy rules. Those are left out rather than guessed at.

---

## 1. Apple Human Interface Guidelines

Sources: [Writing](https://developer.apple.com/design/human-interface-guidelines/writing), [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts), [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons), [Privacy (requesting permission)](https://developer.apple.com/design/human-interface-guidelines/privacy), [Loading](https://developer.apple.com/design/human-interface-guidelines/loading)

### Writing page

- **Voice and tone:** define a voice once, vary tone by context. Serious situations get a "straightforward and direct" tone.
- **Clarity:** "Check each word to ensure it needs to be there." Read it aloud.
- **Write for everyone:** plain language, no jargon, write with accessibility and localization in mind.
- **Action oriented:** active voice; "Use verbs for button and link labels." "Send" beats "Let's do it!" Avoid being "too cute or clever."
- **Links:** never "Click here". Use "Learn more about UX Writing", partly for screen readers.
- **Language patterns:** consistency builds familiarity. Keep a list of common terms.
- **Capitalization:** pick one style per element type and apply it everywhere.
- **Multi-step flows:** start with "Get Started", move with "Continue"/"Next", end with "Done". Be consistent.
- **Possessive pronouns sparingly:** "Favorites" beats "Your Favorites". If used, be consistent; don't switch perspectives.
- **"Avoid using 'we' altogether"**, especially in errors. Bad: "We're having trouble loading this content." Better: "Unable to load content."
- **Device verbs:** don't say "click" on touch devices.
- **Empty states:** "Provide clear next steps on any blank screens." Offer a button or link. "Don't show crucial information that could disappear" (empty states are temporary).
- **Errors:** help people avoid errors first; show the message next to the problem; avoid blame; say what to do. Good: "Choose a password with at least 8 characters." Bad: "That password is too short." **No "oops!" or "uh-oh."** Avoid robotic messages like "Invalid name." Prefer instruction over prohibition: "Use only letters for your name" beats "Don't use numbers or symbols." If many people hit the same error, rethink the interaction rather than the words.
- **Delivery method:** choose notification vs alert vs inline by urgency and how much supporting information is needed.
- **Settings labels:** label practically; if a label isn't enough, add an explanation that **describes what the setting does when on** (people infer the off state). Link directly to a setting rather than describing where it lives.
- **Text fields:** label every field; use hint text for format ("name@example.com") or description ("Your name").

### Alerts

- Use sparingly. Not for information alone, not for common undoable deletions, not at launch.
- **Title:** "clearly and succinctly describes the situation"; never "Error" or "Error 329347 occurred"; no more than two lines. A full-sentence title takes sentence case and end punctuation; a fragment takes title case and none.
- **Message:** only if it adds value; as short as possible; complete sentences.
- **Tone:** "direct ... neutral, approachable." "Avoid being oblique or accusatory, or masking the severity of the issue."
- **Buttons:** one or two words describing the result; verbs that relate to the alert text ("View All", "Reply", "Ignore"); always "Cancel" for cancel. **"Avoid using 'Yes' and 'No'."** OK only in purely informational alerts; "The meaning of 'OK' can be unclear even in alerts that ask people to confirm."
- **Destructive style** only for destructive actions people didn't deliberately choose; always pair with Cancel. Don't make Cancel the default; to force reading, have no default.
- "Avoid explaining alert buttons." If you must, say "choose" and use the exact button title without quotes.

### Buttons

- Start with a verb ("Add to Cart", not "Shopping Cart"); a few words.
- **Trailing ellipsis when a button opens another window or view** that asks for more input ("Edit…").
- Don't give a destructive button the primary role, "even if that action is most likely", because people press primary buttons without reading.

### Requesting permission (Privacy page)

- Purpose string: **one active sentence saying how and why**, sentence case, full stop. Good: "The app records during the night to detect snoring sounds." Bad: "Microphone access is needed for a better experience." (passive, vague) and "Turn on microphone access." (no reason).
- Ask only when the feature is used, not at launch unless the app cannot work without it.
- A pre-permission screen has one button, "Continue" or "Next", **not "Allow"**; no incentives; no imitating the system prompt.

### Loading

- Show something immediately; placeholders beat blank screens (blank reads as broken).
- "Clearly communicate that content is loading and how long it might take." Determinate indicator when duration is known, indeterminate otherwise.

---

## 2. Microsoft (Writing Style Guide, Windows app writing style, Win32 error guidance)

Sources: [Top 10 tips](https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice), [Windows apps writing style](https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style), [please](https://learn.microsoft.com/en-us/style-guide/a-z-word-list-term-collections/p/please), [sorry](https://learn.microsoft.com/en-us/style-guide/a-z-word-list-term-collections/s/sorry), [Win32 error messages](https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-error)

- **"Shorter is always better."** Prune every excess word. Lead with what matters; front-load keywords.
- **"When in doubt, don't capitalize."** Sentence case for headings, labels, UI titles.
- **No period or colon at the end of titles, headings and UI titles.** Use periods on full sentences in tooltips, errors and dialogs; none on buttons, radio buttons, labels, checkboxes.
- **Start statements with a verb; cut "you can";** avoid "there is/there are".
- Oxford comma. (Microsoft uses unspaced em dashes; DorkOS bans them.)
- **Contractions** are expected; avoiding them reads stilted.
- **Addressing the user (Windows):** always "you"; **"Use 'we' to refer to your own perspective"**; never "I" or "me" for the app.
- **Errors (Windows):** don't blame; say what went wrong, **what will happen next**, and a realistic solution. Example of trimming: "We couldn't upload the picture. If this happens again, try restarting the app."
- **Dialogs:** the "call and response" between title and buttons: buttons must be clear answers to the title's question.
- **Buttons:** "a couple short words" at most; active verbs ("Install now", "Share").
- **Abbreviations:** define on first use; don't assume familiarity.
- **"please":** avoid, except when asking the user to do something inconvenient or when the app is to blame. Example: "The network connection was lost. Please reenter your password."
- **"sorry":** only for serious problems (data loss, can't continue, must contact support, product fails), and only for problems the product caused, never for external ones.
- **Win32 error guidance (older but the most detailed public error spec):**
  - A good error message has **a problem, a cause, and a solution**; is relevant, actionable, user-centred, brief, clear, specific, courteous.
  - "Often the best error message is no error message." Don't report errors users don't care about or can't act on; don't report outcomes the user considers fine (deleting a file already being deleted).
  - **Disabled controls:** if it isn't obvious why a control is disabled, leave it enabled and explain on use.
  - **Banned words:** error/failure (use "problem"), "failed to" (use "unable to"), illegal/invalid/bad (use "incorrect"), abort/kill/terminate (use "stop"), catastrophic/fatal (use "serious").
  - **Avoid "you" and "your" in error phrasing that could blame;** use passive voice when the active voice would make the user the culprit ("Incorrect password", not "You entered an incorrect password").
  - **Be specific:** name the objects, locations and values involved; "File not found" and "Disk is full" are incorrect.
  - **Show/Hide details** for advanced information and error codes ("Error code: 0x…"); don't hide needed information there, and don't use it to restate the message verbosely.
  - One message per detectable cause; when the cause is unknown, list solutions in order of likelihood and be honest about not knowing.
  - Don't clear incorrect input.

---

## 3. Google Material Design

Sources: [Material 1 writing](https://m1.material.io/style/writing.html), [Material communication codelab](https://codelabs.developers.google.com/codelabs/material-communication-guidance), [M3 global writing](https://m3.material.io/foundations/content-design/global-writing/word-choice) (client-rendered; content via search index)

- **Pronouns:** "you/your" by default. "I/my" can emphasise ownership but **"avoid using 'me' or 'my,' and 'you' or 'your,' in the same phrase."** **Avoid "we"** unless a person takes the action ("We'll review your appeal").
- **Tense:** "Use the present tense to describe product behavior." No future tense for things the product always does.
- **Sentence case** for titles, headings, labels, menu items.
- **Periods:** omit on single sentences in labels, hover text, bulleted lists.
- **Ellipsis** indicates an action in progress or incomplete text.
- **"Avoid exclamation points as they tend to come across as shouting."**
- **Numerals,** not words ("3", not "three").
- **Contractions** encouraged.
- **Brevity:** scannable segments; omit introductory phrases; begin with the objective; refer to controls by their label text.
- **Errors:** explain the issue and suggest a solution; supportive, never jokes.
- **M3 global writing:** avoid idioms and polite expressions ("Please", "Sorry", "Thank you"), especially in errors; "please" is acceptable when asking for something inconvenient.
- Material's button examples include "OK" and "Got it" for acknowledgements.

---

## 4. Shopify Polaris

Sources: [Actionable language](https://polaris.shopify.com/foundations/content/actionable-language), [Error messages](https://polaris-react.shopify.com/content/error-messages), [Toast](https://polaris-react.shopify.com/components/deprecated/toast), [Button](https://polaris-react.shopify.com/components/actions/button), [Shopify app content guidelines](https://shopify.dev/docs/apps/design/content)

- **Buttons:** lead with a strong verb; **{verb} + {noun}** ("Add tags") except common actions (Done, Close, Cancel, OK). Sentence case, **no articles**, no punctuation.
- **No permissive language:** don't write "you can"; start instructional sentences with an imperative verb.
- **Errors:** say what's wrong and what to do; be specific (precise numbers, dates, the merchant's own data); **don't over-apologise unless Shopify caused the problem**; avoid "invalid"; offer a one-click fix where possible; otherwise give troubleshooting steps.
- **Toasts:** short, affirmative, **noun + past participle, three words max** ("Product updated", "Collection added", "Internet disconnected"). Don't: "Your product has been successfully updated", "We were unable to save the customer." Toasts are for success and only for non-critical errors explainable in three words.
- **App content (shopify.dev):** target a **grade 7 reading level**; one term per concept, no synonyms; avoid idioms; spell words out instead of symbols; use the company name on first reference and **"we" after that is allowed**.

---

## 5. Atlassian Design System

Sources: [Designing messages](https://atlassian.design/foundations/content/designing-messages), [Error messages](https://atlassian.design/foundations/content/designing-messages/error-messages), [Empty state](https://atlassian.design/foundations/content/designing-messages/empty-state)

- **Error titles:** optional; scannable; **three to four words**; sentence case; don't put the fix in the title.
- **Error body:** the reason and how to act, **one to two sentences**; **"Avoid putting technical information in the message."**
- **"Avoid using 'please' and 'sorry'."**
- **Use "we" rather than "you"** so people don't feel blamed.
- **Buttons:** imperative verbs ("Save", "Remove", "Create"), one or two words, never "OK"; always offer dismiss or cancel.
- **Empty states:** informative title, sentence case, **no punctuation unless a question**; body gives the reason and where to go next, one to two sentences, no jargon; CTA uses an imperative verb, not "OK". If nothing is left to do, celebrate completion.
- Message types: error (problem + next step), warning (advance notice of possible loss), success ("celebrates success"), info.

---

## 6. GitHub Primer

Sources: [Content](https://primer.style/product/getting-started/foundations/content/), [ConfirmationDialog guidelines](https://primer.style/product/components/confirmation-dialog/guidelines/)

- Top rules: plain English, "don't sound like a robot"; cut adjectives and adverbs; active voice; **sentence case, "when in doubt, don't capitalize"**; no slang; no "here"/"click here"; be very careful with humour.
- Voice: "Clear but not cold", "Conversational but not jargon-y", "Helpful but not overly-prescriptive".
- **Labels and buttons: sentence case, no punctuation.** Buttons start with imperative verbs. "Sign in", not "log in".
- **Avoid exclamation marks;** "most actions aren't exciting enough."
- **Errors:** specific, no blame, no humour, no excessive apology.
- **"you/your"** for the user and their things.
- **Dates and times:** "am"/"pm"; relative time via a localised component; **precise absolute dates (weekday, date, month, year) for sensitive things like expirations.**
- **Confirmation dialogs:** title is a specific question, ideally **under five words** ("Delete repository?", "Discard changes?"); never "Are you sure?" or "Confirm action". Body states consequences, especially irreversible ones, and names the items affected; "This action cannot be undone" alone is too generic. Buttons: imperative, 1 to 3 words ("Delete repository" / "Cancel"), never Yes/No. Use only for destructive, irreversible, multi-user or data-loss actions; not for routine ones.

---

## 7. Mailchimp Content Style Guide

Sources: [Voice and tone](https://styleguide.mailchimp.com/voice-and-tone/), [Grammar and mechanics](https://styleguide.mailchimp.com/grammar-and-mechanics/), [Writing for accessibility](https://styleguide.mailchimp.com/writing-for-accessibility/)

- Voice: plainspoken, genuine, translators of jargon, **dry humour** ("straight-faced, subtle"); "forced humor can be worse than none." Tone shifts with the reader's emotional state.
- Active voice; singular "they"; contractions encouraged.
- **Numbers:** numerals except at the start of a sentence; commas over 999; "1k" in tight spaces; "%" symbol.
- **Dates:** spell out day and month ("Saturday, January 24"); abbreviate only for space ("Sat., Jan. 24").
- **Times:** "7 am", "7:30 pm"; drop ":00"; en dash ranges; state time zones.
- **Ellipses** sparingly; never for drama; never in titles or headers.
- **Exclamation points:** sparingly, never more than one, **never in failure messages or alerts.**
- Spell out unfamiliar abbreviations on first use.
- **Accessibility:** no directional language ("right sidebar"); descriptive links; plain language; don't rely on images alone.

---

## 8. Intuit Content Design (supplementary, concrete)

Source: [Errors](https://contentdesign.intuit.com/product-and-ui/errors/)

- Structure: **headline (what happened or how to fix it) / optional more info / call to action.**
- **No error codes in the UI;** log them on the back end.
- "Clarity trumps brevity."
- Passive voice is acceptable where it avoids blame.
- Tone by severity: casual for minor, neutral and direct for moderate, neutral for severe (don't escalate).
- Avoid: "error", "please", "hmm/yikes", "whoops/oops", "wrong", "invalid", "prohibited", "fail", "declined", "denied".
- Example: "Check your internet connection. You're not connected right now..." over "Network connection error. This operation could not be completed..."

---

## 9. Research and evidence (NN/g, Microsoft Research, Google PAIR)

### Error messages: [NN/g error-message guidelines](https://www.nngroup.com/articles/error-message-guidelines/)

- Visibility: next to the source; high contrast; never colour or animation alone; severity decides the vehicle (inline/toast for minor, modal only for severe); don't fire errors during exploration.
- Communication: plainspoken; hide obscure codes; **precise, never "An error occurred"**; constructive remedy; no "invalid"/"illegal"; **no humour** (it stales on repeat).
- Efficiency: prevent errors; **preserve input**; offer suggested fixes; educate briefly with links.

### Confirmation dialogs: [NN/g](https://www.nngroup.com/articles/confirmation-dialog/)

- Only for serious consequences; routine confirmations cause habituation ("cry wolf").
- Be specific about consequences; never "Are you sure you want to do this?"
- **Buttons summarise the outcome** ("Delete file" / "Keep file"), not Yes/No.
- No default "Yes"; probably no default at all.
- For very dangerous operations, require a nonstandard action (type a word).
- Offer a way to bypass routine confirmations. (Undo is the usual better alternative.)

### Empty states: [NN/g](https://www.nngroup.com/articles/empty-state-interface-design/)

- State plainly that nothing is there (so it isn't mistaken for loading or failure); say what would appear and how to populate it; give a direct link to the key task.

### Progress: [NN/g progress indicators](https://www.nngroup.com/articles/progress-indicators/)

- Spinners for roughly 2 to 10 seconds; nothing under 1 second; percent-done for 10 seconds or more.
- Label the wait: "Updating address 3 of 50", "Loading comments…".
- Evidence cited: people shown a moving progress bar were willing to wait about three times longer.

### AI-specific copy

- **[NN/g, Humanizing AI is a trap](https://www.nngroup.com/articles/humanizing-ai/):** first-person pronouns, emotional language, pleasantries ("Love this brief") are humanization patterns; cites studies where warmth-tuned models had 10 to 30% higher error rates and where attributing emotion to AI reduced advice acceptance. Recommends "usefulness over artificial friendship."
- **[NN/g, Explainable AI in chat interfaces](https://www.nngroup.com/articles/explainable-ai/):** sources next to the claim they support, with meaningful labels; step-by-step "reasoning" can mislead; disclaimers in plain language, paired with an action ("Double-check AI outputs"), placed near the input; "factual, neutral language" instead of first-person cognition.
- **[NN/g, 4 degrees of anthropomorphism](https://www.nngroup.com/articles/anthropomorphism/):** users anthropomorphise on their own; interfaces should not amplify it.
- **[Google PAIR, Explainability + Trust](https://pair.withgoogle.com/chapter/explainability-trust/):** show confidence as buckets (High/Medium/Low) or N-best alternatives ("might be New York, Tokyo, or Los Angeles") rather than raw numbers; explain outputs in response to user actions; give reasons in high-stakes cases; tell users when lack of data means they should use their own judgement; state capabilities and limits early.
- **[Microsoft HAX, Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/)** (Amershi et al., CHI 2019; [toolkit](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/)). Copy-relevant ones: G1 make clear what the system can do; G2 make clear how well it can do it; G11 make clear why the system did what it did; G16 convey the consequences of user actions; G17 provide global controls; G18 notify users about changes. (Guideline list from the published paper; the toolkit page did not render.)

---

## Synthesis

### (a) Where the sources agree

1. **Sentence case** for everything except proper nouns (Microsoft, Material, Polaris, Atlassian, Primer). Apple is the outlier for its own platform controls.
2. **Buttons are verbs, short (1 to 3 words), specific;** verb + noun when the verb alone is ambiguous (all).
3. **No "Yes/No"; avoid "OK" whenever a specific verb exists** (Apple, Atlassian, Primer, NN/g). Cancel is universal for cancelling.
4. **Confirmation buttons summarise outcomes** and dialog titles name the action ("Delete repository?"), never "Are you sure?" (Primer, NN/g, Apple, Microsoft's "call and response").
5. **Confirm only serious, irreversible actions;** prefer undo; destructive actions are never the default (Apple, Primer, NN/g).
6. **Errors: what happened + what to do,** specific (names, values), no blame, no jargon, no codes up front (all).
7. **No humour, interjections or exclamation marks in errors** ("oops", "uh-oh", "whoops") (Apple, Primer, Mailchimp, Intuit, NN/g, Material).
8. **Ban "invalid"/"illegal"** and similar judgement words (NN/g, Polaris, Microsoft, Intuit, Apple's "Invalid name" example).
9. **Empty states: state the fact, then a pathway with a button or link** (Apple, Atlassian, NN/g).
10. **No punctuation on buttons, labels, titles;** full stops on full sentences in body, tooltips, errors (Microsoft, Primer, Atlassian, Material).
11. **Plain language and one term per concept** (Apple's term list, Shopify's no-synonyms rule, Material).
12. **Descriptive links; never "click here"** (Apple, Primer, Mailchimp).
13. **Active voice,** imperative for instructions, no "you can" (Microsoft, Polaris, Apple).
14. **Contractions are fine** (Microsoft, Material, Mailchimp).
15. **Preserve input** after an error (NN/g, Microsoft Win32).

### (b) Where they disagree

| Question                  | Position A                                                                      | Position B                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| May the product say "we"? | No: Apple ("avoid altogether"), Material (only when a human acts)               | Yes: Microsoft Windows ("welcoming"), Atlassian (to avoid blaming "you"), Shopify (after first naming the company) |
| "please"                  | Never: Atlassian, Intuit                                                        | When the request is inconvenient or the app is at fault: Microsoft, Material                                       |
| "sorry"                   | Never: Atlassian                                                                | Only for serious failures the product caused: Microsoft, Polaris                                                   |
| "OK"                      | Never: Atlassian                                                                | Allowed for pure acknowledgement: Apple, Polaris, Material                                                         |
| "you" in errors           | Avoid, use passive to dodge blame: Microsoft Win32, Intuit                      | Address "you" directly: Microsoft Windows, Primer, Material                                                        |
| Error codes               | Never in UI, back end only: Intuit, Atlassian                                   | Behind Show/Hide details: Microsoft Win32                                                                          |
| Warmth                    | Warm, relaxed, celebratory: Microsoft Windows, Atlassian ("celebrates success") | Direct, neutral, no hype: Apple alerts, Primer ("most actions aren't exciting enough"), Mailchimp (dry)            |
| Ellipsis                  | Signals "opens another view for input" on a button: Apple                       | Signals in-progress or truncated text: Material; sparingly, never in titles: Mailchimp                             |
| Possessives               | Sparingly, "Favorites" over "Your Favorites": Apple                             | "your" for user-owned things: Primer, Material                                                                     |
| Capitalisation            | Title case for buttons and fragment titles: Apple                               | Sentence case everywhere: everyone else                                                                            |

### (c) Source rules that support DorkOS's decisions

| DorkOS decision                                    | Backed by                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dry, calm tone; control panel                      | Apple alerts ("direct ... neutral"), Primer (no exclamation; "most actions aren't exciting enough"), Mailchimp (dry, plainspoken), Intuit (neutral for serious errors), NN/g (no humour in errors) |
| Readable by a non-coder                            | Apple (plain language, no jargon), Shopify (grade 7), Microsoft (define abbreviations), NN/g                                                                                                       |
| Never "we"/"I"; talk to "you"                      | Apple (no "we"), Material (no "we"; don't mix "my" and "you"), Microsoft (never "I"), NN/g humanizing-AI (first person is a humanization pattern)                                                  |
| Errors = what happened + what to do                | Microsoft Win32 (problem, cause, solution), Polaris, Atlassian, Intuit, NN/g, Apple                                                                                                                |
| Raw details behind a Details toggle                | Microsoft Win32 ("Use a Show/Hide details progressive disclosure button"; error codes go there), NN/g (minimise or hide codes), Atlassian (no technical information in the message)                |
| Buttons name the exact action; never OK/Yes/Submit | Apple (no Yes/No; OK only for information), Atlassian (no OK), Primer, NN/g, Polaris verb + noun                                                                                                   |
| Empty state = one fact + one next step             | NN/g's three guidelines collapse to exactly this; Atlassian (1 to 2 sentences, reason + where next); Apple                                                                                         |
| Agents by name, then "it"                          | NN/g anti-humanization; PAIR; Material's present-tense, product-behaviour framing                                                                                                                  |
| Success toasts only when the result is not visible | Apple ("Don't use alerts merely to provide information"), NN/g (habituation), Microsoft Win32 ("Don't report errors users don't care about", by analogy)                                           |
| Sentence case                                      | Microsoft, Material, Polaris, Atlassian, Primer                                                                                                                                                    |
| Headlines take no full stop                        | Microsoft, Atlassian, Primer, Material                                                                                                                                                             |
| No hype words                                      | Primer (cut adjectives and adverbs), Microsoft (prune every word)                                                                                                                                  |
| Single-character ellipsis                          | Consistent with all; none mandate three dots                                                                                                                                                       |

### (d) Conflicts with DorkOS's decisions (flagged)

1. **CONFLICT: Apple's actorless errors vs "name the actor."** Apple's recommended fix for "we" is the actorless fragment "Unable to load content", and Microsoft Win32 prefers "unable to" over "failed to". DorkOS instead names the actor ("DorkOS couldn't load your sessions"). The two agree on dropping "we" but differ on what replaces it. Recommendation: keep naming the actor when the actor is something the user must act on (Telegram rejected the token; your agent stopped), and allow the actorless form when the actor adds nothing ("Couldn't load sessions"). Needs a decision.
2. **CONFLICT: Microsoft Win32 and Intuit say avoid "you/your" in errors** and use passive voice where "you" would blame ("Incorrect password", not "You entered an incorrect password"). DorkOS talks to "you" everywhere. Compatible if the rule is "you" for instructions, never "you" as the subject of a mistake.
3. **CONFLICT: Microsoft Windows and Atlassian endorse "we"** as warm and blame-deflecting. DorkOS's ban is backed by Apple and Material, so this is a choice, not an error, but reviewers citing Atlassian will push back.
4. **CONFLICT: "Never OK".** Apple, Polaris and Material allow OK for pure acknowledgement. DorkOS's rule is stricter (and Atlassian agrees). Practical gap: what does an acknowledge-only button say? "Done", "Close" or "Got it" are the usual substitutes; DorkOS should name one.
5. **CONFLICT: "Name the exact action" vs universal generic verbs.** Every guide keeps "Cancel", and Polaris exempts Done, Close, Cancel. DorkOS should state these carve-outs explicitly so the rule isn't applied to Cancel.
6. **CONFLICT: Success toasts.** Polaris uses toasts as the default success confirmation and Atlassian "celebrates success". DorkOS's "only when not visible" is stricter. Defensible (Apple, NN/g habituation), but note that toasts also serve screen-reader users who can't see the visible result, so "visible" should mean "perceivable", including via a live region.
7. **CONFLICT: "your agent" vs Apple's sparing possessives.** Apple would write "Agents", not "Your agents". Minor; DorkOS's actor-naming needs the possessive to distinguish the user's agent from DorkOS.
8. **CONFLICT: Warmth.** Microsoft Windows ("warm and relaxed", "don't worry") and Atlassian (celebrate) want more warmth than DorkOS's dry voice. Mailchimp shows dry can still be humane; DorkOS should keep "calm" from sliding into curt in serious errors (Microsoft and Polaris allow "sorry" when the product caused data loss).
9. **Minor: em dashes.** Microsoft's style uses them; DorkOS bans them. No impact on in-app rules.
10. **Minor: Apple title case** on buttons and fragment alert titles. DorkOS is a web and Electron app using sentence case; Microsoft, Material and the others support that.

### (e) Gaps DorkOS hasn't decided that the sources say matter

1. **"please" and "sorry".** Three positions exist (never; when inconvenient or our fault; serious failures only). DorkOS's no-"I"/"we" rule makes "sorry" awkward anyway ("DorkOS is sorry" sounds odd), which argues for Atlassian's never.
2. **Tense and form for status and results.** Material: present tense for behaviour. Polaris: toasts as noun + past participle ("Product updated"). Unsettled for DorkOS: "Agent stopped" vs "Your agent stopped" vs "Stopped"; activity-log entries (past tense, actor first?); live status ("Running", "Waiting for you", "Thinking…").
3. **Numbers, dates, times.** Numerals always (Material, Mailchimp); thousands separators and "1.2k" when tight; relative times for recency and absolute dates for anything consequential like expiry or scheduled runs (Primer); "am/pm" vs 24-hour and whose time zone (Mailchimp, Primer); durations and cost formatting (token counts, dollars).
4. **Lengths and truncation.** Sources give hard numbers: buttons 1 to 3 words (Primer), toasts 3 words or fewer (Polaris), error and empty-state titles 3 to 4 words (Atlassian), dialog titles under 5 words (Primer), alert titles no more than 2 lines (Apple), bodies 1 to 2 sentences (Atlassian). DorkOS has no limits, and no rule for truncating agent names, session titles and paths (middle vs end truncation, full text in a tooltip).
5. **Placeholder and hint text.** Apple: placeholder shows format or example. Accessibility practice: placeholder never replaces a label. Unsettled: example values ("e.g. …"), whether placeholders end with an ellipsis, and how the composer prompt reads.
6. **Permission and approval prompts** (the most DorkOS-specific gap). Apple: one active sentence of how and why; ask at the moment of use; pre-prompt button is "Continue", not "Allow". HAX G16: convey consequences. Unsettled: how an agent's request to run a command or edit files is phrased (actor + action + object + consequence?), button pair wording ("Allow once" / "Always allow" / "Deny"?), how much of the raw command shows by default, and how to describe risk without alarm.
7. **AI-specific copy.** Sources agree on no first person for the system and factual, neutral language (NN/g), but DorkOS hasn't decided how to describe: an agent's uncertainty or failure ("Claude Code couldn't finish" vs "stopped"), agent actions in the third person in logs, confidence (PAIR buckets vs nothing), whether agent-written text is labelled as such, what limitations disclaimer exists and where (NN/g: near the input, paired with an action), and how to attribute which runtime/model did what (HAX G11 "why it did what it did").
8. **Confirmation dialog shape.** Title as a question naming the object ("Delete Atlas?"), body naming consequences and affected items, typing to confirm for the most dangerous actions (NN/g), when undo replaces confirmation, and whether to offer "Don't ask again" (NN/g bypass; Microsoft Win32 has rules for it).
9. **Disabled controls.** Microsoft Win32: if the reason isn't obvious, leave the control enabled and explain, or give a tooltip. DorkOS has no rule for explaining disabled states.
10. **Loading and progress text.** NN/g thresholds (nothing under 1 s, spinner 2 to 10 s, progress over 10 s) and labelled waits ("Starting agent 2 of 5…"). Unsettled: verb form ("Loading sessions…" vs "Loading…"), and whether long waits show the step.
11. **Accessibility labels.** Icon-only buttons need verb labels matching visible conventions; descriptive links (Apple, Primer, Mailchimp); no directional language like "the button on the right" (Mailchimp); never colour alone for status (NN/g). Unsettled: aria-label wording conventions and whether success messages go to a live region when no toast is shown.
12. **Settings descriptions.** Apple: describe what happens when the setting is on; don't describe the off state; link directly to settings instead of giving directions. DorkOS has no stated rule.
13. **Glossary.** Apple and Shopify both require a term list with one word per concept. DorkOS has vocabulary gates for banned words but the brief does not mention a positive glossary of preferred terms for in-app copy (session vs chat vs conversation, stop vs cancel vs interrupt).
14. **Interaction verbs.** "Click" vs "select" vs "tap" across desktop, web and phone (Apple, Microsoft use "select").
15. **Banned-word list for errors.** Microsoft Win32 and Intuit give ready lists (error, failure, failed, invalid, illegal, abort, kill, fatal, oops). DorkOS's dry tone suggests adopting one; "kill" and "terminate" are common in developer-facing agent tooling and would need translating ("stop").

---

## Research gaps and limitations

- Apple Style Guide (help.apple.com) was not consulted directly; HIG pages cover in-app rules.
- Material 3 and Atlassian pages are client-rendered; Material 3 rules come from search-indexed excerpts and the Material 1 page plus Google's codelab, which may lag M3 wording.
- Polaris's current content pages redirect to the new Polaris docs; rules come from indexed excerpts of the archived Polaris React site and `shopify.dev`.
- Stripe, Linear, Figma, Slack (UI copy), Intercom and 37signals have no published in-app microcopy guides that surfaced. Their copy is admired but undocumented, so no rules are attributed to them.
- The Microsoft Win32 error guidance targets Windows 7 but remains the most detailed public specification.
- No controlled study was found comparing specific button labels (e.g., "Delete" vs "Delete file"); button-label guidance rests on expert consensus and the habituation evidence NN/g cites.

## Search methodology

- Searches: 10 WebSearch calls, about 30 WebFetch calls.
- Productive techniques: Apple's JSON data endpoints for HIG pages; Microsoft Learn pages render fully; NN/g pages render fully.
- Primary sources: developer.apple.com, learn.microsoft.com, m1.material.io, codelabs.developers.google.com, polaris.shopify.com, shopify.dev, atlassian.design, primer.style, styleguide.mailchimp.com, contentdesign.intuit.com, nngroup.com, pair.withgoogle.com, microsoft.com/research.
