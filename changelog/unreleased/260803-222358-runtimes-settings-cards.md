---
covers:
  - 'chore(client): runtime card building blocks — summary builder, rows, trust-write hook, accounts section (DOR-888 P2 wave 1)'
  - 'chore(client): RuntimeCardView, section registry, power source, global trust row (DOR-888 P2 wave 2)'
  - 'chore(client): RuntimeCard container with lazy catalog, sectioned writes, shared mock-factory fix (DOR-888 P2 wave 3)'
  - 'chore(client): recomposed RuntimesTab, settings trust vocabulary, strip injection (DOR-888 P2 wave 4)'
  - 'chore(client): retire superseded settings components, playground showcases, e2e flow, changelog fragment (DOR-888 P2 wave 5)'
  - 'chore(client): visual-gate fixes from driving the real cockpit (DOR-888 P2 wave 6)'
  - 'chore(client): P2 review round — conversation-first trust heading, sectionless honesty, review nits (DOR-888 P2 wave 7)'
---

### Changed

- The Settings Runtimes page now shows one card per runtime instead of a
  single shared form. Each card shows what a new conversation with that
  runtime will start with, at a glance.
- You can now set the model and thinking effort for every runtime, not just
  your default one. Before, only the default runtime's model and effort
  could be changed at all.
- Pick your default runtime by clicking Make default on its card.
- Claude Code's billing accounts and OpenCode's power source now live on
  their own runtime's card instead of somewhere else in Settings.
- One shared control, "Where new conversations stop for you," sits below the
  cards and covers every runtime at once.
- The Runtimes page now works on your phone: cards expand in place instead
  of needing a wider screen.
- This page now calls the three trust levels "Asks before acting," "Pauses
  at big steps," and "Full autonomy," so the words describe what each level
  actually does.

### Fixed

- Fix the exceptions list guessing whether a runtime you have not connected
  yet supports a reasoning effort. It now waits to say anything until it
  actually knows.
