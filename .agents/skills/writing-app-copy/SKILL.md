---
name: writing-app-copy
description: The DorkOS in-app copy standard - voice, the word-count cap, and the rules for buttons, errors, empty states, confirmations, toasts, settings, approvals, status, times and truncation. Use when writing, editing or reviewing any string the DorkOS app renders (apps/client/src, or server copy the client shows verbatim), or when sweeping app copy.
---

# Writing App Copy

The app is a control panel, not a consumer app. Its words are dry, calm, short and plain. This skill is the standard for every string the DorkOS app renders. It builds on `writing-for-humans`, which still sets the readability floor: a smart 9th grader who does not code can follow it. The operator settled every rule here on 2026-10-02; the research behind them is `research/20261002_in-app-copy-guidelines.md`.

**Governs:** every string a person sees or hears in the app. That is labels, buttons, titles, descriptions, toasts, banners, tooltips, placeholders, empty states, errors, `aria-label`s, and server-authored copy the client renders as written.

**Does not govern:** docs, the marketing site, blog, changelog and READMEs (`writing-for-humans`), replies to one person (`writing-to-users`), code samples inside `<code>`, Dev Playground commentary, and prompt text written for a model.

## Length: the one rule a robot checks

Count the words in each **block**: one label, one title, one body, one toast, one tooltip. A title and its body are two blocks.

| Words | Verdict                              |
| ----- | ------------------------------------ |
| 1-3   | Preferred                            |
| 4-6   | Good                                 |
| 7-15  | Allowed, flagged. Shorten if you can |
| 16+   | Never                                |

`pnpm check:copy-length` measures every block in `apps/client/src` and lists the long ones, worst first (`--warnings` lists the 7-15 ones too). It runs in the `typecheck` CI job, and a 16+ block fails the build. It counts `{name}` as one word, and joins `Couldn’t reach {name}. Try again.` into one block.

**When there is more to say,** climb this ladder and stop at the first rung that works:

1. **Cut.** Most long copy explains how the system works. Drop that and keep what changes for the person.
2. **Split** into a short title and a short body.
3. **Disclose in place.** Put the rest behind an expandable section, a popover, or an info tip next to the control. Each paragraph inside is a block too, so each stays at 15 words or fewer.
   Use `InfoTip` for a note on one control and `MoreDetails` for paragraphs under a description, both from `layers/shared/ui`. Never a `Tooltip`: it is hover-only.
4. **Link out** to a docs page with "Learn more". Last resort.

There is no exception marker. A block that "has to" be long has not been split yet.

> Before (82 words, `BindingAdvancedSection.tsx`): "At a stop that asks, an action this agent needs permission for waits for an answer: where your connection can show buttons, it arrives in the chat as Approve and Deny, and only the…"
>
> After: "Asks in the chat" (title). "Approve or deny from the chat itself." (body). The routing detail goes in a popover.

## Voice

- **Dry and calm.** No jokes, no exclamation marks, no cheerleading.
- **Never "we" or "I".** The app has no speaker. Name the actor: DorkOS, your agent, Scout, Telegram. Talk to "you".
- **No "please", "sorry" or "oops".** With no speaker, there is nobody to apologize.
- **No blame words:** failed, invalid, illegal, fatal, abort, kill. Say what did not happen: "Couldn’t save".
- **Plain words.** Gloss a technical term in the same sentence or cut it.
- **No code names.** Relay, Mesh, Pulse, Harness Sync and "runtime" never appear. Say what it does: "Messages can’t be delivered right now", "Runs on: Codex". A name the person chose, like an agent's name, is fine. One carve-out: "Runtimes" stays as the name of its Settings tab and rows (`plans/language-ia-simplification.md` D3, kept by the operator on 2026-10-02). A sentence still says "Runs on: Codex", never "Runtime: codex".
- **One word per idea.** Once a thing has a name in the app, use that name everywhere. The banned-term list in `scripts/vocab-gate/banned-terms.json` holds the retired ones.

| Before                                                                    | After                                        |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| "OpenRouter sign-in failed. Please try again."                            | "Couldn’t sign in to OpenRouter. Try again." |
| "DorkOS shares a little anonymous data … so we can count active installs" | "DorkOS counts installs anonymously."        |
| `Test failed: ${reason}`                                                  | `Telegram didn’t answer: ${reason}`          |

## Agents

- Call an agent by its name. Without one, say "your agent". The pronoun is "it".
- Describe what an agent did, as fact: "Scout changed 3 files". No feelings or mind verbs: not "thinking hard", "confused", "happy to help".
- Be honest about limits: "Scout stopped. It hit its turn limit."

## Buttons

- **Name the exact action:** "Delete agent", "Connect Telegram", "Send".
- **Generic labels allowed:** Cancel, Close, Done. These mean "leave".
- **Banned:** OK, Yes, No, Submit, Confirm.
- The destructive button is never the default or the autofocused one.
- A disabled control explains why in a tooltip, unless the reason is on screen.

## Errors

1. Say what did not happen, naming the object: "Couldn’t reach Telegram."
2. Say what to do next: "Check your token and try again."
3. Hide raw details (codes, stack traces, server text) behind a "Details" toggle.
4. Keep everything the person typed.

## Confirmation dialogs

Use one only for something that can't be undone.

- **Title:** a question naming the object. "Delete Scout?"
- **Body:** what happens, to what. "Its chats are kept. Its folder is deleted."
- **Buttons:** "Cancel" and the exact action. "Delete agent".

## Empty states

One fact, one next step. No selling.

> No tasks yet
> Tasks run an agent on a schedule.
> [New task]

## Success feedback

- If the screen already shows the result (a toggle flipped, a dialog closed), add nothing visible.
- Toast only for a result that happens out of sight: "Task started".
- A screen reader still announces the result, through a polite live region. Silence on screen is not silence for everyone.
- `contributing/design-system.md` (Toast, Banners) decides toast vs banner vs moment.

## Settings

The label names the thing. One line under it says what changes for you when it is on. No mechanism.

> Keep agents running when you close the app
> They finish their work and message you when done.

## Approvals and other asks

- Lead with the plain outcome: "Scout wants to delete the build folder".
- Show the raw command below it, smaller, for anyone who wants to check.
- Every ask says what happens and why. A command, stage name or item ID is never the headline.
- Buttons: "Don’t allow" and "Allow".

## Status and activity

Short state words. Present tense for now, past tense for done. Drop the actor when the row already shows it.

> Scout Working
> Atlas Needs you
> Bolt Finished 2m ago

Waits get a label: "Starting agent 2 of 5…".

## Times

- Recent times are relative: just now, 5m ago, 3h ago, yesterday.
- Older ones are a date: Sep 28.
- The exact time shows on hover. Follow the computer's 12/24-hour setting.

## Truncation

- Paths are cut in the middle, keeping the file name: `~/code/…/ui/Button.tsx`.
- Names and titles are cut at the end with `…`.
- The full text always shows on hover.

## Mechanics (already house rules)

Summarised here. Casing, ellipsis, quotes and full stops are set in `contributing/design-system.md` (Casing, Punctuation); the em-dash rule is `writing-for-humans`.

- Sentence case for every string.
- The single-character ellipsis `…`. Curly quotes and apostrophes, written literally.
- A headline takes no full stop. A supporting sentence does.
- No em dashes.

The vocab gate (`pnpm check:vocab-gate`) fails the build on banned words and on `...` or HTML-entity quotes.

## Self-check before you save

1. **Count.** Is every block 6 words or fewer? If over 15, climb the ladder.
2. **Speaker.** Any "we", "I", "please" or "sorry"? Cut it.
3. **Actor.** Does the sentence say who did it?
4. **Outcome.** Does it say what changes for the person, not how the system works?
5. **Next step.** Does every error and empty state leave the person a clear next move?
6. **Code names.** Would someone who never read the source understand every noun?
7. **E2E strings.** Browser specs assert literal copy. `grep -rn "<old text>" apps/e2e` before you change a string.
