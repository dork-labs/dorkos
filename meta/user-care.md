# User care: how we treat a person who reaches out

> **A person who tells us about a problem gets a real answer within one business day, hears what we decided, and hears when it ships. Nobody gets silence.**

This page is the standard. It applies to every person who contacts us about DorkOS in any channel: a GitHub issue, the in-app "Send feedback" dialog, `dorkos feedback`, a GitHub discussion, email, Discord, or a reply on social media. It binds people and agents alike. How to _write_ each reply is the `writing-to-users` skill. How the queue is worked is `/feedback:triage`.

## 1. Why this is a standard and not a nice-to-have

Most people who hit a bug in alpha software do not report it. They close the app and never come back. The few who write to us are doing us a favor with their time. Some, like the reporter of #1458, hand us a diagnosis that saves a day of work.

So a report is not a support ticket. It is the moment we find out whether a user stays. The fix matters. The reply matters more, and sooner. People forgive a slow fix. They do not forgive being ignored.

## 2. The three beats

Every report gets all three. No report skips one.

| Beat        | When                         | What the person learns                                                               |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| **Heard**   | within one business day      | A person read it. Here is the one detail that proves it. Here is when you hear next. |
| **Decided** | within five business days    | What we will do, or that we will not, and why.                                       |
| **Shipped** | the day the release goes out | The version, one line on what changed, thanks that names their help.                 |

Clocks start when the report lands, not when we notice it. If a beat is going to slip, say so before the deadline, not after they ask.

## 3. The rules

1. **Reply where they wrote.** They chose the channel. Answer there. Never ask a person to re-file somewhere else. Mirroring into Linear is our job, not theirs.
2. **A person answers.** Sign with a name. An agent may draft; a person approves before anything posts in public. Agent-drafted replies still carry the `agent:provenance` line so the trail is honest.
3. **Prove you read it.** Every "heard" reply names one specific thing from their report. "Thanks, we'll look into it" is a form letter. Form letters are a defect.
4. **Say what happens next, with a time.** "You'll hear from us by Thursday." Then hear from them by Thursday.
5. **Never promise a date for a fix.** Promise the next update instead. Dates for fixes come from the release, after it ships.
6. **A kind no beats a silent yes.** If we will not fix it, say so, say why in one sentence, and thank them anyway. Closing without a reply is forbidden.
7. **Never blame the person.** Not their setup, not their reading of the docs, not their expectations. If the docs misled them, the docs are the bug.
8. **Close the loop on GitHub the same way we do by email.** When the fix ships, comment with the version and close the issue. Do not close on merge; the person cannot get the fix until the release.
9. **One reply per beat.** Do not pile on updates. Silence between beats is fine when the next date is known. Over-talking reads as a bot.
10. **Write plainly.** The `writing-for-humans` rules apply. No hype, no jargon without a gloss, no em dashes, nothing that reads like it came from a template.

## 4. What an agent may and may not do

An agent working the queue (`/feedback:triage`) may: read every channel, mirror a report into Linear, search for duplicates, draft any of the three replies, and print the queue's health.

An agent may not, without a person approving that exact text: post in public, email a reporter, close an issue, or say that anything is fixed or planned.

## 5. How we know we are keeping the promise

`/feedback:triage` ends every run with these rows. A non-zero row is a defect to fix that day, not a statistic.

- Reports with **no reply after one business day**.
- Reports **heard but not decided** after five business days.
- Reports **decided as "fix" with no linked work item**.
- Reports whose fix **shipped with no "shipped" reply**.
- Reports **closed by hand with no reply** on the thread.

Two numbers to watch over time: median hours to first reply, and median days to decision. If the first goes over a day, stop other work and clear the queue.

## 6. The bar

The reply on #1458 (2026-09-03) is the bar: answered in 17 hours, named the exact diagnosis the reporter had made, told them the release it would be in, and thanked them for the time it saved. Their answer was "Amazing!" That is the response we want from every person who writes to us, whether the news is good or not.
