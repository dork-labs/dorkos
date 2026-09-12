# Implementation Summary: Sessions with nobody to answer

**Created:** 2026-09-12
**Last Updated:** 2026-09-12
**Spec:** `specs/unattended-session-permission-prompts/02-specification.md`
**Tracker:** none — shipped directly from the spec.

## Progress

**Status:** Implemented — all tasks shipped, all PRs merged.

## What shipped

**PR #1818** — a task running on its timer no longer waits ten minutes for an approval
nobody can give. When it reaches for something that needs permission, the request is
turned down straight away and the agent carries on without that one tool.

The person is told what it missed, twice over: the run's own line in run history leads
with the tools it could not use, and each one lands in the activity feed on its own.
Nothing pings a phone about it.

**Clicking "Run now" is unchanged.** Somebody is sitting there watching, so its approval
cards behave exactly as they always have.

### The design

All three interactive callbacks — `canUseTool`'s approval path, the `AskUserQuestion`
path, and `onElicitation` — refuse on the spot when `session.unattended` is set. No card
is pushed, no timer is armed, and the model reads one constant sentence: nobody is
available to approve this, do what you can without it and say what you skipped.

**The refusal sits behind every existing gate, not in front of one.** The CLI's own
permission engine, the safe lists, `isAutoAllowedCall` and `resolveModeDecision` all run
first and are untouched. A scheduled run keeps every tool it never had to ask about, and
a `bypassPermissions` schedule still allows exactly what that mode always allowed. Only
an ask that would otherwise sit and wait is refused.

Each refusal pushes a `permission_denied` event stamped `no_approval_surface` — a
discriminator only DorkOS writes, which is what lets the run summary say "nobody was
there to approve it" flatly. The SDK's own denials describe decisions that would have
gone the same way with a person present, carry different discriminators, and are left
out, so a safety-classifier refusal is never dressed up as an absent human.

## Accepted deviations from the spec

- **The SDK's `permissionPrompts: 'none'` was used first, then reverted.** Two reasons,
  both worth keeping. It **denies more than it should**: the option refuses everything
  that would prompt, including the calls the CLI escalates under `bypassPermissions`
  that `resolveModeDecision` deliberately allows — so it would have narrowed a level the
  operator chose on purpose. And it **forces a list this repo has already banned**: with
  the option set the SDK never calls `canUseTool` at all, so DorkOS's own auto-allow
  disappears with it, and restoring it means writing tool names into
  `options.allowedTools` — the approval-widening option DOR-519 removed and pinned a
  regression test against. It also left a dead-but-still-set callback, an eager identity
  read per launch, and a standing exception somebody would have to re-argue. Refusing
  inside the callback costs nothing the option bought: the record the reporting needs is
  one event this code writes itself.
- **The rooms proposal is withdrawn.** The ideation suggested flagging room turns too. A
  room turn's ask is answerable from the app, and `room-turn-runner.ts` already tracks
  each one to its resolution, so by the codebase's own rule — can anybody answer this? —
  rooms keep the wait. Decision 2 (bridged senders) is moot as a result.

## Fixed on the way past

The scheduler set the unattended flag for **every** run it executed, including a "Run
now" somebody clicked and stayed to watch — taking their approval cards away at the one
trigger with a person in front of it. The flag is now set only for
`trigger === 'scheduled'`, on both dispatch paths, and the wire field became a closed
enum so an invented value can no longer read as "attended" (three fixtures were carrying
`cron` and `schedule`).

## Notes

- DorkOS's own capability approvals are unchanged and still on the late-verdict path;
  they never travelled through `canUseTool`, and two cases pin that the gate cannot tell
  an unattended session from any other.
- The relay dispatch path reaches no activity service and carries the summary line
  alone — the same asymmetry DOR-1580 records.
- The rule is global; there is no per-task override.
