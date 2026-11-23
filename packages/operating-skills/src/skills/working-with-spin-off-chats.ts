import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/**
 * Teaches an agent when to use a helper and when to start a spin-off chat, and
 * how to brief, check on, message and stop a spin-off (spec `spin-off-chats` §7),
 * and how one project-lead spin-off carries long work while a room hears only
 * three kinds of update (DOR-4469).
 */
export const workingWithSpinOffChats: OperatingSkill = {
  name: 'working-with-spin-off-chats',
  description:
    'Use when work should run somewhere other than your own turn: choosing between a helper ' +
    'and a spin-off chat, starting and briefing a spin-off, checking on it, messaging, ' +
    'steering or stopping another chat, acting on a report a spin-off sent back, or leading ' +
    'long project work from one chat. Covers ' +
    'session_start, chat_send, chat_read and chat_stop.',
  body: `# Working with spin-off chats

${TOOL_NAME_NOTE}

Three words, used exactly:

- **Chat**: a conversation with an agent. People and agents can open it, read
  it and type in it.
- **Spin-off chat**: a full chat that another chat started. It shows "Started
  from" the chat that made it, lasts hours or days, and survives restarts.
- **Helper**: a worker inside one chat (your runtime may call it a subagent).
  Nobody can open it or message it. It reports once, to the chat that made it,
  and ends in minutes.

Never say "helper chat". Never call a helper a spin-off.

## Helper or spin-off?

Use a **helper** for short look-and-report work: read these files, search for
that, sum up this log. It finishes inside your turn and hands you one answer.

Use a **spin-off chat** when the work:

- takes more than a few minutes, or waits on CI, a deploy or a timer;
- has to keep going after your turn ends, or survive a restart;
- should run on a different account;
- is something the person may want to watch or step into.

A helper has no DorkOS tools. Send messages to other chats from your own chat.

## One lead for long project work

Long project work gets **one project lead**: one spin-off chat that owns the
work until it ships. It is an ordinary spin-off with a clear brief, not a new
role and not more access.

- **Start one, or reuse one.** If a lead already has the work, message it.
  Never start a second chat just to ask how it is going.
- **The lead coordinates by direct message.** It sends \`chat_send\` to the one
  agent who must act, checks the result, and keeps going. Chasing a late reply
  is one more message to that agent, not a post in a room.
- **No status relays.** Progress, chasing and other chats' reports stay in the
  chats. Never copy them into a room, and never use cc as a status channel.
- **A room hears three things about project work**: it started, it is blocked
  on a person, it shipped. These are kinds of update, not a quota. When someone
  in the room asks, they still get a short, useful answer.

## Start one

\`session_start\` with \`prompt\` (the first message) and \`cwd\` (the folder it
works in). It returns the new chat's id at once, and the spin-off starts on
its own.

Write the first message as a brief:

1. **The goal**, in one or two sentences.
2. **What done means**: the check that proves it. Tests pass, the PR merged, a
   file exists.
3. **How to wait**: keep its turn alive while it waits on CI or a timer, for
   example \`gh pr checks --watch\`, or a short \`sleep\` loop that checks again.
   A turn that ends while still waiting has not finished anything.
4. **What is known**: the context it needs, its limits, and the reviews or
   approvals the work must pass.
5. **How to report**: send working notes with \`chat_send\` as it goes, never
   into a room. The final report comes back by itself.

## How a spin-off reports back

You do not need to ask. When one of its turns ends finished, failed, needing
the person, or paused at an account limit, its last message arrives in your
chat as a report. If you are idle, the report starts a turn for you. If a turn
ends with background work still running, the report waits up to 15 minutes for
that work.

Started from a room, the report comes to your chat in that room as a turn
only you see. Nobody else in the room reads it, and it is not room news by
itself. Post there only when the work starts, is blocked on a person, or
ships, or to answer someone who asked. Long work stays with its lead chat; do
not carry it on inside your room chat.

A spin-off started from a beat, a scheduled run or a Telegram or Slack chat
does not report back: nothing can write into those. Name in its brief the chat
or agent that should hear the result.

So after you start one, end your turn. Do not poll it.

## Check on one

\`chat_read\` reads a chat linked to yours: your own, the chat that started you,
chats you started, and chats you have messaged or that messaged you.

1. Start cheap: \`chat_read\` with \`include: "status"\`. You get its state
   (running, needs-you, done, failed, stopped, paused-at-limit, idle, never-started) and no
   messages.
2. Then read what is new: \`chat_read\` with \`since: "last-read"\`, the default.
3. Only when needed: \`last\` for the newest few, \`query\` to find words,
   \`include: "tools"\` for one line per tool call, \`cursor\` to continue a
   long read.

A spin-off that misses its first turn reports back after five minutes.
Its state is \`never-started\`; \`chat.startupFailure\` says why.

Never read transcript files to check on a chat.

## Message one

\`chat_send\` with \`to\` (a chat id, or an agent id for your own direct chat
with that agent), \`message\`, and a short \`summary\` for the card the person
sees.

Pick a \`delivery\`:

- \`queue\` (default): waits until its current turn ends. Use this almost always.
- \`steer\`: joins its running turn now, to change course while it works.
- \`interrupt\`: stops its running turn and runs your message next. Use it when
  the current work is wrong and should not finish.

To answer a message another chat sent you, set \`replyTo\` to that message's id.
There is no "from" field. The server marks every message with you and your
chat, so the other side always knows who wrote it.

Your chat in a room can send too. \`chat_send\` never posts into a room: sent
to another agent's chat in a room, it arrives there as a private turn, and the
room sees at most a one-line note that you wrote. Only \`post_to_room\` speaks
in a room.

## Stop one

\`chat_stop\` with the chat id and a short \`reason\`. It stops the running turn,
like the Stop button. The stop goes in the audit trail and shows in that chat
with your name and reason. Anything the person queued there still runs. To
stop your own chat, end your turn instead.

## Quiet in speech

When a report wakes you, act on it first: check what it claims, start the next
step, or send the spin-off what it needs. Then tell the person only what
matters to them: a result, a decision they owe, or a problem. Do not narrate
the messages between chats. They can open any of them.
`,
};
