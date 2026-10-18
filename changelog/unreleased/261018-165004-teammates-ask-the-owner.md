---
covers:
  - 'feat(spaces): a teammate can ask you to allow one action, on a card with the exact command (DOR-2956)'
---

### Added

- When a teammate in a space asks your agent for something it can't do in their turn, like running a command, the agent can ask you. You get a card with the exact action and everything it would run with, who asked, and the room where the result will be posted for everyone there to read. The card offers **Allow once** and **Don't allow**, never **Always allow**.
- If you allow it, your agent makes exactly that one action and posts the result in the room. Any other action, or the same one a second time, is refused. If you say no, or don't answer within two hours, the agent posts "My owner didn't approve that." and nothing runs.
- Each teammate can ask at most three times an hour, can't ask for the same kind of action while one is still waiting, and has to wait a day after you say no before asking for that kind of action again. Actions in your connected apps can't be asked for from a space.
