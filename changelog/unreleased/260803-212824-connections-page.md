---
covers:
  - 'feat(shared,client): Transport reaches the connection-scoping endpoints (DOR-857)'
  - 'feat(client): entity hooks for agent attachments, the claim feed, and binding move (DOR-857)'
  - 'feat(client): the setup wizard asks who answers first, and saves both together (DOR-857)'
  - 'feat(client): Connections page v2 — two regions, claim cards, the relay dialog retired (DOR-857)'
  - "feat(client): retire the messaging dialog's deep links onto the page (DOR-857)"
  - 'feat(client): a designed intent step for services that are two things at once (DOR-857)'
  - 'fix(client): tell the truth when a failed save cannot be undone (DOR-857 review)'
  - 'fix(client): a failed services fetch is an error state, not an empty one (DOR-857 review)'
---

### Added

- **Connections is a page now, with two halves.** Messaging is where people and
  platforms reach your agents. Accounts is the services your agents can act on
  for you. They sit on one page, one scroll, because they ask two different
  things of you: who may write to your agents, and what your agents may do
  under your name.
- **You can see who is trying to reach a bot nobody set up.** A Telegram or
  Slack bot can be found by anyone. When a stranger writes to one, DorkOS now
  shows you a card at the top of the page: who wrote, and how many times. It
  never shows what they wrote, because it never reads it. Pick an agent to
  answer, ignore the chat, or block it outright. The bot stays quiet until you
  decide, and no agent runs, so nothing is spent.
- **An account you give an agent stays given.** Switch on Gmail for an agent and
  every session it starts gets Gmail, today and after a restart. A single
  session can still add or drop an account just for itself.
- **A fresh install shows you what is possible.** The Accounts half used to be
  an empty box until you set up a carrier, which made it look broken. It now
  names the services and tells you the truth about what stands in the way:
  Gmail and the rest connect through Composio, a one-time setup of about two
  minutes, and your sign-ins live in Composio's vault rather than on this
  machine.

### Changed

- **Setting up Telegram or Slack asks who should answer first.** It used to ask
  last, and let you skip. Skipping left you with a bot that reached nobody and
  no sign that anything was wrong. The agent and the connection are now saved
  together, and if the agent cannot be set, nothing is saved at all.
- **A chat that already reaches an agent says so.** Pointing it at someone else
  now asks once — "This chat reaches DorkBot. Move it to security-auditor?" —
  instead of quietly creating a second route that never fires.
- **Old links still work.** Anything that used to open the messaging pop-up,
  including the Settings link, now lands on the messaging half of the page.
- **Slack asks what you want it for.** It can be a place you talk to your
  agents, or an account they act on as you. Those are different things, so it
  asks which, and tells you where an account sign-in is kept before you pick.
- **Session strategy is in plain words.** "One conversation per chat", "One
  conversation per person", or "A fresh start every message", each saying what
  it means.
