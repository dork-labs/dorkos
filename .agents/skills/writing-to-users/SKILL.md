---
name: writing-to-users
description: 'Writes a direct reply to one person about their own report or question: GitHub issue replies, feedback receipt, decision and shipped emails, discussion answers, decline notes. Use when a named person is waiting to hear back from DorkOS in any channel. Builds on writing-for-humans; the standard it enforces is meta/user-care.md.'
---

# Writing to Users

One person wrote to us. This skill is how we write back. It covers every one-to-one reply: a comment on a GitHub issue, the receipt and shipped emails, a decline, an answer in a discussion, a reply on Discord or social media.

It builds on `writing-for-humans`, which owns everything published for everyone (docs, changelog, UI copy). Read that first if you have not. This skill adds what a reply to a specific person needs: the standard in `meta/user-care.md`, the three reply shapes, and the checks before anything posts.

## When to use

- Someone opened a GitHub issue or discussion and has not been answered
- A feedback report needs its receipt, decision, or shipped note
- We are declining a request or closing a report
- Any time a named person is waiting on us

Do not use it for a changelog entry, release notes, or a docs page. That is `writing-for-humans` and `writing-changelogs`.

## The three replies

Every report gets these three, in order, per `meta/user-care.md`. Each one is short. Each one names something real.

### 1. Heard (within one business day)

Four parts, in this order, usually four to six sentences total:

1. Their name and thanks. "Thanks, Karl."
2. One specific detail from their report that proves a person read it. Quote or paraphrase something only their report contains.
3. What we are doing right now. "I've filed it and I'm reading through the log you attached."
4. When they hear next. A day, not "soon."

Example:

> Thanks, Karl. The part where a heartbeat from the old page resets the failure count is the key detail, and it explains why the ladder never climbs past a plain reload. I've filed this and I'm reproducing it on a slow machine. You'll hear from me by Wednesday with what we're going to do.

### 2. Decided (within five business days)

Three parts:

1. The decision in the first sentence. "We're fixing this." or "We're not going to change this."
2. One sentence of why, in their terms, not ours.
3. What happens next. For a fix: "I'll comment here when it's in a release." For a no: what they can do instead, if anything, and thanks anyway.

Never give a date for the fix. Give the next update instead.

Example of a no:

> We're not going to add a setting for this. The panel is meant to show one state, and a second mode would make the common case harder to read. If the delay is the real problem for you, the fix in #1840 should remove it. Thanks for writing it up so carefully.

### 3. Shipped (the day of the release)

Three parts:

1. The version and the release link.
2. One plain line on what changed for them. Not the commit, the outcome.
3. Thanks that names what they contributed.

Then close the issue. On GitHub, comment first and close second, so the close is never silent.

Example:

> This is in v0.75.0: https://github.com/dork-labs/dorkos/releases/tag/v0.75.0. The app now waits for the new page's own heartbeat before it counts a boot as healthy, so a slow start can't loop. Your write-up of the reset was exactly right and saved us most of a day. Thank you.

## Tone

Write like one person writing to another. Plain words. Short sentences. Say "I" when you did it and "we" when the team did.

- Warm, not gushing. One thank-you per reply.
- Specific, not vague. "The log line at 14:02" beats "the details you provided."
- Honest, not reassuring. If we do not know yet, say we do not know yet.
- Calm about bad news. A "no" is one sentence, not a paragraph of apology.

## Never write

- "We'll look into it." Say what you are doing instead.
- "Sorry for any inconvenience." Say what went wrong and what you did.
- "Great question!" or "Thanks for reaching out!" as an opener. Start with their name.
- A fix date. Only a next-update date.
- Anything about a fix being done before it is in a release someone can install.
- Anything that blames their setup, skills, or reading of the docs.
- Em dashes, bullet lists, headers, or bold in a reply. A reply is a note, not a document.
- Filler that reads like a template: "I hope this helps," "Please don't hesitate," "Feel free to."

## Before it posts

Run these in order. Any miss means rewrite.

1. Does the reply name one thing only their report contains?
2. Does it say when they hear next, with a day?
3. Could a smart 9th grader read every sentence?
4. Is every claim true today? (`writing-for-humans` honesty gate)
5. Would you be glad to receive it if you had written the report?
6. Is the `agent:provenance` line at the end if an agent drafted it?
7. Has a person approved this exact text? An agent never posts to a reporter on its own.

## Where the replies go

Reply in the channel the person used. A GitHub issue gets a GitHub comment. A "Send feedback" report gets the receipt and shipped emails from the pipeline, and a decline email when needed (`/feedback:triage`). Never ask a person to move channels.

Related: `meta/user-care.md` (the standard), `writing-for-humans` (the base rules), `/feedback:triage` (the queue and its checks), `meta/agent-etiquette.md` (how agents behave in shared rooms; the same restraint applies here).
